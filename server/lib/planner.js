/**
 * Auto-edit planner.
 *
 * Turns analyzed source media + a style preset into a concrete timeline:
 * an ordered list of clips, each with a source file, in/out time, and the
 * transitions that connect it to the next clip.
 *
 * This module is pure logic — no FFmpeg, no I/O. That makes it easy to unit test.
 */
import { getPreset } from './presets.js';

const EPS = 0.001;

/** Subtract silence regions from a [start,end] window, returning kept intervals. */
export function subtractSilences(start, end, silences) {
  let segments = [[start, end]];
  for (const s of silences) {
    const next = [];
    for (const [a, b] of segments) {
      if (s.end <= a + EPS || s.start >= b - EPS) {
        next.push([a, b]);
        continue;
      }
      if (s.start > a + EPS) next.push([a, Math.min(s.start, b)]);
      if (s.end < b - EPS) next.push([Math.max(s.end, a), b]);
    }
    segments = next;
  }
  return segments.filter(([a, b]) => b - a > EPS);
}

/**
 * Build candidate segments for one source file.
 * Scene boundaries define cuts; long scenes are subdivided so no clip is
 * unbounded, and short scenes are merged forward so we do not emit slivers.
 */
export function candidateSegments(fileAnalysis, preset) {
  const { meta, scenes, silences } = fileAnalysis;
  const duration = meta.duration;
  if (!duration || duration <= EPS) return [];

  const bounds = [0, ...scenes.map((s) => s.time).filter((t) => t > EPS && t < duration - EPS), duration];

  // Merge scene cuts that are too close together for the preset's clip length.
  const raw = [];
  for (let i = 0; i < bounds.length - 1; i += 1) {
    const a = bounds[i];
    const b = bounds[i + 1];
    if (b - a > EPS) raw.push([a, b]);
  }

  const segments = [];
  for (const [a, b] of raw) {
    const len = b - a;
    if (len < preset.minClip * 0.5) {
      // Too short — attach to the previous segment instead of dropping it.
      if (segments.length) {
        segments[segments.length - 1][1] = b;
        continue;
      }
      segments.push([a, b]);
      continue;
    }
    if (len > preset.maxClip) {
      // Split long scenes into preset-sized pieces, biased to keep motion.
      const pieces = Math.ceil(len / preset.targetClip);
      const step = len / pieces;
      for (let i = 0; i < pieces; i += 1) {
        segments.push([a + i * step, a + (i + 1) * step]);
      }
      continue;
    }
    segments.push([a, b]);
  }

  // Apply silence removal inside each segment.
  const out = [];
  for (const [a, b] of segments) {
    const kept = preset.silence.enabled ? subtractSilences(a, b, silences) : [[a, b]];
    for (const [ka, kb] of kept) {
      if (kb - ka >= Math.max(0.25, preset.minClip * 0.35)) {
        out.push({ start: ka, end: kb });
      }
    }
  }

  // Enforce the preset min clip length by padding forward (never past source end).
  const padded = out.map((seg) => {
    let { start, end } = seg;
    const len = end - start;
    if (len < preset.minClip) {
      const grow = preset.minClip - len;
      const room = duration - end;
      const take = Math.min(grow, Math.max(0, room));
      end += take;
    }
    return { start, end };
  });

  return padded.filter((s) => s.end - s.start > EPS);
}

/**
 * Score a segment for "interestingness" using cheap, local heuristics:
 *  - longer scenes tend to be more meaningful
 *  - segments that start near a scene cut get a small bonus
 *  - segments containing speech (surrounded by non-silence) rank higher
 */
export function scoreSegment(seg, fileAnalysis, preset) {
  const len = seg.end - seg.start;
  let score = Math.min(1, len / Math.max(1, preset.targetClip));

  const cutTimes = fileAnalysis.scenes.map((s) => s.time);
  const nearCut = cutTimes.some((t) => Math.abs(t - seg.start) < 0.35);
  if (nearCut) score += 0.18;

  // Prefer segments that are not entirely silent.
  if (preset.silence.enabled) {
    const silentOverlap = fileAnalysis.silences.reduce((acc, s) => {
      const ov = Math.max(0, Math.min(s.end, seg.end) - Math.max(s.start, seg.start));
      return acc + ov;
    }, 0);
    const silenceRatio = len > 0 ? silentOverlap / len : 1;
    score += (1 - silenceRatio) * 0.35;
    if (silenceRatio > 0.6) score -= 0.4;
  }
  return Math.max(0, score);
}

