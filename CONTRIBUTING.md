# Contributing

PDFreader currently targets Windows 10/11 x64. Keep changes focused on reading,
annotation integrity, selection translation, or a clearly described issue.

## Build

Install Node.js 24+, stable Rust (1.90+), the Visual Studio C++ toolchain and
Windows SDK, and Microsoft Edge WebView2 Runtime. Then:

```powershell
npm ci
npm run desktop:dev
npm run desktop:build
npm run desktop:bundle
```

`desktop:build` creates an EXE; `desktop:bundle` creates the primary NSIS installer.
The launcher also supports a project-local Rust toolchain under `.local` without
requiring that layout for contributors. Commit both dependency lock files.

## Checks

```powershell
python -m pip install pypdf Pillow
npm run test:stage02
npm run test:stage03
npm run test:stage04
npm run test:stage05
npm run test:workspace
npm run test:native
```

Install Poppler and put `pdftoppm` on PATH for the independent PDF rendering
check in `test:stage02` (Windows: `choco install poppler`; CI also locates its bin
directory explicitly). Python is only for test fixtures and independent PDF inspection. Some native
HTTP/credential tests are opt-in (`npm run test:native -- -- --include-ignored`).
They use loopback servers and a temporary dummy credential, not a paid provider.
Desktop UI checks require a Windows desktop and system Edge; see scripts named
`verify-*`. Regenerate fixtures with `python scripts/stage02-fixtures.py` first.
The browser/workspace fixtures explicitly mock translation; never treat them as
proof of a live provider response. Do not add provider calls to CI.

## PDF.js and licensing

The pinned generic viewer is vendored under `public/pdfjs`. Host integration
lives in `bridge.mjs`, viewer preferences/styles, and the standalone note patch.
Apply `scripts/patch-pdfjs-notes.mjs` only to the matching upstream version after
reviewing its guards; upgrading requires rerunning annotation/export regressions.
Keep upstream notices and regenerate both runtime license inventories before
distributing a build. `NOTICE` lists original and third-party components.

Avoid committing API keys, real documents, reading history, application data,
credentials, generated logs, or build/tool caches. Use the original demonstration
PDFs under `docs/assets` when filing a reproducible issue or capturing screenshots.
