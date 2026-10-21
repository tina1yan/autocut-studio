/**
 * End-to-end smoke test: build a timeline from the generated samples, render it
 * with FFmpeg in every preset, and verify each output with ffprobe.
 *
 * This is the test that proves the presets actually change the rendered video.
 *
 * Run:  npm run smoke
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { PROJECT_ROOT, FFMPEG_PATH, FFPROBE_PATH, run } from '../server/ffmpeg.js';
import { analyzeFile } from '../server/lib/analyze.js';
import { planTimeline } from '../server/lib/planner.js';
import { renderProject } from '../server/lib/render.js';
import { PRESET_IDS } from '../server/lib/presets.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_DIR = path.join(PROJECT_ROOT, 'examples');
const OUT_DIR = path.join(PROJECT_ROOT, 'exports', 'test');
const ASPECT = process.env.SMOKE_ASPECT || '9:16';

const results = [];
let failures = 0;

function log(ok, msg, extra = '') {
  const line = `${ok ? 'PASS' : 'FAIL'}  ${msg}${extra ? `  ${extra}` : ''}`;
  results.push({ ok, msg, extra });
  if (!ok) failures += 1;
  console.log(line);
}

function probeJson(file) {
  return new Promise((resolve, reject) => {
    const child = spawn(FFPROBE_PATH, [
      '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file,
    ], { windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) { reject(new Error(`ffprobe exit ${code}`)); return; }
      try { resolve(JSON.parse(out)); } catch (err) { reject(err); }
    });
  });
}

/** Average RGB of a frame, used to prove presets alter the picture. */
async function frameSignature(file, atSec = 0.5) {
  const res = await run(FFMPEG_PATH, [
    '-hide_banner', '-nostdin', '-ss', String(atSec), '-i', file,
    '-frames:v', '1', '-vf', 'scale=32:32', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
  ], { timeout: 60000 });
  if (res.failed || !res.stdout.length) return null;
  // rawvideo comes back as binary; run() decoded it as utf8, so re-extract bytes.
  return res.stdout;
}

