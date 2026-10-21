# Changelog

All notable changes to AutoCut Studio are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2026-10-21

First public release.

### Added

- **Drag-and-drop import** of MP4 / MOV / M4V / WebM / MKV / AVI, with multi-select
  and background analysis that keeps the UI responsive.
- **Automatic scene detection** using FFmpeg's `select` filter.
- **Automatic silence detection and removal** using `silencedetect`, with
  per-preset thresholds and minimum durations.
- **Loudness measurement and normalization** using `ebur128` (LUFS).
- **Automatic multi-clip assembly** — segments from every source are scored,
  trimmed to the preset's pacing and interleaved into a timeline.
- **Six editing presets** — Dramatic, Cinematic, Montage, Travel Vlog, Funny Meme
  and Minimal Clean. Each one changes the rendered output, verified by pixel
  comparison rather than by inspection.
- **Visual timeline** with per-clip in/out trimming, transition type and duration,
  reordering and removal.
- **Real video preview** — low-resolution draft rendering with HTTP Range
  support so the `<video>` element can seek.
- **MP4 export** via FFmpeg (H.264 + AAC, `yuv420p`, `+faststart`) with live
  progress reporting.
- **Aspect ratio output** — 9:16 portrait, 16:9 landscape and 1:1 square, with
  correct orientation and optional letterboxing.
- **Privacy redaction** — drag a region to blur, pixelate or black it out. Baked
  into the export; the source file is never modified.
- **Windows launcher** (`Start-AutoCut.cmd`) that provisions FFmpeg, installs
  dependencies on first run, starts the server and opens the browser. It never
  terminates a process it does not own.
- **Automated test suite** — 116 checks across unit, API integration, export
  smoke, end-to-end journey, pixel-level output, final acceptance and reset
  regression suites. See [docs/TEST-REPORT.md](docs/TEST-REPORT.md).
- **Verification scripts** — `npm run check` (environment self-check),
  `npm run verify:sample` (ffprobe + full decode + frame count on the shipped
  sample) and `npm run make-samples` (synthetic test material).

### Security

- Upgraded `multer` from 1.x to 2.x. The 1.x line is deprecated upstream and
  carries advisories that are only fixed in 2.x. The upload API is unchanged;
  the full test suite passes on 2.4.0 and `npm audit` reports 0 vulnerabilities.

### Fixed

During development the following real defects were found and fixed. The full
list, with reproduction and regression coverage, is in
[docs/TEST-REPORT.md](docs/TEST-REPORT.md) §9.

- `unsharp` filter requires an **odd** matrix size; the Meme preset used an even
  one and failed to render.
- FFmpeg's `overlay` filter takes its output size from the **main** input, so
  the privacy overlay was cropping the output instead of covering a region.
- The launcher's batch script had an unescaped `)` that broke startup, and it
  used to `taskkill` whatever process held port 3210.
- The preview stage was distorted in portrait because `width:auto` filled a
  block-level box.
- The state file could be left truncated by a crash mid-write; it is now
  written to a temp file and renamed atomically.
- Exporting with a missing source file surfaced a raw FFmpeg error; it now
  reports a clear message.
- The test suite shared the real project's state file and could overwrite a
  project in progress; tests now use an isolated state directory.
- Reloading the page left a stale empty-state message and a stale export
  status; both are now restored from the saved project.
- Running `npm run reset` while the server was up left the server holding a
  stale in-memory project whose media no longer existed. The store now detects
  external state-file changes and reloads, and every write re-syncs first.

[1.0.0]: https://github.com/tina1yan/autocut-studio/releases/tag/v1.0.0
