# Windows application icon

`app-icon.svg` is the project's original geometric P icon: an abstract triangular
loop on a solid `#BF293B` red tile, with a `#68B7F0` blue stem. The triangle's left
beam and its blue extension are both 33 SVG units wide. The extension joins below
the outside diagonal so the complete triangle remains visible. This project
artwork is covered by the repository's MIT license.

`icon.ico` was generated with the already locked Tauri CLI 2.12.4:

```powershell
node node_modules/@tauri-apps/cli/tauri.js icon src-tauri/icons/app-icon.svg --output .local/generated-icons
Copy-Item -LiteralPath .local/generated-icons/icon.ico -Destination src-tauri/icons/icon.ico
Copy-Item -LiteralPath .local/generated-icons/icon.png -Destination src-tauri/icons/app-icon.png
```

The Windows build consumes `icon.ico`; `app-icon.png` is a raster preview of the
same SVG. Other generated platforms remain temporary build tooling output. The
ICO is required by `tauri-build` even when installer bundling is disabled.
