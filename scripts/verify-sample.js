/**
 * Verify the headline deliverable `sample-output.mp4`.
 *
 * Checks, in order:
 *   1. ffprobe  -> container / duration / video codec+geometry / audio codec
 *   2. full decode -> decode every frame to a null sink; any corruption errors out
 *   3. frame count -> decoded frame count must match the container's frame count
 *   4. size      -> the file must be non-trivial
 *
 * Run:  node scripts/verify-sample.js
 * Exit code 0 = PASS, 1 = FAIL.
 */
import fs from 'node:fs';
import path from 'node:path';

import { PROJECT_ROOT, FFMPEG_PATH, FFPROBE_PATH, run } from '../server/ffmpeg.js';

const TARGET = process.env.VERIFY_FILE || path.join(PROJECT_ROOT, 'sample-output.mp4');

function parseProbe(json) {
  const meta = JSON.parse(json);
  const v = (meta.streams || []).find((s) => s.codec_type === 'video');
  const a = (meta.streams || []).find((s) => s.codec_type === 'audio');
  return { format: meta.format || {}, video: v, audio: a };
}

async function main() {
  console.log(`AutoCut Studio — verifying ${path.basename(TARGET)}\n`);

  if (!fs.existsSync(TARGET)) {
    console.error(`  FAIL  file not found: ${TARGET}`);
    console.error('  Run: node scripts/make-sample-output.js');
    process.exit(1);
  }
  const size = fs.statSync(TARGET).size;

  // --- 1. ffprobe -----------------------------------------------------------
  const probe = await run(FFPROBE_PATH, [
    '-v', 'error', '-print_format', 'json',
    '-show_format', '-show_streams', TARGET,
  ]);
  if (probe.failed) {
    console.error(`  FAIL  ffprobe could not read the file:\n${probe.stderr}`);
    process.exit(1);
  }
  const { format, video, audio } = parseProbe(probe.stdout);

  console.log('  ffprobe');
  console.log(`    container : ${format.format_name}`);
  console.log(`    duration  : ${Number(format.duration).toFixed(2)}s`);
  console.log(`    size      : ${(size / 1024).toFixed(0)} KB`);
  console.log(`    video     : ${video ? `${video.codec_name} ${video.width}x${video.height} ${video.pix_fmt}` : 'MISSING'}`);
  console.log(`    audio     : ${audio ? `${audio.codec_name} ${audio.channels}ch ${audio.sample_rate}Hz` : 'MISSING'}`);

  // --- 2. full decode integrity -------------------------------------------
  console.log('\n  full decode integrity check');
  const decode = await run(FFMPEG_PATH, [
    '-v', 'error', '-i', TARGET, '-f', 'null', '-',
  ]);
  const decodeErr = (decode.stderr || '').trim();
  if (decode.failed || decodeErr) {
    console.error(`    FAIL  decoder reported errors:\n${decodeErr}`);
    process.exit(1);
  }
  console.log('    PASS  decoded the entire file with zero errors');

  // --- 3. frame count ------------------------------------------------------
  // ffprobe's `-count_frames` actually decodes every frame and reports how
  // many it read, so it can be compared against the container's frame count.
  const countRun = await run(FFPROBE_PATH, [
    '-v', 'error', '-print_format', 'json',
    '-select_streams', 'v:0', '-count_frames',
    '-show_streams', TARGET,
  ]);
  let readFrames = 0;
  if (!countRun.failed) {
    const vStream = (JSON.parse(countRun.stdout).streams || [])[0] || {};
    readFrames = Number(vStream.nb_read_frames || 0);
  }
  const containerFrames = Number((video && video.nb_frames) || 0);

  console.log('\n  frame count');
  console.log(`    width=${video ? video.width : '?'}`);
  console.log(`    height=${video ? video.height : '?'}`);
  console.log(`    nb_frames=${containerFrames}`);
  console.log(`    nb_read_frames=${readFrames}`);

  // --- 4. verdict -----------------------------------------------------------
  const checks = [
    ['container is mp4-family', /mp4|mov/.test(format.format_name || '')],
    ['has a video stream', !!video],
    ['has an audio stream', !!audio],
    ['video is h264', video && video.codec_name === 'h264'],
    ['pixel format is yuv420p', video && video.pix_fmt === 'yuv420p'],
    ['dimensions are even', video && video.width % 2 === 0 && video.height % 2 === 0],
    ['duration is non-zero', Number(format.duration) > 0],
    ['file is non-trivial', size > 10000],
    ['decoded frames match container', readFrames > 0 && readFrames === containerFrames],
  ];

  console.log('\n  checks');
  let failed = 0;
  for (const [label, ok] of checks) {
    console.log(`    ${ok ? 'PASS' : 'FAIL'}  ${label}`);
    if (!ok) failed += 1;
  }

  const result = failed === 0 ? 'PASS' : 'FAIL';
  console.log(`\n  RESULT: ${result}  (${checks.length - failed}/${checks.length} checks)\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