/**
 * Plan a full timeline.
 *
 * @param {Array} analyses - array of { id, name, meta, scenes, silences }
 * @param {string} presetId
 * @param {object} opts - { maxClips, order }
 * @returns {{ clips: Array, totalDuration: number, preset: object }}
 */
export function planTimeline(analyses, presetId, opts = {}) {
  const preset = getPreset(presetId);
  const maxClips = opts.maxClips || 24;
  const order = opts.order || 'chronological';

  // 1. Gather all candidates from all files with scores.
  const candidates = [];
  for (const analysis of analyses) {
    const segs = candidateSegments(analysis, preset);
    for (const seg of segs) {
      candidates.push({
        fileId: analysis.id,
        fileName: analysis.name,
        start: seg.start,
        end: seg.end,
        score: scoreSegment(seg, analysis, preset),
        duration: seg.end - seg.start,
        width: analysis.meta.width,
        height: analysis.meta.height,
        hasAudio: analysis.meta.hasAudio,
      });
    }
  }

  if (!candidates.length) {
    // Fall back to one clip per file covering its first preset.maxClip seconds.
    const fallback = analyses.map((a) => ({
      fileId: a.id,
      fileName: a.name,
      start: 0,
      end: Math.min(a.meta.duration || preset.maxClip, preset.maxClip),
      score: 1,
      duration: Math.min(a.meta.duration || preset.maxClip, preset.maxClip),
      width: a.meta.width,
      height: a.meta.height,
      hasAudio: a.meta.hasAudio,
    }));
    return buildTimeline(fallback, preset, order, maxClips);
  }

  // 2. Pick the best candidates, but keep the mix across files reasonably even.
  const perFile = Math.max(1, Math.ceil(maxClips / Math.max(1, new Set(candidates.map((c) => c.fileId)).size)));
  const byFile = new Map();
  for (const c of candidates) {
    if (!byFile.has(c.fileId)) byFile.set(c.fileId, []);
    byFile.get(c.fileId).push(c);
  }
  const picked = [];
  for (const list of byFile.values()) {
    list.sort((a, b) => b.score - a.score);
    picked.push(...list.slice(0, perFile));
  }

  // 3. Trim to the global clip budget, keeping the highest scores.
  picked.sort((a, b) => b.score - a.score);
  const chosen = picked.slice(0, maxClips);

  return buildTimeline(chosen, preset, order, maxClips);
}

function buildTimeline(clips, preset, order, maxClips) {
  let ordered = clips;
  if (order === 'chronological') {
    // Keep each file's clips together, in the order the files were imported.
    const firstIndex = new Map();
    clips.forEach((c, i) => {
      if (!firstIndex.has(c.fileId)) firstIndex.set(c.fileId, i);
    });
    ordered = [...clips].sort((a, b) => {
      const fa = firstIndex.get(a.fileId);
      const fb = firstIndex.get(b.fileId);
      if (fa !== fb) return fa - fb;
      return a.start - b.start;
    });
  } else if (order === 'score') {
    ordered = [...clips].sort((a, b) => b.score - a.score);
  } else if (order === 'shortest') {
    ordered = [...clips].sort((a, b) => a.duration - b.duration);
  } else if (order === 'longest') {
    ordered = [...clips].sort((a, b) => b.duration - a.duration);
  }

  const finalClips = ordered.slice(0, maxClips).map((c, i, arr) => ({
    id: `clip_${i + 1}`,
    fileId: c.fileId,
    fileName: c.fileName,
    start: round3(c.start),
    end: round3(c.end),
    duration: round3(c.end - c.start),
    score: round3(c.score),
    width: c.width,
    height: c.height,
    hasAudio: c.hasAudio,
    transition: i === 0 ? null : { ...preset.transition },
  }));

  const totalDuration = finalClips.reduce((acc, c) => acc + c.duration, 0);
  return { clips: finalClips, totalDuration: round3(totalDuration), preset };
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

/**
 * Recompute a timeline after the user manually trims/reorders/removes clips.
 * Preserves user intent: only transition metadata and totals are refreshed.
 */
export function retimeTimeline(clips, presetId) {
  const preset = getPreset(presetId);
  const out = clips.map((c, i, arr) => ({
    ...c,
    duration: round3(Math.max(0.04, c.end - c.start)),
    transition: i === 0 ? null : (c.transition || { ...preset.transition }),
  }));
  const totalDuration = out.reduce((acc, c) => acc + c.duration, 0);
  return { clips: out, totalDuration: round3(totalDuration), preset };
}
