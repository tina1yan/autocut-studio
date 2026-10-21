/* AutoCut Studio — client */
'use strict';

const $ = (id) => document.getElementById(id);
const api = async (url, opts = {}) => {
  const r = await fetch(url, opts);
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { ok: false, error: text.slice(0, 300) }; }
  if (!r.ok || data.ok === false) {
    throw new Error(data.error || `HTTP ${r.status}`);
  }
  return data;
};

const state = {
  presets: [],
  project: { files: [], clips: [], privacy: [], preset: 'dramatic', aspect: '9:16' },
  activeClipId: null,
  privacyMode: false,
  privacyRegions: [],
  drawStart: null,
  draftUrl: null,
  exporting: false,
};

/* ------------------------------------------------------------- utils -- */
function toast(msg, kind = '') {
  const t = $('toast');
  t.textContent = msg;
  t.className = `toast ${kind}`;
  setTimeout(() => t.classList.add('hidden'), kind === 'err' ? 6000 : 3000);
}
function fmtTime(sec) {
  if (!Number.isFinite(sec)) return '0:00';
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function fmtSize(bytes) {
  if (!bytes) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* -------------------------------------------------------------- boot -- */
async function boot() {
  try {
    const health = await api('/api/health');
    state.presets = health.presets || [];
    state.project = health.project || state.project;
    state.privacyRegions = (state.project.privacy || []).slice();

    const badge = $('ffmpegBadge');
    if (health.ffmpeg && health.ffprobe) {
      badge.textContent = `FFmpeg ${health.ffmpegVersion || 'OK'}`;
      badge.className = 'badge badge-ok';
    } else {
      badge.textContent = 'FFmpeg 缺失';
      badge.className = 'badge badge-err';
    }

    renderPresets();
    renderFiles();
    renderTimeline();
    renderPrivacy();
    syncControls();
    restoreStage();
  } catch (err) {
    toast(`无法连接服务：${err.message}`, 'err');
  }
}

/**
 * On load, show the most recent export in the preview if there is one, and
 * make the empty-state message reflect whether a timeline already exists.
 */
function restoreStage() {
  const hasTimeline = state.project.clips && state.project.clips.length > 0;
  const empty = $('stageEmpty');
  if (!hasTimeline) {
    empty.innerHTML = '<p>导入视频后点击「自动剪辑」</p><p class="muted">选择风格 → 自动剪辑 → 预览 → 导出</p>';
    empty.classList.remove('hidden');
    return;
  }
  const last = (state.project.exports || [])[0];
  if (last && !last.draft) {
    const pv = $('preview');
    pv.src = `/exports/${last.fileName}`;
    empty.classList.add('hidden');
    // Reflect the restored export in the status panel, so the panel does not
    // still read "not exported yet" next to a finished file.
    $('exportBar').style.width = '100%';
    $('exportText').textContent = `上次导出 · ${fmtSize(last.size)} · ${fmtTime(last.duration)}`;
  } else {
    empty.innerHTML = '<p>时间线已就绪</p><p class="muted">点击「生成草稿预览」查看自动剪辑结果</p>';
    empty.classList.remove('hidden');
  }
}

function syncControls() {
  const p = state.project;
  $('aspectSel').value = p.aspect || '9:16';
  $('resSel').value = p.resolution || '1080';
  $('orderSel').value = p.order || 'chronological';
  $('maxClips').value = p.maxClips || 12;
  $('maxClipsVal').textContent = p.maxClips || 12;
  updateStageAspect();
  const preset = state.presets.find((x) => x.id === p.preset);
  $('presetDesc').textContent = preset ? preset.description : '';
}

/* ----------------------------------------------------------- presets -- */
function renderPresets() {
  const grid = $('presetGrid');
  grid.innerHTML = state.presets.map((p) => `
    <div class="preset-card ${p.id === state.project.preset ? 'active' : ''}" data-preset="${p.id}">
      <span class="pe">${p.emoji}</span>
      <span class="pn">${esc(p.name.split(' ')[0])}</span>
      <span class="pt">${esc(p.nameEn)}</span>
    </div>`).join('');
  grid.querySelectorAll('.preset-card').forEach((el) => {
    el.addEventListener('click', async () => {
      await setPreset(el.dataset.preset);
    });
  });
}

async function setPreset(id) {
  state.project.preset = id;
  renderPresets();
  const preset = state.presets.find((x) => x.id === id);
  $('presetDesc').textContent = preset ? preset.description : '';
  try {
    await api('/api/project', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preset: id }),
    });
  } catch (err) { /* non-fatal: local state still updated */ }
}

