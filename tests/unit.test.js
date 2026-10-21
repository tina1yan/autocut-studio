/**
 * Unit tests for the pure-logic modules (no FFmpeg required).
 * Run:  npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { subtractSilences, candidateSegments, scoreSegment, planTimeline, retimeTimeline } from '../server/lib/planner.js';
import { getPreset, PRESET_IDS, PRESETS } from '../server/lib/presets.js';
import { clipSpeed, buildRenderPlan, ASPECTS } from '../server/lib/render.js';

/* ---------------------------------------------------------- silences -- */
test('subtractSilences removes a silent window inside a range', () => {
  const segs = subtractSilences(0, 10, [{ start: 4, end: 6 }]);
  assert.equal(segs.length, 2);
  assert.deepEqual(segs[0], [0, 4]);
  assert.deepEqual(segs[1], [6, 10]);
});

test('subtractSilences ignores silence outside the range', () => {
  const segs = subtractSilences(5, 10, [{ start: 0, end: 4 }]);
  assert.equal(segs.length, 1);
  assert.deepEqual(segs[0], [5, 10]);
});

test('subtractSilences handles a fully silent range', () => {
  const segs = subtractSilences(2, 4, [{ start: 0, end: 10 }]);
  assert.equal(segs.length, 0);
});

test('subtractSilences handles overlapping silences', () => {
  const segs = subtractSilences(0, 10, [
    { start: 2, end: 5 },
    { start: 4, end: 7 },
  ]);
  assert.equal(segs.length, 2);
  assert.deepEqual(segs[0], [0, 2]);
  assert.deepEqual(segs[1], [7, 10]);
});

test('subtractSilences with no silences returns the original range', () => {
  const segs = subtractSilences(1, 3, []);
  assert.deepEqual(segs, [[1, 3]]);
});

/* --------------------------------------------------------- segments --- */
const fakeFile = (over = {}) => ({
  id: over.id || 'f1',
  name: over.name || 'clip.mp4',
  meta: { duration: over.duration || 20, width: 1920, height: 1080, hasAudio: true },
  scenes: over.scenes || [],
  silences: over.silences || [],
  loudness: over.loudness ?? -20,
});

test('candidateSegments splits on detected scene cuts', () => {
  const preset = getPreset('minimal');
  const f = fakeFile({ scenes: [{ time: 5 }, { time: 10 }] });
  const segs = candidateSegments(f, preset);
  // Scenes at 0-5 and 5-10 are kept whole; the 10-20 tail exceeds the preset
  // maxClip (6s) and is subdivided, so it yields more than one segment.
  assert.equal(segs.length, 5);
  assert.ok(Math.abs(segs[0].start - 0) < 0.01);
  assert.ok(Math.abs(segs[1].start - 5) < 0.01);
  assert.ok(Math.abs(segs[2].start - 10) < 0.01);
  assert.ok(Math.abs(segs[segs.length - 1].end - 20) < 0.01);
});

test('candidateSegments keeps a scene whole when it fits the preset bounds', () => {
  const preset = getPreset('minimal'); // minClip 2.5, maxClip 6.0
  const f = fakeFile({ duration: 20, scenes: [{ time: 5 }] });
  const segs = candidateSegments(f, preset);
  // 0-5 and 5-20; the 15s tail exceeds maxClip so it splits.
  assert.ok(Math.abs(segs[0].start - 0) < 0.01);
  assert.ok(Math.abs(segs[0].end - 5) < 0.01);
  assert.ok(Math.abs(segs[1].start - 5) < 0.01);
  assert.ok(segs.length >= 2);
});

test('candidateSegments subdivides scenes longer than the preset max', () => {
  const preset = getPreset('montage'); // maxClip 2.0
  const f = fakeFile({ duration: 10, scenes: [] });
  const segs = candidateSegments(f, preset);
  assert.ok(segs.length >= 5, `expected >=5 segments, got ${segs.length}`);
  for (const s of segs) {
    assert.ok(s.end - s.start <= preset.maxClip + 0.001, 'segment exceeds maxClip');
  }
});

