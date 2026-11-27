use crate::http;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Write},
    os::windows::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    process::{self, Command},
    sync::{Arc, Mutex, atomic::{AtomicBool, AtomicU64, Ordering}},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, State, ipc::Channel};
use url::Url;

const CURRENT: &str = env!("CARGO_PKG_VERSION");
const REPO: &str = "MPomelo/PDFreader";
const MAX_INSTALLER: usize = 128 * 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(180);
const STATE_ERROR: &str = "应用更新状态不可用。";
static NEXT_FILE: AtomicU64 = AtomicU64::new(0);

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    draft: bool,
    prerelease: bool,
    assets: Vec<Asset>,
}

#[derive(Deserialize)]
struct Asset {
    name: String,
    state: String,
    browser_download_url: String,
    size: usize,
    digest: Option<String>,
}

#[derive(Clone, PartialEq, Eq)]
struct Candidate {
    info: UpdateInfo,
    url: Url,
    hash: String,
}

#[derive(Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateInfo {
    version: String,
    prerelease: bool,
    size: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    current_version: &'static str,
    available: Option<UpdateInfo>,
    downloaded: bool,
    busy: bool,
    downloading: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    downloaded: usize,
    total: usize,
}

struct Prepared {
    path: PathBuf,
    keep: bool,
}

impl Drop for Prepared {
    fn drop(&mut self) {
        if !self.keep {
            let _ = fs::remove_file(&self.path);
        }
    }
}

#[derive(Default)]
struct Updates {
    candidate: Option<Candidate>,
    prepared: Option<Prepared>,
    busy: bool,
    cancellation: Option<Arc<AtomicBool>>,
}

#[derive(Default)]
pub struct UpdateState(Mutex<Updates>);

impl Updates {
    fn status(&self) -> UpdateStatus {
        UpdateStatus {
            current_version: CURRENT,
            available: self.candidate.as_ref().map(|candidate| candidate.info.clone()),
            downloaded: self.prepared.is_some(),
            busy: self.busy,
            downloading: self.cancellation.is_some(),
        }
    }
}

fn version(value: &str) -> Option<[u32; 3]> {
    let mut parts = value.split('.');
    let mut result = [0; 3];
    for number in &mut result {
        let part = parts.next()?;
        if !part.bytes().all(|byte| byte.is_ascii_digit()) || (part.len() > 1 && part.starts_with('0')) {
            return None;
        }
        *number = part.parse().ok()?;
    }
    parts.next().is_none().then_some(result)
}

fn choose_release(mut releases: Vec<Release>, current: &str, include_prerelease: bool) -> Result<Option<Candidate>, String> {
    let current = version(current).ok_or("当前版本号无法用于更新。")?;
    let newest = releases.drain(..).filter_map(|release| {
        let number = version(release.tag_name.strip_prefix('v')?)?;
        (!release.draft && (include_prerelease || !release.prerelease) && number > current).then_some((number, release))
    }).max_by_key(|(number, _)| *number);
    let Some((_, release)) = newest else { return Ok(None); };
    let release_version = &release.tag_name[1..];
    let name = format!("PDFreader_{release_version}_x64-setup.exe");
    let url = format!("https://github.com/{REPO}/releases/download/{}/{name}", release.tag_name);
    let asset = release.assets.into_iter().find(|asset| {
        asset.name == name && asset.state == "uploaded" && asset.browser_download_url == url && (1..=MAX_INSTALLER).contains(&asset.size)
    }).ok_or("新版本暂未提供可下载的 Windows x64 安装包。")?;
    let Some(hash) = asset.digest.as_deref().and_then(|digest| digest.strip_prefix("sha256:"))
        .filter(|digest| digest.len() == 64 && digest.bytes().all(|byte| byte.is_ascii_hexdigit()))
    else { return Err("安装包缺少有效的 SHA-256 校验值。".into()); };
    Ok(Some(Candidate {
        info: UpdateInfo { version: release_version.into(), prerelease: release.prerelease, size: asset.size },
        url: Url::parse(&url).map_err(|_| "安装包地址无效。")?,
        hash: hash.to_ascii_lowercase(),
    }))
}

fn check(current: &str, include_prerelease: bool) -> Result<Option<Candidate>, String> {
    let url = Url::parse(&format!("https://api.github.com/repos/{REPO}/releases?per_page=30")).unwrap();
    let response = http::request(&url, "none", None, None, &AtomicBool::new(false), Duration::from_secs(20))?;
    if response.status != 200 { return Err(format!("GitHub 更新检查失败（HTTP {}）。请稍后重试。", response.status)); }
    let releases = serde_json::from_slice(&response.body).map_err(|_| "GitHub 发布列表格式无效。")?;
    choose_release(releases, current, include_prerelease)
}

