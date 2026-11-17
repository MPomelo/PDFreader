use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{fs::{self, OpenOptions}, io::Write, path::{Path, PathBuf}, sync::{Mutex, atomic::{AtomicU64, Ordering}}};
use tauri::Manager;
static NEXT: AtomicU64 = AtomicU64::new(0);
#[derive(Default)] pub struct LocalState(pub Mutex<()>);
#[derive(Serialize, Deserialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct Record { version: u32, revision: u64, data: Value }
fn filename(kind: &str, document: &str) -> Result<String, String> {
    match kind {
        "state" | "notes" if document.is_empty() => Ok(format!("{kind}.json")),
        "cache" if document.len() == 64 && document.bytes().all(|b| b.is_ascii_hexdigit()) => Ok(format!("cache-{}.json", document.to_ascii_lowercase())),
        _ => Err("本地数据类型或文档标识无效".into()),
    }
}
fn read(path: &Path) -> Result<Record, String> {
    if !path.exists() { return Ok(Record { version: 1, revision: 0, data: Value::Null }); }
    if fs::metadata(path).map_err(|e| e.to_string())?.len() > 2 * 1024 * 1024 { return Err("本地数据过大；原文件保持不变，请先备份恢复".into()); }
    let record: Record = serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|_| "本地数据损坏，未覆盖原文件；可备份损坏文件后恢复空数据".to_string())?;
    if record.version != 1 { return Err("本地数据版本不支持，未覆盖原文件".into()); }
    Ok(record)
}
fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let temp = path.with_extension(format!("{}-{}.tmp", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
    let result = (|| -> std::io::Result<()> {
        let mut file = OpenOptions::new().write(true).create_new(true).open(&temp)?;
        file.write_all(bytes)?; file.sync_all()?; drop(file); fs::rename(&temp, path)
    })();
    if let Err(error) = result { let _ = fs::remove_file(temp); return Err(format!("本地数据保存失败，原文件未改动：{error}")); }
    Ok(())
}
fn write(path: &Path, expected: u64, data: Value) -> Result<Record, String> {
    let current = read(path)?;
    if current.revision != expected { return Err("另一窗口已更新本地数据，请重新载入后重试；未覆盖其修改".into()); }
    let record = Record { version: 1, revision: expected.checked_add(1).ok_or("数据版本已达上限")?, data };
    let bytes = serde_json::to_vec(&record).map_err(|e| e.to_string())?;
    if bytes.len() > 2 * 1024 * 1024 { return Err("本地数据达到 2 MiB 上限，请先导出并整理笔记；未删除已有内容".into()); }
    atomic_write(path, &bytes)?; Ok(record)
}
fn lock(path: &Path) -> Result<std::fs::File, String> {
    let mut options = OpenOptions::new(); options.read(true).write(true).create(true).truncate(false);
    #[cfg(windows)] { use std::os::windows::fs::OpenOptionsExt; options.share_mode(0); }
    options.open(path.with_extension("lock")).map_err(|_| "另一窗口正在读写本地数据，请稍后重试".into())
}
fn directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("local-v1");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?; Ok(dir)
}
#[tauri::command]
pub fn local_read(app: tauri::AppHandle, state: tauri::State<LocalState>, kind: String, document: String) -> Result<Record, String> {
    let _guard = state.0.lock().map_err(|e| e.to_string())?;
    let path = directory(&app)?.join(filename(&kind, &document)?); let _lock = lock(&path)?; read(&path)
}
#[tauri::command]
pub fn local_write(app: tauri::AppHandle, state: tauri::State<LocalState>, kind: String, document: String, revision: u64, data: Value) -> Result<Record, String> {
    let _guard = state.0.lock().map_err(|e| e.to_string())?;
    let path = directory(&app)?.join(filename(&kind, &document)?); let _lock = lock(&path)?;
    let record = write(&path, revision, data)?;
    if kind == "cache" { prune_caches(path.parent().unwrap(), &path)?; }
    Ok(record)
}
fn prune_caches(dir: &Path, keep: &Path) -> Result<(), String> {
    let mut entries: Vec<_> = fs::read_dir(dir).map_err(|e| e.to_string())?.filter_map(Result::ok).filter_map(|entry| {
        let name = entry.file_name().to_string_lossy().into_owned();
        let id = name.strip_prefix("cache-")?.strip_suffix(".json")?;
        if filename("cache", id).ok()? != name { return None; }
        let metadata = entry.metadata().ok()?;
        if !metadata.is_file() { return None; }
        Some((entry.path(), metadata.modified().ok()?, metadata.len()))
    }).collect();
    entries.sort_by_key(|entry| entry.1);
    let mut bytes: u64 = entries.iter().map(|entry| entry.2).sum(); let mut count = entries.len();
    for (path, _, size) in entries {
        if count <= 64 && bytes <= 32 * 1024 * 1024 { break; }
        if path != keep { let _lock = lock(&path)?; if fs::remove_file(&path).is_ok() { bytes -= size; count -= 1; } }
    }
    Ok(())
}
#[tauri::command]
pub fn local_recover(app: tauri::AppHandle, state: tauri::State<LocalState>, kind: String, document: String) -> Result<String, String> {
    let _guard = state.0.lock().map_err(|e| e.to_string())?;
    let path = directory(&app)?.join(filename(&kind, &document)?); let _lock = lock(&path)?;
    if !path.exists() { return Ok("原文件不存在，可重新载入".into()); }
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|e| e.to_string())?.as_nanos();
    let backup = path.with_extension(format!("{stamp}.backup"));
    fs::copy(&path, &backup).map_err(|e| e.to_string())?;
    fs::remove_file(&path).map_err(|e| e.to_string())?;
    Ok(format!("原数据已备份：{}", backup.display()))
}
#[tauri::command]
pub fn reopen_pdf(app: tauri::AppHandle, local: tauri::State<LocalState>, files: tauri::State<crate::AllowedFiles>, path: String) -> Result<String, String> {
    let _guard = local.0.lock().map_err(|e| e.to_string())?;
    let state_path = directory(&app)?.join("state.json"); let _lock = lock(&state_path)?;
    let record = read(&state_path)?;
    if !record.data["recents"].as_array().is_some_and(|items| items.iter().any(|item| item["path"].as_str() == Some(path.as_str()))) {
        return Err("该文件不在最近记录中，请使用打开文件重新定位".into());
    }
    crate::allow(PathBuf::from(path), &files).map_err(|_| "文件已移动或不存在，请在最近文件中重新定位或移除记录".into())
}
#[tauri::command]
pub async fn export_notes(markdown: String) -> Result<Option<String>, String> {
    if markdown.len() > 2 * 1024 * 1024 { return Err("导出内容过大".into()); }
    tauri::async_runtime::spawn_blocking(move || {
        let Some(path) = rfd::FileDialog::new().add_filter("Markdown", &["md"]).set_file_name("PDFreader-翻译笔记.md").save_file() else { return Ok(None); };
        if !path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("md")) { return Err("笔记导出必须使用 .md 扩展名".into()); }
        atomic_write(&path, markdown.as_bytes())?; Ok(Some(path.to_string_lossy().into_owned()))
    }).await.map_err(|e| e.to_string())?
}
#[cfg(test)] mod tests {
    use super::*;
    #[test] fn atomic_revision_corruption_and_size_failures_preserve_saved_data() {
        let dir = std::env::temp_dir().join(format!("pdfreader-local-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
        fs::create_dir_all(&dir).unwrap(); let path = dir.join("notes.json");
        assert_eq!(read(&path).unwrap().revision, 0);
        write(&path, 0, serde_json::json!({"notes":["$x$"]})).unwrap(); let good = fs::read(&path).unwrap();
        assert!(write(&path, 0, Value::Null).is_err()); assert_eq!(fs::read(&path).unwrap(), good);
        assert!(write(&path, 1, Value::String("x".repeat(2 * 1024 * 1024))).is_err()); assert_eq!(fs::read(&path).unwrap(), good);
        fs::write(&path, b"corrupt").unwrap(); assert!(write(&path, 1, Value::Null).is_err()); assert_eq!(fs::read(&path).unwrap(), b"corrupt");
        fs::remove_dir_all(dir).unwrap();
    }
    #[test] fn cache_paths_and_cleanup_never_touch_notes_or_state() {
        assert!(filename("cache", "../notes").is_err()); assert!(filename("notes", "id").is_err());
        let dir = std::env::temp_dir().join(format!("pdfreader-cache-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed))); fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("notes.json"), b"notes").unwrap(); fs::write(dir.join("state.json"), b"state").unwrap();
        for i in 0..66 { fs::write(dir.join(format!("cache-{i:064x}.json")), b"cache").unwrap(); }
        prune_caches(&dir, &dir.join(format!("cache-{:064x}.json", 65))).unwrap();
        assert_eq!(fs::read(dir.join("notes.json")).unwrap(), b"notes"); assert_eq!(fs::read(dir.join("state.json")).unwrap(), b"state");
        assert_eq!(fs::read_dir(&dir).unwrap().filter_map(Result::ok).filter(|e| e.path().extension().is_some_and(|v|v=="json")).count(), 66);
        fs::remove_dir_all(dir).unwrap();
    }
}
