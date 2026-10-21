/**
 * Regression check: `npm run reset` while the server is running.
 *
 * The reset runs in a separate process and deletes the media from disk. The
 * running server must notice the change and drop the clips that pointed at
 * the deleted files — otherwise the next render dies with
 * "Error opening input file".
 *
 * Usage:  node tests/reset-while-running.js [baseUrl]
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { PROJECT_ROOT } from '../server/ffmpeg.js';

const BASE = (process.argv[2] || 'http://127.0.0.1:3210').replace(/\/$/, '');
const SAMPLE_DIR = path.join(PROJECT_ROOT, 'examples');

let failures = 0;
const ok = (label, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ->  ' + detail : ''}`);
  if (!cond) failures += 1;
};

async function j(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body, text };
}

async function main() {
  console.log(`AutoCut Studio — reset-while-running regression (${BASE})\n`);

  // 0. start from a clean project (the reset below is the interesting part)
  const preReset = spawnSync(process.execPath, [path.join(PROJECT_ROOT, 'scripts', 'reset-project.js')], {
    cwd: PROJECT_ROOT, encoding: 'utf8', windowsHide: true,
  });
  ok('clean slate', preReset.status === 0);

  // 1. build a real timeline
  const samples = fs.readdirSync(SAMPLE_DIR).filter((f) => f.endsWith('.mp4')).sort()
    .map((f) => ({ name: f, path: path.join(SAMPLE_DIR, f) }));
  const fd = new FormData();
  for (const s of samples) {
    fd.append('videos', new Blob([fs.readFileSync(s.path)], { type: 'video/mp4' }), s.name);
  }
  const up = await j(`${BASE}/api/upload`, { method: 'POST', body: fd });
  ok('uploads accepted', up.status === 200 && (up.body.results || []).every((r) => r.ok));

  let files = [];
  for (let i = 0; i < 90; i += 1) {
    files = (await j(`${BASE}/api/files`)).body.files || [];
    if (files.length && files.every((f) => !f.analyzing)) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  ok('all files analysed', files.length === samples.length && files.every((f) => f.analysis));

  const auto = await j(`${BASE}/api/auto-edit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ preset: 'cinematic', maxClips: 6 }),
  });
  const clips = (auto.body.timeline || {}).clips || [];
  ok('timeline built', clips.length > 0, `${clips.length} clips`);

  // 2. reset from a SEPARATE process, exactly like `npm run reset` does
  const reset = spawnSync(process.execPath, [path.join(PROJECT_ROOT, 'scripts', 'reset-project.js')], {
    cwd: PROJECT_ROOT, encoding: 'utf8', windowsHide: true,
  });
  ok('reset script ran', reset.status === 0, (reset.stdout || '').split('\n')[0]);

  // 3. the server must now see an empty project
  const after = await j(`${BASE}/api/health`);
  ok('server saw the reset', after.body.project.files.length === 0,
    `files=${after.body.project.files.length}`);
  ok('dangling clips were dropped', after.body.project.clips.length === 0,
    `clips=${after.body.project.clips.length}`);

  // 4. and the endpoints must fail cleanly rather than with a raw FFmpeg error
  const exp = await j(`${BASE}/api/export`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ draft: true }),
  });
  ok('export refuses an empty timeline with a clear message',
    exp.status === 400 && /Timeline is empty/.test(exp.body.error || ''),
    `status=${exp.status} error="${exp.body.error || ''}"`);

  const prev = await j(`${BASE}/api/preview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ draft: true }),
  });
  ok('preview refuses an empty timeline with a clear message',
    prev.status === 400 && /Timeline is empty/.test(prev.body.error || ''),
    `status=${prev.status} error="${prev.body.error || ''}"`);

  console.log(`\n  ${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
