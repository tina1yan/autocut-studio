# Contributing to AutoCut Studio

Thanks for taking a look. This document explains how to get set up and what is
expected of a change.

## Getting set up

```bash
git clone https://github.com/tina1yan/autocut-studio.git
cd autocut-studio

npm install --ignore-scripts
npm run setup:ffmpeg
npm run make-samples
```

`--ignore-scripts` is intentional: the project fetches FFmpeg itself through
`npm run setup:ffmpeg` rather than letting an npm lifecycle script do it.

Then start the app:

```bash
npm start          # http://127.0.0.1:3210
npm run dev        # same, with auto-restart on file changes
```

## Running the tests

Run the whole suite before opening a pull request:

```bash
npm test                          # 35 unit tests
node --test tests/api.test.js     # 11 API integration tests
npm run smoke                     # 18 export smoke tests
node tests/e2e-live.js            # 18 user-journey tests
node tests/verify-output.js       # 7 pixel-level tests
npm run verify:sample             # 9 sample verification checks
```

Two suites drive a **running** application, so start it first:

```bash
node tests/acceptance-morning.js   # 8-step final acceptance
node tests/reset-while-running.js  # 10 reset regression checks
```

Tests use an isolated state directory (`server/state/test-run/`) and never
touch `server/state/project.json`, so they will not damage a project you are
working on.

## Code style

- ES modules, Node 20+.
- Two-space indentation, semicolons, single quotes.
- Comments explain *why*, not *what*. Match the density of the file you are
  editing — the existing files are sparsely commented and that is deliberate.
- Keep the front end dependency-free: vanilla HTML/CSS/JS, no framework, no
  CDN, no build step. Adding a bundler would break the "clone and run"
  promise.

## What a good pull request looks like

- **One concern per PR.** Bug fixes and features should not be mixed.
- **A test.** Every behavioural change needs a test that fails before the fix
  and passes after. The existing suites are the model — see
  `docs/TEST-REPORT.md` §9 for how previous defects were turned into
  regression tests.
- **Honest verification.** If you cannot run a test, say so in the PR
  description. Do not claim results you did not observe.
- **Update the docs.** `README.md` if behaviour or commands changed;
  `CHANGELOG.md` under *Unreleased* for user-visible changes.

## Things that are deliberately out of scope

- Adding a front-end framework or build step.
- Adding a cloud backend, telemetry, or any code path that sends media off
  the machine. The local-only property is the point of the project.
- Copying code, assets or branding from commercial editors. If you want to
  match a competitor's behaviour, implement it from FFmpeg's documented
  filter primitives.
- Committing FFmpeg binaries, node_modules, uploads, exports or runtime state.
  `.gitignore` already covers these; please do not override it.

## Reporting bugs

Open an issue with:

- What you did, what you expected, and what happened instead.
- Your OS, Node version and FFmpeg version (`npm run check` prints the
  environment).
- The relevant part of the console output.

If the problem only happens with specific footage, note whether it is H.264 or
HEVC, and its resolution, duration and audio layout.

## License

By contributing, you agree that your contributions are licensed under the
project's MIT License.
