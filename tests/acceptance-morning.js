/**
 * Final acceptance rehearsal.
 *
 * Drives the ALREADY RUNNING app (started via Start-AutoCut.cmd) through
 * every step the user will perform in the morning, against a clean state:
 *
 *   STEP 1  the app is up
 *   STEP 2  import 3 videos
 *   STEP 3  pick a style
 *   STEP 4  auto edit
 *   STEP 5  draft preview
 *   STEP 6  privacy redaction
 *   STEP 7  export
 *   STEP 8  verify the exported MP4 with ffprobe + full decode + HTTP download
 *
 * Usage:  node tests/acceptance-morning.js [baseUrl]
 *         (defaults to http://127.0.0.1:3210)
 */
import fs from 'node:fs';
import path from 'node:path';

import { PROJECT_ROOT, FFMPEG_PATH, FFPROBE_PATH, run } from '../server/ffmpeg.js';

const BASE = (process.argv[2] || process.env.ACCEPT_BASE || 'http://127.0.0.1:3210').replace(/\/$/, '');
const SAMPLE_DIR = path.join(PROJECT_ROOT, 'examples');

let failures = 0;
function step(label, detail) {
  console.log(`  ${label}${detail ? '  ->  ' + detail : ''}`);
}
function fail(msg) {
  failures += 1;
  console.log(`  FAIL  ${msg}`);
}

async function j(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body, text, headers: res.headers };
}

function multipart(files) {
  const form = new FormData();
  for (const f of files) {
    // The server's multer middleware expects the field name to be "videos".
    form.append('videos', new Blob([fs.readFileSync(f.path)], { type: 'video/mp4' }), f.name);
  }
  return form;
}

async function poll(url, { timeoutMs = 300000, label = 'job' } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await j(url);
    const job = r.body?.job;
    if (job && (job.status === 'done' || job.status === 'failed')) return job;
    await new Promise((res) => setTimeout(res, 700));
  }
  fail(`${label} did not finish within ${timeoutMs / 1000}s`);
  return null;
}

