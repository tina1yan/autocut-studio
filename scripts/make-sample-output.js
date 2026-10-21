/**
 * Produce the headline deliverable: a real, playable `sample-output.mp4`.
 *
 * Uses the generated sample videos, runs the full analysis -> plan -> render
 * pipeline, and writes the result to the project root. Verified with ffprobe.
 *
 * Run:  node scripts/make-sample-output.js
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { PROJECT_ROOT, FFMPEG_PATH, FFPROBE_PATH } from '../server/ffmpeg.js';
import { analyzeFile } from '../server/lib/analyze.js';
import { planTimeline } from '../server/lib/planner.js';
import { renderProject } from '../server/lib/render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_DIR = path.join(PROJECT_ROOT, 'examples');
const OUT = path.join(PROJECT_ROOT, 'sample-output.mp4');

const PRESET = process.env.SAMPLE_PRESET || 'dramatic';
const ASPECT = process.env.SAMPLE_ASPECT || '9:16';
const RESOLUTION = process.env.SAMPLE_RESOLUTION || '1080';

function probe(file) {
  return new Promise((resolve, reject) => {
    const child = spawn(FFPROBE_PATH, [
      '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file,
    ], { windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => out += d.toString());
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) { reject(new Error(`ffprobe exit ${code}: ${out.slice(-300)}`)); return; }
      resolve(JSON.parse(out));
    });
  });
}

async function main() {
  console.log('AutoCut Studio — building sample-output.mp4\n');
  const samples = fs.readdirSync(SAMPLE_DIR)
    .filter((f) => f.endsWith('.mp4'))
    .map((f) => path.join(SAMPLE_DIR, f))
    .sort();
  if (!samples.length) {
    console.error('No samples. Run: npm run make-samples');
    process.exit(1);
  }
  console.log(`  preset     : ${PRESET}`);
  console.log(`  aspect     : ${ASPECT} @ ${RESOLUTION}`);
  console.log(`  sources    : ${samples.map((s) => path.basename(s)).join(', ')}\n`);

  const files = [];
  const analyses = [];
  for (const s of samples) {
    const a = await analyzeFile(s);
    analyses.push({ id: path.basename(s), name: path.basename(s), ...a });
    files.push({
      id: path.basename(s), name: path.basename(s), path: s,
      hasAudio: a.meta.hasAudio, loudness: a.loudness,
    });
    console.log(`  analysed ${path.basename(s)}: ${a.meta.width}x${a.meta.height} `
      + `${a.meta.duration.toFixed(1)}s, ${a.scenes.length} scenes, ${a.silences.length} silences`);
  }

  const plan = planTimeline(analyses, PRESET, { order: 'chronological', maxClips: 10 });
  console.log(`\n  planned ${plan.clips.length} clips, ${plan.totalDuration.toFixed(2)}s total`);
  for (const c of plan.clips) {
    console.log(`    ${c.fileName}  ${c.start.toFixed(2)}s -> ${c.end.toFixed(2)}s  (${c.duration.toFixed(2)}s)`);
  }

  console.log('\n  rendering...');
  const t0 = Date.now();
  const res = await renderProject({
    preset: PRESET, aspect: ASPECT, resolution: RESOLUTION,
    files, clips: plan.clips, privacy: [],
  }, OUT, {
    onProgress: (p) => {
      if (Math.round(p.percent) % 25 === 0) {
        process.stdout.write(`  ${Math.round(p.percent)}%\r`);
      }
    },
  });
  if (!res.ok) {
    console.error('\n  render FAILED:\n', res.stderr);
    process.exit(1);
  }
  console.log(`  rendered in ${((Date.now() - t0) / 1000).toFixed(1)}s          `);

  const meta = await probe(OUT);
  const v = (meta.streams || []).find((s) => s.codec_type === 'video');
  const a = (meta.streams || []).find((s) => s.codec_type === 'audio');
  const size = fs.statSync(OUT).size;

  console.log('\n  ffprobe verification');
  console.log(`    container : ${meta.format.format_name}`);
  console.log(`    duration  : ${Number(meta.format.duration).toFixed(2)}s`);
  console.log(`    size      : ${(size / 1024).toFixed(0)} KB`);
  console.log(`    video     : ${v ? `${v.codec_name} ${v.width}x${v.height} ${v.pix_fmt}` : 'MISSING'}`);
  console.log(`    audio     : ${a ? `${a.codec_name} ${a.channels}ch ${a.sample_rate}Hz` : 'MISSING'}`);

  const ok = !!v && !!a && size > 10000;
  console.log(`\n  RESULT: ${ok ? 'PASS' : 'FAIL'}`);
  console.log(`  output: ${OUT}\n`);
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