test('candidateSegments applies silence removal', () => {
  const preset = getPreset('minimal');
  const f = fakeFile({ duration: 20, scenes: [{ time: 10 }], silences: [{ start: 2, end: 4 }] });
  const segs = candidateSegments(f, preset);
  // The silent window 2-4 should not be fully present as a kept segment.
  const coversSilent = segs.some((s) => s.start <= 2.01 && s.end >= 3.99);
  assert.equal(coversSilent, false, 'a fully-silent region was kept intact');
});

test('candidateSegments never exceeds the source duration', () => {
  const preset = getPreset('cinematic');
  const f = fakeFile({ duration: 3, scenes: [] });
  const segs = candidateSegments(f, preset);
  for (const s of segs) {
    assert.ok(s.end <= 3.001, `segment end ${s.end} exceeds duration 3`);
  }
});

/* ----------------------------------------------------------- scoring -- */
test('scoreSegment rewards longer and speech-bearing segments', () => {
  const preset = getPreset('minimal');
  const f = fakeFile({ duration: 20, scenes: [], silences: [{ start: 0, end: 5 }] });
  const quiet = scoreSegment({ start: 0, end: 5 }, f, preset);
  const loud = scoreSegment({ start: 5, end: 10 }, f, preset);
  assert.ok(loud > quiet, 'a non-silent segment should outscore a silent one');
});

test('scoreSegment is never negative', () => {
  const preset = getPreset('minimal');
  const f = fakeFile({ duration: 20, silences: [{ start: 0, end: 10 }] });
  assert.ok(scoreSegment({ start: 0, end: 10 }, f, preset) >= 0);
});

/* ---------------------------------------------------------- planning -- */
test('planTimeline produces clips ordered by import order in chronological mode', () => {
  const analyses = [
    fakeFile({ id: 'a', name: 'a.mp4', duration: 20, scenes: [{ time: 5 }, { time: 10 }] }),
    fakeFile({ id: 'b', name: 'b.mp4', duration: 20, scenes: [{ time: 5 }, { time: 10 }] }),
  ];
  const plan = planTimeline(analyses, 'minimal', { order: 'chronological', maxClips: 8 });
  assert.ok(plan.clips.length > 0);
  const firstA = plan.clips.findIndex((c) => c.fileId === 'a');
  const firstB = plan.clips.findIndex((c) => c.fileId === 'b');
  assert.ok(firstA >= 0 && firstB >= 0, 'both files should be represented');
  assert.ok(firstA < firstB, 'file a should come before file b');
});

test('planTimeline respects the maxClips budget', () => {
  const analyses = [
    fakeFile({ id: 'a', duration: 60, scenes: [{ time: 5 }, { time: 10 }, { time: 15 }, { time: 20 }] }),
    fakeFile({ id: 'b', duration: 60, scenes: [{ time: 5 }, { time: 10 }, { time: 15 }, { time: 20 }] }),
  ];
  const plan = planTimeline(analyses, 'montage', { maxClips: 5 });
  assert.ok(plan.clips.length <= 5, `expected <=5 clips, got ${plan.clips.length}`);
});

test('planTimeline only the first clip has a null transition', () => {
  const analyses = [fakeFile({ id: 'a', duration: 30, scenes: [{ time: 5 }, { time: 10 }] })];
  const plan = planTimeline(analyses, 'dramatic', { maxClips: 5 });
  assert.equal(plan.clips[0].transition, null);
  for (let i = 1; i < plan.clips.length; i += 1) {
    assert.ok(plan.clips[i].transition, `clip ${i} should have a transition`);
  }
});

test('planTimeline falls back to a single clip per file when there are no scenes', () => {
  const analyses = [fakeFile({ id: 'a', duration: 30, scenes: [] })];
  const plan = planTimeline(analyses, 'minimal', { maxClips: 5 });
  assert.ok(plan.clips.length >= 1);
  assert.ok(plan.clips[0].end > plan.clips[0].start);
});

test('planTimeline returns a valid total duration', () => {
  const analyses = [fakeFile({ id: 'a', duration: 30, scenes: [{ time: 10 }] })];
  const plan = planTimeline(analyses, 'cinematic', { maxClips: 6 });
  const sum = plan.clips.reduce((a, c) => a + c.duration, 0);
  assert.ok(Math.abs(sum - plan.totalDuration) < 0.05);
});