async function main() {
  console.log(`AutoCut Studio — final acceptance rehearsal against ${BASE}\n`);

  // ---------------------------------------------------------------- STEP 1
  console.log('STEP 1: app is up');
  const health = await j(`${BASE}/api/health`);
  if (health.status !== 200) { fail(`health returned ${health.status}`); process.exit(1); }
  const h = health.body;
  step('server up', `ffmpeg=${h.ffmpeg} (${h.ffmpegVersion}) presets=${h.presets?.length} files=${h.project?.files?.length}`);
  if (!h.ffmpeg) fail('ffmpeg not reported as available');
  if (!h.ffprobe) fail('ffprobe not reported as available');
  if (!h.presets?.length) fail('no presets exposed');
  if (h.project?.files?.length !== 0) fail(`expected a clean state, found ${h.project.files.length} file(s)`);

  // ---------------------------------------------------------------- STEP 2
  console.log('\nSTEP 2: import 3 videos');
  const samples = fs.readdirSync(SAMPLE_DIR).filter((f) => f.endsWith('.mp4')).sort()
    .map((f) => ({ name: f, path: path.join(SAMPLE_DIR, f) }));
  const up = await j(`${BASE}/api/upload`, { method: 'POST', body: multipart(samples) });
  if (up.status !== 200) { fail(`upload returned ${up.status}: ${up.text.slice(0, 200)}`); process.exit(1); }
  const results = up.body.results || [];
  for (const r of results) step('uploaded', `${r.name}: ok=${r.ok} ${r.meta ? `${r.meta.width}x${r.meta.height}` : r.error || ''}`);
  if (results.length !== samples.length) fail(`expected ${samples.length} uploads, got ${results.length}`);
  if (results.some((r) => !r.ok)) fail('at least one upload was rejected');

  // wait for background analysis to finish
  let files = [];
  for (let i = 0; i < 90; i += 1) {
    const st = await j(`${BASE}/api/files`);
    files = st.body.files || [];
    if (files.length && files.every((f) => !f.analyzing)) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  for (const f of files) {
    const sc = f.analysis?.scenes?.length ?? 0;
    const si = f.analysis?.silences?.length ?? 0;
    step('analysis done', `${f.name}: ${sc}sc/${si}sil`);
  }
  if (files.length !== samples.length) fail(`expected ${samples.length} analysed files, got ${files.length}`);
  if (files.some((f) => !f.analysis)) fail('at least one file was not analysed');

  // ---------------------------------------------------------------- STEP 3
  console.log('\nSTEP 3: pick a style (cinematic)');
  const presetIds = (h.presets || []).map((p) => p.id);
  step('preset set', presetIds.join(', '));
  if (!presetIds.includes('cinematic')) fail('cinematic preset missing');
  const proj = await j(`${BASE}/api/project`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ preset: 'cinematic', aspect: '9:16', resolution: '1080' }),
  });
  step('project updated', `status=${proj.status} preset=${proj.body?.project?.preset}`);
  if (proj.body?.project?.preset !== 'cinematic') fail('preset not applied');

  // ---------------------------------------------------------------- STEP 4
  console.log('\nSTEP 4: auto edit');
  const auto = await j(`${BASE}/api/auto-edit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ preset: 'cinematic', aspect: '9:16', resolution: '1080', order: 'chronological', maxClips: 8 }),
  });
  if (auto.status !== 200) { fail(`auto-edit returned ${auto.status}: ${auto.text.slice(0, 200)}`); process.exit(1); }
  const timeline = auto.body.timeline || {};
  const clips = timeline.clips || [];
  const sources = new Set(clips.map((c) => c.fileName));
  step('timeline', `${clips.length} clips / ${sources.size} sources / ${(timeline.totalDuration || 0).toFixed(0)}s`);
  if (!clips.length) fail('auto edit produced no clips');
  if (sources.size < 2) fail(`expected clips from multiple sources, got ${sources.size}`);
  if (clips.some((c) => !(c.end > c.start))) fail('a clip has a non-positive duration');

  // ---------------------------------------------------------------- STEP 5
  console.log('\nSTEP 5: draft preview');
  const prev = await j(`${BASE}/api/preview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ draft: true }),
  });
  if (prev.status !== 200) { fail(`preview returned ${prev.status}: ${prev.text.slice(0, 200)}`); process.exit(1); }
  const pv = await poll(`${BASE}/api/preview/${prev.body.jobId}`, { label: 'preview' });
  if (pv) {
    step('preview', `${pv.status} ${pv.width}x${pv.height} ${Math.round((pv.size || 0) / 1024)}KB`);
    if (pv.status !== 'done') fail(`preview failed: ${pv.error || 'unknown error'}`);
    const pvGet = await fetch(`${BASE}${pv.output}`);
    step('preview served', `HTTP ${pvGet.status} ${pvGet.headers.get('content-type')}`);
    if (pvGet.status !== 200) fail('preview not playable');
  }

  // ---------------------------------------------------------------- STEP 6
  console.log('\nSTEP 6: privacy redaction (blur)');
  const priv = await j(`${BASE}/api/privacy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ regions: [{ x: 0.3, y: 0.35, w: 0.4, h: 0.2, mode: 'blur', color: '#000000' }] }),
  });
  const regions = priv.body.privacy || [];
  step('regions stored', `${regions.length} (mode=${regions[0]?.mode})`);
  if (regions.length !== 1) fail(`expected 1 privacy region, got ${regions.length}`);

  // ---------------------------------------------------------------- STEP 7
  console.log('\nSTEP 7: export');
  const exp = await j(`${BASE}/api/export`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ preset: 'cinematic', aspect: '9:16', resolution: '1080', draft: false }),
  });
  if (exp.status !== 200) { fail(`export returned ${exp.status}: ${exp.text.slice(0, 200)}`); process.exit(1); }
  const e = await poll(`${BASE}/api/export/${exp.body.jobId}`, { label: 'export' });
  if (!e) process.exit(1);
  step('export', `status=${e.status} ${e.width}x${e.height} ${e.duration}s ${Math.round((e.size || 0) / 1024)}KB`);
  if (e.status !== 'done') { fail(`export failed: ${e.error || 'unknown error'}`); process.exit(1); }
  step('file', e.fileName);

  // ---------------------------------------------------------------- STEP 8
  console.log('\nSTEP 8: verify the exported MP4');
  const expPath = path.join(PROJECT_ROOT, 'exports', e.fileName);
  if (!fs.existsSync(expPath)) { fail(`export file not on disk: ${expPath}`); }
  else {
    const probe = await run(FFPROBE_PATH, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', expPath]);
    if (probe.failed) fail(`ffprobe failed: ${probe.stderr.slice(0, 200)}`);
    else {
      const meta = JSON.parse(probe.stdout);
      const v = (meta.streams || []).find((s) => s.codec_type === 'video');
      const a = (meta.streams || []).find((s) => s.codec_type === 'audio');
      console.log(`    codec_name=${v?.codec_name}      codec_type=video`);
      console.log(`    width=${v?.width}           height=${v?.height}`);
      console.log(`    pix_fmt=${v?.pix_fmt}`);
      console.log(`    codec_name=${a?.codec_name}       codec_type=audio`);
      console.log(`    sample_rate=${a?.sample_rate}    channels=${a?.channels}`);
      console.log(`    format_name=${meta.format?.format_name}`);
      console.log(`    duration=${Number(meta.format?.duration).toFixed(6)}   size=${fs.statSync(expPath).size}`);
      if (v?.codec_name !== 'h264') fail('video codec is not h264');
      if (v?.width !== 1080 || v?.height !== 1920) fail(`unexpected geometry ${v?.width}x${v?.height}`);
      if (v?.pix_fmt !== 'yuv420p') fail(`unexpected pixel format ${v?.pix_fmt}`);
      if (!a) fail('no audio stream');
    }
    const dec = await run(FFMPEG_PATH, ['-v', 'error', '-i', expPath, '-f', 'null', '-']);
    const derr = (dec.stderr || '').trim();
    if (dec.failed || derr) fail(`full decode reported errors: ${derr.slice(0, 300)}`);
    else step('full decode', 'PASS (zero errors)');
  }
  const dl = await fetch(`${BASE}/exports/${encodeURIComponent(e.fileName)}`);
  const dlBuf = Buffer.from(await dl.arrayBuffer());
  step('download check', `HTTP ${dl.status}, ${dlBuf.length} bytes, ${dl.headers.get('content-type')}`);
  if (dl.status !== 200) fail(`download returned ${dl.status}`);
  if (dlBuf.subarray(4, 8).toString() !== 'ftyp') fail('downloaded file is not a valid MP4 container');

  console.log('\n==============================================================');
  console.log(failures === 0
    ? '  ACCEPTANCE PASSED — import -> style -> auto edit -> preview -> export -> verify'
    : `  ACCEPTANCE FAILED — ${failures} problem(s)`);
  console.log('==============================================================');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
