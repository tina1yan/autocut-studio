/**
 * Render pipeline.
 *
 * Builds an FFmpeg filter_complex graph that reproduces the edited timeline and
 * encodes it to an H.264 MP4.
 *
 * Pipeline per clip:
 *   trim -> speed -> fps -> exact frame count -> frame (scale/crop/pad)
 *        -> Ken Burns zoom -> colour grade -> vignette -> yuv420p
 *
 * Clips are joined with xfade/acrossfade (transitions) or hard-cut with the
 * concat filter. Privacy regions are applied to the final composite.
 */
import path from 'node:path';
import { runFfmpeg } from '../ffmpeg.js';
import { getPreset } from './presets.js';

export const ASPECTS = {
  '9:16': { width: 1080, height: 1920, label: 'Portrait 9:16' },
  '16:9': { width: 1920, height: 1080, label: 'Landscape 16:9' },
  '1:1': { width: 1080, height: 1080, label: 'Square 1:1' },
};

const DRAFT_SCALE = 0.34; // draft preview resolution factor

function fmt(n, digits = 3) {
  return Number(n).toFixed(digits);
}

/** Deterministic pseudo-random in [0,1) from a string seed. */
function hashUnit(seed) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

/** Per-clip speed derived deterministically from the preset range. */
export function clipSpeed(clip, preset) {
  if (!preset.speed || !preset.speed.enabled) return 1;
  const { min, max } = preset.speed;
  if (max <= min) return min;
  const u = hashUnit(`${clip.id}:${clip.fileId}:${fmt(clip.start, 2)}`);
  return min + u * (max - min);
}

/** Xfade transition names supported by our FFmpeg build. */
const XFADE_NAMES = new Set([
  'fade', 'fadeblack', 'fadewhite', 'wipeleft', 'wiperight', 'wipeup', 'wipedown',
  'slideleft', 'slideright', 'slideup', 'slidedown', 'circleopen', 'circleclose',
  'dissolve', 'zoomin', 'zoomout', 'radial', 'smoothleft', 'smoothright',
  'smoothup', 'smoothdown', 'vertopen', 'vertclose', 'horzopen', 'horzclose',
  'diagtl', 'diagtr', 'diagbl', 'diagbr', 'pixelize', 'squeezeh', 'squeezev',
  'hblur', 'fadegrays', 'wipetl', 'wipetr', 'wipebl', 'wipebr',
]);

function transitionName(t) {
  if (!t || !t.type) return 'fade';
  if (t.type === 'cut') return 'fade';
  if (!XFADE_NAMES.has(t.type)) return 'fade';
  return t.type;
}

/**
 * Build the complete filter graph and argument list.
 *
 * @param {object} project - { files, clips, preset, aspect, resolution, privacy }
 * @param {object} opts - { draft: boolean }
 * @returns {{ args: string[], outLabel: string, totalDuration: number }}
 */