/* ------------------------------------------------------------- files -- */
function renderFiles() {
  const list = $('fileList');
  const files = state.project.files || [];
  if (!files.length) { list.innerHTML = ''; return; }
  list.innerHTML = files.map((f) => {
    const m = f.meta || {};
    const status = f.analyzing
      ? '<span class="fi-status busy">分析中…</span>'
      : (f.analysis
        ? `<span class="fi-status ready">${f.analysis.scenes.length} 场景 / ${f.analysis.silences.length} 静音</span>`
        : '<span class="fi-status err">未分析</span>');
    return `
      <div class="file-item" data-file="${f.id}">
        <div class="fi-top">
          <span class="fi-name" title="${esc(f.name)}">${esc(f.name)}</span>
          <button data-del="${f.id}" title="移除">✕</button>
        </div>
        <div class="fi-meta">${m.width}×${m.height} · ${fmtTime(m.duration)} · ${fmtSize(f.size)} ${m.hasAudio ? '· 有音轨' : '· 无音轨'}</div>
        <div class="fi-meta">${status}</div>
      </div>`;
  }).join('');
  list.querySelectorAll('[data-del]').forEach((b) => {
    b.addEventListener('click', async (e) => {
      e.stopPropagation();
      await api(`/api/files/${b.dataset.del}`, { method: 'DELETE' });
      await refreshProject();
    });
  });
}

async function refreshProject() {
  const data = await api('/api/health');
  state.project = data.project;
  state.privacyRegions = (state.project.privacy || []).slice();
  renderFiles();
  renderTimeline();
  renderPrivacy();
  syncControls();
}

/* ------------------------------------------------------------ upload -- */
async function uploadFiles(fileList) {
  const files = Array.from(fileList).filter((f) => /\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(f.name));
  if (!files.length) { toast('没有可用的视频文件（支持 MP4 / MOV / M4V / WebM / MKV / AVI）', 'err'); return; }

  const fd = new FormData();
  files.forEach((f) => fd.append('videos', f));
  toast(`正在导入 ${files.length} 个文件…`);
  try {
    const res = await api('/api/upload', { method: 'POST', body: fd });
    const failed = (res.results || []).filter((r) => !r.ok);
    await refreshProject();
    if (failed.length) {
      toast(`导入完成，但 ${failed.length} 个文件失败：${failed[0].error}`, 'err');
    } else {
      toast(`已导入 ${files.length} 个文件，正在后台分析…`, 'ok');
    }
    pollAnalysis();
  } catch (err) {
    toast(`导入失败：${err.message}`, 'err');
  }
}

let analysisTimer = null;
function pollAnalysis() {
  clearTimeout(analysisTimer);
  analysisTimer = setTimeout(async () => {
    try {
      const data = await api('/api/files');
      const prev = JSON.stringify((state.project.files || []).map((f) => [f.id, f.analyzing]));
      state.project.files = data.files;
      renderFiles();
      const now = JSON.stringify((data.files || []).map((f) => [f.id, f.analyzing]));
      if (prev !== now) { /* state changed, keep polling */ }
      const busy = (data.files || []).some((f) => f.analyzing);
      if (busy) pollAnalysis();
      else toast('素材分析完成，可以点击「自动剪辑」', 'ok');
    } catch { /* retry silently */ }
  }, 1200);
}

