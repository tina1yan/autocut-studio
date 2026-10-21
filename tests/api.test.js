/**
 * API integration test: boots the real server on a test port and drives the
 * full user flow — health -> upload -> analyze -> auto-edit -> export -> verify.
 *
 * Run:  node tests/api.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const PORT = 3299;
const BASE = `http://127.0.0.1:${PORT}`;
const SAMPLE_DIR = path.join(PROJECT_ROOT, 'examples');
// Use an isolated state directory so a test run never overwrites the real
// project the user is working on.
const TEST_STATE_DIR = path.join(PROJECT_ROOT, 'server', 'state', 'test-run');

let serverProc = null;

function waitForServer(timeoutMs = 30000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const r = await fetch(`${BASE}/api/health`);
        if (r.ok) { resolve(); return; }
      } catch { /* not up yet */ }
      if (Date.now() - start > timeoutMs) { reject(new Error('server did not start')); return; }
      setTimeout(tick, 350);
    };
    tick();
  });
}

const json = async (url, opts = {}) => {
  const r = await fetch(url, opts);
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`non-JSON response from ${url}: ${text.slice(0, 200)}`); }
  return { status: r.status, data };
};

test.before(async () => {
  fs.rmSync(TEST_STATE_DIR, { recursive: true, force: true });
  serverProc = spawn(process.execPath, [path.join(PROJECT_ROOT, 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), AUTOCUT_STATE_DIR: TEST_STATE_DIR },
    cwd: PROJECT_ROOT,
    stdio: 'ignore',
    windowsHide: true,
  });
  await waitForServer();
});

test.after(() => {
  if (serverProc) { try { serverProc.kill(); } catch { /* ignore */ } }
});

test('GET /api/health reports ffmpeg availability and presets', async () => {
  const { status, data } = await json(`${BASE}/api/health`);
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.ffmpeg, true, 'ffmpeg should be available');
  assert.equal(data.ffprobe, true, 'ffprobe should be available');
  assert.ok(data.ffmpegVersion, 'ffmpeg version should be reported');
  assert.equal(data.presets.length, 6, 'all six presets should be exposed');
  assert.ok(data.project, 'a project should be returned');
});

test('POST /api/upload accepts a video and returns metadata', async () => {
  const sample = path.join(SAMPLE_DIR, 'sample-portrait.mp4');
  assert.ok(fs.existsSync(sample), 'sample video must exist (npm run make-samples)');
  const buf = fs.readFileSync(sample);
  const fd = new FormData();
  fd.append('videos', new Blob([buf], { type: 'video/mp4' }), 'sample-portrait.mp4');
  const { status, data } = await json(`${BASE}/api/upload`, { method: 'POST', body: fd });
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.results.length, 1);
  assert.equal(data.results[0].ok, true, `upload failed: ${JSON.stringify(data.results[0])}`);
  assert.ok(data.results[0].meta.duration > 0);
  assert.equal(data.results[0].meta.width, 540);
  assert.equal(data.results[0].meta.height, 960);
});

test('POST /api/auto-edit builds a timeline from the uploaded file', async () => {
  // Wait for the background analysis to finish.
  let files = [];
  for (let i = 0; i < 40; i += 1) {
    const res = await json(`${BASE}/api/files`);
    files = res.data.files;
    if (files.length && !files.some((f) => f.analyzing)) break;
    await new Promise((r) => setTimeout(r, 400));
  }
  assert.ok(files.length >= 1, 'at least one file should be uploaded');
  assert.ok(files[0].analysis, 'the file should have been analyzed');
  assert.ok(Array.isArray(files[0].analysis.scenes));
  assert.ok(Array.isArray(files[0].analysis.silences));

  const { status, data } = await json(`${BASE}/api/auto-edit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ preset: 'dramatic', maxClips: 6 }),
  });
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.ok(data.timeline.clips.length > 0, 'a timeline should be produced');
  assert.ok(data.timeline.totalDuration > 0);
  assert.equal(data.project.clips.length, data.timeline.clips.length);
});

test('POST /api/timeline applies manual edits', async () => {
  const { data: before } = await json(`${BASE}/api/health`);
  const clips = before.project.clips.map((c) => ({ ...c }));
  assert.ok(clips.length >= 1);
  // Trim the first clip and drop the last one.
  clips[0].end = Math.min(clips[0].end, clips[0].start + 1.5);
  if (clips.length > 1) clips.pop();

  const { status, data } = await json(`${BASE}/api/timeline`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clips, preset: 'dramatic' }),
  });
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.timeline.clips.length, clips.length);
  assert.ok(data.timeline.clips[0].duration <= 1.5 + 0.001, 'the trim should be applied');
});

test('POST /api/privacy stores redaction regions', async () => {
  const { status, data } = await json(`${BASE}/api/privacy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      regions: [{ id: 'r1', x: 0.1, y: 0.2, w: 0.3, h: 0.25, mode: 'blur' }],
    }),
  });
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.privacy.length, 1);
  assert.equal(data.privacy[0].mode, 'blur');
  assert.ok(data.privacy[0].x >= 0 && data.privacy[0].x <= 1, 'coordinates should be clamped to 0..1');
});

