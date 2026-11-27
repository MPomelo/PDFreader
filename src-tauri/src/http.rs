// Windows' native asynchronous HTTP transport. No Node service or SDK runtime.
// All callback buffers live until WINHTTP_CALLBACK_STATUS_HANDLE_CLOSING.
use std::{cell::UnsafeCell, ffi::c_void, sync::{Arc, atomic::{AtomicBool, Ordering}, mpsc}, time::{Duration, Instant}};
use windows_sys::Win32::{Foundation::GetLastError, Networking::WinHttp::*};
use crate::secrets::Secret;
pub const MAX_RESPONSE: usize = 2 * 1024 * 1024;
pub fn service_base_url(value: &str) -> Result<url::Url, String> {
    let value = value.trim().trim_end_matches('/');
    let url = url::Url::parse(value).map_err(|_| "API 地址无效；请填写完整 Base URL。")?;
    let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]" | "::1"));
    if (url.scheme() != "https" && !(url.scheme() == "http" && local)) || url.host_str().is_none()
        || !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some() {
        return Err("地址须为不含密码、查询参数或片段的 HTTPS Base URL；本机服务可用 HTTP。".into());
    }
    Ok(url)
}
pub struct Response { pub status: u32, pub body: Vec<u8> }
enum Event { Ready(u32), Read(Vec<u8>), Error(u32) }
struct Context { sender: mpsc::Sender<Event>, buffer: UnsafeCell<[u8; 8192]>, body: Vec<u8> }
// Only WinHTTP writes buffer; its completed callback copies it before notifying
// the owner. The owner never reads or writes it, and issues one read at a time.
unsafe impl Sync for Context {}
unsafe extern "system" fn callback(_: *mut c_void, context: usize, status: u32, info: *mut c_void, len: u32) {
    if context == 0 { return; }
    if status == WINHTTP_CALLBACK_STATUS_HANDLE_CLOSING { drop(Arc::from_raw(context as *const Context)); return; }
    let ctx = &*(context as *const Context);
    let event = match status {
        WINHTTP_CALLBACK_STATUS_REQUEST_ERROR => Event::Error((*(info as *const WINHTTP_ASYNC_RESULT)).dwError),
        WINHTTP_CALLBACK_STATUS_READ_COMPLETE => Event::Read(if len == 0 { Vec::new() } else { std::slice::from_raw_parts(info as *const u8, len as usize).to_vec() }),
        WINHTTP_CALLBACK_STATUS_SENDREQUEST_COMPLETE | WINHTTP_CALLBACK_STATUS_HEADERS_AVAILABLE => Event::Ready(status),
        _ => return,
    };
    let _ = ctx.sender.send(event);
}
struct Handle(*mut c_void);
impl Drop for Handle { fn drop(&mut self) { unsafe { WinHttpCloseHandle(self.0); } } }
fn wide(text: &str) -> Vec<u16> { text.encode_utf16().chain(Some(0)).collect() }
fn error(code: u32) -> String {
    if code == ERROR_WINHTTP_TIMEOUT { "请求超时；可手动重试。".into() }
    else { format!("网络或 TLS 连接失败（Windows {code}）；请检查地址、网络及系统代理。") }
}
fn ok(value: i32) -> Result<(), String> { if value == 0 { Err(error(unsafe { GetLastError() })) } else { Ok(()) } }
fn handle(value: *mut c_void) -> Result<Handle, String> { if value.is_null() { Err(error(unsafe { GetLastError() })) } else { Ok(Handle(value)) } }
fn wait(receiver: &mpsc::Receiver<Event>, expected: u32, cancel: &AtomicBool, deadline: Instant) -> Result<Vec<u8>, String> {
    loop {
        if cancel.load(Ordering::SeqCst) { return Err("已取消请求。".into()); }
        if Instant::now() >= deadline { return Err("请求超时；可手动重试。".into()); }
        match receiver.recv_timeout(Duration::from_millis(25)) {
            Ok(Event::Error(code)) => return Err(error(code)),
            Ok(Event::Ready(code)) if code == expected => return Ok(Vec::new()),
            Ok(Event::Read(bytes)) if expected == WINHTTP_CALLBACK_STATUS_READ_COMPLETE => return Ok(bytes),
            Err(mpsc::RecvTimeoutError::Disconnected) => return Err("网络请求意外终止。".into()),
            _ => {},
        }
    }
}
pub fn request(url: &url::Url, auth: &str, secret: Option<&Secret>, body: Option<Vec<u8>>, cancel: &AtomicBool, timeout: Duration) -> Result<Response, String> {
    request_with(url, auth, secret, body, cancel, timeout, ("application/json", "application/json"), None)
}
pub fn request_form(url: &url::Url, body: Vec<u8>, cancel: &AtomicBool, timeout: Duration) -> Result<Response, String> {
    request_with(url, "none", None, Some(body), cancel, timeout, ("application/x-www-form-urlencoded", "application/json"), None)
}
pub fn request_stream(url: &url::Url, auth: &str, secret: Option<&Secret>, body: Option<Vec<u8>>, cancel: &AtomicBool, timeout: Duration,
    chunk: &mut dyn FnMut(&[u8]) -> Result<bool, String>) -> Result<Response, String> {
    request_with(url, auth, secret, body, cancel, timeout, ("application/json", "text/event-stream"), Some(chunk))
}
pub fn request_ndjson(url: &url::Url, body: Vec<u8>, cancel: &AtomicBool, timeout: Duration,
    chunk: &mut dyn FnMut(&[u8]) -> Result<bool, String>) -> Result<Response, String> {
    request_with(url, "none", None, Some(body), cancel, timeout, ("application/json", "application/x-ndjson"), Some(chunk))
}
fn request_with(url: &url::Url, auth: &str, secret: Option<&Secret>, body: Option<Vec<u8>>, cancel: &AtomicBool, timeout: Duration,
    (content_type, accept): (&str, &str), mut chunk_handler: Option<&mut dyn FnMut(&[u8]) -> Result<bool, String>>) -> Result<Response, String> {
    if cancel.load(Ordering::SeqCst) { return Err("已取消请求。".into()); }
    let deadline = Instant::now() + timeout;
    let (sender, receiver) = mpsc::channel();
    let context = Arc::new(Context { sender, buffer: UnsafeCell::new([0; 8192]), body: body.unwrap_or_default() });
    unsafe {
        let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]" | "::1"));
        let session = handle(WinHttpOpen(wide("PDFreader/0.1").as_ptr(), if local { WINHTTP_ACCESS_TYPE_NO_PROXY } else { WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY }, std::ptr::null(), std::ptr::null(), WINHTTP_FLAG_ASYNC))?;
        ok(WinHttpSetTimeouts(session.0, 15000, 15000, 30000, timeout.as_millis().min(i32::MAX as u128) as i32))?;
        let connection = handle(WinHttpConnect(session.0, wide(url.host_str().ok_or("地址缺少主机")?).as_ptr(), url.port_or_known_default().ok_or("地址端口无效")?, 0))?;
        let method = if context.body.is_empty() { "GET" } else { "POST" };
        let request = handle(WinHttpOpenRequest(connection.0, wide(method).as_ptr(), wide(url.path()).as_ptr(), std::ptr::null(), std::ptr::null(), std::ptr::null(), if url.scheme() == "https" { WINHTTP_FLAG_SECURE } else { 0 }))?;
        // Never forward credentials through redirects or silently replay a POST.
        let policy: u32 = WINHTTP_OPTION_REDIRECT_POLICY_NEVER;
        ok(WinHttpSetOption(request.0, WINHTTP_OPTION_REDIRECT_POLICY, (&policy as *const u32).cast(), 4))?;
        let disable: u32 = WINHTTP_DISABLE_COOKIES | WINHTTP_DISABLE_AUTHENTICATION;
        ok(WinHttpSetOption(request.0, WINHTTP_OPTION_DISABLE_FEATURE, (&disable as *const u32).cast(), 4))?;
        let flags = WINHTTP_CALLBACK_STATUS_SENDREQUEST_COMPLETE | WINHTTP_CALLBACK_STATUS_HEADERS_AVAILABLE
            | WINHTTP_CALLBACK_STATUS_READ_COMPLETE | WINHTTP_CALLBACK_STATUS_REQUEST_ERROR | WINHTTP_CALLBACK_STATUS_HANDLE_CLOSING;
        if WinHttpSetStatusCallback(request.0, Some(callback), flags, 0).is_some_and(|f| f as usize == usize::MAX) { return Err(error(GetLastError())); }
        // This reference belongs to the closing callback, not to this stack.
        let owned = Arc::into_raw(context.clone()) as usize;
        if WinHttpSetOption(request.0, WINHTTP_OPTION_CONTEXT_VALUE, (&owned as *const usize).cast(), std::mem::size_of::<usize>() as u32) == 0 {
            drop(Arc::from_raw(owned as *const Context)); return Err(error(GetLastError()));
        }
        let mut headers = format!("Content-Type: {content_type}\r\nAccept: {accept}\r\n");
        if auth != "none" {
            let key = std::str::from_utf8(&secret.ok_or("未配置密钥")?.0).map_err(|_| "密钥编码无效")?;
            headers.push_str(match auth {
                "api-key" => "api-key: ",
                "anthropic" => "anthropic-version: 2023-06-01\r\nx-api-key: ",
                _ => "Authorization: Bearer ",
            });
            headers.push_str(key); headers.push_str("\r\n");
        }
        if cancel.load(Ordering::SeqCst) { return Err("已取消请求。".into()); }
        ok(WinHttpSendRequest(request.0, wide(&headers).as_ptr(), u32::MAX, if context.body.is_empty() { std::ptr::null() } else { context.body.as_ptr().cast() }, context.body.len() as u32, context.body.len() as u32, owned))?;
        wait(&receiver, WINHTTP_CALLBACK_STATUS_SENDREQUEST_COMPLETE, cancel, deadline)?;
        ok(WinHttpReceiveResponse(request.0, std::ptr::null_mut()))?;
        wait(&receiver, WINHTTP_CALLBACK_STATUS_HEADERS_AVAILABLE, cancel, deadline)?;
        let mut status = 0u32; let mut len = 4u32;
        ok(WinHttpQueryHeaders(request.0, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER, std::ptr::null(), (&mut status as *mut u32).cast(), &mut len, std::ptr::null_mut()))?;
        let mut bytes = Vec::new(); let mut received = 0usize;
        loop {
            ok(WinHttpReadData(request.0, context.buffer.get().cast(), 8192, std::ptr::null_mut()))?;
            let chunk = wait(&receiver, WINHTTP_CALLBACK_STATUS_READ_COMPLETE, cancel, deadline)?;
            if chunk.is_empty() { break; }
            received += chunk.len();
            if received > MAX_RESPONSE { return Err("响应超过 2 MiB 限制；请缩短选区。".into()); }
            if (200..300).contains(&status) && chunk_handler.is_some() {
                if chunk_handler.as_mut().unwrap()(&chunk)? { break; }
            } else { bytes.extend_from_slice(&chunk); }
        }
        Ok(Response { status, body: bytes })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::{Read, Write}, net::TcpListener, thread};
    #[test]
    #[ignore = "Requires Windows loopback networking outside the agent sandbox; Windows 12029 observed here"]
    fn native_http_sends_one_auth_header_and_decodes_chunked_utf8() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap(); let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap(); socket.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let mut data = Vec::new(); let mut buffer = [0; 4096];
            loop { let n = socket.read(&mut buffer).unwrap(); data.extend_from_slice(&buffer[..n]); if data.windows(4).any(|w| w == b"\r\n\r\n") && data.ends_with(b"{}") { break; } }
            let headers = String::from_utf8(data).unwrap().to_ascii_lowercase();
            assert!(headers.starts_with("post /v1/chat/completions")); assert!(headers.contains("api-key: dummy-test-key")); assert!(!headers.contains("authorization:"));
            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n").unwrap();
            let bytes = "中文 response".as_bytes();
            for part in bytes.chunks(2) { socket.write_all(format!("{:X}\r\n", part.len()).as_bytes()).unwrap(); socket.write_all(part).unwrap(); socket.write_all(b"\r\n").unwrap(); }
            socket.write_all(b"0\r\n\r\n").unwrap();
        });
        let url = url::Url::parse(&format!("http://{address}/v1/chat/completions")).unwrap();
        let response = request(&url, "api-key", Some(&Secret(b"dummy-test-key".to_vec())), Some(b"{}".to_vec()), &AtomicBool::new(false), Duration::from_secs(5)).unwrap();
        assert_eq!(response.status, 200); assert_eq!(String::from_utf8(response.body).unwrap(), "中文 response"); server.join().unwrap();
    }
    #[test]
    #[ignore = "Requires Windows loopback networking outside the agent sandbox; Windows 12029 observed here"]
    fn native_http_cancel_and_deadline_stop_waiting_for_headers() {
        for should_cancel in [true, false] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap(); let address = listener.local_addr().unwrap();
            let server = thread::spawn(move || { let (_socket, _) = listener.accept().unwrap(); thread::sleep(Duration::from_millis(500)); });
            let cancel = Arc::new(AtomicBool::new(false)); let flag = cancel.clone();
            if should_cancel { thread::spawn(move || { thread::sleep(Duration::from_millis(100)); flag.store(true, Ordering::SeqCst); }); }
            let start = Instant::now();
            let result = request(&url::Url::parse(&format!("http://{address}/v1/models")).unwrap(), "none", None, None, &cancel, Duration::from_millis(220));
            assert!(result.err().unwrap().contains(if should_cancel { "取消" } else { "超时" })); assert!(start.elapsed() < Duration::from_millis(450)); server.join().unwrap();
        }
    }
    #[test]
    fn callback_wait_honors_cancellation_deadlines_and_chunk_boundaries() {
        let (sender, receiver) = mpsc::channel();
        sender.send(Event::Ready(WINHTTP_CALLBACK_STATUS_SENDREQUEST_COMPLETE)).unwrap();
        sender.send(Event::Read(vec![0xe4, 0xb8])).unwrap();
        let cancel = AtomicBool::new(false);
        let deadline = Instant::now() + Duration::from_millis(150);
        assert!(wait(&receiver, WINHTTP_CALLBACK_STATUS_SENDREQUEST_COMPLETE, &cancel, deadline).unwrap().is_empty());
        assert_eq!(wait(&receiver, WINHTTP_CALLBACK_STATUS_READ_COMPLETE, &cancel, deadline).unwrap(), vec![0xe4, 0xb8]);
        cancel.store(true, Ordering::SeqCst);
        assert!(wait(&receiver, WINHTTP_CALLBACK_STATUS_READ_COMPLETE, &cancel, deadline).err().unwrap().contains("取消"));
        cancel.store(false, Ordering::SeqCst);
        assert!(wait(&receiver, WINHTTP_CALLBACK_STATUS_READ_COMPLETE, &cancel, Instant::now()).err().unwrap().contains("超时"));
    }
    #[test]
    #[ignore = "Run with --include-ignored in the host session for a real Windows SSE socket check"]
    fn native_sse_stream_decodes_split_events_and_keeps_reasoning_separate() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap(); let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap(); let mut request = [0; 4096]; let _ = socket.read(&mut request).unwrap();
            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n").unwrap();
            let stream = concat!(": ping\r\n\r\n", "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"思考\"}}]}\r\n\r\n", "data: {\"choices\":[{\"delta\":{\"content\":\"中文 $x$\"}}]}\r\n\r\n", "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n", "data: [DONE]\n\n");
            for byte in stream.as_bytes() { socket.write_all(b"1\r\n").unwrap(); socket.write_all(&[*byte]).unwrap(); socket.write_all(b"\r\n").unwrap(); }
            let _ = socket.write_all(b"0\r\n\r\n");
        });
        let mut parser = crate::sse::Completion::default();
        let output = request_stream(&url::Url::parse(&format!("http://{address}/chat/completions")).unwrap(), "none", None, Some(b"{}".to_vec()), &AtomicBool::new(false), Duration::from_secs(5), &mut |bytes| { parser.push(bytes)?; Ok(parser.is_done()) }).unwrap();
        assert_eq!(output.status, 200); assert!(output.body.is_empty()); assert_eq!(parser.text, "中文 $x$"); assert_eq!(parser.reasoning, "思考"); assert!(parser.complete().is_ok()); server.join().unwrap();
    }
}
