/**
 * AutoCut Studio — local automatic video editor.
 *
 * A single Express server: static UI + local JSON API + FFmpeg worker.
 * Nothing leaves the machine. No cloud, no API keys, no model downloads.
 */
import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { PROJECT_ROOT, FFMPEG_PATH, FFPROBE_PATH, binariesAvailable, run } from './ffmpeg.js';
import { analyzeFile, probe } from './lib/analyze.js';
import { planTimeline, retimeTimeline } from './lib/planner.js';
import { presetSummaries, getPreset, PRESET_IDS } from './lib/presets.js';
import { renderProject, buildRenderPlan, ASPECTS } from './lib/render.js';
import * as store from './lib/store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(PROJECT_ROOT, 'public');
const MEDIA_DIR = path.join(PROJECT_ROOT, 'media');
const UPLOAD_DIR = path.join(MEDIA_DIR, 'uploads');
const WORK_DIR = path.join(MEDIA_DIR, 'work');
const THUMB_DIR = path.join(MEDIA_DIR, 'thumbs');
const EXPORT_DIR = path.join(PROJECT_ROOT, 'exports');

for (const d of [UPLOAD_DIR, WORK_DIR, THUMB_DIR, EXPORT_DIR]) {
  fs.mkdirSync(d, { recursive: true });
}

const PORT = Number(process.env.PORT || 3210);
const app = express();
app.use(express.json({ limit: '8mb' }));
app.use(express.static(PUBLIC_DIR));

// Range-request support so <video> can seek in exported/draft files.
app.get('/media/:file(*)', (req, res, next) => {
  const filePath = path.join(MEDIA_DIR, req.params.file);
  if (!filePath.startsWith(MEDIA_DIR) || !fs.existsSync(filePath)) return next();
  const stat = fs.statSync(filePath);
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    const start = m && m[1] ? Number(m[1]) : 0;
    const end = m && m[2] ? Number(m[2]) : stat.size - 1;
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Type': 'video/mp4',
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, {
    'Content-Length': stat.size,
    'Content-Type': 'video/mp4',
    'Accept-Ranges': 'bytes',
  });
  fs.createReadStream(filePath).pipe(res);
});

app.get('/api/health', async (req, res) => {
  const bins = binariesAvailable();
  let ffmpegVersion = null;
  if (bins.ffmpeg) {
    const r = await run(FFMPEG_PATH, ['-hide_banner', '-version'], { timeout: 20000 });
    const m = /ffmpeg version (\S+)/.exec(r.stdout || '');
    ffmpegVersion = m ? m[1] : 'unknown';
  }
  res.json({
    ok: true,
    version: '1.0.0',
    ffmpeg: bins.ffmpeg,
    ffprobe: bins.ffprobe,
    ffmpegPath: FFMPEG_PATH,
    ffmpegVersion,
    presets: presetSummaries(),
    aspects: ASPECTS,
    project: store.getProject(),
  });
});