export function buildRenderPlan(project, opts = {}) {
  const preset = getPreset(project.preset);
  const aspect = ASPECTS[project.aspect] || ASPECTS['9:16'];
  const FPS = preset.fps || 30;

  let W = aspect.width;
  let H = aspect.height;
  if (opts.draft) {
    W = Math.round((W * DRAFT_SCALE) / 2) * 2;
    H = Math.round((H * DRAFT_SCALE) / 2) * 2;
  } else if (project.resolution === '720') {
    if (W >= H) { W = 1280; H = 720; } else { W = 720; H = 1280; }
  } else if (project.resolution === '480') {
    if (W >= H) { W = 854; H = 480; } else { W = 480; H = 854; }
  }
  W = Math.max(2, Math.round(W / 2) * 2);
  H = Math.max(2, Math.round(H / 2) * 2);

  const clips = (project.clips || [])
    .filter((c) => c && c.end > c.start)
    .map((c) => ({ ...c }));
  if (!clips.length) {
    throw new Error('Timeline has no clips to render.');
  }

  const usedIds = new Set(clips.map((c) => c.fileId));
  const fileList = (project.files || []).filter((f) => usedIds.has(f.id));
  if (!fileList.length) throw new Error('No source files referenced by the timeline.');
  const inputIndex = new Map(fileList.map((f, i) => [f.id, i]));

  const args = [];
  for (const f of fileList) {
    args.push('-i', f.path);
  }

  const chains = [];
  const audioChains = [];
  const effDurations = [];

  clips.forEach((clip, i) => {
    const idx = inputIndex.get(clip.fileId);
    const S = Math.max(0, clip.start);
    const E = Math.max(S + 0.05, clip.end);
    const L = E - S;
    const speed = clipSpeed(clip, preset);
    const outDur = L / speed;
    const N = Math.max(1, Math.round(outDur * FPS));
    const effDur = N / FPS;
    effDurations.push(effDur);

    // ---- video chain ----
    const parts = [];
    parts.push(`[${idx}:v]trim=start=${fmt(S)}:duration=${fmt(L)}`);
    parts.push(`setpts=(PTS-STARTPTS)/${fmt(speed, 4)}`);
    parts.push(`fps=${FPS}`);
    parts.push('tpad=stop_mode=clone:stop_duration=1');
    parts.push(`trim=end_frame=${N}`);
    parts.push(`setpts=N/(${FPS}*TB)`);

    // framing: cover (fill + crop) or contain (fit + pad)
    if (preset.letterbox) {
      parts.push(`scale=${W}:${Math.round(H * 0.88)}:force_original_aspect_ratio=decrease`);
      parts.push(`pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black`);
    } else {
      parts.push(`scale=${W}:${H}:force_original_aspect_ratio=increase`);
      parts.push(`crop=${W}:${H}`);
    }

    // camera motion
    const zoom = preset.zoom || { push: 0, punch: 0, punchTime: 0 };
    if (zoom.push > 0 || zoom.punch > 0) {
      const z = buildZoomExpression(zoom, N, FPS);
      parts.push(`zoompan=z='${z}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=${FPS}`);
    }

    // colour grade
    if (preset.grade) parts.push(preset.grade);
    if (preset.vignette > 0) {
      const angle = Math.PI / (4 + preset.vignette * 8);
      parts.push(`vignette=angle=${fmt(angle, 4)}`);
    }
    parts.push('setsar=1');
    parts.push('format=yuv420p');
    parts.push(`setpts=N/(${FPS}*TB)`);
    chains.push(`${parts.join(',')}[v${i}]`);

    // ---- audio chain ----
    const aParts = [];
    const file = fileList.find((f) => f.id === clip.fileId);
    if (file && file.hasAudio === false) {
      aParts.push(`anullsrc=r=48000:cl=stereo`);
      aParts.push(`atrim=duration=${fmt(effDur)}`);
    } else {
      aParts.push(`[${idx}:a]atrim=start=${fmt(S)}:duration=${fmt(L)}`);
      aParts.push('asetpts=PTS-STARTPTS');
      if (Math.abs(speed - 1) > 0.001) aParts.push(`atempo=${fmt(speed, 4)}`);
    }
    aParts.push('aresample=48000');
    aParts.push('aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo');
    // Guarantee the audio length matches the video exactly.
    aParts.push(`apad`);
    aParts.push(`atrim=duration=${fmt(effDur)}`);
    const gain = audioGainDb(clip, file, preset);
    if (gain !== 0) aParts.push(`volume=${fmt(gain, 2)}dB`);
    audioChains.push(`${aParts.join(',')}[a${i}]`);
  });

  // ---- group clips by transition (zero-length transition => hard cut) ----
  const groups = [];
  let current = [0];
  for (let i = 1; i < clips.length; i += 1) {
    const t = clips[i].transition;
    if (!t || !t.duration || t.duration <= 0.001) {
      groups.push(current);
      current = [i];
    } else {
      current.push(i);
    }
  }
  groups.push(current);

  const videoLabels = [];
  const audioLabels = [];
  let totalDuration = 0;

  groups.forEach((group, gi) => {
    let vLabel;
    let aLabel;
    if (group.length === 1) {
      vLabel = `v${group[0]}`;
      aLabel = `a${group[0]}`;
      totalDuration += effDurations[group[0]];
    } else {
      // xfade chain inside the group
      let acc = effDurations[group[0]];
      let vCur = `v${group[0]}`;
      let aCur = `a${group[0]}`;
      for (let k = 1; k < group.length; k += 1) {
        const prevIdx = group[k - 1];
        const curIdx = group[k];
        const t = clips[curIdx].transition || { type: 'fade', duration: 0.3 };
        const d = Math.min(t.duration, effDurations[prevIdx] * 0.5, effDurations[curIdx] * 0.5);
        const offset = Math.max(0, acc - d);
        const name = transitionName(t);
        const vNext = `xg${gi}_${k}`;
        chains.push(`[${vCur}][v${curIdx}]xfade=transition=${name}:duration=${fmt(d)}:offset=${fmt(offset)}[${vNext}]`);
        const aNext = `ag${gi}_${k}`;
        audioChains.push(`[${aCur}][a${curIdx}]acrossfade=d=${fmt(d)}:c1=tri:c2=tri[${aNext}]`);
        acc = acc + effDurations[curIdx] - d;
        vCur = vNext;
        aCur = aNext;
      }
      vLabel = vCur;
      aLabel = aCur;
      totalDuration += acc;
    }
    videoLabels.push(vLabel);
    audioLabels.push(aLabel);
  });

  // ---- combine groups ----
  let outVideo;
  let outAudio;
  if (videoLabels.length === 1) {
    outVideo = videoLabels[0];
    outAudio = audioLabels[0];
  } else {
    chains.push(`${videoLabels.map((l) => `[${l}]`).join('')}concat=n=${videoLabels.length}:v=1:a=0[catv]`);
    audioChains.push(`${audioLabels.map((l) => `[${l}]`).join('')}concat=n=${audioLabels.length}:v=0:a=1[cata]`);
    outVideo = 'catv';
    outAudio = 'cata';
  }

  // ---- privacy regions ----
  const privacy = (project.privacy || []).filter((r) => r && r.w > 0.001 && r.h > 0.001);
  if (privacy.length) {
    const timeline = clipTimelinePositions(clips, groups, effDurations, preset);
    let cur = outVideo;
    privacy.forEach((region, ri) => {
      const x = Math.round(region.x * W);
      const y = Math.round(region.y * H);
      const w = Math.max(2, Math.round(region.w * W));
      const h = Math.max(2, Math.round(region.h * H));
      const win = regionWindow(region, timeline, clips, totalDuration);
      const enable = `between(t,${fmt(win[0])},${fmt(win[1])})`;
      const next = `pv${ri}`;
      if (region.mode === 'box') {
        const color = region.color || '#000000';
        chains.push(`[${cur}]drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=${color}@1.0:t=fill:enable='${enable}'[${next}]`);
      } else if (region.mode === 'pixelate') {
        // The overlay filter takes the output size from its MAIN input, so the
        // untouched full frame must be main and the small patch the overlay.
        chains.push(`[${cur}]split=2[pvbase${ri}][pvpatch${ri}]`);
        chains.push(`[pvpatch${ri}]crop=${w}:${h}:${x}:${y},scale=iw/14:ih/14,scale=${w}:${h}:flags=neighbor[pvpx${ri}]`);
        chains.push(`[pvbase${ri}][pvpx${ri}]overlay=${x}:${y}:enable='${enable}'[${next}]`);
      } else {
        // blur (default)
        chains.push(`[${cur}]split=2[pvbase${ri}][pvpatch${ri}]`);
        chains.push(`[pvpatch${ri}]crop=${w}:${h}:${x}:${y},boxblur=luma_radius=12:luma_power=2:chroma_radius=6:chroma_power=1[pvbl${ri}]`);
        chains.push(`[pvbase${ri}][pvbl${ri}]overlay=${x}:${y}:enable='${enable}'[${next}]`);
      }
      cur = next;
    });
    outVideo = cur;
  }

  const filterComplex = [...chains, ...audioChains].join(';');

  args.push('-filter_complex', filterComplex);
  args.push('-map', `[${outVideo}]`);
  args.push('-map', `[${outAudio}]`);
  args.push('-c:v', 'libx264');
  args.push('-preset', opts.draft ? 'veryfast' : 'medium');
  args.push('-crf', opts.draft ? '28' : '20');
  args.push('-pix_fmt', 'yuv420p');
  args.push('-r', String(FPS));
  args.push('-c:a', 'aac');
  args.push('-b:a', '192k');
  args.push('-ar', '48000');
  args.push('-movflags', '+faststart');
  args.push('-shortest');
  args.push('-y');

  return { args, outLabel: outVideo, totalDuration, width: W, height: H, fps: FPS, filterComplex };
}