/* --------------------------------------------------------- retiming --- */
test('retimeTimeline recomputes durations and totals', () => {
  const clips = [
    { id: 'c1', fileId: 'a', fileName: 'a.mp4', start: 0, end: 4, duration: 4, transition: null },
    { id: 'c2', fileId: 'a', fileName: 'a.mp4', start: 4, end: 9, duration: 5, transition: { type: 'fade', duration: 0.5 } },
  ];
  const t = retimeTimeline(clips, 'minimal');
  assert.equal(t.clips[0].transition, null);
  assert.ok(Math.abs(t.totalDuration - 9) < 0.001);
  assert.equal(t.clips[1].duration, 5);
});

test('retimeTimeline guarantees the first clip has no transition', () => {
  const clips = [{ id: 'c1', fileId: 'a', start: 0, end: 3, transition: { type: 'fade', duration: 1 } }];
  const t = retimeTimeline(clips, 'minimal');
  assert.equal(t.clips[0].transition, null);
});

/* ---------------------------------------------------------- presets --- */
test('all six presets exist and are well formed', () => {
  assert.equal(PRESET_IDS.length, 6);
  for (const id of PRESET_IDS) {
    const p = PRESETS[id];
    assert.ok(p.name && p.nameEn, `${id} needs a name`);
    assert.ok(p.description, `${id} needs a description`);
    assert.ok(p.grade, `${id} needs a colour grade`);
    assert.ok(p.transition && p.transition.type, `${id} needs a transition`);
    assert.ok(p.minClip > 0 && p.maxClip >= p.minClip, `${id} has invalid clip bounds`);
  }
});

test('presets differ from each other in grade and transition', () => {
  const grades = new Set(PRESET_IDS.map((id) => PRESETS[id].grade));
  const transitions = new Set(PRESET_IDS.map((id) => `${PRESETS[id].transition.type}:${PRESETS[id].transition.duration}`));
  assert.equal(grades.size, PRESET_IDS.length, 'each preset needs a unique grade');
  assert.ok(transitions.size >= 4, 'presets should use several distinct transitions');
});

test('clipSpeed stays within the preset speed range', () => {
  for (const id of PRESET_IDS) {
    const preset = PRESETS[id];
    for (let i = 0; i < 20; i += 1) {
      const s = clipSpeed({ id: `c${i}`, fileId: 'f', start: i }, preset);
      assert.ok(s >= preset.speed.min - 1e-6 && s <= preset.speed.max + 1e-6, `${id} speed out of range`);
    }
  }
});

test('presets with speed disabled always render at 1.0', () => {
  for (const id of ['cinematic', 'travel', 'minimal']) {
    const preset = PRESETS[id];
    assert.equal(clipSpeed({ id: 'x', fileId: 'f', start: 0 }, preset), 1);
  }
});

/* ----------------------------------------------------- render plan ---- */
const projectFor = (preset, clips) => ({
  preset,
  aspect: '9:16',
  resolution: '1080',
  files: [
    { id: 'f1', name: 'a.mp4', path: 'C:/tmp/a.mp4', hasAudio: true, loudness: -20 },
    { id: 'f2', name: 'b.mp4', path: 'C:/tmp/b.mp4', hasAudio: true, loudness: -25 },
  ],
  clips: clips || [
    { id: 'c1', fileId: 'f1', fileName: 'a.mp4', start: 0, end: 3, duration: 3, transition: null },
    { id: 'c2', fileId: 'f2', fileName: 'b.mp4', start: 1, end: 4, duration: 3, transition: { type: 'fade', duration: 0.4 } },
  ],
  privacy: [],
});

test('buildRenderPlan produces a valid filter graph', () => {
  const plan = buildRenderPlan(projectFor('dramatic'), {});
  assert.ok(plan.args.includes('-filter_complex'));
  assert.ok(plan.filterComplex.includes('xfade'), 'expected an xfade transition');
  assert.ok(plan.filterComplex.includes('zoompan'), 'dramatic should apply a zoom');
  assert.ok(plan.args.includes('libx264'));
});

test('buildRenderPlan handles a single clip with no transition', () => {
  const plan = buildRenderPlan(projectFor('minimal', [
    { id: 'c1', fileId: 'f1', fileName: 'a.mp4', start: 0, end: 3, duration: 3, transition: null },
  ]), {});
  assert.ok(plan.filterComplex.includes('concat') === false, 'a single clip should not be concatenated');
  assert.ok(plan.totalDuration > 0);
});

