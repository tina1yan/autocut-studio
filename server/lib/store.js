/**
 * In-memory project store with JSON persistence.
 *
 * One active project at a time. State lives in server/state/project.json so a
 * restart does not lose the user's import list and timeline.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../ffmpeg.js';

const STATE_DIR = process.env.AUTOCUT_STATE_DIR
  ? path.resolve(process.env.AUTOCUT_STATE_DIR)
  : path.join(PROJECT_ROOT, 'server', 'state');
const STATE_FILE = path.join(STATE_DIR, 'project.json');

function defaultProject() {
  return {
    id: 'default',
    name: 'Untitled Project',
    preset: 'dramatic',
    aspect: '9:16',
    resolution: '1080',
    order: 'chronological',
    maxClips: 12,
    files: [],
    clips: [],
    privacy: [],
    exports: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

let project = defaultProject();
/**
 * Signature of the state file as this process last read or wrote it.
 * Combines mtime and size so a change is detected even when the filesystem's
 * timestamp granularity is coarse.
 */
let stateSig = '';

export function loadProject() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      project = { ...defaultProject(), ...parsed };
      pruneMissingMedia();
      try {
        const st = fs.statSync(STATE_FILE);
        stateSig = `${st.mtimeMs}:${st.size}`;
      } catch { /* ignore */ }
    }
  } catch (err) {
    console.error('[store] failed to load project state:', err.message);
    project = defaultProject();
  }
  return project;
}

/**
 * Reload the project if the state file was changed by another process.
 *
 * `npm run reset` and `scripts/reset-project.js` run in their own process and
 * rewrite the state file behind the server's back. Without this, the running
 * server keeps a stale in-memory project whose media no longer exists on
 * disk, and the next render dies with "Error opening input file".
 */
function syncIfChanged() {
  let sig = '';
  try {
    const st = fs.statSync(STATE_FILE);
    sig = `${st.mtimeMs}:${st.size}`;
  } catch {
    // The state file was deleted -> fall back to an empty project.
    if (stateSig !== '') {
      console.warn('[store] state file disappeared, resetting project');
      project = defaultProject();
      stateSig = '';
    }
    return;
  }
  if (sig === stateSig) return;

  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    project = { ...defaultProject(), ...parsed };
    console.warn('[store] state file changed on disk, reloaded project');
  } catch (err) {
    console.error('[store] failed to reload project state:', err.message);
  }
  stateSig = sig;
  pruneMissingMedia();
}

/**
 * Drop files whose media has disappeared, together with the clips that
 * reference them. Returns the names that were dropped.
 */
export function pruneMissingMedia() {
  const before = (project.files || []).length;
  const dropped = [];
  project.files = (project.files || []).filter((f) => {
    const ok = f.path && fs.existsSync(f.path);
    if (!ok) dropped.push(f.name || f.id);
    return ok;
  });
  if (project.files.length !== before) {
    const kept = new Set(project.files.map((f) => f.id));
    project.clips = (project.clips || []).filter((c) => kept.has(c.fileId));
    for (const name of dropped) {
      console.warn(`[store] dropping missing media: ${name}`);
    }
    saveProject();
  }
  return dropped;
}

export function stateFilePath() {
  return STATE_FILE;
}

export function getProject() {
  syncIfChanged();
  return project;
}

/**
 * Sync with the state file before mutating.
 *
 * Every mutator must call this first: otherwise a change made by another
 * process (e.g. `npm run reset`) would be silently overwritten by this
 * process's stale in-memory copy on the next save.
 */
function syncBeforeWrite() {
  syncIfChanged();
}

export function updateProject(patch) {
  syncBeforeWrite();
  project = { ...project, ...patch, updatedAt: new Date().toISOString() };
  saveProject();
  return project;
}

export function saveProject() {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    // Write to a temp file and rename, so a crash mid-write can never leave
    // a truncated/corrupt state file behind.
    const tmp = `${STATE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(project, null, 2), 'utf8');
    fs.renameSync(tmp, STATE_FILE);
    // Remember the file we just wrote, so syncIfChanged() does not mistake
    // our own write for an external change.
    try {
      const st = fs.statSync(STATE_FILE);
      stateSig = `${st.mtimeMs}:${st.size}`;
    } catch { /* ignore */ }
  } catch (err) {
    console.error('[store] failed to persist project state:', err.message);
  }
}

/**
 * Delete upload files that are no longer referenced by the project.
 * Keeps the media directory from growing without bound.
 */
export function pruneOrphanUploads(uploadDir) {
  try {
    if (!fs.existsSync(uploadDir)) return 0;
    const keep = new Set(store().files.map((f) => f.storedName).filter(Boolean));
    let removed = 0;
    for (const name of fs.readdirSync(uploadDir)) {
      if (!keep.has(name)) {
        try {
          fs.unlinkSync(path.join(uploadDir, name));
          removed += 1;
        } catch { /* ignore individual failures */ }
      }
    }
    return removed;
  } catch (err) {
    console.error('[store] failed to prune orphan uploads:', err.message);
    return 0;
  }
}

function store() {
  return project;
}

export function resetProject() {
  project = defaultProject();
  saveProject();
  return project;
}

/**
 * Re-read the project from disk. Called after a reset performed by another
 * process so the server drops the clips that pointed at deleted media.
 */
export function reloadProject() {
  loadProject();
  return project;
}

export function addFile(fileRecord) {
  syncBeforeWrite();
  project.files.push(fileRecord);
  saveProject();
  return fileRecord;
}

export function removeFile(fileId) {
  syncBeforeWrite();
  const file = project.files.find((f) => f.id === fileId);
  project.files = project.files.filter((f) => f.id !== fileId);
  project.clips = project.clips.filter((c) => c.fileId !== fileId);
  saveProject();
  return file;
}

export function addExport(record) {
  syncBeforeWrite();
  project.exports.unshift(record);
  project.exports = project.exports.slice(0, 25);
  saveProject();
  return record;
}
