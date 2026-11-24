use std::{path::{Path, PathBuf}, sync::Mutex};
use serde::Serialize;

#[derive(Default, Serialize)]
pub struct Batch { pub paths: Vec<String>, pub errors: Vec<String> }
#[derive(Default)]
pub struct IncomingPdfs(pub Mutex<Batch>);

pub fn document_paths(args: impl IntoIterator<Item = String>, cwd: &Path) -> Vec<PathBuf> {
    args.into_iter().skip(1).map(PathBuf::from)
        .filter(|p| super::document_extension(p).is_some())
        .map(|p| if p.is_absolute() { p } else { cwd.join(p) }).collect()
}

pub fn enqueue(args: impl IntoIterator<Item = String>, cwd: &Path, incoming: &IncomingPdfs, allowed: &super::AllowedFiles) {
    let mut batch = incoming.0.lock().unwrap_or_else(|e| e.into_inner());
    for path in document_paths(args, cwd) {
        match super::allow(path, allowed) {
            Ok(path) => batch.paths.push(path),
            Err(error) => batch.errors.push(error),
        }
    }
}

#[tauri::command]
pub fn startup_pdfs(state: tauri::State<IncomingPdfs>) -> Batch {
    // Draining is atomic. Requests arriving before the JS event listener exists
    // remain queued and are picked up by the initial startup call.
    std::mem::take(&mut *state.0.lock().unwrap_or_else(|e| e.into_inner()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn launch_paths_preserve_unicode_spaces_and_resolve_against_sender_cwd() {
        let cwd = Path::new(r"D:\资料 目录");
        let paths = document_paths(["reader.exe", "中文 文献.PDF", "--flag", "notes.txt", r"C:\other file.pdf"].map(String::from), cwd);
        assert_eq!(paths, [cwd.join("中文 文献.PDF"), cwd.join("notes.txt"), PathBuf::from(r"C:\other file.pdf")]);
    }
    #[test]
    fn queued_launches_retain_valid_files_and_errors_until_drained() {
        let root = std::env::temp_dir().join(format!("pdfreader-launch-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let pdf = root.join("文献 sample.pdf");
        std::fs::write(&pdf, b"%PDF-1.7\n").unwrap();
        let incoming = IncomingPdfs::default(); let allowed = super::super::AllowedFiles::default();
        enqueue(["reader.exe", "文献 sample.pdf", "missing.pdf"].map(String::from), &root, &incoming, &allowed);
        let batch = std::mem::take(&mut *incoming.0.lock().unwrap());
        assert_eq!(batch.paths.len(), 1); assert_eq!(batch.errors.len(), 1);
        assert!(incoming.0.lock().unwrap().paths.is_empty());
        assert!(allowed.0.lock().unwrap().contains(&pdf.canonicalize().unwrap()));
        std::fs::remove_file(pdf).unwrap(); std::fs::remove_dir(root).unwrap();
    }
}