fn asset_redirect(value: &str) -> Result<Url, String> {
    let invalid = "安装包下载跳转到了无法验证的地址。";
    let url = Url::parse(value).map_err(|_| invalid)?;
    if url.scheme() != "https" || url.port_or_known_default() != Some(443) || !url.username().is_empty()
        || url.password().is_some() || url.fragment().is_some()
        || !matches!(url.host_str(), Some("release-assets.githubusercontent.com" | "objects.githubusercontent.com" | "github-releases.githubusercontent.com")) {
        return Err(invalid.into());
    }
    Ok(url)
}

fn update_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_cache_dir().map_err(|_| "无法定位更新缓存目录。")?.join("installers"))
}

pub fn clean_cache(app: &AppHandle) {
    let Ok(path) = update_dir(app) else { return; };
    let Ok(files) = fs::read_dir(path) else { return; };
    for file in files.flatten() {
        let name = file.file_name();
        let name = name.to_string_lossy();
        if name.starts_with("pdfreader-update-") && name.ends_with(".exe")
            && file.file_type().is_ok_and(|kind| kind.is_file()) {
            let _ = fs::remove_file(file.path());
        }
    }
}

fn create_file(directory: &Path) -> Result<(Prepared, File), String> {
    fs::create_dir_all(directory).map_err(|_| "无法创建更新缓存目录。")?;
    let path = directory.join(format!("pdfreader-update-{}-{}.exe", process::id(), NEXT_FILE.fetch_add(1, Ordering::Relaxed)));
    let file = OpenOptions::new().write(true).create_new(true).open(&path).map_err(|_| "无法创建安装包文件。")?;
    Ok((Prepared { path, keep: false }, file))
}

fn download(directory: &Path, candidate: &Candidate, cancel: &AtomicBool, mut progress: impl FnMut(DownloadProgress)) -> Result<Prepared, String> {
    let (prepared, mut file) = create_file(directory)?;
    let size = candidate.info.size;
    let mut url = candidate.url.clone();
    let mut received = 0;
    let mut hash = Sha256::new();
    let start = Instant::now();
    let mut last_progress = start;
    for _ in 0..4 {
        let remaining = TIMEOUT.checked_sub(start.elapsed()).ok_or("下载更新超时。")?;
        let (status, redirect) = http::download(&url, size, cancel, remaining, &mut |bytes| {
            file.write_all(bytes).map_err(|_| "无法写入更新安装包。")?;
            received += bytes.len();
            hash.update(bytes);
            if received == size || last_progress.elapsed() >= Duration::from_millis(125) {
                progress(DownloadProgress { downloaded: received, total: size });
                last_progress = Instant::now();
            }
            Ok(false)
        })?;
        if cancel.load(Ordering::SeqCst) { return Err("已取消下载更新。".into()); }
        if let Some(redirect) = redirect {
            url = asset_redirect(&redirect)?;
            continue;
        }
        if status != 200 { return Err(format!("安装包下载失败（HTTP {status}）。")); }
        if received != size || format!("{:x}", hash.finalize()) != candidate.hash {
            return Err("安装包的大小或 SHA-256 校验值与发布记录不符。".into());
        }
        file.sync_all().map_err(|_| "无法保存更新安装包。")?;
        return Ok(prepared);
    }
    Err("安装包下载跳转次数过多。".into())
}

#[tauri::command]
pub fn update_status(state: State<UpdateState>) -> Result<UpdateStatus, String> {
    Ok(state.0.lock().map_err(|_| STATE_ERROR)?.status())
}

#[tauri::command]
pub async fn update_check(state: State<'_, UpdateState>, include_prerelease: bool) -> Result<UpdateStatus, String> {
    {
        let mut update = state.0.lock().map_err(|_| STATE_ERROR)?;
        if update.busy { return Err("正在处理更新，请稍候。".into()); }
        update.busy = true;
    }
    let result = tauri::async_runtime::spawn_blocking(move || check(CURRENT, include_prerelease)).await;
    let mut update = state.0.lock().map_err(|_| STATE_ERROR)?;
    update.busy = false;
    let candidate = result.map_err(|_| "更新检查任务意外结束。")??;
    if update.candidate != candidate {
        update.prepared = None;
        update.candidate = candidate;
    }
    Ok(update.status())
}

#[tauri::command]
pub async fn update_download(app: AppHandle, state: State<'_, UpdateState>, on_progress: Channel<DownloadProgress>) -> Result<UpdateStatus, String> {
    let cancel = Arc::new(AtomicBool::new(false));
    let candidate = {
        let mut update = state.0.lock().map_err(|_| STATE_ERROR)?;
        if update.busy { return Err("正在处理更新，请稍候。".into()); }
        let candidate = update.candidate.clone().ok_or("请先检查更新。")?;
        if update.prepared.is_some() { return Ok(update.status()); }
        update.busy = true;
        update.cancellation = Some(cancel.clone());
        candidate
    };
    let result = tauri::async_runtime::spawn_blocking(move || {
        let result = update_dir(&app).and_then(|directory| download(&directory, &candidate, &cancel, |progress| {
            let _ = on_progress.send(progress);
        }));
        if cancel.load(Ordering::SeqCst) { Err("已取消下载更新。".into()) } else { result }
    }).await;
    let mut update = state.0.lock().map_err(|_| STATE_ERROR)?;
    update.busy = false;
    let cancelled = update.cancellation.take().is_some_and(|flag| flag.load(Ordering::SeqCst));
    if cancelled { return Err("已取消下载更新。".into()); }
    update.prepared = Some(result.map_err(|_| "更新下载任务意外结束。")??);
    Ok(update.status())
}

