/**
 * Reset the project to a pristine state: clear the timeline, remove imported
 * media, and drop stale upload/preview files.
 *
 * Already exported files are KEPT — they are finished artifacts, and the
 * export list is preserved so they stay downloadable from the UI.
 *
 * Run:  node scripts/reset-project.js
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROJECT_ROOT } from '../server/ffmpeg.js';
import * as store from '../server/lib/store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Preserve the export list across the reset, but only for files that are
// still on disk — a dangling entry would show a broken download link.
const exportDir = path.join(PROJECT_ROOT, 'exports');
const keptExports = (store.getProject().exports || [])
  .filter((e) => e.fileName && fs.existsSync(path.join(exportDir, e.fileName)));
store.resetProject();
if (keptExports.length) {
  store.updateProject({ exports: keptExports });
}

let removed = 0;
for (const dir of ['media/uploads', 'media/work']) {
  const full = path.join(PROJECT_ROOT, dir);
  if (!fs.existsSync(full)) continue;
  for (const name of fs.readdirSync(full)) {
    if (name === '.gitkeep') continue;
    try {
      fs.unlinkSync(path.join(full, name));
      removed += 1;
    } catch { /* ignore */ }
  }
}

console.log('Project reset.');
console.log(`  state file : ${store.stateFilePath()}`);
console.log(`  files      : 0`);
console.log(`  clips      : 0`);
console.log(`  exports    : ${keptExports.length} (kept)`);
console.log(`  removed    : ${removed} media file(s)`);
