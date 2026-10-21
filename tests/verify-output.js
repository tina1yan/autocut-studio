/**
 * Pixel-level verification of the rendered output.
 *
 * Proves that:
 *  1. A privacy redaction region actually changes the pixels inside it,
 *     while pixels OUTSIDE it stay (near) identical.
 *  2. Different presets produce measurably different picture content.
 *
 * Method: render the same source twice (with and without a redaction region)
 * and compare the RGB values region by region using FFmpeg's `crop` +
 * rawvideo output.
 *
 * NOTE: the redaction test uses a *textured* source. The generated sample
 * clips are flat solid colours, and blurring or pixelating a uniform region
 * yields the same uniform region -- so a flat source cannot demonstrate that
 * the redaction does anything. `testsrc2` has rich moving texture and does.
 *
 * Run:  node tests/verify-output.js
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { PROJECT_ROOT, FFMPEG_PATH } from '../server/ffmpeg.js';
import { analyzeFile } from '../server/lib/analyze.js';
import { planTimeline } from '../server/lib/planner.js';
import { renderProject } from '../server/lib/render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_DIR = path.join(PROJECT_ROOT, 'examples');
const OUT_DIR = path.join(PROJECT_ROOT, 'exports', 'verify');
const TEXTURED = path.join(OUT_DIR, 'textured.mp4');

let pass = 0;
let fail = 0;
const log = (ok, msg, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}${extra ? `  ${extra}` : ''}`);
  if (ok) pass += 1; else fail += 1;
};

/** Run ffmpeg and return { code, out (raw stdout Buffer), err }. */
function ffmpeg(args) {
  return new Promise((resolve) => {
    const child = spawn(FFMPEG_PATH, args, { windowsHide: true });
    const out = [];
    let err = '';
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => resolve({ code: -1, out: Buffer.alloc(0), err: String(e) }));
    child.on('close', (code) => resolve({ code, out: Buffer.concat(out), err }));
  });
}

/** Extract a rectangle of raw RGB bytes from a video at a given time. */
async function grabFrame(file, atSec, x, y, w, h) {
  const r = await ffmpeg([
    '-hide_banner', '-nostdin', '-loglevel', 'error',
    '-ss', String(atSec), '-i', file,
    '-frames:v', '1',
    '-vf', `crop=${w}:${h}:${x}:${y}`,
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
  ]);
  if (r.code !== 0 || !r.out.length) {
    throw new Error(`grabFrame failed: ${r.err.slice(-300)}`);
  }
  return r.out;
}

/** Mean absolute per-channel difference between two equal-size RGB buffers. */
function meanDiff(a, b) {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 255;
  let sum = 0;
  for (let i = 0; i < n; i += 1) sum += Math.abs(a[i] - b[i]);
  return sum / n;
}

/** Count how many pixels differ by more than a threshold. */
function changedPixels(a, b, threshold = 24) {
  const n = Math.min(a.length, b.length);
  let changed = 0;
  for (let i = 0; i + 2 < n; i += 3) {
    const d = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    if (d > threshold) changed += 1;
  }
  return changed;
}

/** Build a textured test clip so blur/pixelate have something to work on. */
async function makeTexturedSource() {
  if (fs.existsSync(TEXTURED) && fs.statSync(TEXTURED).size > 10000) return TEXTURED;
  const r = await ffmpeg([
    '-hide_banner', '-nostdin', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=s=854x480:r=30:d=4',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4:sample_rate=48000',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest', '-y', TEXTURED,
  ]);
  if (r.code !== 0) throw new Error(`could not build textured source: ${r.err.slice(-300)}`);
  return TEXTURED;
}

