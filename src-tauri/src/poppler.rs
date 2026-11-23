// Optional native text layout. The application loads a user-provided GLib
// runtime only when PDFREADER_POPPLER_DIR points to an absolute directory.
use libloading::Library;
use serde::Serialize;
use std::{
    ffi::{c_char, c_double, c_int, c_uint, c_void, CStr},
    path::Path,
    ptr,
    sync::OnceLock,
};

type Handle = *mut c_void;
type Release = unsafe extern "C" fn(Handle);

#[repr(C)]
#[derive(Clone, Copy)]
struct Rect {
    x1: c_double,
    y1: c_double,
    x2: c_double,
    y2: c_double,
}

#[derive(Serialize)]
pub struct PageLayout {
    width: f64,
    height: f64,
    lines: Vec<Line>,
}

#[derive(Serialize)]
struct Line {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

struct Owned(Handle, Release);

impl Owned {
    fn new(handle: Handle, release: Release) -> Option<Self> {
        (!handle.is_null()).then(|| Self(handle, release))
    }
}

impl Drop for Owned {
    fn drop(&mut self) {
        unsafe { (self.1)(self.0) };
    }
}

struct Api {
    bytes_new: unsafe extern "C" fn(*const u8, usize) -> Handle,
    bytes_unref: Release,
    object_unref: Release,
    free: Release,
    open: unsafe extern "C" fn(Handle, *const c_char, *mut Handle) -> Handle,
    page: unsafe extern "C" fn(Handle, c_int) -> Handle,
    size: unsafe extern "C" fn(Handle, *mut f64, *mut f64),
    text: unsafe extern "C" fn(Handle) -> Handle,
    layout: unsafe extern "C" fn(Handle, *mut *mut Rect, *mut c_uint) -> c_int,
    _libraries: [Library; 3],
}

impl Api {
    unsafe fn load(dir: &Path) -> Option<Self> {
        #[cfg(windows)]
        let names = [
            "libpoppler-glib-8.dll",
            "libglib-2.0-0.dll",
            "libgobject-2.0-0.dll",
        ];
        #[cfg(target_os = "macos")]
        let names = [
            "libpoppler-glib.8.dylib",
            "libglib-2.0.0.dylib",
            "libgobject-2.0.0.dylib",
        ];
        #[cfg(all(not(windows), not(target_os = "macos")))]
        let names = [
            "libpoppler-glib.so.8",
            "libglib-2.0.so.0",
            "libgobject-2.0.so.0",
        ];

        unsafe fn library(path: &Path) -> Option<Library> {
            #[cfg(windows)]
            {
                use libloading::os::windows::{
                    Library as WindowsLibrary, LOAD_LIBRARY_SEARCH_DEFAULT_DIRS,
                    LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR,
                };
                WindowsLibrary::load_with_flags(
                    path,
                    LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS,
                )
                .ok()
                .map(Into::into)
            }
            #[cfg(not(windows))]
            Library::new(path).ok()
        }

        let glib = library(&dir.join(names[1]))?;
        let object = library(&dir.join(names[2]))?;
        let poppler = library(&dir.join(names[0]))?;
        Some(Self {
            bytes_new: *glib.get(b"g_bytes_new_static\0").ok()?,
            bytes_unref: *glib.get(b"g_bytes_unref\0").ok()?,
            free: *glib.get(b"g_free\0").ok()?,
            object_unref: *object.get(b"g_object_unref\0").ok()?,
            open: *poppler.get(b"poppler_document_new_from_bytes\0").ok()?,
            page: *poppler.get(b"poppler_document_get_page\0").ok()?,
            size: *poppler.get(b"poppler_page_get_size\0").ok()?,
            text: *poppler.get(b"poppler_page_get_text\0").ok()?,
            layout: *poppler.get(b"poppler_page_get_text_layout\0").ok()?,
            _libraries: [poppler, object, glib],
        })
    }
}

fn api() -> Option<&'static Api> {
    static API: OnceLock<Option<Api>> = OnceLock::new();
    API.get_or_init(|| {
        let dir = std::path::PathBuf::from(std::env::var_os("PDFREADER_POPPLER_DIR")?);
        if !dir.is_absolute() {
            return None;
        }
        unsafe { Api::load(&dir) }
    })
    .as_ref()
}

pub fn enabled() -> bool {
    api().is_some()
}

pub fn page_layout(bytes: &[u8], page: u32) -> Option<PageLayout> {
    let api = api()?;
    let index = c_int::try_from(page.checked_sub(1)?).ok()?;
    // The GBytes view borrows the input. Page and document references drop
    // before that view and the original Rust slice leave this scope.
    unsafe {
        let data = Owned::new(
            (api.bytes_new)(bytes.as_ptr(), bytes.len()),
            api.bytes_unref,
        )?;
        let document = Owned::new(
            (api.open)(data.0, ptr::null(), ptr::null_mut()),
            api.object_unref,
        )?;
        let page = Owned::new((api.page)(document.0, index), api.object_unref)?;
        let mut width = 0.0;
        let mut height = 0.0;
        (api.size)(page.0, &mut width, &mut height);
        if !(width.is_finite() && height.is_finite() && width > 0.0 && height > 0.0) {
            return None;
        }
        let text = Owned::new((api.text)(page.0), api.free)?;
        let text = CStr::from_ptr(text.0.cast()).to_str().ok()?;
        let mut rects = ptr::null_mut();
        let mut count = 0;
        let valid = (api.layout)(page.0, &mut rects, &mut count);
        let rects = Owned::new(rects.cast(), api.free)?;
        if valid == 0 || text.chars().count() != count as usize {
            return None;
        }

        let rects = std::slice::from_raw_parts(rects.0.cast::<Rect>(), count as usize);
        let mut lines = Vec::new();
        let mut offset = 0;
        for text_line in text.split_inclusive('\n') {
            let end = offset + text_line.chars().count();
            let bounds = text_line
                .chars()
                .zip(&rects[offset..end])
                .filter(|(character, rect)| {
                    !character.is_whitespace() && rect.x2 > rect.x1 && rect.y2 > rect.y1
                })
                .map(|(_, rect)| *rect)
                .reduce(|a, b| Rect {
                    x1: a.x1.min(b.x1),
                    y1: a.y1.min(b.y1),
                    x2: a.x2.max(b.x2),
                    y2: a.y2.max(b.y2),
                });
            offset = end;
            if let Some(r) = bounds {
                lines.push(Line {
                    x: r.x1 / width,
                    y: r.y1 / height,
                    width: (r.x2 - r.x1) / width,
                    height: (r.y2 - r.y1) / height,
                });
            }
        }
        Some(PageLayout {
            width,
            height,
            lines,
        })
    }
}