#[tauri::command]
pub fn update_cancel_download(state: State<UpdateState>) -> Result<(), String> {
    if let Some(cancel) = &state.0.lock().map_err(|_| STATE_ERROR)?.cancellation {
        cancel.store(true, Ordering::SeqCst);
    }
    Ok(())
}

fn launch_installer(candidate: &Candidate, prepared: &mut Prepared) -> Result<(), String> {
    // Keep the file open without write/delete sharing through validation and CreateProcess.
    let mut file = OpenOptions::new().read(true).share_mode(1).open(&prepared.path).map_err(|_| "无法打开下载的安装包。")?;
    if file.metadata().map_err(|_| "无法读取安装包大小。")?.len() != candidate.info.size as u64 {
        return Err("安装包已变更。请重新检查并下载更新。".into());
    }
    let mut hash = Sha256::new();
    io::copy(&mut file, &mut hash).map_err(|_| "无法校验安装包。")?;
    if format!("{:x}", hash.finalize()) != candidate.hash {
        return Err("安装包校验失败。请重新检查并下载更新。".into());
    }
    Command::new(&prepared.path).current_dir(prepared.path.parent().ok_or("安装包目录无效。")?)
        .spawn().map_err(|_| "无法启动 Windows 安装程序。")?;
    prepared.keep = true;
    Ok(())
}

#[tauri::command]
pub async fn update_install(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<UpdateState>();
        let mut update = state.0.lock().map_err(|_| STATE_ERROR)?;
        if update.busy { return Err("请等待更新下载完成。".into()); }
        let candidate = update.candidate.clone().ok_or("请先检查更新。")?;
        let mut prepared = update.prepared.take().ok_or("请先下载更新。")?;
        launch_installer(&candidate, &mut prepared)?;
        drop(update);
        app.exit(0);
        Ok(())
    }).await.map_err(|_| "安装程序启动任务意外结束。".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn release(tag: &str, prerelease: bool, draft: bool) -> Release {
        let name = format!("PDFreader_{}_x64-setup.exe", &tag[1..]);
        Release { tag_name: tag.into(), prerelease, draft, assets: vec![Asset {
            browser_download_url: format!("https://github.com/{REPO}/releases/download/{tag}/{name}"),
            name, state: "uploaded".into(), size: 100, digest: Some(format!("sha256:{}", "a".repeat(64))),
        }] }
    }

    #[test]
    fn checks_newer_numeric_versions_and_respects_the_prerelease_choice() {
        let releases = || vec![
            release("v2.2.2", false, false), release("v2.2.9", false, false),
            release("v2.2.10", true, false), release("v3.0.0", false, true),
        ];
        assert_eq!(choose_release(releases(), "2.2.2", true).unwrap().unwrap().info.version, "2.2.10");
        assert_eq!(choose_release(releases(), "2.2.2", false).unwrap().unwrap().info.version, "2.2.9");
        assert!(choose_release(releases(), "2.2.10", true).unwrap().is_none());
        assert!(version("2.2.03").is_none());
    }

    #[test]
    fn rejects_missing_digests_and_nonofficial_installer_urls() {
        let mut edited = release("v2.2.3", false, false);
        edited.assets[0].digest = None;
        assert!(choose_release(vec![edited], "2.2.2", false).is_err());
        let mut edited = release("v2.2.3", false, false);
        edited.assets[0].browser_download_url.push_str("?redirect=elsewhere");
        assert!(choose_release(vec![edited], "2.2.2", false).is_err());
        assert!(asset_redirect("https://release-assets.githubusercontent.com/object?token=example").is_ok());
        for url in ["https://release-assets.githubusercontent.com.evil.test/a", "http://release-assets.githubusercontent.com/a",
            "https://user@release-assets.githubusercontent.com/a", "https://release-assets.githubusercontent.com:444/a"] {
            assert!(asset_redirect(url).is_err(), "{url}");
        }
    }

    #[test]
    #[ignore = "Downloads a published Windows installer without launching it"]
    fn public_release_download_matches_github_digest() {
        let candidate = check("2.2.1", true).unwrap().expect("published update");
        let directory = std::env::temp_dir().join(format!("PDFreader-updater-test-{}", process::id()));
        let result = download(&directory, &candidate, &AtomicBool::new(false), |_| {});
        let prepared = result.expect("official installer and SHA-256");
        assert_eq!(fs::metadata(&prepared.path).unwrap().len(), candidate.info.size as u64);
        drop(prepared);
        fs::remove_dir(directory).unwrap();
    }
}
