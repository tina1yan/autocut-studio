/**
 * FFmpeg / FFprobe binary resolution and process helpers.
 *
 * Resolution order:
 *   1. AUTOCUT_FFMPEG / AUTOCUT_FFPROBE environment variables
 *   2. vendor/ inside the project (downloaded by scripts/setup-ffmpeg.js)
 *   3. node_modules/ffmpeg-static + node_modules/ffprobe-static
 *   4. whatever is on PATH
 */
import { existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(__dirname, '..');

function onPath(name) {
  const exts = (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';');
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function resolveBinary(envVar, name, candidates) {
  const fromEnv = process.env[envVar];
  if (fromEnv && existsSync(fromEnv)) return fromEnv;

  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return onPath(name);
}

export const FFMPEG_PATH = resolveBinary('AUTOCUT_FFMPEG', 'ffmpeg', [
  path.join(PROJECT_ROOT, 'vendor', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'),
  path.join(PROJECT_ROOT, 'node_modules', 'ffmpeg-static', 'ffmpeg'),
  path.join(PROJECT_ROOT, 'node_modules', 'ffmpeg-static', 'ffmpeg.exe'),
]);

export const FFPROBE_PATH = resolveBinary('AUTOCUT_FFPROBE', 'ffprobe', [
  path.join(PROJECT_ROOT, 'vendor', process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'),
  path.join(PROJECT_ROOT, 'node_modules', 'ffprobe-static', 'bin', 'win32', 'x64', 'ffprobe.exe'),
  path.join(PROJECT_ROOT, 'node_modules', 'ffprobe-static', 'bin', 'linux', 'x64', 'ffprobe'),
  path.join(PROJECT_ROOT, 'node_modules', 'ffprobe-static', 'bin', 'darwin', 'x64', 'ffprobe'),
]);

export function binariesAvailable() {
  return { ffmpeg: !!FFMPEG_PATH, ffprobe: !!FFPROBE_PATH };
}

/** Run a binary to completion, capturing stdout/stderr. Never uses a shell. */
export function run(bin, args, { timeout = 600000 } = {}) {
  return new Promise((resolve) => {
    if (!bin) {
      resolve({ code: -1, stdout: '', stderr: 'binary not found', failed: true });
      return;
    }
    let child;
    try {
      child = spawn(bin, args, { windowsHide: true });
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: String(err), failed: true });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timer = null;
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    if (timeout) {
      timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, timeout);
    }
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + String(err), failed: true });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr, failed: code !== 0 });
    });
  });
}

/**
 * Run ffmpeg, streaming `-progress` key=value output so callers can report
 * percentage completion. `onProgress({ percent, outTimeSec, frame })` is called.
 */
export function runFfmpeg(args, { durationSec = 0, onProgress = null, timeout = 1800000 } = {}) {
  return new Promise((resolve) => {
    if (!FFMPEG_PATH) {
      resolve({ code: -1, stdout: '', stderr: 'ffmpeg not found', failed: true });
      return;
    }
    const fullArgs = [
      '-hide_banner',
      '-nostdin',
      '-loglevel', 'error',
      '-progress', 'pipe:1',
      '-nostats',
      ...args,
    ];
    let child;
    try {
      child = spawn(FFMPEG_PATH, fullArgs, { windowsHide: true });
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: String(err), failed: true });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timer = null;
    if (timeout) {
      timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, timeout);
    }
    child.stdout.on('data', (d) => {
      stdout += d.toString();
      if (!onProgress) return;
      // ffmpeg -progress emits blocks of key=value lines ending with "progress=continue|end"
      const lines = stdout.split('\n');
      stdout = lines.pop();
      for (const line of lines) {
        const idx = line.indexOf('=');
        if (idx === -1) continue;
        const key = line.slice(0, idx);
        const value = line.slice(idx + 1).trim();
        if (key === 'out_time_us' || key === 'out_time_ms') {
          const sec = Number(value) / 1000000;
          if (Number.isFinite(sec) && durationSec > 0) {
            const percent = Math.max(0, Math.min(99, (sec / durationSec) * 100));
            onProgress({ percent, outTimeSec: sec });
          }
        }
      }
    });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + String(err), failed: true });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0 && onProgress) onProgress({ percent: 100, outTimeSec: durationSec });
      resolve({ code, stdout, stderr, failed: code !== 0 });
    });
  });
}

export function runSync(bin, args) {
  return spawnSync(bin, args, { encoding: 'utf8', windowsHide: true });
}