test('POST /api/export produces a real MP4 that ffprobe can read', async () => {
  const { data: start } = await json(`${BASE}/api/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ draft: true }),
  });
  assert.equal(start.ok, true);
  assert.ok(start.jobId, 'a job id should be returned');
  assert.ok(start.output.startsWith('/exports/'));

  // Poll until the job finishes.
  let job = null;
  for (let i = 0; i < 120; i += 1) {
    const res = await json(`${BASE}/api/export/${start.jobId}`);
    job = res.data.job;
    if (job.status !== 'running') break;
    await new Promise((r) => setTimeout(r, 500));
  }
  assert.ok(job, 'a job should be returned');
  assert.equal(job.status, 'done', `export failed: ${job.error}`);
  assert.ok(job.size > 1000, 'the export should not be empty');
  assert.ok(job.duration > 0);

  // The file must exist in exports/ and be servable over HTTP.
  const file = path.join(PROJECT_ROOT, 'exports', job.fileName);
  assert.ok(fs.existsSync(file), 'the exported file should exist on disk');
  assert.ok(fs.statSync(file).size > 1000);

  const head = await fetch(`${BASE}${job.output}`, { method: 'GET' });
  assert.equal(head.status, 200);
  const ct = head.headers.get('content-type') || '';
  assert.ok(ct.includes('video/mp4'), `unexpected content-type: ${ct}`);
});

test('POST /api/preview renders a playable draft of the timeline', async () => {
  const { status, data } = await json(`${BASE}/api/preview`, { method: 'POST' });
  assert.equal(status, 200);
  assert.ok(data.jobId, 'a preview job id should be returned');

  let job = null;
  for (let i = 0; i < 120; i += 1) {
    const res = await json(`${BASE}/api/preview/${data.jobId}`);
    job = res.data.job;
    if (job.status !== 'running') break;
    await new Promise((r) => setTimeout(r, 400));
  }
  assert.equal(job.status, 'done', `preview failed: ${job.error}`);
  assert.ok(job.output.startsWith('/media/work/'), `unexpected preview path: ${job.output}`);
  assert.ok(job.size > 1000, 'the preview should not be empty');

  // It must be servable with range support so <video> can seek.
  const r = await fetch(`${BASE}${job.output}`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('accept-ranges'), 'bytes');
  const ranged = await fetch(`${BASE}${job.output}`, { headers: { Range: 'bytes=0-99' } });
  assert.equal(ranged.status, 206, 'range requests should be honoured');
});

test('GET /api/exports lists the finished export', async () => {
  const { status, data } = await json(`${BASE}/api/exports`);
  assert.equal(status, 200);
  assert.ok(data.exports.length >= 1, 'the export should be listed');
  assert.ok(data.exports[0].fileName.endsWith('.mp4'));
});

test('GET /api/presets exposes every style', async () => {
  const { status, data } = await json(`${BASE}/api/presets`);
  assert.equal(status, 200);
  assert.equal(data.presets.length, 6);
  const ids = data.presets.map((p) => p.id).sort();
  assert.deepEqual(ids, ['cinematic', 'dramatic', 'meme', 'minimal', 'montage', 'travel']);
});

test('a reset performed by another process is picked up by the server', async () => {
  // `npm run reset` runs in its own process and rewrites the state file. The
  // running server must notice and drop the clips that pointed at the media
  // it just deleted — otherwise the next render dies with
  // "Error opening input file".
  const { data: before } = await json(`${BASE}/api/health`);
  assert.ok(before.project.files.length >= 1, 'there should be media to reset');

  const reset = spawnSync(process.execPath, [path.join(PROJECT_ROOT, 'scripts', 'reset-project.js')], {
    env: { ...process.env, AUTOCUT_STATE_DIR: TEST_STATE_DIR },
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(reset.status, 0, `reset failed: ${reset.stderr}`);

  // The next request must see the reset state, not the stale in-memory copy.
  const { data: after } = await json(`${BASE}/api/health`);
  assert.equal(after.project.files.length, 0, 'the server should have reloaded the reset state');
  assert.equal(after.project.clips.length, 0, 'clips pointing at deleted media should be dropped');
});

test('the UI page is served', async () => {
  const r = await fetch(BASE);
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.ok(html.includes('AutoCut Studio'));
  assert.ok(html.includes('dropzone'), 'the dropzone should be present');
  assert.ok(html.includes('privacyMode'), 'privacy controls should be present');
});
