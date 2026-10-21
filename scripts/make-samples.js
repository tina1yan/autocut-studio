/**
 * Generate synthetic sample videos for testing AutoCut Studio.
 *
 * Uses FFmpeg's lavfi virtual sources (testsrc2, color, sine, anullsrc) so no
 * real footage is needed. The clips are designed to exercise the pipeline:
 *   - hard colour changes  -> scene detection
 *   - tone / tone / silence -> silence detection
 *   - mixed aspect ratios  -> 9:16 and 16:9 conversion
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FFMPEG_PATH, PROJECT_ROOT } from '../server/ffmpeg.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(PROJECT_ROOT, 'examples');

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG_PATH, args, { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ ok: true, stderr });
      else reject(new Error(`ffmpeg failed (${code}):\n${stderr.slice(-2500)}`));
    });
  });
}

/**
 * A clip with N visually distinct scenes and an audio track that alternates
 * between a tone and silence.
 */
function buildFilter({ scenes, width, height, fps, tone, silenceEvery }) {
  const parts = [];
  const videoLabels = [];
  const audioLabels = [];

  scenes.forEach((scene, i) => {
    const v = `v${i}`;
    parts.push(
      `color=c=${scene.color}:s=${width}x${height}:r=${fps}:d=${scene.dur}[${v}raw]`,
    );
    // Overlay a moving box so frames differ over time (not just colour).
    parts.push(
      `[${v}raw]drawbox=x='mod(t*${Math.max(40, width / 8)},${width})':y=0:w=${Math.max(12, Math.floor(width / 10))}:h=${height}:color=white@0.85:t=fill[${v}mov]`,
    );
    parts.push(`[${v}mov]format=yuv420p[${v}]`);
    videoLabels.push(`[${v}]`);

    const a = `a${i}`;
    const toneDur = scene.dur / 2;
    const silentDur = scene.dur - toneDur;
    parts.push(`sine=frequency=${tone + i * 220}:duration=${toneDur}:sample_rate=48000[s${i}t]`);
    parts.push(`anullsrc=r=48000:cl=mono:d=${silentDur}[s${i}s]`);
    parts.push(`[s${i}t][s${i}s]concat=n=2:v=0:a=1[${a}]`);
    audioLabels.push(`[${a}]`);
  });

  parts.push(`${videoLabels.join('')}concat=n=${scenes.length}:v=1:a=0[vcat]`);
  parts.push(`${audioLabels.join('')}concat=n=${scenes.length}:v=0:a=1[acat]`);
  return { filter: parts.join(';'), outVideo: 'vcat', outAudio: 'acat' };
}

const SAMPLES = [
  {
    name: 'sample-portrait.mp4',
    width: 540,
    height: 960,
    fps: 30,
    scenes: [
      { color: '0x1b3a5c', dur: 3 },
      { color: '0xc23b22', dur: 3 },
      { color: '0x1f7a3d', dur: 3 },
      { color: '0x8e44ad', dur: 3 },
    ],
    tone: 440,
  },
  {
    name: 'sample-landscape.mp4',
    width: 1280,
    height: 720,
    fps: 30,
    scenes: [
      { color: '0x0e2f4a', dur: 4 },
      { color: '0xd35400', dur: 4 },
      { color: '0x117a65', dur: 4 },
    ],
    tone: 330,
  },
  {
    name: 'sample-quiet.mp4',
    width: 640,
    height: 360,
    fps: 25,
    scenes: [
      { color: '0x2c3e50', dur: 5 },
      { color: '0x7f8c8d', dur: 5 },
    ],
    tone: 220,
  },
];

async function main() {
  if (!FFMPEG_PATH) {
    console.error('FFmpeg binary not found. Run: npm run setup:ffmpeg');
    process.exit(1);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`Using ffmpeg: ${FFMPEG_PATH}\n`);

  for (const s of SAMPLES) {
    const outPath = path.join(OUT_DIR, s.name);
    if (fs.existsSync(outPath)) {
      console.log(`  skip (exists): ${s.name}`);
      continue;
    }
    const { filter, outVideo, outAudio } = buildFilter(s);
    console.log(`  generating: ${s.name} ...`);
    await run([
      '-hide_banner', '-nostdin', '-loglevel', 'error',
      '-filter_complex', filter,
      '-map', `[${outVideo}]`, '-map', `[${outAudio}]`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24',
      '-pix_fmt', 'yuv420p', '-r', String(s.fps),
      '-c:a', 'aac', '-b:a', '128k', '-ar', '48000',
      '-movflags', '+faststart', '-t', String(s.scenes.reduce((a, b) => a + b.dur, 0)),
      '-y', outPath,
    ]);
    const size = fs.statSync(outPath).size;
    console.log(`    done -> ${outPath} (${(size / 1024).toFixed(0)} KB)`);
  }
  console.log('\nAll samples generated.');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
