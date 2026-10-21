/**
 * Provision the local FFmpeg / FFprobe binaries into ./vendor.
 *
 * The binaries come from the `eugeneware/ffmpeg-static` GitHub release (the
 * same source the npm package `ffmpeg-static` uses) and the bundled
 * `ffprobe-static` package. Nothing is installed system-wide and nothing is
 * uploaded anywhere.
 *
 * Run:  npm run setup:ffmpeg
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const VENDOR = path.join(PROJECT_ROOT, 'vendor');

const FFMPEG_STATIC_PKG = path.join(PROJECT_ROOT, 'node_modules', 'ffmpeg-static', 'package.json');
const FFPROBE_PKG = path.join(PROJECT_ROOT, 'node_modules', 'ffprobe-static', 'package.json');

function platformTarget() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  switch (process.platform) {
    case 'win32': return { platform: 'win32', arch, exe: '.exe' };
    case 'darwin': return { platform: 'darwin', arch, exe: '' };
    case 'linux': return { platform: 'linux', arch, exe: '' };
    default: return null;
  }
}

async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fsp.writeFile(dest, buf);
  return buf.length;
}

async function gunzip(src, dest) {
  await pipeline(
    fs.createReadStream(src),
    zlib.createGunzip(),
    fs.createWriteStream(dest),
  );
  if (process.platform !== 'win32') {
    await fsp.chmod(dest, 0o755);
  }
}

async function main() {
  const target = platformTarget();
  if (!target) {
    console.error(`Unsupported platform: ${process.platform}`);
    process.exit(1);
  }
  fs.mkdirSync(VENDOR, { recursive: true });

  const ffmpegDest = path.join(VENDOR, `ffmpeg${target.exe}`);
  const ffprobeDest = path.join(VENDOR, `ffprobe${target.exe}`);

  // ---- ffmpeg ----
  if (fs.existsSync(ffmpegDest) && fs.statSync(ffmpegDest).size > 1_000_000) {
    console.log(`  ffmpeg   already present: ${ffmpegDest}`);
  } else {
    let tag = 'b6.1.1';
    let base = 'https://github.com/eugeneware/ffmpeg-static/releases/download';
    if (fs.existsSync(FFMPEG_STATIC_PKG)) {
      const pkg = JSON.parse(fs.readFileSync(FFMPEG_STATIC_PKG, 'utf8'));
      const cfg = pkg['ffmpeg-static'] || {};
      tag = cfg['binary-release-tag'] || tag;
      base = cfg['binaries-url'] || base;
    }
    const url = `${base}/${tag}/ffmpeg-${target.platform}-${target.arch}.gz`;
    const gz = path.join(VENDOR, `ffmpeg-${target.platform}-${target.arch}.gz`);
    console.log(`  downloading ffmpeg from ${url}`);
    const bytes = await download(url, gz);
    console.log(`  downloaded ${(bytes / 1024 / 1024).toFixed(1)} MB, decompressing...`);
    await gunzip(gz, ffmpegDest);
    await fsp.unlink(gz).catch(() => {});
    console.log(`  ffmpeg   -> ${ffmpegDest}`);
  }

  // ---- ffprobe ----
  if (fs.existsSync(ffprobeDest) && fs.statSync(ffprobeDest).size > 1_000_000) {
    console.log(`  ffprobe  already present: ${ffprobeDest}`);
  } else {
    const candidates = [
      path.join(PROJECT_ROOT, 'node_modules', 'ffprobe-static', 'bin', target.platform, target.arch, `ffprobe${target.exe}`),
      path.join(PROJECT_ROOT, 'node_modules', 'ffprobe-static', 'bin', 'win32', 'x64', 'ffprobe.exe'),
    ];
    const found = candidates.find((c) => fs.existsSync(c));
    if (found) {
      await fsp.copyFile(found, ffprobeDest);
      console.log(`  ffprobe  -> ${ffprobeDest} (copied from ${found})`);
    } else {
      console.error('  ffprobe binary not found in node_modules/ffprobe-static.');
      console.error('  Run "npm install --ignore-scripts" first, then retry.');
      process.exit(1);
    }
  }

  // ---- verify ----
  const check = (bin) => new Promise((resolve) => {
    const child = spawn(bin, ['-hide_banner', '-version'], { windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.on('error', () => resolve(null));
    child.on('close', () => resolve(out));
  });

  const fv = await check(ffmpegDest);
  const pv = await check(ffprobeDest);
  const fMatch = fv && /ffmpeg version (\S+)/.exec(fv);
  const pMatch = pv && /ffprobe version (\S+)/.exec(pv);
  console.log('');
  console.log(`  ffmpeg  : ${fMatch ? fMatch[1] : 'FAILED TO RUN'}`);
  console.log(`  ffprobe : ${pMatch ? pMatch[1] : 'FAILED TO RUN'}`);
  if (!fMatch || !pMatch) process.exit(1);
  console.log('\n  Setup complete.\n');
}

main().catch((err) => {
  console.error('\n  Setup failed:', err.message);
  process.exit(1);
});
