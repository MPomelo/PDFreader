use base64::{engine::general_purpose::STANDARD, Engine};
use encoding_rs::{Encoding, UTF_16BE, UTF_16LE, UTF_8};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex},
};

use crate::{document_extension, files::atomic_write_checked, AllowedFiles};

const TEXT_LIMIT: usize = 32 * 1024 * 1024;
const IMAGE_LIMIT: usize = 16 * 1024 * 1024;

#[derive(Default)]
pub struct TextFiles {
    destinations: Mutex<HashSet<PathBuf>>,
    dropped: Mutex<HashSet<PathBuf>>,
    writes: Arc<Mutex<()>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextFile {
    name: String,
    path: String,
    revision: String,
    encoding: Option<&'static str>,
    bom: bool,
    content: Option<String>,
    assets_dir: String,
}

#[derive(Serialize)]
pub struct Destination {
    path: String,
    revision: Option<String>,
}

fn display(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn basename(path: &Path) -> String {
    path.file_name().unwrap_or_default().to_string_lossy().into_owned()
}

fn assets_dir(path: &Path) -> String {
    format!("{}.assets", path.file_stem().unwrap_or_default().to_string_lossy())
}

fn extension(path: &Path) -> Result<&'static str, String> {
    match document_extension(path) {
        Some(kind @ ("md" | "markdown" | "txt")) => Ok(kind),
        _ => Err("请选择 Markdown 或 TXT 文件".into()),
    }
}

fn markdown(path: &Path) -> Result<(), String> {
    match extension(path)? {
        "md" | "markdown" => Ok(()),
        _ => Err("只有 Markdown 文档支持图片附件".into()),
    }
}

fn allowed(path: &Path, files: &AllowedFiles) -> Result<PathBuf, String> {
    let resolved = path.canonicalize().map_err(|error| error.to_string())?;
    if !files.0.lock().map_err(|error| error.to_string())?.contains(&resolved) {
        return Err("文件未经打开操作授权".into());
    }
    Ok(resolved)
}

fn read_bytes(path: &Path, limit: usize) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    File::open(path)?.take((limit + 1) as u64).read_to_end(&mut bytes)?;
    if bytes.len() > limit {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "文件超过大小限制"));
    }
    Ok(bytes)
}