function buildZoomExpression(zoom, N, FPS) {
  const push = zoom.push || 0;
  const punch = zoom.punch || 0;
  const punchFrames = Math.max(1, Math.round((zoom.punchTime || 0.4) * FPS));
  if (punch > 0) {
    // Snap in fast, then ease back slightly and hold.
    const hold = 1 + punch * 0.6;
    return `if(lt(on,${punchFrames}),1+${fmt(punch, 4)}*on/${punchFrames},${fmt(hold, 4)}+${fmt(punch * 0.4, 4)}*min(1,max(0,(on-${punchFrames})/${Math.max(1, N - punchFrames)})))`;
  }
  if (push > 0) {
    return `min(1+${fmt(push, 4)}*on/${Math.max(1, N)},${fmt(1 + push, 4)})`;
  }
  return '1';
}

function audioGainDb(clip, file, preset) {
  const presetGain = (preset.audio && preset.audio.gainDb) || 0;
  if (!preset.audio || !preset.audio.normalize) return presetGain;
  const measured = file && typeof file.loudness === 'number' ? file.loudness : null;
  if (measured === null) return presetGain;
  const target = preset.audio.targetLufs ?? -16;
  const gain = target - measured + presetGain;
  return Math.max(-12, Math.min(12, gain));
}

/** Compute each clip's start/end position on the final timeline. */
function clipTimelinePositions(clips, groups, effDurations, preset) {
  const positions = [];
  let cursor = 0;
  for (const group of groups) {
    for (let k = 0; k < group.length; k += 1) {
      const idx = group[k];
      const dur = effDurations[idx];
      if (k > 0) {
        const t = clips[idx].transition || { duration: 0 };
        cursor -= Math.min(t.duration, dur * 0.5, effDurations[group[k - 1]] * 0.5);
      }
      positions[idx] = { start: cursor, end: cursor + dur, clipId: clips[idx].id };
      cursor += dur;
    }
  }
  return positions;
}

function regionWindow(region, positions, clips, totalDuration) {
  if (region.clipId) {
    const p = positions.find((x) => x && x.clipId === region.clipId);
    if (p) return [p.start, p.end];
  }
  return [0, totalDuration];
}

/**
 * Render a project to an MP4 file.
 * @returns {Promise<{ ok: boolean, code: number, stderr: string, totalDuration: number, output: string }>}
 */
export async function renderProject(project, outputPath, { draft = false, onProgress = null } = {}) {
  const plan = buildRenderPlan(project, { draft });
  const args = [...plan.args, outputPath];
  const res = await runFfmpeg(args, {
    durationSec: plan.totalDuration,
    onProgress,
    timeout: draft ? 900000 : 3600000,
  });
  return {
    ok: !res.failed,
    code: res.code,
    stderr: res.stderr,
    totalDuration: plan.totalDuration,
    width: plan.width,
    height: plan.height,
    fps: plan.fps,
    output: outputPath,
    filterLength: plan.filterComplex.length,
  };
}