/* ---------------------------------------------------------- timeline -- */
function renderTimeline() {
  const tl = $('timeline');
  const clips = state.project.clips || [];
  if (!clips.length) {
    tl.innerHTML = '<div class="timeline-empty"><p>时间线为空</p><p class="muted small">导入素材后点击「⚡ 自动剪辑」</p></div>';
    $('timelineMeta').textContent = '';
    return;
  }
  const total = clips.reduce((a, c) => a + (c.duration || 0), 0);
  const maxDur = Math.max(...clips.map((c) => c.duration || 0), 0.001);
  tl.innerHTML = clips.map((c, i) => `
    <div class="clip ${c.id === state.activeClipId ? 'active' : ''}" data-clip="${c.id}">
      <span class="c-idx">${i + 1}</span>
      <div class="c-name" title="${esc(c.fileName)}">${esc(c.fileName)}</div>
      <div class="c-bar"><i style="width:${Math.max(6, ((c.duration || 0) / maxDur) * 100)}%"></i></div>
      <div class="c-meta">
        <span>${fmtTime(c.start)}→${fmtTime(c.end)}</span>
        <span class="c-tr">${c.transition ? esc(c.transition.type) : '起点'}</span>
      </div>
    </div>`).join('');
  $('timelineMeta').textContent = `${clips.length} 个片段 · 总时长 ${fmtTime(total)}`;
  tl.querySelectorAll('.clip').forEach((el) => {
    el.addEventListener('click', () => selectClip(el.dataset.clip));
  });
}

function findClip(id) { return (state.project.clips || []).find((c) => c.id === id); }

function selectClip(id) {
  state.activeClipId = id;
  renderTimeline();
  const clip = findClip(id);
  if (!clip) { $('clipEditor').classList.add('hidden'); return; }
  const file = (state.project.files || []).find((f) => f.id === clip.fileId);
  const full = file ? file.meta.duration : clip.end;
  $('clipEditor').classList.remove('hidden');
  $('ceTitle').textContent = `片段：${clip.fileName}`;
  const inSlider = $('ceIn');
  const outSlider = $('ceOut');
  inSlider.max = String(full || 100);
  outSlider.max = String(full || 100);
  inSlider.value = String(clip.start);
  outSlider.value = String(clip.end);
  $('ceInVal').textContent = fmtTime(clip.start);
  $('ceOutVal').textContent = fmtTime(clip.end);
  const t = clip.transition || { type: 'fade', duration: 0.3 };
  $('ceTransition').value = t.type;
  $('ceTd').value = String(t.duration || 0);
  $('ceTdVal').textContent = `${Number(t.duration || 0).toFixed(2)}s`;
}

function updateClipTrim(which, value) {
  const clip = findClip(state.activeClipId);
  if (!clip) return;
  const v = Number(value);
  if (which === 'in') {
    clip.start = Math.min(v, clip.end - 0.1);
    $('ceInVal').textContent = fmtTime(clip.start);
  } else {
    clip.end = Math.max(v, clip.start + 0.1);
    $('ceOutVal').textContent = fmtTime(clip.end);
  }
  clip.duration = Math.max(0.04, clip.end - clip.start);
  renderTimeline();
}

async function saveTimeline() {
  try {
    const res = await api('/api/timeline', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clips: state.project.clips, preset: state.project.preset }),
    });
    state.project.clips = res.timeline.clips;
    renderTimeline();
  } catch (err) {
    toast(`保存时间线失败：${err.message}`, 'err');
  }
}

function moveClip(dir) {
  const clips = state.project.clips;
  const i = clips.findIndex((c) => c.id === state.activeClipId);
  if (i === -1) return;
  const j = i + dir;
  if (j < 0 || j >= clips.length) return;
  [clips[i], clips[j]] = [clips[j], clips[i]];
  // First clip has no incoming transition.
  clips[0].transition = null;
  renderTimeline();
  saveTimeline();
}

function removeClip() {
  const clips = state.project.clips;
  const i = clips.findIndex((c) => c.id === state.activeClipId);
  if (i === -1) return;
  clips.splice(i, 1);
  if (clips.length) clips[0].transition = null;
  state.activeClipId = clips.length ? clips[0].id : null;
  $('clipEditor').classList.add('hidden');
  renderTimeline();
  saveTimeline();
}

/* -------------------------------------------------------- auto edit --- */
async function autoEdit() {
  const btn = $('btnAutoEdit');
  btn.disabled = true;
  btn.textContent = '⏳ 分析中…';
  try {
    const res = await api('/api/auto-edit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        preset: state.project.preset,
        order: $('orderSel').value,
        maxClips: Number($('maxClips').value),
      }),
    });
    state.project = res.project;
    renderTimeline();
    toast(`已生成 ${res.timeline.clips.length} 个片段 · 总时长 ${fmtTime(res.timeline.totalDuration)}`, 'ok');
    selectClip(state.project.clips[0] ? state.project.clips[0].id : null);
    if (state.project.clips.length) {
      $('stageEmpty').classList.add('hidden');
      // Render a draft straight away so the user can watch the auto-edited
      // result before deciding to export.
      makePreview();
    }
  } catch (err) {
    toast(`自动剪辑失败：${err.message}`, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = '⚡ 自动剪辑';
  }
}