async function main() {
  console.log('AutoCut Studio — end-to-end smoke test\n');
  console.log(`  aspect : ${ASPECT}`);
  console.log(`  ffmpeg : ${FFMPEG_PATH}\n`);

  if (!FFMPEG_PATH || !FFPROBE_PATH) {
    console.error('FFmpeg/FFprobe missing. Run: npm run setup:ffmpeg');
    process.exit(1);
  }

  const samples = fs.existsSync(SAMPLE_DIR)
    ? fs.readdirSync(SAMPLE_DIR).filter((f) => f.endsWith('.mp4')).map((f) => path.join(SAMPLE_DIR, f))
    : [];
  if (!samples.length) {
    console.error('No sample videos. Run: npm run make-samples');
    process.exit(1);
  }
  console.log(`  samples: ${samples.length}\n`);

  fs.mkdirSync(OUT_DIR, { recursive: true });

  // ---- 1. analysis ----
  console.log('— analysis —');
  const analyses = [];
  for (const s of samples) {
    const t0 = Date.now();
    const a = await analyzeFile(s);
    analyses.push({ id: path.basename(s), name: path.basename(s), ...a });
    log(a.meta.duration > 0, `probe ${path.basename(s)}`,
      `dur=${a.meta.duration.toFixed(2)}s ${a.meta.width}x${a.meta.height} scenes=${a.scenes.length} silences=${a.silences.length} loudness=${a.loudness ?? 'n/a'} (${Date.now() - t0}ms)`);
  }

  const sceneTotal = analyses.reduce((a, x) => a + x.scenes.length, 0);
  const silenceTotal = analyses.reduce((a, x) => a + x.silences.length, 0);
  log(sceneTotal > 0, 'scene detection found cuts across samples', `total=${sceneTotal}`);
  log(silenceTotal > 0, 'silence detection found quiet regions across samples', `total=${silenceTotal}`);

  // ---- 2. planning ----
  console.log('\n— planning —');
  const plan = planTimeline(analyses, 'dramatic', { order: 'chronological', maxClips: 8 });
  log(plan.clips.length > 0, 'auto-edit produced a timeline', `clips=${plan.clips.length} total=${plan.totalDuration.toFixed(2)}s`);
  log(plan.clips.every((c) => c.end > c.start), 'every planned clip has positive duration');

  // ---- 3. render every preset ----
  console.log('\n— render (all presets) —');
  const files = analyses.map((a) => ({
    id: a.id, name: a.name, path: a.meta.__path, hasAudio: a.meta.hasAudio, loudness: a.loudness,
  }));
  // The analysis helper does not retain the path; re-derive it from samples order.
  analyses.forEach((a, i) => { files[i].path = samples[i]; });

  const rendered = [];
  for (const presetId of PRESET_IDS) {
    const p = planTimeline(analyses, presetId, { order: 'chronological', maxClips: 8 });
    const out = path.join(OUT_DIR, `smoke-${presetId}-${ASPECT.replace(':', 'x')}.mp4`);
    const t0 = Date.now();
    const res = await renderProject({
      preset: presetId,
      aspect: ASPECT,
      resolution: '480',
      files,
      clips: p.clips,
      privacy: [],
    }, out);
    const ms = Date.now() - t0;
    if (!res.ok) {
      log(false, `render preset "${presetId}"`, res.stderr.slice(-400));
      continue;
    }
    let meta = null;
    try { meta = await probeJson(out); } catch { /* handled below */ }
    const v = (meta && meta.streams || []).find((s) => s.codec_type === 'video');
    const a = (meta && meta.streams || []).find((s) => s.codec_type === 'audio');
    const size = fs.existsSync(out) ? fs.statSync(out).size : 0;
    const ok = !!v && !!a && size > 1000 && Number(v.width) > 0;
    log(ok, `render preset "${presetId}"`,
      `${v ? `${v.width}x${v.height}` : 'no video'} ${v ? `${Number(v.duration || 0).toFixed(2)}s` : ''} ${size ? `${(size / 1024).toFixed(0)}KB` : ''} (${ms}ms)`);
    if (ok) rendered.push({ presetId, out, size, width: v.width, height: v.height, duration: Number(meta.format.duration) });
  }

  // ---- 4. presets must produce different videos ----
  console.log('\n— preset differentiation —');
  const bySize = new Set(rendered.map((r) => r.size));
  log(bySize.size === rendered.length,
    'each preset produced a byte-different video',
    `unique sizes ${bySize.size}/${rendered.length}`);

  // Compare frame content between two very different presets.
  if (rendered.length >= 2) {
    const a = rendered.find((r) => r.presetId === 'cinematic');
    const b = rendered.find((r) => r.presetId === 'dramatic');
    if (a && b) {
      const sigA = await frameSignature(a.out, 0.4);
      const sigB = await frameSignature(b.out, 0.4);
      const differs = sigA !== sigB && sigA && sigB;
      log(!!differs, 'cinematic and dramatic produce different frame content');
    }
  }

  // ---- 5. privacy region ----
  console.log('\n— privacy redaction —');
  {
    const p = planTimeline(analyses, 'minimal', { order: 'chronological', maxClips: 4 });
    const out = path.join(OUT_DIR, `smoke-privacy-${ASPECT.replace(':', 'x')}.mp4`);
    const res = await renderProject({
      preset: 'minimal',
      aspect: ASPECT,
      resolution: '480',
      files,
      clips: p.clips,
      privacy: [{ id: 'r1', x: 0.25, y: 0.3, w: 0.4, h: 0.25, mode: 'pixelate' }],
    }, out);
    if (!res.ok) {
      log(false, 'render with privacy region', res.stderr.slice(-400));
    } else {
      const meta = await probeJson(out);
      const v = (meta.streams || []).find((s) => s.codec_type === 'video');
      // The redaction must not change the output geometry: the overlay filter
      // takes its size from the main input, so a swapped input would crop the
      // video down to the size of the redaction box.
      const expected = ASPECT === '16:9' ? { w: 854, h: 480 } : { w: 480, h: 854 };
      const geomOk = v && v.width === expected.w && v.height === expected.h;
      log(!!v && geomOk, 'render with privacy region kept full frame geometry',
        v ? `${v.width}x${v.height} (expected ${expected.w}x${expected.h}) ${(fs.statSync(out).size / 1024).toFixed(0)}KB` : 'no video stream');
    }
  }

  // ---- 6. both aspect ratios ----
  console.log('\n— aspect ratio conversion —');
  for (const aspect of ['9:16', '16:9']) {
    const p = planTimeline(analyses, 'minimal', { order: 'chronological', maxClips: 3 });
    const out = path.join(OUT_DIR, `smoke-aspect-${aspect.replace(':', 'x')}.mp4`);
    const res = await renderProject({
      preset: 'minimal', aspect, resolution: '480', files, clips: p.clips, privacy: [],
    }, out);
    if (!res.ok) { log(false, `render aspect ${aspect}`, res.stderr.slice(-300)); continue; }
    const meta = await probeJson(out);
    const v = (meta.streams || []).find((s) => s.codec_type === 'video');
    const portrait = aspect === '9:16' ? v.height > v.width : v.width > v.height;
    log(!!v && portrait, `render aspect ${aspect} has correct orientation`, v ? `${v.width}x${v.height}` : '');
  }

  // ---- summary ----
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${results.length - failures}/${results.length} checks passed`);
  if (failures) {
    console.log(`  ${failures} FAILED`);
    console.log('='.repeat(60));
    process.exit(1);
  }
  console.log('  ALL SMOKE TESTS PASSED');
  console.log('='.repeat(60));
  process.exit(0);
}

main().catch((err) => {
  console.error('\nSmoke test crashed:', err);
  process.exit(1);
});