fn revision(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn current_revision(path: &Path) -> Result<Option<String>, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() => {
            read_bytes(path, TEXT_LIMIT).map(|bytes| Some(revision(&bytes))).map_err(|error| error.to_string())
        }
        Ok(_) => Err("目标不是普通文件".into()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn encoding_for(label: &str) -> Result<&'static Encoding, String> {
    match label {
        "UTF-8" | "UTF-16LE" | "UTF-16BE" | "GB18030" | "Big5" | "windows-1252" => {
            Encoding::for_label(label.as_bytes()).ok_or_else(|| "无法识别该编码".into())
        }
        _ => Err("请选择支持的文件编码".into()),
    }
}

fn decode(bytes: &[u8], chosen: Option<&str>) -> Result<(Option<&'static str>, bool, Option<String>), String> {
    let signature = Encoding::for_bom(bytes);
    let encoding = match chosen {
        Some(label) => encoding_for(label)?,
        None => signature.map_or(UTF_8, |(encoding, _)| encoding),
    };
    let skip = signature.filter(|(found, _)| *found == encoding).map_or(0, |(_, len)| len);
    match encoding.decode_without_bom_handling_and_without_replacement(&bytes[skip..]) {
        Some(content) => Ok((Some(if encoding == encoding_rs::GB18030 { "GB18030" } else { encoding.name() }), skip > 0, Some(content.into_owned()))),
        None if chosen.is_none() => Ok((None, false, None)),
        None => Err("无法用所选编码读取此文件，请选择其他编码。".into()),
    }
}

fn encode(content: &str, label: &str, bom: bool) -> Result<Vec<u8>, String> {
    let encoding = encoding_for(label)?;
    if encoding == UTF_16LE || encoding == UTF_16BE {
        let mut bytes = Vec::new();
        let little = encoding == UTF_16LE;
        if bom {
            bytes.extend(if little { [0xff, 0xfe] } else { [0xfe, 0xff] });
        }
        for unit in content.encode_utf16() {
            bytes.extend(if little { unit.to_le_bytes() } else { unit.to_be_bytes() });
        }
        return Ok(bytes);
    }
    let (encoded, _, errors) = encoding.encode(content);
    if errors {
        return Err(format!("部分字符无法用 {label} 保存。请改用 UTF-8，或编辑这些字符后重试。"));
    }
    if bom && encoding == UTF_8 {
        let mut bytes = vec![0xef, 0xbb, 0xbf];
        bytes.extend_from_slice(&encoded);
        return Ok(bytes);
    }
    Ok(encoded.into_owned())
}

#[tauri::command]
pub async fn read_text(path: String, encoding: Option<String>, files: tauri::State<'_, AllowedFiles>) -> Result<TextFile, String> {
    let path = allowed(Path::new(&path), &files)?;
    extension(&path)?;
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = read_bytes(&path, TEXT_LIMIT).map_err(|error| error.to_string())?;
        let (encoding, bom, content) = decode(&bytes, encoding.as_deref())?;
        Ok(TextFile { name: basename(&path), path: display(&path), revision: revision(&bytes),
            encoding, bom, content, assets_dir: assets_dir(&path) })
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn choose_text_destination(
    name: String, kind: String, state: tauri::State<'_, TextFiles>,
) -> Result<Option<Destination>, String> {
    let suffixes: &[&str] = match kind.as_str() {
        "markdown" => &["md", "markdown"],
        "txt" => &["txt"],
        _ => return Err("无效的文档类型".into()),
    };
    let target = tauri::async_runtime::spawn_blocking(move || {
        let Some(mut path) = rfd::FileDialog::new().set_title("保存文档")
            .add_filter(if kind == "txt" { "TXT" } else { "Markdown" }, suffixes)
            .set_file_name(name).save_file() else { return Ok::<_, String>(None); };
        if path.extension().is_none() {
            path.set_extension(suffixes[0]);
        }
        if !suffixes.contains(&extension(&path)?) {
            return Err("文件扩展名与当前文档类型不匹配".into());
        }
        let canonical = if path.exists() {
            path.canonicalize().map_err(|error| error.to_string())?
        } else {
            path.parent().ok_or("保存目录无效")?.canonicalize().map_err(|error| error.to_string())?
                .join(path.file_name().ok_or("文件名无效")?)
        };
        if !suffixes.contains(&extension(&canonical)?) {
            return Err("文件扩展名与当前文档类型不匹配".into());
        }
        let revision = current_revision(&canonical)?;
        Ok(Some((canonical, revision)))
    }).await.map_err(|error| error.to_string())??;
    let Some((path, revision)) = target else { return Ok(None); };
    state.destinations.lock().map_err(|error| error.to_string())?.insert(path.clone());
    Ok(Some(Destination { path: display(&path), revision }))
}

pub fn image_mime(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "bmp" => Some("image/bmp"),
        "ico" => Some("image/x-icon"),
        "avif" => Some("image/avif"),
        "svg" => Some("image/svg+xml"),
        _ => None,
    }
}

fn single_name(value: &str) -> Result<&Path, String> {
    let path = Path::new(value);
    if value.contains(['/', '\\', ':', '\0']) || !matches!(path.components().next(), Some(Component::Normal(_))) || image_mime(path).is_none() {
        return Err("图片文件名或格式无效".into());
    }
    Ok(path)
}

struct AssetWrites {
    directory: PathBuf,
    created_directory: bool,
    created_files: Vec<PathBuf>,
    committed: bool,
}

impl AssetWrites {
    fn new(document: &Path) -> Result<Self, String> {
        let directory = document.parent().ok_or("附件目录无效")?.join(assets_dir(document));
        let created_directory = match fs::create_dir(&directory) {
            Ok(()) => true,
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => false,
            Err(error) => return Err(format!("无法创建附件目录：{error}")),
        };
        let actual = directory.canonicalize().map_err(|error| error.to_string())?;
        let same_path = if cfg!(windows) {
            display(&actual).to_lowercase() == display(&directory).to_lowercase()
        } else { actual == directory };
        if !same_path || !directory.is_dir() {
            return Err("附件目录指向其他位置或不可用".into());
        }
        Ok(Self { directory, created_directory, created_files: Vec::new(), committed: false })
    }

    fn add(&mut self, name: &str, bytes: &[u8]) -> Result<String, String> {
        let name = single_name(name)?;
        if bytes.is_empty() || bytes.len() > IMAGE_LIMIT {
            return Err("图片为空或超过 16 MiB".into());
        }
        let stem = name.file_stem().and_then(|part| part.to_str()).ok_or("图片文件名无效")?;
        let suffix = name.extension().and_then(|part| part.to_str()).ok_or("图片扩展名无效")?;
        for index in 1..=10_000 {
            let filename = if index == 1 { basename(name) } else { format!("{stem}-{index}.{suffix}") };
            let path = self.directory.join(&filename);
            let mut file = match OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(file) => file,
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(format!("无法写入附件 {filename}：{error}")),
            };
            self.created_files.push(path);
            file.write_all(bytes).and_then(|()| file.sync_all()).map_err(|error| format!("附件保存失败：{error}"))?;
            return Ok(filename);
        }
        Err("同名附件过多，请修改文件名后重试".into())
    }
}