/* ----------------------------------------------------------- export --- */
async function exportVideo(draft = false) {
  if (state.exporting) { toast('已有导出任务进行中', 'err'); return; }
  if (!state.project.clips || !state.project.clips.length) {
    toast('时间线为空，请先自动剪辑', 'err');
    return;
  }
  state.exporting = true;
  $('btnExport').disabled = true;
  $('exportBar').style.width = '0%';
  $('exportText').textContent = '正在准备…';

  try {
    const res = await api('/api/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ draft }),
    });
    const jobId = res.jobId;
    const poll = setInterval(async () => {
      try {
        const j = await api(`/api/export/${jobId}`);
        const job = j.job;
        $('exportBar').style.width = `${job.percent || 0}%`;
        if (job.status === 'running') {
          $('exportText').textContent = `导出中… ${job.percent || 0}%`;
        } else if (job.status === 'done') {
          clearInterval(poll);
          state.exporting = false;
          $('btnExport').disabled = false;
          $('exportBar').style.width = '100%';
          $('exportText').textContent = `完成 · ${fmtSize(job.size)} · ${fmtTime(job.duration)} · ${job.width}×${job.height}`;
          toast('导出完成！可在右侧下载', 'ok');
          loadExports();
          // Play back the finished export in the stage.
          state.draftUrl = job.output;
          const pv = $('preview');
          pv.src = job.output;
          $('stageEmpty').classList.add('hidden');
        } else if (job.status === 'failed') {
          clearInterval(poll);
          state.exporting = false;
          $('btnExport').disabled = false;
          $('exportText').textContent = '导出失败';
          toast(`导出失败：${(job.error || '').slice(0, 260)}`, 'err');
        }
      } catch (err) {
        clearInterval(poll);
        state.exporting = false;
        $('btnExport').disabled = false;
        toast(`导出轮询失败：${err.message}`, 'err');
      }
    }, 700);
  } catch (err) {
    state.exporting = false;
    $('btnExport').disabled = false;
    toast(`导出失败：${err.message}`, 'err');
  }
}

/** Render a low-res draft of the current timeline and play it in the stage. */
async function makePreview() {
  const btn = $('btnDraft');
  if (state.exporting) { toast('已有任务进行中', 'err'); return; }
  if (!state.project.clips || !state.project.clips.length) {
    toast('时间线为空，请先自动剪辑', 'err');
    return;
  }
  state.exporting = true;
  btn.disabled = true;
  btn.textContent = '⏳ 渲染中…';
  try {
    const res = await api('/api/preview', { method: 'POST' });
    const poll = setInterval(async () => {
      try {
        const j = await api(`/api/preview/${res.jobId}`);
        const job = j.job;
        if (job.status === 'running') {
          btn.textContent = `⏳ ${job.percent || 0}%`;
        } else if (job.status === 'done') {
          clearInterval(poll);
          state.exporting = false;
          btn.disabled = false;
          btn.textContent = '生成草稿预览';
          const pv = $('preview');
          pv.src = job.output;
          $('stageEmpty').classList.add('hidden');
          try { await pv.play(); } catch { /* autoplay may be blocked */ }
          toast('草稿预览已生成', 'ok');
        } else {
          clearInterval(poll);
          state.exporting = false;
          btn.disabled = false;
          btn.textContent = '生成草稿预览';
          toast(`预览失败：${(job.error || '').slice(0, 220)}`, 'err');
        }
      } catch (err) {
        clearInterval(poll);
        state.exporting = false;
        btn.disabled = false;
        btn.textContent = '生成草稿预览';
        toast(`预览失败：${err.message}`, 'err');
      }
    }, 600);
  } catch (err) {
    state.exporting = false;
    btn.disabled = false;
    btn.textContent = '生成草稿预览';
    toast(`预览失败：${err.message}`, 'err');
  }
}