async function main() {
  console.log('AutoCut Studio — pixel-level output verification\n');
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // ---------------------------------------------------------------- 1 ---
  console.log('— privacy redaction (textured source) —');
  const textured = await makeTexturedSource();
  const texAnalysis = await analyzeFile(textured);
  const texFile = {
    id: 'tex', name: 'textured.mp4', path: textured,
    hasAudio: texAnalysis.meta.hasAudio, loudness: texAnalysis.loudness,
  };
  const texPlan = planTimeline(
    [{ id: 'tex', name: 'textured.mp4', ...texAnalysis }],
    'minimal', { order: 'chronological', maxClips: 4 },
  );

  const region = { id: 'r1', x: 0.2, y: 0.25, w: 0.4, h: 0.3, mode: 'pixelate' };
  const baseProject = {
    preset: 'minimal', aspect: '16:9', resolution: '480',
    files: [texFile], clips: texPlan.clips, privacy: [],
  };

  const outPlain = path.join(OUT_DIR, 'noredact.mp4');
  const rPlain = await renderProject(baseProject, outPlain);
  if (!rPlain.ok) { log(false, 'render plain variant', rPlain.stderr.slice(-300)); process.exit(1); }
  const W = rPlain.width;
  const H = rPlain.height;
  const at = Math.min(1.0, rPlain.totalDuration / 2);

  const ix = Math.round(region.x * W);
  const iy = Math.round(region.y * H);
  const iw = Math.round(region.w * W);
  const ih = Math.round(region.h * H);

  for (const mode of ['pixelate', 'blur', 'box']) {
    const out = path.join(OUT_DIR, `redact-${mode}.mp4`);
    const res = await renderProject(
      { ...baseProject, privacy: [{ ...region, mode }] }, out,
    );
    if (!res.ok) { log(false, `render ${mode} variant`, res.stderr.slice(-300)); continue; }

    const inA = await grabFrame(outPlain, at, ix, iy, iw, ih);
    const inB = await grabFrame(out, at, ix, iy, iw, ih);
    const innerDiff = meanDiff(inA, inB);
    const innerChanged = changedPixels(inA, inB);
    const innerTotal = Math.floor(Math.min(inA.length, inB.length) / 3);
    // Blur smooths gradients rather than replacing pixels, so fewer pixels
    // exceed a strict per-pixel threshold than for pixelate/box. Require a
    // clear mean shift plus a meaningful share of changed pixels.
    log(innerDiff > 4 && innerChanged > innerTotal * 0.05,
      `pixels INSIDE the region changed (${mode})`,
      `mean diff=${innerDiff.toFixed(1)}/255, ${innerChanged}/${innerTotal} pixels changed`);

    // A corner well away from the region must be untouched.
    const ow = Math.max(8, Math.round(W * 0.1));
    const oh = Math.max(8, Math.round(H * 0.1));
    const oA = await grabFrame(outPlain, at, 2, 2, ow, oh);
    const oB = await grabFrame(out, at, 2, 2, ow, oh);
    const outerDiff = meanDiff(oA, oB);
    log(outerDiff < 3, `pixels OUTSIDE the region unchanged (${mode})`,
      `mean diff=${outerDiff.toFixed(2)}/255`);
  }

  // ---------------------------------------------------------------- 2 ---
  console.log('\n— preset differentiation (picture content) —');
  const samples = fs.readdirSync(SAMPLE_DIR).filter((f) => f.endsWith('.mp4')).sort();
  const files = [];
  const analyses = [];
  for (const s of samples) {
    const p = path.join(SAMPLE_DIR, s);
    const a = await analyzeFile(p);
    analyses.push({ id: s, name: s, ...a });
    files.push({ id: s, name: s, path: p, hasAudio: a.meta.hasAudio, loudness: a.loudness });
  }
  const plan = planTimeline(analyses, 'minimal', { order: 'chronological', maxClips: 4 });

  const sigs = new Map();
  for (const preset of ['cinematic', 'dramatic', 'meme', 'minimal']) {
    const p2 = planTimeline(analyses, preset, { order: 'chronological', maxClips: 4 });
    const out = path.join(OUT_DIR, `preset-${preset}.mp4`);
    const res = await renderProject({
      preset, aspect: '16:9', resolution: '480', files, clips: p2.clips, privacy: [],
    }, out);
    if (!res.ok) { log(false, `render preset ${preset}`, res.stderr.slice(-250)); continue; }
    const buf = await grabFrame(out, at, 0, 0, Math.min(64, res.width), Math.min(64, res.height));
    sigs.set(preset, buf);
  }
  const names = [...sigs.keys()];
  let distinct = 0;
  let pairs = 0;
  for (let i = 0; i < names.length; i += 1) {
    for (let j = i + 1; j < names.length; j += 1) {
      pairs += 1;
      const d = meanDiff(sigs.get(names[i]), sigs.get(names[j]));
      if (d > 1.0) distinct += 1;
      console.log(`       ${names[i]} vs ${names[j]}: mean pixel diff = ${d.toFixed(2)}`);
    }
  }
  log(distinct === pairs, 'every preset pair produces different picture content',
    `${distinct}/${pairs} pairs differ`);

  console.log(`\n${'='.repeat(62)}`);
  console.log(`  ${pass}/${pass + fail} checks passed`);
  if (fail) { console.log(`  ${fail} FAILED`); console.log('='.repeat(62)); process.exit(1); }
  console.log('  PIXEL VERIFICATION PASSED');
  console.log('='.repeat(62));
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
