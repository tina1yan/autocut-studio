/**
 * Media analysis: probe metadata, detect scene cuts, detect silence.
 *
 * Everything here is local FFmpeg/FFprobe work — no cloud calls, no models.
 */
import { run, FFPROBE_PATH, FFMPEG_PATH } from '../ffmpeg.js';

/** Probe a media file and return normalized metadata. */
export async function probe(filePath) {
  const res = await run(FFPROBE_PATH, [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    filePath,
  ], { timeout: 60000 });

  if (res.failed || !res.stdout.trim()) {
    throw new Error(`ffprobe failed for ${filePath}: ${res.stderr || res.stdout || 'unknown error'}`);
  }
  const data = JSON.parse(res.stdout);
  const streams = data.streams || [];
  const video = streams.find((s) => s.codec_type === 'video');
  const audio = streams.find((s) => s.codec_type === 'audio');
  const format = data.format || {};

  const duration = Number(format.duration || (video && video.duration) || 0) || 0;
  const fps = video && video.avg_frame_rate && video.avg_frame_rate !== '0/0'
    ? (() => {
        const [n, d] = video.avg_frame_rate.split('/').map(Number);
        return d ? n / d : 30;
      })()
    : 30;

  return {
    duration,
    width: video ? Number(video.width || 0) : 0,
    height: video ? Number(video.height || 0) : 0,
    fps: Number.isFinite(fps) && fps > 0 ? fps : 30,
    hasVideo: !!video,
    hasAudio: !!audio,
    videoCodec: video ? video.codec_name : null,
    audioCodec: audio ? audio.codec_name : null,
    bitrate: Number(format.bit_rate || 0),
    size: Number(format.size || 0),
    rotation: rotationDegrees(video),
  };
}

function rotationDegrees(video) {
  if (!video) return 0;
  const tag = video.tags && video.tags.rotate;
  if (tag) {
    const n = Math.abs(Number(tag)) % 360;
    return Number.isFinite(n) ? n : 0;
  }
  const side = (video.side_data_list || []).find((s) => s.rotation !== undefined);
  if (side) {
    const n = Math.abs(Number(side.rotation)) % 360;
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/**
 * Detect scene changes with FFmpeg's `select` filter.
 * Returns array of { time, score } for detected cuts.
 */
export async function detectScenes(filePath, { threshold = 0.35, minGap = 0.6 } = {}) {
  const res = await run(FFMPEG_PATH, [
    '-hide_banner',
    '-nostdin',
    '-i', filePath,
    '-filter_complex',
    `select='gt(scene,${threshold})',metadata=print:file=-`,
    '-an',
    '-f', 'null',
    '-',
  ], { timeout: 600000 });

  if (res.failed) {
    // Fall back to a no-scenes result rather than failing the whole import.
    return [];
  }
  const out = res.stdout + res.stderr;
  const scenes = [];
  const re = /pts_time:([0-9.]+)/g;
  let m;
  while ((m = re.exec(out)) !== null) {
    const time = Number(m[1]);
    if (Number.isFinite(time)) scenes.push({ time });
  }
  scenes.sort((a, b) => a.time - b.time);

  // Enforce a minimum gap between cuts so we do not get frame-level flicker.
  const filtered = [];
  for (const s of scenes) {
    if (filtered.length === 0 || s.time - filtered[filtered.length - 1].time >= minGap) {
      filtered.push(s);
    }
  }
  return filtered;
}

/**
 * Detect silent regions using FFmpeg's `silencedetect` filter.
 * Returns array of { start, end, duration } where audio is below the threshold.
 */
export async function detectSilence(filePath, { noiseDb = -30, minSilence = 0.45 } = {}) {
  const res = await run(FFMPEG_PATH, [
    '-hide_banner',
    '-nostdin',
    '-i', filePath,
    '-af', `silencedetect=noise=${noiseDb}dB:d=${minSilence}`,
    '-f', 'null',
    '-',
  ], { timeout: 600000 });

  const out = res.stdout + res.stderr;
  const silences = [];
  const startRe = /silence_start:\s*(-?[0-9.]+)/g;
  const endRe = /silence_end:\s*(-?[0-9.]+)/g;
  const starts = [];
  const ends = [];
  let m;
  while ((m = startRe.exec(out)) !== null) starts.push(Number(m[1]));
  while ((m = endRe.exec(out)) !== null) ends.push(Number(m[1]));

  for (let i = 0; i < starts.length; i += 1) {
    const start = Math.max(0, starts[i]);
    const end = ends[i] !== undefined ? ends[i] : start;
    if (end > start) {
      silences.push({ start, end, duration: end - start });
    }
  }
  return silences;
}

/**
 * Measure loudness (integrated LUFS) so we can normalise audio between clips.
 * Returns null when the file has no audio.
 */
export async function measureLoudness(filePath) {
  const res = await run(FFMPEG_PATH, [
    '-hide_banner',
    '-nostdin',
    '-i', filePath,
    '-af', 'ebur128=peak=true',
    '-f', 'null',
    '-',
  ], { timeout: 600000 });

  const out = res.stdout + res.stderr;
  const iRe = /I:\s*(-?[0-9.]+)\s*LUFS/g;
  const values = [];
  let m;
  while ((m = iRe.exec(out)) !== null) {
    const v = Number(m[1]);
    if (Number.isFinite(v)) values.push(v);
  }
  if (!values.length) return null;
  // The final "I:" reading is the integrated loudness; ebur128 prints a summary at the end.
  const integrated = values[values.length - 1];
  return Number.isFinite(integrated) && integrated > -70 ? integrated : null;
}

/**
 * Full analysis pass for one file.
 */
export async function analyzeFile(filePath, options = {}) {
  const meta = await probe(filePath);
  const scenes = meta.hasVideo ? await detectScenes(filePath, options.scene) : [];
  const silences = meta.hasAudio ? await detectSilence(filePath, options.silence) : [];
  const loudness = meta.hasAudio ? await measureLoudness(filePath) : null;
  return { meta, scenes, silences, loudness };
}
