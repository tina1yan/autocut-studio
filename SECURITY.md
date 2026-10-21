# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| 1.0.x | ✅ |

## Reporting a vulnerability

Please report security issues privately rather than opening a public issue.
Use GitHub's **Security → Report a vulnerability** button on the repository
page, which opens a private advisory.

Include:

- A description of the issue and its impact.
- Steps to reproduce.
- The version affected, and your OS / Node / FFmpeg versions (`npm run check`
  prints these).

You can expect an acknowledgement within a few days. Fixes for confirmed
issues are released as a patch version and credited in `CHANGELOG.md` unless
you would prefer otherwise.

## Threat model

AutoCut Studio is a **single-user, local desktop tool**. It is designed to run
on one machine, for one person, handling one project.

### What the project does

- Binds the HTTP server to `127.0.0.1` only, so it is not reachable from the
  local network.
- Reads and writes media under the project directory.
- Shells out to FFmpeg and FFprobe as subprocesses.

### Security properties

- **No network egress at runtime.** There is no telemetry, no analytics, no
  crash reporting and no update check. The only network access the project
  ever makes is the one-time `npm install` and the one-time FFmpeg download.
- **No API keys or accounts.** Nothing is configured, so nothing can leak.
- **No model downloads.** The editing is done with FFmpeg's built-in filters.
- **Original implementation.** No code, assets or branding from CapCut, 剪映
  or any other commercial editor is included.

### Known limitations of this threat model

- **The server has no authentication.** Anyone who can reach `127.0.0.1:3210`
  on the same machine can use the app — including uploading arbitrary files
  for processing. On a shared or multi-user machine, do not run it, or run it
  behind a firewall rule that blocks the port.
- **The upload endpoint accepts any file the OS lets it write**, and the
  extension allow-list (`.mp4 .mov .m4v .webm .mkv .avi`) is checked *after*
  the file is written to disk. A file with a disallowed extension is deleted
  immediately, but it is briefly on disk. The 2 GB size limit is enforced by
  the upload middleware.
- **FFmpeg is invoked with filenames as arguments.** Arguments are passed
  through `spawn` without a shell, so shell metacharacters are not
  interpreted, but FFmpeg's own file-format probing is the remaining
  attack surface for hostile media.
- **Rendered output is served from `exports/` and `media/work/`** over the
  same local HTTP server. The Range-request handler resolves paths relative
  to those roots and checks the result stays inside the root.
- **The project state is a plain JSON file** (`server/state/project.json`).
  It contains file paths and project settings, not secrets.

### Out of scope

- Vulnerabilities in FFmpeg itself — please report those to the FFmpeg
  project.
- Vulnerabilities in the npm dependency tree. `npm audit` covers these and
  they are patched by updating `package-lock.json`.
- Physical access to the machine running the app.

## Hardening for shared machines

If you need to run AutoCut Studio on a machine other people can reach:

1. Bind it to a different interface only if you have added authentication —
   as shipped, do not expose the port.
2. Use a Windows Firewall rule to block inbound connections to the port.
3. Keep the project directory on a volume you control, and review
   `media/uploads/` periodically — uploaded media is retained until you
   delete it.
