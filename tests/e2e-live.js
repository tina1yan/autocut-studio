/**
 * Full user-journey test against a live server, exactly as the user will
 * perform it tomorrow morning:
 *
 *   import -> select style -> auto edit -> preview -> export
 *
 * Uses the real HTTP API and the real generated sample videos.
 *
 * Run:  node tests/e2e-live.js [baseUrl]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const SAMPLE_DIR = path.join(PROJECT_ROOT, 'examples');
const BASE = process.argv[2] || 'http://127.0.0.1:3211';
// Isolated state so a test run never overwrites the user's real project.
const TEST_STATE_DIR = path.join(PROJECT_ROOT, 'server', 'state', 'test-run');

let pass = 0;
let fail = 0;
const log = (ok, msg, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}${extra ? `  ${extra}` : ''}`);
  if (ok) pass += 1; else fail += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function j(url, opts = {}) {
  const r = await fetch(url, opts);
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`non-JSON: ${text.slice(0, 200)}`); }
  return { status: r.status, data };
}

async function main() {
  console.log('AutoCut Studio — full user journey (live server)\n');
  console.log(`  server: ${BASE}\n`);

  let serverProc = null;
  const health = await j(`${BASE}/api/health`).catch(() => null);
  if (!health || health.status !== 200) {
    console.log('  (no server running - starting one on port 3299)');
    const PORT = '3299';
    fs.rmSync(TEST_STATE_DIR, { recursive: true, force: true });
    serverProc = spawn(process.execPath, [path.join(PROJECT_ROOT, 'server', 'index.js')], {
      env: { ...process.env, PORT, AUTOCUT_STATE_DIR: TEST_STATE_DIR },
      cwd: PROJECT_ROOT, stdio: 'ignore', windowsHide: true,
    });
    // wait for it
    for (let i = 0; i < 60; i += 1) {
      const ok = await j(`http://127.0.0.1:${PORT}/api/health`).catch(() => null);
      if (ok && ok.status === 200) { break; }
      await sleep(300);
    }
    process.env.E2E_BASE = `http://127.0.0.1:${PORT}`;
  }
  const base = process.env.E2E_BASE || BASE;

  // ---- step 0: reset to a clean state ----
  const reset = await j(`${base}/api/reset`, { method: 'POST' });
  log(reset.status === 200, 'reset project to a clean state');

  // ---- step 1: import ----
  const samples = fs.readdirSync(SAMPLE_DIR).filter((f) => f.endsWith('.mp4')).sort();
  if (!samples.length) {
    console.error('  No samples. Run: npm run make-samples');
    process.exit(1);
  }
  const fd = new FormData();
  for (const s of samples) {
    const buf = fs.readFileSync(path.join(SAMPLE_DIR, s));
    fd.append('videos', new Blob([buf], { type: 'video/mp4' }), s);
  }
  const up = await j(`${base}/api/upload`, { method: 'POST', body: fd });
  const okCount = (up.data.results || []).filter((r) => r.ok).length;
  log(up.status === 200 && okCount === samples.length,
    'import multiple videos by drag-and-drop upload',
    `${okCount}/${samples.length} accepted`);

  // ---- wait for analysis ----
  let files = [];
  for (let i = 0; i < 60; i += 1) {
    const res = await j(`${base}/api/files`);
    files = res.data.files;
    if (files.length && !files.some((f) => f.analyzing)) break;
    await sleep(500);
  }
  const scenes = files.reduce((a, f) => a + (f.analysis?.scenes?.length || 0), 0);
  const silences = files.reduce((a, f) => a + (f.analysis?.silences?.length || 0), 0);
  log(files.length === samples.length, 'all imported files are present', `${files.length} files`);
  log(scenes > 0, 'automatic scene detection ran', `${scenes} scene cuts`);
  log(silences > 0, 'automatic silence detection ran', `${silences} silent regions`);

  // ---- step 2: select a style ----
  const style = await j(`${base}/api/project`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ preset: 'cinematic', aspect: '9:16', resolution: '1080' }),
  });
  log(style.status === 200 && style.data.project.preset === 'cinematic',
    'select editing style + output aspect', 'cinematic / 9:16');

  // ---- step 3: auto edit ----
  const auto = await j(`${base}/api/auto-edit`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ preset: 'cinematic', maxClips: 10 }),
  });
  const clips = auto.data.timeline?.clips || [];
  log(auto.status === 200 && clips.length > 0,
    'auto edit produces a timeline', `${clips.length} clips, ${auto.data.timeline?.totalDuration?.toFixed(2)}s`);
  const fromMultiple = new Set(clips.map((c) => c.fileId)).size > 1;
  log(fromMultiple, 'timeline combines multiple source videos', `${new Set(clips.map((c) => c.fileId)).size} sources`);
  log(clips.every((c) => c.end > c.start), 'every clip has a valid in/out range');

  // ---- step 4: manual editing controls ----
  const trimmed = clips.map((c) => ({ ...c }));
  trimmed[0].end = trimmed[0].start + 1.2;
  const edit = await j(`${base}/api/timeline`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clips: trimmed, preset: 'cinematic' }),
  });
  log(edit.status === 200 && Math.abs(edit.data.timeline.clips[0].duration - 1.2) < 0.05,
    'manual trim of a clip is applied', `duration=${edit.data.timeline.clips[0].duration}s`);

  // ---- step 5: privacy region ----
  const priv = await j(`${base}/api/privacy`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ regions: [{ id: 'r1', x: 0.3, y: 0.4, w: 0.35, h: 0.2, mode: 'blur' }] }),
  });
  log(priv.status === 200 && priv.data.privacy.length === 1, 'privacy redaction region is stored');

  // ---- step 6: preview ----
  const pv = await j(`${base}/api/preview`, { method: 'POST' });
  let pjob = null;
  for (let i = 0; i < 150; i += 1) {
    const r = await j(`${base}/api/preview/${pv.data.jobId}`);
    pjob = r.data.job;
    if (pjob.status !== 'running') break;
    await sleep(400);
  }
  log(pjob.status === 'done', 'preview renders and is playable', pjob.error || `${pjob.width}x${pjob.height} ${pjob.size} bytes`);
  if (pjob.status === 'done') {
    const head = await fetch(`${base}${pjob.output}`);
    const ct = head.headers.get('content-type') || '';
    log(head.status === 200 && ct.includes('video/mp4'), 'preview is served as video/mp4', ct);
  }

  // ---- step 7: export ----
  const ex = await j(`${base}/api/export`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ draft: false }),
  });
  let ejob = null;
  for (let i = 0; i < 400; i += 1) {
    const r = await j(`${base}/api/export/${ex.data.jobId}`);
    ejob = r.data.job;
    if (ejob.status !== 'running') break;
    await sleep(500);
  }
  log(ejob.status === 'done', 'export completes', ejob.error || `${ejob.width}x${ejob.height} ${ejob.duration?.toFixed(2)}s ${(ejob.size/1024).toFixed(0)}KB`);

  if (ejob.status === 'done') {
    const file = path.join(PROJECT_ROOT, 'exports', ejob.fileName);
    log(fs.existsSync(file) && fs.statSync(file).size > 10000,
      'exported file exists on disk', `${(fs.statSync(file).size/1024).toFixed(0)}KB`);
    const dl = await fetch(`${base}${ejob.output}`);
    const buf = Buffer.from(await dl.arrayBuffer());
    log(dl.status === 200 && buf.length > 10000, 'exported file downloads over HTTP', `${(buf.length/1024).toFixed(0)}KB`);
    // An MP4 must start with an ftyp box.
    log(buf.slice(4, 8).toString() === 'ftyp', 'downloaded file is a valid MP4 container',
      `magic="${buf.slice(4,8).toString()}"`);
  }

  // ---- step 8: exports list ----
  const list = await j(`${base}/api/exports`);
  log(list.data.exports.length >= 1, 'export appears in the download list', `${list.data.exports.length} entries`);

  console.log(`\n${'='.repeat(62)}`);
  console.log(`  ${pass}/${pass + fail} checks passed`);
  if (fail) { console.log(`  ${fail} FAILED`); console.log('='.repeat(62)); process.exit(1); }
  console.log('  FULL USER JOURNEY PASSED');
  console.log('='.repeat(62));

  if (serverProc) { try { serverProc.kill(); } catch { /* ignore */ } }
  process.exit(0);
}

main().catch((err) => {
  console.error('\nE2E crashed:', err);
  process.exit(1);
});
