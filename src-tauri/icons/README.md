# Windows application icon

`app-icon.svg` is the existing Fluent System Icons `DocumentPdf20Regular` from
`@fluentui/react-icons` 2.0.316, rendered with the application's `#0f6cbd` accent.
It is covered by the MIT notice in `public/licenses/Fluent-System-Icons.txt`.

`icon.ico` was generated with the already locked Tauri CLI 2.12.4:

```powershell
node node_modules/@tauri-apps/cli/tauri.js icon src-tauri/icons/app-icon.svg --output .local/generated-icons
Copy-Item -LiteralPath .local/generated-icons/icon.ico -Destination src-tauri/icons/icon.ico
```

Only the Windows ICO is needed for STAGE-01. Other generated platforms remain
temporary build tooling output. The ICO is required by `tauri-build` even when
installer bundling is disabled.
