/**
 * Verify the local toolchain: FFmpeg + FFprobe present and working.
 * Run with:  npm run check
 */
import { FFMPEG_PATH, FFPROBE_PATH, run } from '../server/ffmpeg.js';

async function main() {
  console.log('AutoCut Studio — environment check\n');
  console.log(`  node        : ${process.version}`);
  console.log(`  ffmpeg path : ${FFMPEG_PATH || 'NOT FOUND'}`);
  console.log(`  ffprobe path: ${FFPROBE_PATH || 'NOT FOUND'}`);

  if (!FFMPEG_PATH || !FFPROBE_PATH) {
    console.log('\n  RESULT: FAIL — one or both binaries are missing.');
    process.exit(1);
  }

  const f = await run(FFMPEG_PATH, ['-hide_banner', '-version'], { timeout: 30000 });
  const fv = /ffmpeg version (\S+)/.exec(f.stdout || '');
  console.log(`  ffmpeg ver  : ${fv ? fv[1] : 'unknown'}`);

  const p = await run(FFPROBE_PATH, ['-hide_banner', '-version'], { timeout: 30000 });
  const pv = /ffprobe version (\S+)/.exec(p.stdout || '');
  console.log(`  ffprobe ver : ${pv ? pv[1] : 'unknown'}`);

  // Check for the filters and encoders the renderer depends on.
  const enc = await run(FFMPEG_PATH, ['-hide_banner', '-encoders'], { timeout: 30000 });
  const hasX264 = /libx264/.test(enc.stdout || '');
  const hasAac = /\baac\b/.test(enc.stdout || '');

  const filt = await run(FFMPEG_PATH, ['-hide_banner', '-filters'], { timeout: 30000 });
  const required = ['xfade', 'acrossfade', 'zoompan', 'silencedetect', 'drawbox', 'boxblur', 'vignette', 'curves', 'colorbalance', 'unsharp', 'atempo', 'apad', 'tpad'];
  const missing = required.filter((n) => !new RegExp(`\\b${n}\\b`).test(filt.stdout || ''));

  console.log(`  libx264    : ${hasX264 ? 'yes' : 'NO'}`);
  console.log(`  aac        : ${hasAac ? 'yes' : 'NO'}`);
  console.log(`  filters    : ${missing.length ? `MISSING -> ${missing.join(', ')}` : 'all present'}`);

  const ok = f.code === 0 && p.code === 0 && hasX264 && hasAac && missing.length === 0;
  console.log(`\n  RESULT: ${ok ? 'PASS' : 'FAIL'}`);
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
