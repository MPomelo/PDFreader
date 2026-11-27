#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::{HashSet, VecDeque},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::SystemTime,
};

mod files;
mod secrets;
mod http;
mod openai_compat;
mod sse;
mod translation;
mod chat;
mod chat_api;
mod chatgpt;
mod chatgpt_oauth;
mod local;
mod launch;
mod poppler;
mod text;
mod update;

const PDF_LAYOUT_CACHE_CAPACITY: usize = 4;

#[derive(Default)]
struct AllowedFiles(Mutex<HashSet<PathBuf>>);

#[derive(Serialize)]
struct PdfMeta {
    name: String,
    path: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct PdfCacheKey {
    path: PathBuf,
    len: u64,
    modified: Option<SystemTime>,
}

struct PdfCacheEntry {
    key: PdfCacheKey,
    fingerprint: String,
    bytes: Arc<Vec<u8>>,
}

/// 为 `native_page_layout` 缓存最近打开的少数 PDF 原始字节与 SHA-256 指纹，
/// 避免每次翻页重复整文件读盘与重算哈希。
#[derive(Clone, Default)]
struct PdfLayoutCache(Arc<Mutex<VecDeque<PdfCacheEntry>>>);

impl PdfLayoutCache {
    fn get(&self, key: &PdfCacheKey) -> Option<(String, Arc<Vec<u8>>)> {
        let mut entries = self.0.lock().ok()?;
        let index = entries.iter().position(|entry| &entry.key == key)?;
        let entry = entries.remove(index)?;
        let result = (entry.fingerprint.clone(), Arc::clone(&entry.bytes));
        entries.push_back(entry);
        Some(result)
    }

    fn insert(&self, key: PdfCacheKey, fingerprint: String, bytes: Arc<Vec<u8>>) {
        let Ok(mut entries) = self.0.lock() else { return };
        // 同一路径文件变更后替换旧槽位，避免同文件占用多个 LRU 槽位
        entries.retain(|entry| entry.key.path != key.path);
        while entries.len() >= PDF_LAYOUT_CACHE_CAPACITY {
            entries.pop_front();
        }
        entries.push_back(PdfCacheEntry { key, fingerprint, bytes });
    }

    fn load_verified(&self, path: &Path, expected_fingerprint: &str) -> Option<Arc<Vec<u8>>> {
        let metadata = std::fs::metadata(path).ok()?;
        let key = PdfCacheKey {
            path: path.to_path_buf(),
            len: metadata.len(),
            modified: metadata.modified().ok(),
        };
        if let Some((cached_fingerprint, bytes)) = self.get(&key) {
            return (cached_fingerprint == expected_fingerprint).then_some(bytes);
        }
        let bytes = Arc::new(std::fs::read(path).ok()?);
        let computed = format!("{:x}", Sha256::digest(bytes.as_ref()));
        self.insert(key, computed.clone(), Arc::clone(&bytes));
        (computed == expected_fingerprint).then_some(bytes)
    }
}

fn authorized_pdf_path(path: &str, state: &AllowedFiles) -> Result<PathBuf, String> {
    let canonical = PathBuf::from(path).canonicalize().map_err(|e| e.to_string())?;
    if !state.0.lock().map_err(|e| e.to_string())?.contains(&canonical) {
        return Err("文件未经打开操作授权".into());
    }
    if document_extension(&canonical) != Some("pdf") {
        return Err("请选择 PDF 文件".into());
    }
    Ok(canonical)
}

fn read_validated_pdf_bytes(path: &Path) -> Result<Vec<u8>, String> {
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    if !bytes.starts_with(b"%PDF-") {
        return Err("文件不是有效的 PDF".into());
    }
    Ok(bytes)
}

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

fn document_extension(path: &Path) -> Option<&'static str> {
    let extension = path.extension()?.to_str()?;
    ["pdf", "txt", "md", "markdown"].into_iter().find(|kind| extension.eq_ignore_ascii_case(kind))
}