async function loadExports() {
  try {
    const res = await api('/api/exports');
    const list = $('exportList');
    if (!res.exports.length) { list.innerHTML = '<p class="muted small">还没有导出记录</p>'; return; }
    list.innerHTML = res.exports.map((e) => `
      <div class="export-item">
        <a href="${esc(e.fileName)}" download>${esc(e.fileName)}</a>
        <span class="ex-meta">${esc(e.preset)} · ${esc(e.aspect)} · ${fmtTime(e.duration)} · ${fmtSize(e.size)}${e.draft ? ' · 草稿' : ''}</span>
      </div>`).join('');
  } catch { /* ignore */ }
}

/* ---------------------------------------------------------- privacy --- */
function renderPrivacy() {
  const list = $('privacyList');
  const regions = state.privacyRegions || [];
  $('privacyPanel').classList.toggle('hidden', regions.length === 0);
  if (!regions.length) { list.innerHTML = ''; return; }
  list.innerHTML = regions.map((r, i) => `
    <div class="privacy-item" data-region="${r.id}">
      <span class="pi-mode">#${i + 1}</span>
      <span class="pi-pos">${Math.round(r.x * 100)}%,${Math.round(r.y * 100)}% ${Math.round(r.w * 100)}×${Math.round(r.h * 100)}%</span>
      <select data-mode="${r.id}">
        <option value="blur" ${r.mode === 'blur' ? 'selected' : ''}>模糊</option>
        <option value="pixelate" ${r.mode === 'pixelate' ? 'selected' : ''}>马赛克</option>
        <option value="box" ${r.mode === 'box' ? 'selected' : ''}>色块</option>
      </select>
      <button data-rm="${r.id}" title="删除">✕</button>
    </div>`).join('');
  list.querySelectorAll('[data-rm]').forEach((b) => {
    b.addEventListener('click', async () => {
      state.privacyRegions = state.privacyRegions.filter((r) => r.id !== b.dataset.rm);
      renderPrivacy();
      await savePrivacy();
    });
  });
  list.querySelectorAll('[data-mode]').forEach((s) => {
    s.addEventListener('change', async () => {
      const r = state.privacyRegions.find((x) => x.id === s.dataset.mode);
      if (r) { r.mode = s.value; renderPrivacy(); await savePrivacy(); }
    });
  });
}

async function savePrivacy() {
  try {
    await api('/api/privacy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ regions: state.privacyRegions }),
    });
  } catch (err) { toast(`保存遮挡区域失败：${err.message}`, 'err'); }
}

/* Draw privacy rectangles on the overlay canvas. */
function drawOverlay() {
  const canvas = $('overlay');
  const stage = $('stage');
  const rect = stage.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);

  const regions = state.privacyRegions || [];
  for (const r of regions) {
    const x = r.x * rect.width;
    const y = r.y * rect.height;
    const w = r.w * rect.width;
    const h = r.h * rect.height;
    ctx.fillStyle = r.mode === 'box' ? 'rgba(0,0,0,0.55)' : 'rgba(79,140,255,0.18)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = r.mode === 'box' ? '#f85149' : '#4f8cff';
    ctx.lineWidth = 2;
    ctx.setLineDash(r.mode === 'box' ? [] : [5, 4]);
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);
  }
  if (state.drawStart && state.drawCurrent) {
    const a = state.drawStart;
    const b = state.drawCurrent;
    ctx.strokeStyle = '#ff4d8d';
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    ctx.setLineDash([]);
  }
}

function setupPrivacyDrawing() {
  const canvas = $('overlay');
  const toLocal = (e) => {
    const rect = canvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)),
    };
  };
  canvas.addEventListener('mousedown', (e) => {
    if (!state.privacyMode) return;
    e.preventDefault();
    state.drawStart = toLocal(e);
    state.drawCurrent = state.drawStart;
  });
  window.addEventListener('mousemove', (e) => {
    if (!state.drawStart) return;
    state.drawCurrent = toLocal(e);
    drawOverlay();
  });
  window.addEventListener('mouseup', async () => {
    if (!state.drawStart) return;
    const a = state.drawStart;
    const b = state.drawCurrent || a;
    state.drawStart = null;
    state.drawCurrent = null;
    const w = Math.abs(b.x - a.x);
    const h = Math.abs(b.y - a.y);
    if (w > 0.02 && h > 0.02) {
      state.privacyRegions.push({
        id: `reg_${Date.now()}_${state.privacyRegions.length}`,
        x: Math.min(a.x, b.x), y: Math.min(a.y, b.y),
        w, h, mode: 'blur', color: '#000000',
      });
      renderPrivacy();
      await savePrivacy();
      toast('已添加遮挡区域', 'ok');
    }
    drawOverlay();
  });
}