impl Drop for AssetWrites {
    fn drop(&mut self) {
        if self.committed { return; }
        for file in &self.created_files {
            let _ = fs::remove_file(file);
        }
        if self.created_directory {
            let _ = fs::remove_dir(&self.directory);
        }
    }
}

fn attachment_bytes(data: &str) -> Result<Vec<u8>, String> {
    if data.len() > IMAGE_LIMIT.div_ceil(3) * 4 {
        return Err("图片超过 16 MiB".into());
    }
    STANDARD.decode(data).map_err(|_| "图片数据无效".into())
}

#[tauri::command]
pub async fn store_text_image(path: String, name: String, data: String, files: tauri::State<'_, AllowedFiles>) -> Result<String, String> {
    let path = allowed(Path::new(&path), &files)?;
    markdown(&path)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut writes = AssetWrites::new(&path)?;
        let name = writes.add(&name, &attachment_bytes(&data)?)?;
        writes.committed = true;
        Ok(name)
    }).await.map_err(|error| error.to_string())?
}

#[derive(Serialize)]
pub struct TextImage {
    mime: &'static str,
    data: String,
}

pub fn allow_drop(path: PathBuf, state: &TextFiles) -> Result<String, String> {
    let path = path.canonicalize().map_err(|error| error.to_string())?;
    if image_mime(&path).is_none() || !path.is_file() {
        return Err("无法读取拖入的图片".into());
    }
    let mut dropped = state.dropped.lock().map_err(|error| error.to_string())?;
    if dropped.len() >= 128 { dropped.clear(); }
    dropped.insert(path.clone());
    Ok(display(&path))
}

#[derive(Serialize)]
pub struct DroppedImage {
    name: String,
    mime: &'static str,
    data: String,
}

