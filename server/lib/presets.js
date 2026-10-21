/**
 * Editing style presets.
 *
 * Every preset here must change the *rendered* output, not just the UI.
 * Each preset controls:
 *   - clip selection / pacing (which segments are kept, how long)
 *   - colour grade (FFmpeg eq / curves / colorbalance chain)
 *   - camera motion (Ken Burns push-in, punch-in)
 *   - transition type + duration between clips
 *   - letterbox / vignette framing
 *   - audio treatment (silence removal, loudness, speed)
 *
 * The `filter` strings are pure FFmpeg video filter chains applied to a single
 * clip. They are combined with framing filters (scale/crop/pad) at render time.
 */

/** @typedef {'cut'|'fade'|'wipeleft'|'wiperight'|'slideup'|'slidedown'|'zoomin'|'circleopen'|'fadeblack'|'dissolve'} TransitionType */

export const PRESETS = {
  dramatic: {
    id: 'dramatic',
    name: '戏剧 Dramatic',
    nameEn: 'Dramatic',
    emoji: '🔥',
    description: '夸张效果、快速剪辑、强烈对比与冲击性缩放。适合运动、派对、开箱。',
    descriptionEn: 'Exaggerated punch-ins, fast cuts, high contrast, hard transitions.',
    // pacing
    minClip: 0.8,
    maxClip: 3.0,
    targetClip: 1.8,
    preferFast: true,
    // transitions
    transition: { type: 'fadeblack', duration: 0.28 },
    // look
    grade: 'eq=contrast=1.38:saturation=1.55:brightness=-0.03,unsharp=5:5:1.1',
    vignette: 0.35,
    letterbox: false,
    // camera motion
    zoom: { push: 0.16, punch: 0.22, punchTime: 0.45 },
    // audio
    silence: { enabled: true, threshold: -32, minSilence: 0.35 },
    speed: { enabled: true, min: 1.0, max: 1.12 },
    audio: { gain: 1.05, normalize: true },
  },

  cinematic: {
    id: 'cinematic',
    name: '电影感 Cinematic',
    nameEn: 'Cinematic',
    emoji: '🎬',
    description: '电影级节奏、柔和转场、青橙调色与宽银幕遮幅。',
    descriptionEn: 'Film-like pacing, soft dissolves, teal/orange grade, letterbox bars.',
    minClip: 3.0,
    maxClip: 7.0,
    targetClip: 4.5,
    preferFast: false,
    transition: { type: 'fade', duration: 0.75 },
    grade: 'eq=contrast=1.16:saturation=0.92:gamma=0.96,colorbalance=rs=0.04:gs=-0.01:bs=0.07:rm=0.02:bm=-0.05,curves=all=\'0/0 0.5/0.52 1/1\'',
    vignette: 0.28,
    letterbox: true,
    zoom: { push: 0.08, punch: 0, punchTime: 0 },
    silence: { enabled: true, threshold: -34, minSilence: 0.6 },
    speed: { enabled: false, min: 1.0, max: 1.0 },
    audio: { gain: 1.0, normalize: true },
  },

  montage: {
    id: 'montage',
    name: '蒙太奇 Montage',
    nameEn: 'Montage',
    emoji: '⚡',
    description: '按节奏把多个片段交叉组合，快速滑动转场，高饱和度。',
    descriptionEn: 'Rhythmic intercut of many clips, fast slide wipes, punchy saturation.',
    minClip: 0.6,
    maxClip: 2.0,
    targetClip: 1.1,
    preferFast: true,
    transition: { type: 'wipeleft', duration: 0.22 },
    grade: 'eq=contrast=1.26:saturation=1.38:brightness=0.01,unsharp=3:3:0.8',
    vignette: 0.14,
    letterbox: false,
    zoom: { push: 0.12, punch: 0.1, punchTime: 0.3 },
    silence: { enabled: true, threshold: -32, minSilence: 0.3 },
    speed: { enabled: true, min: 1.0, max: 1.08 },
    audio: { gain: 1.0, normalize: true },
  },

  travel: {
    id: 'travel',
    name: '旅行 Vlog Travel',
    nameEn: 'Travel Vlog',
    emoji: '🧭',
    description: '风景叙事、舒展节奏、明亮通透的调色与缓慢推镜。',
    descriptionEn: 'Scenic storytelling, balanced pacing, airy bright grade, slow push-in.',
    minClip: 3.5,
    maxClip: 9.0,
    targetClip: 5.5,
    preferFast: false,
    transition: { type: 'fade', duration: 0.55 },
    grade: 'eq=contrast=1.06:saturation=1.16:brightness=0.035:gamma=1.02,curves=all=\'0/0.02 0.5/0.53 1/1\'',
    vignette: 0.12,
    letterbox: false,
    zoom: { push: 0.1, punch: 0, punchTime: 0 },
    silence: { enabled: true, threshold: -36, minSilence: 0.7 },
    speed: { enabled: false, min: 1.0, max: 1.0 },
    audio: { gain: 1.0, normalize: true },
  },

  meme: {
    id: 'meme',
    name: '搞笑 Meme',
    nameEn: 'Funny Meme',
    emoji: '😂',
    description: '喜剧节奏、瞬间放大冲击、夸张高对比与快速推拉。',
    descriptionEn: 'Comedic timing, punch-in zooms, exaggerated contrast, fast whip feel.',
    minClip: 0.7,
    maxClip: 2.4,
    targetClip: 1.3,
    preferFast: true,
    transition: { type: 'zoomin', duration: 0.25 },
    grade: 'eq=contrast=1.42:saturation=1.6:brightness=0.02,unsharp=7:7:1.3',
    vignette: 0.18,
    letterbox: false,
    zoom: { push: 0.06, punch: 0.3, punchTime: 0.5 },
    silence: { enabled: true, threshold: -30, minSilence: 0.3 },
    speed: { enabled: true, min: 1.0, max: 1.18 },
    audio: { gain: 1.08, normalize: true },
  },

  minimal: {
    id: 'minimal',
    name: '极简 Minimal Clean',
    nameEn: 'Minimal Clean',
    emoji: '⚪',
    description: '简洁专业：自然色彩、干净硬切、几乎不加特效。',
    descriptionEn: 'Simple and professional: natural colour, clean cuts, almost no effects.',
    minClip: 2.5,
    maxClip: 6.0,
    targetClip: 3.6,
    preferFast: false,
    transition: { type: 'cut', duration: 0.0 },
    grade: 'eq=contrast=1.02:saturation=1.0',
    vignette: 0,
    letterbox: false,
    zoom: { push: 0, punch: 0, punchTime: 0 },
    silence: { enabled: true, threshold: -35, minSilence: 0.5 },
    speed: { enabled: false, min: 1.0, max: 1.0 },
    audio: { gain: 1.0, normalize: true },
  },
};

export const PRESET_IDS = Object.keys(PRESETS);

export function getPreset(id) {
  return PRESETS[id] || PRESETS.minimal;
}

/** Public (JSON-safe) description of all presets, for the UI. */
export function presetSummaries() {
  return Object.values(PRESETS).map((p) => ({
    id: p.id,
    name: p.name,
    nameEn: p.nameEn,
    emoji: p.emoji,
    description: p.description,
    descriptionEn: p.descriptionEn,
    transition: p.transition,
    letterbox: p.letterbox,
    minClip: p.minClip,
    maxClip: p.maxClip,
  }));
}