fn allow(path: PathBuf, state: &AllowedFiles) -> Result<String, String> {
    let path = path.canonicalize().map_err(|e| e.to_string())?;
    if !path.is_file() || document_extension(&path).is_none() {
        return Err("请选择 PDF、Markdown 或 TXT 文件".into());
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
async fn choose_documents(state: tauri::State<'_, AllowedFiles>) -> Result<Vec<String>, String> {
    let candidates = tauri::async_runtime::spawn_blocking(|| rfd::FileDialog::new().add_filter("文档", &["pdf", "md", "markdown", "txt"])
        .add_filter("PDF", &["pdf"]).add_filter("Markdown", &["md", "markdown"]).add_filter("TXT", &["txt"]).pick_files())
        .await.map_err(|error| error.to_string())?.unwrap_or_default();
    candidates.into_iter().map(|path| allow(path, &state)).collect()
}

#[tauri::command]
fn resolve_pdf_meta(path: String, state: tauri::State<AllowedFiles>) -> Result<PdfMeta, String> {
    let path = authorized_pdf_path(&path, &state)?;
    Ok(PdfMeta {
        name: path.file_name().unwrap_or_default().to_string_lossy().into_owned(),
        path: path.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
async fn read_pdf_bytes(path: String, state: tauri::State<'_, AllowedFiles>) -> Result<tauri::ipc::Response, String> {
    let path = authorized_pdf_path(&path, &state)?;
    let bytes = tauri::async_runtime::spawn_blocking(move || read_validated_pdf_bytes(&path))
        .await
        .map_err(|e| e.to_string())??;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
async fn native_page_layout(
    path: String,
    fingerprint: String,
    page: u32,
    state: tauri::State<'_, AllowedFiles>,
    cache: tauri::State<'_, PdfLayoutCache>,
) -> Result<Option<poppler::PageLayout>, String> {
    if !poppler::enabled() || page == 0 {
        return Ok(None);
    }
    let path = authorized_pdf_path(&path, &state)?;
    let cache = cache.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = cache.load_verified(&path, &fingerprint)?;
        poppler::page_layout(&bytes, page)
    }).await.map_err(|e| e.to_string())
}

fn main() {
    use tauri::{Emitter, Manager};
    tauri::Builder::default()
        .manage(AllowedFiles::default())
        .manage(PdfLayoutCache::default())
        .manage(launch::IncomingPdfs::default())
        .manage(text::TextFiles::default())
        .manage(translation::ApiState::default())
        .manage(local::LocalState::default())
        .manage(chatgpt::ChatGptState::default())
        .manage(update::UpdateState::default())
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            launch::enqueue(args, Path::new(&cwd), &app.state::<launch::IncomingPdfs>(), &app.state::<AllowedFiles>());
            let _ = app.emit("pdfs-queued", ());
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show(); let _ = window.unminimize(); let _ = window.set_focus();
            }
        }))
        .setup(|app| {
            let cwd = std::env::current_dir()?;
            launch::enqueue(std::env::args(), &cwd, &app.state::<launch::IncomingPdfs>(), &app.state::<AllowedFiles>());
            update::clean_cache(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            choose_pdf, choose_documents, launch::startup_pdfs, resolve_pdf_meta, read_pdf_bytes, export_pdf, finish_close,
            native_page_layout, text::read_text, text::choose_text_destination, text::save_text,
            text::store_text_image, text::read_text_image, text::read_dropped_image,
            local::local_read, local::local_write, local::local_recover, local::reopen_pdf, local::reopen_workspace_document, local::export_notes, local::export_chat,
            translation::api_load, translation::api_save, translation::api_secret_status,
            translation::api_secret_save, translation::api_secret_delete, translation::api_request, translation::api_stream_request, translation::api_cancel,
            chat::chat_secret_status, chat::chat_secret_save, chat::chat_secret_delete, chat::chat_ollama_models, chat::chat_request,
            chat_api::chat_api_profiles, chat_api::chat_api_save_profile, chat_api::chat_api_delete_profile,
            chat_api::chat_api_secret_status, chat_api::chat_api_secret_save, chat_api::chat_api_secret_delete, chat_api::chat_api_models,
            chatgpt::chatgpt_status, chatgpt::chatgpt_sign_in, chatgpt::chatgpt_cancel_sign_in, chatgpt::chatgpt_select_account,
            chatgpt::chatgpt_sign_out, chatgpt::chatgpt_models, chatgpt::chatgpt_open_usage,
            update::update_status, update::update_check, update::update_download, update::update_cancel_download, update::update_install
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // Always let the shell flush active text/ink before deciding.
                api.prevent_close();
                let _ = window.emit("close-requested", ());
            }
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, position, .. }) = event {
                let mut opened = Vec::new();
                let mut images = Vec::new();
                for path in paths {
                    if text::image_mime(path).is_some() {
                        match text::allow_drop(path.clone(), &window.state::<text::TextFiles>()) {
                            Ok(path) => images.push(path),
                            Err(message) => { let _ = window.emit("pdf-open-error", message); }
                        }
                    } else {
                        match allow(path.clone(), &window.state::<AllowedFiles>()) {
                            Ok(path) => opened.push(path),
                            Err(message) => { let _ = window.emit("pdf-open-error", message); }
                        }
                    }
                }
                if !images.is_empty() {
                    let scale = window.scale_factor().unwrap_or(1.0);
                    let _ = window.emit("images-dropped", serde_json::json!({
                        "paths": images, "x": position.x / scale, "y": position.y / scale
                    }));
                }
                if !opened.is_empty() { let _ = window.emit("pdfs-dropped", opened); }
            }
        })
        .run(tauri::generate_context!()).expect("PDFreader could not start");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    struct TempDir(PathBuf);
    impl TempDir {
        fn new(label: &str) -> Self {
            let stamp = SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
            let path = std::env::temp_dir().join(format!("pdfreader-{label}-{}-{stamp}", std::process::id()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn pdf_layout_cache_keeps_recent_four_and_invalidates_when_file_changes() {
        let dir = TempDir::new("layout-cache");
        let cache = PdfLayoutCache::default();
        let mut files = Vec::new();
        for index in 0..5 {
            let path = dir.0.join(format!("doc-{index}.pdf"));
            let data = format!("%PDF-1.7\ncontent-{index}").into_bytes();
            fs::write(&path, &data).unwrap();
            let canonical = path.canonicalize().unwrap();
            let fp = format!("{:x}", Sha256::digest(&data));
            files.push((canonical, data, fp));
        }

        // 先加载 0..4 填满 4 个槽位
        for (path, data, fp) in &files[..4] {
            let loaded = cache.load_verified(path, fp).unwrap();
            assert_eq!(loaded.as_slice(), data.as_slice());
        }
        // 再次访问 doc-0，将其提升到 LRU 队尾
        let first_ptr = Arc::as_ptr(&cache.load_verified(&files[0].0, &files[0].2).unwrap());
        let again_ptr = Arc::as_ptr(&cache.load_verified(&files[0].0, &files[0].2).unwrap());
        assert_eq!(first_ptr, again_ptr);

        // 加载第 5 份文档应淘汰最久未使用的 doc-1，保留 doc-0
        assert!(cache.load_verified(&files[4].0, &files[4].2).is_some());
        let cached_paths: Vec<PathBuf> = cache.0.lock().unwrap().iter().map(|e| e.key.path.clone()).collect();
        assert_eq!(cached_paths.len(), PDF_LAYOUT_CACHE_CAPACITY);
        assert!(cached_paths.contains(&files[0].0));
        assert!(!cached_paths.contains(&files[1].0));

        // 错误指纹必须被拒绝
        assert!(cache.load_verified(&files[0].0, "deadbeef").is_none());

        // 文件内容变更后（长度改变）缓存自动失效并重新校验新指纹
        let updated = b"%PDF-1.7\nupdated-longer-content".to_vec();
        fs::write(&files[0].0, &updated).unwrap();
        let updated_fp = format!("{:x}", Sha256::digest(&updated));
        assert!(cache.load_verified(&files[0].0, &files[0].2).is_none());
        let reloaded = cache.load_verified(&files[0].0, &updated_fp).unwrap();
        assert_eq!(reloaded.as_slice(), updated.as_slice());
    }

    #[test]
    fn pdf_authorization_and_header_validation_reject_untrusted_or_corrupt_files() {
        let dir = TempDir::new("pdf-auth");
        let pdf = dir.0.join("valid.pdf");
        let bad = dir.0.join("corrupt.pdf");
        let txt = dir.0.join("note.txt");
        fs::write(&pdf, b"%PDF-1.7\nhello").unwrap();
        fs::write(&bad, b"NOT-A-PDF").unwrap();
        fs::write(&txt, b"plain text").unwrap();

        let allowed = AllowedFiles::default();
        assert!(authorized_pdf_path(&pdf.to_string_lossy(), &allowed).is_err());

        let pdf_str = allow(pdf.clone(), &allowed).unwrap();
        let bad_str = allow(bad.clone(), &allowed).unwrap();
        let txt_str = allow(txt.clone(), &allowed).unwrap();

        let authorized_pdf = authorized_pdf_path(&pdf_str, &allowed).unwrap();
        assert_eq!(read_validated_pdf_bytes(&authorized_pdf).unwrap(), b"%PDF-1.7\nhello");

        let authorized_bad = authorized_pdf_path(&bad_str, &allowed).unwrap();
        assert!(read_validated_pdf_bytes(&authorized_bad).is_err());
        assert!(authorized_pdf_path(&txt_str, &allowed).is_err());
    }
}