// ---------------------------------------------------------------- uploads ---
const ALLOWED_EXT = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi']);
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.mp4';
    const base = path.basename(file.originalname, path.extname(file.originalname))
      .replace(/[^\w一-龥.-]+/g, '_')
      .slice(0, 60) || 'clip';
    cb(null, `${Date.now()}-${randomUUID().slice(0, 8)}-${base}${ext}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 2 * 1024 * 1024 * 1024 } });

app.post('/api/upload', (req, res) => {
  upload.array('videos', 30)(req, res, async (err) => {
    if (err) {
      res.status(400).json({ ok: false, error: `Upload failed: ${err.message}` });
      return;
    }
    const files = req.files || [];
    if (!files.length) {
      res.status(400).json({ ok: false, error: 'No files received.' });
      return;
    }
    const results = [];
    for (const f of files) {
      const ext = path.extname(f.originalname).toLowerCase();
      if (!ALLOWED_EXT.has(ext)) {
        await fsp.unlink(f.path).catch(() => {});
        results.push({ ok: false, name: f.originalname, error: `Unsupported format ${ext}` });
        continue;
      }
      try {
        const meta = await probe(f.path);
        const record = {
          id: randomUUID(),
          name: f.originalname,
          storedName: f.filename,
          path: f.path,
          size: f.size,
          uploadedAt: new Date().toISOString(),
          meta,
          hasAudio: meta.hasAudio,
          loudness: null,
          analysis: null,
          analyzing: true,
        };
        store.addFile(record);
        results.push({ ok: true, id: record.id, name: record.name, meta });

        // Background analysis so the UI stays responsive.
        analyzeFile(f.path)
          .then((analysis) => {
            const p = store.getProject();
            const target = p.files.find((x) => x.id === record.id);
            if (target) {
              target.analysis = {
                scenes: analysis.scenes,
                silences: analysis.silences,
                loudness: analysis.loudness,
              };
              target.loudness = analysis.loudness;
              target.analyzing = false;
              store.saveProject();
            }
          })
          .catch((err2) => {
            const p = store.getProject();
            const target = p.files.find((x) => x.id === record.id);
            if (target) {
              target.analyzing = false;
              target.analysisError = err2.message;
              store.saveProject();
            }
          });
      } catch (err2) {
        await fsp.unlink(f.path).catch(() => {});
        results.push({ ok: false, name: f.originalname, error: err2.message });
      }
    }
    res.json({ ok: true, results, project: store.getProject() });
  });
});

app.get('/api/files', (req, res) => {
  res.json({ ok: true, files: store.getProject().files });
});

app.delete('/api/files/:id', async (req, res) => {
  const file = store.getProject().files.find((f) => f.id === req.params.id);
  if (file) {
    await fsp.unlink(file.path).catch(() => {});
  }
  store.removeFile(req.params.id);
  res.json({ ok: true, project: store.getProject() });
});

/** Remove upload files that no longer belong to the project. */
app.post('/api/cleanup', (req, res) => {
  const removed = store.pruneOrphanUploads(UPLOAD_DIR);
  res.json({ ok: true, removed });
});

// ------------------------------------------------------------- analysis ---
app.get('/api/analyze/:id', async (req, res) => {
  const file = store.getProject().files.find((f) => f.id === req.params.id);
  if (!file) {
    res.status(404).json({ ok: false, error: 'File not found.' });
    return;
  }
  try {
    const analysis = await analyzeFile(file.path);
    file.analysis = {
      scenes: analysis.scenes,
      silences: analysis.silences,
      loudness: analysis.loudness,
    };
    file.loudness = analysis.loudness;
    file.analyzing = false;
    store.saveProject();
    res.json({ ok: true, id: file.id, analysis: file.analysis });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ------------------------------------------------------------- auto edit ---
app.post('/api/auto-edit', (req, res) => {
  try {
    const project = store.getProject();
    const presetId = req.body.preset || project.preset;
    const order = req.body.order || project.order;
    const maxClips = Number(req.body.maxClips || project.maxClips || 12);
    const files = project.files.filter((f) => f.analysis);
    if (!files.length) {
      res.status(400).json({
        ok: false,
        error: 'No analyzed files yet. Import videos and wait for analysis to finish.',
      });
      return;
    }
    const analyses = files.map((f) => ({
      id: f.id,
      name: f.name,
      meta: f.meta,
      scenes: f.analysis.scenes || [],
      silences: f.analysis.silences || [],
      loudness: f.loudness,
    }));
    const plan = planTimeline(analyses, presetId, { order, maxClips });
    store.updateProject({
      preset: presetId,
      order,
      maxClips,
      clips: plan.clips,
    });
    res.json({ ok: true, timeline: plan, project: store.getProject() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/** Manual timeline edits: trim, reorder, remove, change transition. */
app.post('/api/timeline', (req, res) => {
  try {
    const { clips, preset } = req.body;
    if (!Array.isArray(clips)) {
      res.status(400).json({ ok: false, error: 'clips must be an array' });
      return;
    }
    const project = store.getProject();
    const p = preset || project.preset;
    const timeline = retimeTimeline(clips, p);
    store.updateProject({ clips: timeline.clips, preset: p });
    res.json({ ok: true, timeline, project: store.getProject() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/project', (req, res) => {
  const allowed = ['preset', 'aspect', 'resolution', 'order', 'maxClips', 'name', 'privacy'];
  const patch = {};
  for (const k of allowed) {
    if (req.body[k] !== undefined) patch[k] = req.body[k];
  }
  if (patch.preset && !PRESET_IDS.includes(patch.preset)) {
    res.status(400).json({ ok: false, error: `Unknown preset: ${patch.preset}` });
    return;
  }
  store.updateProject(patch);
  res.json({ ok: true, project: store.getProject() });
});

app.post('/api/privacy', (req, res) => {
  const regions = Array.isArray(req.body.regions) ? req.body.regions : [];
  const clean = regions
    .filter((r) => r && Number.isFinite(Number(r.x)) && Number.isFinite(Number(r.y)))
    .map((r) => ({
      id: r.id || randomUUID(),
      clipId: r.clipId || null,
      x: Math.max(0, Math.min(1, Number(r.x))),
      y: Math.max(0, Math.min(1, Number(r.y))),
      w: Math.max(0, Math.min(1, Number(r.w))),
      h: Math.max(0, Math.min(1, Number(r.h))),
      mode: ['blur', 'box', 'pixelate'].includes(r.mode) ? r.mode : 'blur',
      color: r.color || '#000000',
      label: r.label || '',
    }));
  store.updateProject({ privacy: clean });
  res.json({ ok: true, privacy: clean });
});

// ---------------------------------------------------------------- export ---
const jobs = new Map();
const previewJobs = new Map();

/**
 * Render a low-resolution draft of the current timeline and serve it for
 * in-page playback. Drafts are NOT added to the export list.
 */
app.post('/api/preview', async (req, res) => {
  const project = store.getProject();
  if (!project.clips.length) {
    res.status(400).json({ ok: false, error: 'Timeline is empty. Run Auto Edit first.' });
    return;
  }
  // Fail fast with a clear message instead of letting FFmpeg die on a
  // missing input file.
  const missing = (project.files || []).filter((f) => !fs.existsSync(f.path));
  if (missing.length) {
    res.status(400).json({
      ok: false,
      error: `Source file(s) missing: ${missing.map((f) => f.name).join(', ')}. Re-import them.`,
    });
    return;
  }
  const jobId = randomUUID();
  const job = { id: jobId, status: 'running', percent: 0, startedAt: new Date().toISOString() };
  previewJobs.set(jobId, job);
  res.json({ ok: true, jobId });

  const outName = `preview-${jobId.slice(0, 8)}.mp4`;
  const outPath = path.join(WORK_DIR, outName);

  (async () => {
    try {
      const result = await renderProject(project, outPath, {
        draft: true,
        onProgress: (p) => { job.percent = Math.round(p.percent); },
      });
      if (!result.ok) {
        job.status = 'failed';
        job.error = result.stderr || `ffmpeg exited with code ${result.code}`;
        return;
      }
      job.status = 'done';
      job.percent = 100;
      job.output = `/media/work/${outName}`;
      job.duration = result.totalDuration;
      job.width = result.width;
      job.height = result.height;
      job.size = fs.existsSync(outPath) ? fs.statSync(outPath).size : 0;
    } catch (err) {
      job.status = 'failed';
      job.error = err.message;
    }
  })();
});

app.get('/api/preview/:id', (req, res) => {
  const job = previewJobs.get(req.params.id);
  if (!job) {
    res.status(404).json({ ok: false, error: 'Unknown preview job.' });
    return;
  }
  res.json({ ok: true, job });
});

app.post('/api/export', async (req, res) => {
  const project = store.getProject();
  if (!project.clips.length) {
    res.status(400).json({ ok: false, error: 'Timeline is empty. Run Auto Edit first.' });
    return;
  }
  // Fail fast with a clear message instead of letting FFmpeg die on a
  // missing input file.
  const missing = (project.files || []).filter((f) => !fs.existsSync(f.path));
  if (missing.length) {
    res.status(400).json({
      ok: false,
      error: `Source file(s) missing: ${missing.map((f) => f.name).join(', ')}. Re-import them.`,
    });
    return;
  }
  const draft = !!req.body.draft;
  const jobId = randomUUID();
  const job = {
    id: jobId,
    status: 'running',
    percent: 0,
    draft,
    startedAt: new Date().toISOString(),
    output: null,
    error: null,
  };
  jobs.set(jobId, job);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outName = `autocut-${project.preset}-${project.aspect.replace(':', 'x')}-${stamp}${draft ? '-draft' : ''}.mp4`;
  const outPath = path.join(EXPORT_DIR, outName);

  // Reply immediately; the client polls /api/export/:id for progress.
  res.json({ ok: true, jobId, output: `/exports/${outName}` });

  (async () => {
    try {
      const result = await renderProject(project, outPath, {
        draft,
        onProgress: (p) => {
          job.percent = Math.round(p.percent);
        },
      });
      if (!result.ok) {
        job.status = 'failed';
        job.error = result.stderr || `ffmpeg exited with code ${result.code}`;
        job.percent = 0;
        return;
      }
      const meta = await probe(outPath).catch(() => null);
      job.status = 'done';
      job.percent = 100;
      job.output = `/exports/${outName}`;
      job.fileName = outName;
      job.duration = meta ? meta.duration : result.totalDuration;
      job.width = result.width;
      job.height = result.height;
      job.size = fs.existsSync(outPath) ? fs.statSync(outPath).size : 0;
      store.addExport({
        id: jobId,
        fileName: outName,
        preset: project.preset,
        aspect: project.aspect,
        draft,
        duration: job.duration,
        size: job.size,
        createdAt: new Date().toISOString(),
      });
    } catch (err) {
      job.status = 'failed';
      job.error = err.message;
    }
  })();
});

app.get('/api/export/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    res.status(404).json({ ok: false, error: 'Unknown job.' });
    return;
  }
  res.json({ ok: true, job });
});

app.get('/api/exports', (req, res) => {
  res.json({ ok: true, exports: store.getProject().exports });
});

app.use('/exports', express.static(EXPORT_DIR, { acceptRanges: true }));

// ------------------------------------------------------------------- misc ---
app.get('/api/presets', (req, res) => {
  res.json({ ok: true, presets: presetSummaries() });
});

app.post('/api/reset', (req, res) => {
  store.resetProject();
  res.json({ ok: true, project: store.getProject() });
});

app.use((err, req, res, next) => {
  console.error('[server] unhandled error:', err);
  res.status(500).json({ ok: false, error: err.message });
});

store.loadProject();

app.listen(PORT, '127.0.0.1', () => {
  const bins = binariesAvailable();
  console.log('');
  console.log('  AutoCut Studio  —  local automatic video editor');
  console.log('  ------------------------------------------------');
  console.log(`  UI        : http://127.0.0.1:${PORT}`);
  console.log(`  ffmpeg    : ${bins.ffmpeg ? FFMPEG_PATH : 'NOT FOUND — export will fail'}`);
  console.log(`  ffprobe   : ${bins.ffprobe ? FFPROBE_PATH : 'NOT FOUND — import will fail'}`);
  console.log(`  project   : ${PROJECT_ROOT}`);
  console.log('');
  if (!bins.ffmpeg || !bins.ffprobe) {
    console.log('  WARNING: FFmpeg binaries are missing.');
    console.log('  Run:  npm run setup:ffmpeg');
    console.log('');
  }
});