test('different presets produce different filter graphs', () => {
  const graphs = new Set();
  for (const id of PRESET_IDS) {
    const plan = buildRenderPlan(projectFor(id), {});
    graphs.add(plan.filterComplex);
  }
  assert.equal(graphs.size, PRESET_IDS.length, 'each preset must render differently');
});

test('cinematic preset adds letterbox padding', () => {
  const plan = buildRenderPlan(projectFor('cinematic'), {});
  assert.ok(plan.filterComplex.includes('pad='), 'cinematic should letterbox');
});

test('privacy regions are applied to the output', () => {
  const project = projectFor('minimal');
  project.privacy = [{ id: 'r1', x: 0.1, y: 0.1, w: 0.3, h: 0.2, mode: 'blur' }];
  const plan = buildRenderPlan(project, {});
  assert.ok(plan.filterComplex.includes('boxblur'), 'blur mode should use boxblur');
  assert.ok(plan.filterComplex.includes('overlay='), 'the blurred region should be overlaid');
});

test('pixelate privacy mode uses scale+neighbor', () => {
  const project = projectFor('minimal');
  project.privacy = [{ id: 'r1', x: 0.1, y: 0.1, w: 0.3, h: 0.2, mode: 'pixelate' }];
  const plan = buildRenderPlan(project, {});
  assert.ok(plan.filterComplex.includes('neighbor'), 'pixelate should use the neighbor scaler');
});

test('privacy overlay keeps the full frame as the main input', () => {
  // Regression: the overlay filter takes the output size from its MAIN input.
  // Putting the small patched region first produced an output the size of the
  // redaction box instead of the full frame.
  for (const mode of ['blur', 'pixelate']) {
    const project = projectFor('minimal');
    project.privacy = [{ id: 'r1', x: 0.25, y: 0.3, w: 0.4, h: 0.25, mode }];
    const plan = buildRenderPlan(project, {});
    const patch = mode === 'blur' ? 'pvbl0' : 'pvpx0';
    assert.ok(
      plan.filterComplex.includes(`[pvbase0][${patch}]overlay=`),
      `${mode}: the full frame must be the overlay main input`,
    );
  }
});

test('every preset grade uses only valid unsharp matrix sizes', () => {
  // FFmpeg rejects even luma matrix sizes: "Invalid even size for luma matrix".
  for (const id of PRESET_IDS) {
    const grade = PRESETS[id].grade;
    const m = /unsharp=(-?\d+):(-?\d+)/.exec(grade);
    if (!m) continue;
    const luma = Number(m[1]);
    const chroma = Number(m[2]);
    assert.equal(luma % 2, 1, `${id}: unsharp luma size must be odd (got ${luma})`);
    assert.equal(chroma % 2, 1, `${id}: unsharp chroma size must be odd (got ${chroma})`);
  }
});

test('draft mode renders at a lower resolution', () => {
  const full = buildRenderPlan(projectFor('minimal'), { draft: false });
  const draft = buildRenderPlan(projectFor('minimal'), { draft: true });
  assert.ok(draft.width < full.width, 'draft should be smaller');
  assert.equal(draft.width % 2, 0, 'width must be even for h264');
  assert.equal(draft.height % 2, 0, 'height must be even for h264');
});

test('output resolution is even for h264 in every aspect', () => {
  for (const aspect of Object.keys(ASPECTS)) {
    for (const res of ['1080', '720', '480']) {
      const p = { ...projectFor('minimal'), aspect, resolution: res };
      const plan = buildRenderPlan(p, {});
      assert.equal(plan.width % 2, 0, `${aspect}/${res} width is odd`);
      assert.equal(plan.height % 2, 0, `${aspect}/${res} height is odd`);
    }
  }
});

test('buildRenderPlan rejects an empty timeline', () => {
  assert.throws(() => buildRenderPlan(projectFor('minimal', []), {}), /no clips/i);
});

test('aspect ratio drives the output dimensions', () => {
  const p = projectFor('minimal');
  p.aspect = '16:9';
  const plan = buildRenderPlan(p, {});
  assert.ok(plan.width > plan.height, '16:9 should be wider than tall');
  p.aspect = '9:16';
  const portrait = buildRenderPlan(p, {});
  assert.ok(portrait.height > portrait.width, '9:16 should be taller than wide');
});
