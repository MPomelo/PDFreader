use std::{fs::{self, OpenOptions}, io::Write, path::{Path, PathBuf}, sync::atomic::{AtomicU64, Ordering}};
static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

pub fn export_target(target: &Path, originals: &[PathBuf]) -> Result<PathBuf, String> {
    if !target.extension().and_then(|s| s.to_str()).is_some_and(|s| s.eq_ignore_ascii_case("pdf")) {
        return Err("导出文件必须使用 .pdf 扩展名".into());
    }
    let resolved = if target.exists() {
        target.canonicalize().map_err(|e| e.to_string())?
    } else {
        let parent = target.parent().ok_or("导出目录无效")?.canonicalize().map_err(|e| e.to_string())?;
        parent.join(target.file_name().ok_or("导出文件名无效")?)
    };
    if originals.iter().any(|original| original == &resolved) {
        return Err("请另选文件名导出，不能覆盖已打开的原 PDF。".into());
    }
    // Canonical paths catch aliases and symlinks; hard links are safe because
    // the atomic rename replaces the destination entry, not the source contents.
    Ok(resolved)
}

pub fn atomic_export(target: &Path, bytes: &[u8]) -> Result<(), String> {
    if !bytes.starts_with(b"%PDF-") { return Err("导出数据不是有效的 PDF，未写入文件。".into()); }
    atomic_write_checked(target, bytes, || Ok(()))
}

pub fn atomic_write_checked(target: &Path, bytes: &[u8], check: impl FnOnce() -> Result<(), String>) -> Result<(), String> {
    let parent = target.parent().ok_or("保存目录无效")?;
    let mut temporary = None;
    for _ in 0..100 {
        let sequence = NEXT_TEMP.fetch_add(1, Ordering::Relaxed);
        let path = parent.join(format!(".pdfreader-{}-{sequence}.tmp", std::process::id()));
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => { temporary = Some((path, file)); break; }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("无法创建保存临时文件：{error}")),
        }
    }
    let (path, mut file) = temporary.ok_or("无法创建唯一的导出临时文件")?;
    let result = (|| {
        let write = file.write_all(bytes).and_then(|()| file.sync_all());
        drop(file);
        write.map_err(|error| format!("写入失败，修改仍未保存：{error}"))?;
        check()?;
        // Same-volume rename atomically replaces a confirmed destination.
        fs::rename(&path, target).map_err(|error| format!("保存失败，修改仍未保存：{error}"))
    })();
    if let Err(error) = result {
        let _ = fs::remove_file(&path);
        return Err(error);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Directory(PathBuf);
    impl Directory {
        fn new() -> Self {
            let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
            let path = std::env::temp_dir().join(format!("pdfreader-export-{}-{stamp}", std::process::id()));
            fs::create_dir_all(&path).unwrap(); Self(path)
        }
    }
    impl Drop for Directory { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
    #[test]
    fn original_cannot_be_export_destination() {
        let dir = Directory::new(); let path = dir.0.join("原始 文件.pdf");
        fs::write(&path, b"%PDF-original").unwrap();
        assert!(export_target(&path, &[path.canonicalize().unwrap()]).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"%PDF-original");
    }
    #[test]
    fn atomic_export_replaces_a_copy_and_leaves_original_unchanged() {
        let dir = Directory::new(); let original = dir.0.join("original.pdf"); let copy = dir.0.join("批注 副本.pdf");
        fs::write(&original, b"%PDF-original").unwrap(); fs::write(&copy, b"%PDF-old-copy").unwrap();
        let target = export_target(&copy, &[original.canonicalize().unwrap()]).unwrap();
        atomic_export(&target, b"%PDF-new-copy").unwrap();
        assert_eq!(fs::read(&copy).unwrap(), b"%PDF-new-copy");
        assert_eq!(fs::read(&original).unwrap(), b"%PDF-original");
        assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 2);
    }
    #[test]
    fn failed_write_retains_existing_destination() {
        let dir = Directory::new(); let copy = dir.0.join("copy.pdf");
        fs::write(&copy, b"%PDF-old-copy").unwrap();
        assert!(atomic_export(&copy, b"not-pdf").is_err());
        assert_eq!(fs::read(&copy).unwrap(), b"%PDF-old-copy");
        assert!(atomic_export(&dir.0.join("missing").join("copy.pdf"), b"%PDF-test").is_err());
        assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 1);
    }
    #[test]
    fn failed_atomic_replace_cleans_up_temporary_file() {
        let dir = Directory::new(); let blocked = dir.0.join("occupied.pdf");
        fs::create_dir(&blocked).unwrap();
        fs::write(blocked.join("keep.txt"), b"keep").unwrap();
        assert!(atomic_export(&blocked, b"%PDF-new-copy").is_err());
        assert_eq!(fs::read(blocked.join("keep.txt")).unwrap(), b"keep");
        assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 1);
    }
}