#[tauri::command]
pub async fn read_dropped_image(path: String, state: tauri::State<'_, TextFiles>) -> Result<DroppedImage, String> {
    let path = PathBuf::from(path);
    if !state.dropped.lock().map_err(|error| error.to_string())?.remove(&path) {
        return Err("图片未经拖入操作授权".into());
    }
    let mime = image_mime(&path).ok_or("不支持的图片格式")?;
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = read_bytes(&path, IMAGE_LIMIT).map_err(|error| error.to_string())?;
        Ok(DroppedImage { name: basename(&path), mime, data: STANDARD.encode(bytes) })
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn read_text_image(path: String, relative: String, files: tauri::State<'_, AllowedFiles>) -> Result<TextImage, String> {
    let document = allowed(Path::new(&path), &files)?;
    markdown(&document)?;
    let relative = Path::new(&relative);
    if relative.components().any(|part| !matches!(part, Component::Normal(_) | Component::CurDir | Component::ParentDir))
        || relative.to_string_lossy().contains(':') {
        return Err("图片路径必须相对于 Markdown 文档".into());
    }
    let path = document.parent().ok_or("附件目录无效")?.join(relative);
    let mime = image_mime(&path).ok_or("不支持的图片格式")?;
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = read_bytes(&path, IMAGE_LIMIT).map_err(|error| error.to_string())?;
        Ok(TextImage { mime, data: STANDARD.encode(bytes) })
    }).await.map_err(|error| error.to_string())?
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum Attachment {
    Staged { name: String, data: String },
    Copy { name: String },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveRequest {
    path: String,
    expected_revision: Option<String>,
    source_path: Option<String>,
    encoding: String,
    bom: bool,
    parts: Vec<String>,
    attachments: Vec<Attachment>,
    links: Vec<usize>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
#[derive(Debug)]
pub struct SavedText {
    path: String,
    name: String,
    assets_dir: String,
    revision: String,
    urls: Vec<String>,
}

fn markdown_url(folder: &str, name: &str) -> String {
    fn escaped(value: &str) -> String {
        let mut encoded = String::new();
        for ch in value.chars() {
            if ch.is_ascii_control() || "%#?&<>\\\"".contains(ch) {
                encoded.push_str(&format!("%{:02X}", ch as u32));
            } else {
                encoded.push(ch);
            }
        }
        encoded
    }
    format!("<{}/{}>", escaped(folder), escaped(name))
}

fn verify_revision(path: &Path, expected: Option<&str>) -> Result<(), String> {
    if current_revision(path)?.as_deref() == expected {
        Ok(())
    } else {
        Err("保存冲突：磁盘文件已被修改或移除。可另存为以保留当前编辑。".into())
    }
}

fn write_document(path: &Path, source: Option<&Path>, request: SaveRequest) -> Result<SavedText, String> {
    if request.parts.len() != request.links.len() + 1 || request.links.iter().any(|&index| index >= request.attachments.len()) {
        return Err("附件链接与文档内容不匹配".into());
    }
    verify_revision(path, request.expected_revision.as_deref())?;
    let folder = assets_dir(path);
    let mut writes = if request.attachments.is_empty() {
        None
    } else {
        markdown(path)?;
        Some(AssetWrites::new(path)?)
    };
    let mut urls = Vec::new();
    if let Some(writes) = &mut writes {
        for attachment in request.attachments {
            let (name, bytes) = match attachment {
                Attachment::Staged { name, data } => (name, attachment_bytes(&data)?),
                Attachment::Copy { name } => {
                    let source = source.ok_or("没有可复制附件的原始文档")?;
                    let source_dir = source.parent().ok_or("原始附件目录无效")?.join(assets_dir(source));
                    let path = source_dir.join(single_name(&name)?);
                    let data = read_bytes(&path, IMAGE_LIMIT).map_err(|error| format!("无法复制附件 {name}：{error}"))?;
                    (name, data)
                }
            };
            urls.push(markdown_url(&folder, &writes.add(&name, &bytes)?));
        }
    }
    let mut parts = request.parts.into_iter();
    let mut content = parts.next().unwrap_or_default();
    for (index, part) in request.links.into_iter().zip(parts) {
        content.push_str(&urls[index]);
        content.push_str(&part);
    }
    let bytes = encode(&content, &request.encoding, request.bom)?;
    if bytes.len() > TEXT_LIMIT {
        return Err("文本超过 32 MiB，修改仍未保存。".into());
    }
    atomic_write_checked(path, &bytes, || verify_revision(path, request.expected_revision.as_deref()))?;
    if let Some(mut writes) = writes {
        writes.committed = true;
    }
    Ok(SavedText { path: display(path), name: basename(path), assets_dir: folder, revision: revision(&bytes), urls })
}

#[tauri::command]
pub async fn save_text(
    request: SaveRequest, files: tauri::State<'_, AllowedFiles>, state: tauri::State<'_, TextFiles>,
) -> Result<SavedText, String> {
    let path = PathBuf::from(&request.path);
    extension(&path)?;
    let picked = state.destinations.lock().map_err(|error| error.to_string())?.remove(&path);
    if !picked && !files.0.lock().map_err(|error| error.to_string())?.contains(&path) {
        return Err("请在保存对话框中选择目标文件".into());
    }
    let source = request.source_path.as_deref().map(PathBuf::from);
    if let Some(source) = &source {
        markdown(source)?;
        if !files.0.lock().map_err(|error| error.to_string())?.contains(source) {
            return Err("原始文档未经打开操作授权".into());
        }
    }
    let writes = state.writes.clone();
    let save = tauri::async_runtime::spawn_blocking(move || {
        let _write = writes.lock().map_err(|error| error.to_string())?;
        write_document(&path, source.as_deref(), request)
    }).await.map_err(|error| error.to_string())??;
    files.0.lock().map_err(|error| error.to_string())?.insert(PathBuf::from(&save.path));
    Ok(save)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    struct TestDirectory(PathBuf);
    impl TestDirectory {
        fn new() -> Self {
            static SEQUENCE: AtomicU64 = AtomicU64::new(0);
            let sequence = SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!("pdfreader-text-{}-{sequence}", std::process::id()));
            fs::create_dir(&path).unwrap();
            Self(path.canonicalize().unwrap())
        }
    }
    impl Drop for TestDirectory {
        fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
    }

    fn request(path: &Path, expected: Option<String>, attachments: Vec<Attachment>) -> SaveRequest {
        let links = if attachments.is_empty() { vec![] } else { vec![0] };
        let parts = if links.is_empty() { vec!["替换\r\n".into()] } else { vec!["![实验](".into(), ")\r\n".into()] };
        SaveRequest {
            path: display(path), expected_revision: expected, source_path: None,
            encoding: "UTF-8".into(), bom: false, parts, attachments, links,
        }
    }

    #[test]
    fn encodings_preserve_bom_crlf_and_legacy_text_without_substitution() {
        for encoding in ["UTF-8", "UTF-16LE", "UTF-16BE", "GB18030", "Big5", "windows-1252"] {
            let original = if encoding == "windows-1252" { "# café\r\n`$100`" } else { "# 中文\r\n`$100`" };
            let bom = encoding.starts_with("UTF-");
            let bytes = encode(original, encoding, bom).unwrap();
            assert_eq!(decode(&bytes, Some(encoding)).unwrap(), (Some(encoding), bom, Some(original.into())));
            if bom { assert_eq!(decode(&bytes, None).unwrap().2.as_deref(), Some(original)); }
        }
        assert_eq!(decode(&[0xd6, 0xd0], None).unwrap(), (None, false, None));
        assert!(encode("中文", "windows-1252", false).is_err());
    }

    #[test]
    fn staged_images_and_save_as_use_relative_collision_safe_paths() {
        let root = TestDirectory::new();
        let source = root.0.join("论文 笔记.md");
        let staged = Attachment::Staged { name: "实验 1.png".into(), data: STANDARD.encode(b"image") };
        let first = write_document(&source, None, request(&source, None, vec![staged])).unwrap();
        let original = fs::read(&source).unwrap();
        assert_eq!(original, "![实验](<论文 笔记.assets/实验 1.png>)\r\n".as_bytes());
        assert_eq!(fs::read(root.0.join("论文 笔记.assets/实验 1.png")).unwrap(), b"image");

        let target_dir = root.0.join("另存 目录");
        fs::create_dir(&target_dir).unwrap();
        let target = target_dir.join("论文 副本.markdown");
        let target_assets = target_dir.join("论文 副本.assets");
        fs::create_dir(&target_assets).unwrap();
        fs::write(target_assets.join("实验 1.png"), b"keep").unwrap();
        let copy = Attachment::Copy { name: "实验 1.png".into() };
        write_document(&target, Some(&source), request(&target, None, vec![copy])).unwrap();
        assert_eq!(fs::read(&source).unwrap(), original);
        assert_eq!(first.revision, revision(&original));
        assert_eq!(fs::read_to_string(&target).unwrap(), "![实验](<论文 副本.assets/实验 1-2.png>)\r\n");
        assert_eq!(fs::read(target_assets.join("实验 1.png")).unwrap(), b"keep");
        assert_eq!(fs::read(target_assets.join("实验 1-2.png")).unwrap(), b"image");

        let relocated = root.0.join("移动 后");
        fs::rename(&target_dir, &relocated).unwrap();
        assert!(fs::read_to_string(relocated.join("论文 副本.markdown")).unwrap().contains("论文 副本.assets/实验 1-2.png"));
        assert_eq!(fs::read(relocated.join("论文 副本.assets/实验 1-2.png")).unwrap(), b"image");
    }

    #[test]
    fn save_conflict_and_attachment_failure_leave_original_data_intact() {
        let root = TestDirectory::new();
        let source = root.0.join("note.md");
        fs::write(&source, b"initial").unwrap();
        let revision_before_edit = revision(b"initial");
        fs::write(&source, b"external edit").unwrap();
        assert!(write_document(&source, None, request(&source, Some(revision_before_edit), vec![])).unwrap_err().contains("保存冲突"));
        assert_eq!(fs::read(&source).unwrap(), b"external edit");

        let assets = root.0.join("note.assets");
        fs::create_dir(&assets).unwrap();
        fs::write(assets.join("keep.png"), b"keep").unwrap();
        let staged = Attachment::Staged { name: "keep.png".into(), data: STANDARD.encode(b"new") };
        let unavailable = Attachment::Copy { name: "missing.png".into() };
        assert!(write_document(&source, Some(&source), request(&source, Some(revision(b"external edit")), vec![staged, unavailable])).is_err());
        assert_eq!(fs::read(&source).unwrap(), b"external edit");
        assert_eq!(fs::read(assets.join("keep.png")).unwrap(), b"keep");
        assert_eq!(fs::read_dir(&assets).unwrap().count(), 1);

        let target = root.0.join("blocked.md");
        fs::write(root.0.join("blocked.assets"), b"do not replace").unwrap();
        let staged = Attachment::Staged { name: "new.png".into(), data: STANDARD.encode(b"new") };
        assert!(write_document(&target, Some(&source), request(&target, None, vec![staged])).is_err());
        assert!(!target.exists());
        assert_eq!(fs::read(root.0.join("blocked.assets")).unwrap(), b"do not replace");
    }
}