function updateStageAspect() {
  const stage = $('stage');
  stage.classList.remove('landscape', 'square');
  const a = state.project.aspect || '9:16';
  if (a === '16:9') stage.classList.add('landscape');
  else if (a === '1:1') stage.classList.add('square');
  drawOverlay();
}

/* -------------------------------------------------------------- init -- */
function init() {
  $('browseBtn').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', (e) => { uploadFiles(e.target.files); e.target.value = ''; });

  const dz = $('dropzone');
  ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => {
    e.preventDefault(); dz.classList.add('drag');
  }));
  ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => {
    e.preventDefault(); dz.classList.remove('drag');
  }));
  dz.addEventListener('drop', (e) => uploadFiles(e.dataTransfer.files));

  $('aspectSel').addEventListener('change', async (e) => {
    state.project.aspect = e.target.value;
    updateStageAspect();
    await api('/api/project', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aspect: e.target.value }),
    }).catch(() => {});
  });
  $('resSel').addEventListener('change', async (e) => {
    state.project.resolution = e.target.value;
    await api('/api/project', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resolution: e.target.value }),
    }).catch(() => {});
  });
  $('orderSel').addEventListener('change', async (e) => {
    state.project.order = e.target.value;
    await api('/api/project', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order: e.target.value }),
    }).catch(() => {});
  });
  $('maxClips').addEventListener('input', (e) => { $('maxClipsVal').textContent = e.target.value; });
  $('maxClips').addEventListener('change', async (e) => {
    state.project.maxClips = Number(e.target.value);
    await api('/api/project', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxClips: Number(e.target.value) }),
    }).catch(() => {});
  });

  $('btnAutoEdit').addEventListener('click', autoEdit);
  $('btnExport').addEventListener('click', () => exportVideo(false));
  $('btnDraft').addEventListener('click', makePreview);

  $('ceClose').addEventListener('click', () => { state.activeClipId = null; $('clipEditor').classList.add('hidden'); renderTimeline(); });
  $('ceIn').addEventListener('input', (e) => updateClipTrim('in', e.target.value));
  $('ceIn').addEventListener('change', saveTimeline);
  $('ceOut').addEventListener('input', (e) => updateClipTrim('out', e.target.value));
  $('ceOut').addEventListener('change', saveTimeline);
  $('ceTransition').addEventListener('change', async (e) => {
    const clip = findClip(state.activeClipId);
    if (!clip) return;
    clip.transition = clip.transition || { type: 'fade', duration: 0.3 };
    clip.transition.type = e.target.value;
    if (e.target.value === 'cut') clip.transition.duration = 0;
    else if (!clip.transition.duration) clip.transition.duration = 0.3;
    renderTimeline();
    await saveTimeline();
  });
  $('ceTd').addEventListener('input', (e) => { $('ceTdVal').textContent = `${Number(e.target.value).toFixed(2)}s`; });
  $('ceTd').addEventListener('change', async (e) => {
    const clip = findClip(state.activeClipId);
    if (!clip) return;
    clip.transition = clip.transition || { type: 'fade', duration: 0.3 };
    clip.transition.duration = Number(e.target.value);
    renderTimeline();
    await saveTimeline();
  });
  $('ceRemove').addEventListener('click', removeClip);
  $('cePrev').addEventListener('click', () => moveClip(-1));
  $('ceNext').addEventListener('click', () => moveClip(1));

  $('privacyMode').addEventListener('change', (e) => {
    state.privacyMode = e.target.checked;
    $('overlay').classList.toggle('off', !state.privacyMode);
    $('privacyHint').classList.toggle('hidden', !state.privacyMode);
    drawOverlay();
  });
  $('privacyClear').addEventListener('click', async () => {
    state.privacyRegions = [];
    renderPrivacy();
    await savePrivacy();
  });

  window.addEventListener('resize', drawOverlay);
  setupPrivacyDrawing();
  loadExports();
  boot();
}

document.addEventListener('DOMContentLoaded', init);
