/**
 * Replace the `<owner>` / `OWNER` placeholder with the real GitHub handle.
 *
 * The repository is published under a handle that is only known once the
 * GitHub account exists, so the clone URL, the issue tracker and the homepage
 * are written with a placeholder. Run this once after the repository has been
 * created:
 *
 *   node scripts/set-repo-owner.js your-github-handle
 *
 * It rewrites the placeholders in README.md, CONTRIBUTING.md, CHANGELOG.md and
 * package.json in place. It touches nothing else and does not touch git
 * history.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

const TARGETS = ['README.md', 'CONTRIBUTING.md', 'CHANGELOG.md', 'package.json'];

// GitHub handles: alphanumeric and single hyphens, 39 characters max.
const HANDLE_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

const handle = (process.argv[2] || '').trim();

if (!handle) {
  console.error('Usage: node scripts/set-repo-owner.js <github-handle>');
  console.error('Example: node scripts/set-repo-owner.js octocat');
  process.exit(1);
}

if (!HANDLE_RE.test(handle)) {
  console.error(`"${handle}" is not a valid GitHub handle.`);
  console.error('Handles use letters, digits and single hyphens, max 39 characters.');
  process.exit(1);
}

let changed = 0;
for (const rel of TARGETS) {
  const file = path.join(PROJECT_ROOT, rel);
  if (!fs.existsSync(file)) continue;
  const before = fs.readFileSync(file, 'utf8');
  const after = before
    .replace(/github\.com\/<owner>\//g, `github.com/${handle}/`)
    .replace(/github\.com\/OWNER\//g, `github.com/${handle}/`);
  if (after !== before) {
    fs.writeFileSync(file, after);
    console.log(`  updated  ${rel}`);
    changed += 1;
  } else {
    console.log(`  no change ${rel}`);
  }
}

console.log(`\n  Owner set to "${handle}" in ${changed} file(s).`);
console.log('  Review the diff, then commit it.\n');
