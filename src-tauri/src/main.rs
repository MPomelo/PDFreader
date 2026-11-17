#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use serde::Serialize;
use std::{collections::HashSet, path::PathBuf, sync::Mutex};
mod files;
mod secrets;
mod http;
mod sse;
mod translation;
mod local;
mod launch;

#[derive(Default)]
struct AllowedFiles(Mutex<HashSet<PathBuf>>);
#[derive(Serialize)]
struct OpenedPdf { name: String, path: String, bytes: Vec<u8> }

#[tauri::command]
async fn export_pdf(bytes: Vec<u8>, suggested_name: String, state: tauri::State<'_, AllowedFiles>) -> Result<Option<String>, String> {
    let originals: Vec<PathBuf> = state.0.lock().map_err(|e| e.to_string())?.iter().cloned().collect();
    tauri::async_runtime::spawn_blocking(move || {
        let Some(path) = rfd::FileDialog::new().set_title("导出带批注的 PDF（保留原件）")
            .add_filter("PDF", &["pdf"]).set_file_name(&suggested_name).save_file() else { return Ok(None); };
        let target = files::export_target(&path, &originals)?;
        files::atomic_export(&target, &bytes)?;
        Ok(Some(target.to_string_lossy().into_owned()))
    }).await.map_err(|e| e.to_string())?
}
#[tauri::command]
fn finish_close(window: tauri::WebviewWindow) -> Result<(), String> {
    window.destroy().map_err(|e| e.to_string())
}

fn allow(path: PathBuf, state: &AllowedFiles) -> Result<String, String> {
    let path = path.canonicalize().map_err(|e| e.to_string())?;
    if !path.is_file() || !path.extension().and_then(|v| v.to_str()).is_some_and(|v| v.eq_ignore_ascii_case("pdf")) {
        return Err("请选择 PDF 文件".into());
    }
    state.0.lock().map_err(|e| e.to_string())?.insert(path.clone());
    Ok(path.to_string_lossy().into_owned())
}
#[tauri::command]
async fn choose_pdf(state: tauri::State<'_, AllowedFiles>) -> Result<Option<String>, String> {
    // Match the working save-dialog path: initialize the native dialog on its
    // own blocking thread, keeping WebView2's IPC/COM thread responsive.
    let candidate = tauri::async_runtime::spawn_blocking(|| rfd::FileDialog::new().add_filter("PDF", &["pdf"]).pick_file())
        .await.map_err(|error| error.to_string())?;
    candidate.map(|path| allow(path, &state)).transpose()
}
#[tauri::command]
async fn choose_pdfs(state: tauri::State<'_, AllowedFiles>) -> Result<Vec<String>, String> {
    let candidates = tauri::async_runtime::spawn_blocking(|| rfd::FileDialog::new().add_filter("PDF", &["pdf"]).pick_files())
        .await.map_err(|error| error.to_string())?.unwrap_or_default();
    candidates.into_iter().map(|path| allow(path, &state)).collect()
}
#[tauri::command]
fn startup_pdf(state: tauri::State<AllowedFiles>) -> Result<Option<String>, String> {
    let candidate = std::env::args_os().skip(1).map(PathBuf::from)
        .find(|p| p.extension().and_then(|v| v.to_str()).is_some_and(|v| v.eq_ignore_ascii_case("pdf")));
    candidate.map(|p| allow(p, &state)).transpose()
}
#[tauri::command]
fn read_pdf(path: String, state: tauri::State<AllowedFiles>) -> Result<OpenedPdf, String> {
    let path = PathBuf::from(path).canonicalize().map_err(|e| e.to_string())?;
    if !state.0.lock().map_err(|e| e.to_string())?.contains(&path) { return Err("文件未经打开操作授权".into()); }
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    if !bytes.starts_with(b"%PDF-") { return Err("文件不是有效的 PDF".into()); }
    Ok(OpenedPdf { name: path.file_name().unwrap_or_default().to_string_lossy().into_owned(), path: path.to_string_lossy().into_owned(), bytes })
}
fn main() {
    use tauri::{Emitter, Manager};
    tauri::Builder::default().manage(AllowedFiles::default()).manage(launch::IncomingPdfs::default())
        .manage(translation::ApiState::default()).manage(local::LocalState::default())
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            launch::enqueue(args, std::path::Path::new(&cwd), &app.state::<launch::IncomingPdfs>(), &app.state::<AllowedFiles>());
            let _ = app.emit("pdfs-queued", ());
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show(); let _ = window.unminimize(); let _ = window.set_focus();
            }
        }))
        .setup(|app| {
            let cwd = std::env::current_dir()?;
            launch::enqueue(std::env::args(), &cwd, &app.state::<launch::IncomingPdfs>(), &app.state::<AllowedFiles>());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![choose_pdf, choose_pdfs, startup_pdf, launch::startup_pdfs, read_pdf, export_pdf, finish_close,
            local::local_read, local::local_write, local::local_recover, local::reopen_pdf, local::export_notes,
            translation::api_load, translation::api_save, translation::api_secret_status,
            translation::api_secret_save, translation::api_secret_delete, translation::api_request, translation::api_stream_request, translation::api_cancel])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // Always let the shell flush active text/ink before deciding.
                api.prevent_close();
                let _ = window.emit("close-requested", ());
            }
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                let mut opened = Vec::new();
                for path in paths {
                    match allow(path.clone(), &window.state::<AllowedFiles>()) {
                        Ok(path) => opened.push(path),
                        Err(message) => { let _ = window.emit("pdf-open-error", message); }
                    }
                }
                if !opened.is_empty() { let _ = window.emit("pdfs-dropped", opened); }
            }
        })
        .run(tauri::generate_context!()).expect("PDFreader could not start");
}
