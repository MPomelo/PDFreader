use crate::{http, secrets::Secret};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    io::{self, Read, Write},
    net::{TcpListener, TcpStream},
    ptr::null_mut,
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use url::Url;
use windows_sys::Win32::{
    Foundation::{LocalFree, RPC_E_CHANGED_MODE},
    Security::Cryptography::*,
    System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE},
    UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL},
};

const ISSUER: &str = "https://auth.openai.com";
const AUTHORIZE: &str = "https://auth.openai.com/api/accounts/authorize";
const TOKEN: &str = "https://auth.openai.com/api/accounts/oauth/token";
const REVOKE: &str = "https://auth.openai.com/api/accounts/oauth/revoke";
const JWKS: &str = "https://auth.openai.com/.well-known/jwks.json";
const RESOURCE: &str = "https://api.openai.com/v1";
const CALLBACK: &str = "/auth/callback";
const SCOPES: &str = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";

pub fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()
}

fn random(bytes: &mut [u8]) -> Result<(), String> {
    if unsafe { BCryptGenRandom(null_mut(), bytes.as_mut_ptr(), bytes.len() as u32, BCRYPT_USE_SYSTEM_PREFERRED_RNG) } != 0 {
        return Err("无法生成登录所需的随机值。".into());
    }
    Ok(())
}

fn random_challenge() -> Result<String, String> {
    let mut bytes = [0; 32];
    random(&mut bytes)?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

pub fn host_id() -> Result<String, String> {
    let mut bytes = [0; 16];
    random(&mut bytes)?;
    bytes[6] = bytes[6] & 0x0f | 0x40;
    bytes[8] = bytes[8] & 0x3f | 0x80;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    Ok(format!("urn:uuid:{}-{}-{}-{}-{}", &hex[..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..]))
}

pub fn open_browser(url: &str) -> Result<(), String> {
    let wide: Vec<u16> = url.encode_utf16().chain(Some(0)).collect();
    let result = unsafe {
        let initialized = CoInitializeEx(std::ptr::null(), (COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) as u32);
        if initialized < 0 && initialized != RPC_E_CHANGED_MODE { return Err("无法打开系统浏览器。".into()); }
        let result = ShellExecuteW(null_mut(), windows_sys::core::w!("open"), wide.as_ptr(), std::ptr::null(),
            std::ptr::null(), SW_SHOWNORMAL);
        if initialized >= 0 { CoUninitialize(); }
        result
    };
    if result as usize <= 32 { return Err("无法打开系统浏览器。".into()); }
    Ok(())
}

pub fn protect(data: &[u8], encrypt: bool) -> Result<Secret, String> {
    let input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr().cast_mut() };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        let success = if encrypt {
            CryptProtectData(&input, windows_sys::core::w!("PDFreader ChatGPT"), std::ptr::null(),
                std::ptr::null(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut output)
        } else {
            CryptUnprotectData(&input, null_mut(), std::ptr::null(),
                std::ptr::null(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut output)
        };
        if success == 0 || output.pbData.is_null() { return Err("Windows 无法读取或保护 ChatGPT 登录凭据。".into()); }
        let bytes = std::slice::from_raw_parts_mut(output.pbData, output.cbData as usize);
        let result = Secret(bytes.to_vec());
        for byte in bytes { std::ptr::write_volatile(byte, 0); }
        LocalFree(output.pbData.cast());
        Ok(result)
    }
}

pub struct Authorization {
    listener: TcpListener,
    redirect: Url,
    state: String,
    nonce: String,
    verifier: String,
    registered_client: Option<String>,
}

impl Authorization {
    pub fn new(client: Option<&str>) -> Result<Self, String> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|_| "无法启动本机 ChatGPT 登录回调。")?;
        listener.set_nonblocking(true).map_err(|_| "无法启动本机 ChatGPT 登录回调。")?;
        let address = listener.local_addr().map_err(|_| "无法读取登录回调地址。")?;
        Ok(Self {
            listener, redirect: Url::parse(&format!("http://{address}{CALLBACK}")).unwrap(),
            state: random_challenge()?, nonce: random_challenge()?, verifier: random_challenge()?,
            registered_client: client.map(str::to_owned),
        })
    }

    pub fn url(&self, host: &str, email: Option<&str>, id_token: Option<&str>, consent: bool) -> Url {
        let mut url = Url::parse(AUTHORIZE).unwrap();
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(self.verifier.as_bytes()));
        let mut query = url.query_pairs_mut();
        query.extend_pairs([
            ("client_id", self.registered_client.as_deref().unwrap_or("dynamic_agent_client")),
            ("ext_agent_host_id", host), ("response_type", "code"),
            ("redirect_uri", self.redirect.as_str()), ("scope", SCOPES), ("resource", RESOURCE),
            ("state", &self.state), ("nonce", &self.nonce),
            ("code_challenge_method", "S256"), ("code_challenge", &challenge),
        ]);
        if self.registered_client.is_none() { query.append_pair("agent_name_hint", "PDFreader"); }
        if let Some(email) = email { query.append_pair("login_hint", email); }
        if let Some(id_token) = id_token { query.append_pair("id_token_hint", id_token); }
        if consent { query.append_pair("prompt", "consent"); }
        drop(query);
        url
    }

    pub fn wait(&self, cancel: &AtomicBool) -> Result<Callback, String> {
        let deadline = Instant::now() + Duration::from_secs(180);
        while !cancel.load(Ordering::SeqCst) && Instant::now() < deadline {
            match self.listener.accept() {
                Ok((mut stream, _)) => {
                    let _ = stream.set_read_timeout(Some(Duration::from_millis(200)));
                    let _ = stream.set_write_timeout(Some(Duration::from_millis(250)));
                    if let Some(callback) = read_request(&mut stream)
                        .and_then(|target| parse_callback(&target, &self.redirect, &self.state, self.registered_client.as_deref())) {
                        return Ok(Callback { stream, result: callback });
                    }
                    respond(&mut stream, false, "未识别的登录回调。");
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(50)),
                Err(_) => return Err("本机登录回调已关闭。".into()),
            }
        }
        Err(if cancel.load(Ordering::SeqCst) { "已取消 ChatGPT 登录。" } else { "ChatGPT 登录超时，请重新开始。" }.into())
    }

    pub fn exchange(&self, code: &str, client: &str, cancel: &AtomicBool) -> Result<TokenResponse, String> {
        let response = post_form(TOKEN, &[
            ("grant_type", "authorization_code"), ("client_id", client), ("code", code),
            ("code_verifier", &self.verifier), ("redirect_uri", self.redirect.as_str()), ("resource", RESOURCE),
        ], cancel)?;
        parse_token(response).map_err(|error| match error {
            TokenError::Expired => "登录授权码已失效，请重新开始。".into(),
            _ => "ChatGPT 登录凭据交换失败，请重新登录。".into(),
        })
    }

    pub fn identity(&self, token: &str, client: &str, cancel: &AtomicBool) -> Result<Identity, String> {
        verify_identity(token, client, &self.nonce, cancel)
    }
}

pub struct Callback {
    stream: TcpStream,
    pub result: Result<(String, String), String>,
}
impl Callback {
    pub fn finish(&mut self, success: bool) {
        let text = if success { "授权完成。你可以关闭此页面，返回 PDFreader。" }
            else { "授权未完成。请返回 PDFreader 查看登录状态。" };
        respond(&mut self.stream, success, text);
    }
}

fn read_request(stream: &mut TcpStream) -> Option<String> {
    let mut data = Vec::new();
    let mut buffer = [0; 2048];
    let deadline = Instant::now() + Duration::from_secs(1);
    while data.len() < 16 * 1024 && Instant::now() < deadline {
        let size = stream.read(&mut buffer).ok()?;
        if size == 0 { return None; }
        data.extend_from_slice(&buffer[..size]);
        if data.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
            let line = std::str::from_utf8(&data).ok()?.lines().next()?;
            let mut parts = line.split(' ');
            if parts.next()? != "GET" { return None; }
            let target = parts.next()?;
            return matches!(parts.next(), Some("HTTP/1.0" | "HTTP/1.1")).then(|| target.to_owned());
        }
    }
    None
}

fn parse_callback(target: &str, redirect: &Url, state: &str, registered: Option<&str>) -> Option<Result<(String, String), String>> {
    if !target.starts_with("/auth/callback?") || target.contains('#') { return None; }
    let url = redirect.join(target).ok()?;
    if url.origin() != redirect.origin() || url.path() != CALLBACK { return None; }
    let mut params = HashMap::new();
    for (name, value) in url.query_pairs() {
        if params.insert(name, value).is_some() { return None; }
    }
    if params.get("state")?.as_ref() != state || params.get("iss").is_some_and(|issuer| issuer.as_ref() != ISSUER) {
        return None;
    }
    if params.contains_key("error") { return Some(Err("ChatGPT 授权已取消或未获批准。".into())); }
    let client = match (registered, params.get("client_id").map(|id| id.as_ref())) {
        (Some(expected), None) => expected,
        (Some(expected), Some(returned)) if returned == expected => expected,
        (None, Some(returned)) if returned != "dynamic_agent_client" && visible_token(returned, 256) => returned,
        _ => return Some(Err("OpenAI 返回的登录注册标识不匹配，请重新登录。".into())),
    };
    let code = params.get("code").filter(|code| visible_token(code, 4096))?;
    Some(Ok((code.to_string(), client.to_owned())))
}

fn respond(stream: &mut TcpStream, success: bool, message: &str) {
    let status = if success { "200 OK" } else { "400 Bad Request" };
    let body = format!("<!doctype html><html lang=\"zh-CN\"><meta charset=\"utf-8\"><title>PDFreader · ChatGPT</title><p>{message}</p></html>");
    let _ = write!(stream, "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nContent-Security-Policy: default-src 'none'\r\nConnection: close\r\n\r\n{body}", body.len());
}

#[derive(Deserialize)]
pub struct TokenResponse {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub id_token: Option<String>,
    pub expires_in: u64,
    pub scope: Option<String>,
    token_type: String,
}
pub fn visible_token(value: &str, limit: usize) -> bool {
    !value.is_empty() && value.len() <= limit && value.bytes().all(|byte| (33..=126).contains(&byte))
}
pub fn plan_allowed(scope: &str) -> bool {
    let mut scopes = scope.split_ascii_whitespace();
    let direct = scopes.any(|scope| scope == "chatgpt.tokens.use.direct");
    direct && scope.split_ascii_whitespace().any(|scope| scope == "resource.invoke")
}

#[derive(PartialEq)]
pub enum TokenError { Expired, Unavailable }
fn parse_token(response: http::Response) -> Result<TokenResponse, TokenError> {
    if response.status != 200 {
        let error: serde_json::Value = serde_json::from_slice(&response.body).unwrap_or_default();
        return Err(if matches!(error["error"].as_str(), Some("invalid_grant" | "invalid_refresh_token" |
            "token_expired" | "refresh_token_expired" | "refresh_token_invalidated" | "refresh_token_reused")) {
            TokenError::Expired
        } else { TokenError::Unavailable });
    }
    let token: TokenResponse = serde_json::from_slice(&response.body).map_err(|_| TokenError::Unavailable)?;
    if !token.token_type.eq_ignore_ascii_case("Bearer") || token.expires_in == 0
        || !visible_token(&token.access_token, 32 * 1024)
        || token.refresh_token.as_ref().is_some_and(|value| !visible_token(value, 32 * 1024)) {
        return Err(TokenError::Unavailable);
    }
    Ok(token)
}

fn post_form(endpoint: &str, parameters: &[(&str, &str)], cancel: &AtomicBool) -> Result<http::Response, String> {
    let form = url::form_urlencoded::Serializer::new(String::new()).extend_pairs(parameters.iter().copied()).finish();
    http::request_form(&Url::parse(endpoint).unwrap(), form.into_bytes(), cancel, Duration::from_secs(15))
}

pub fn refresh(client: &str, token: &str, cancel: &AtomicBool) -> Result<TokenResponse, TokenError> {
    let response = post_form(TOKEN, &[("grant_type", "refresh_token"), ("client_id", client),
        ("refresh_token", token), ("resource", RESOURCE)], cancel).map_err(|_| TokenError::Unavailable)?;
    parse_token(response)
}

pub fn revoke(client: &str, token: &str) -> bool {
    let cancel = AtomicBool::new(false);
    for delay in [0, 350, 900] {
        std::thread::sleep(Duration::from_millis(delay));
        match post_form(REVOKE, &[("token", token), ("token_type_hint", "refresh_token"), ("client_id", client)], &cancel) {
            Ok(response) if response.status == 200 => return true,
            Ok(response) if response.status < 500 => return false,
            _ => {}
        }
    }
    false
}

#[derive(Deserialize)]
struct Header { kid: String, alg: String }
#[derive(Deserialize)]
struct Keys { keys: Vec<Key> }
#[derive(Deserialize)]
struct Key {
    kid: String, kty: String, n: Option<String>, e: Option<String>, alg: Option<String>,
    #[serde(rename = "use")]
    purpose: Option<String>,
}
#[derive(Deserialize)]
#[serde(untagged)]
enum Audience { Single(String), Multiple(Vec<String>) }
#[derive(Deserialize)]
struct Claims {
    iss: String, sub: String, aud: Audience, azp: Option<String>, exp: u64, nbf: Option<u64>, nonce: String,
    email: Option<String>,
}
pub struct Identity { pub subject: String, pub email: Option<String> }

fn verify_identity(token: &str, client: &str, nonce: &str, cancel: &AtomicBool) -> Result<Identity, String> {
    let invalid = "无法验证 ChatGPT 账户身份，请重新登录。";
    if !visible_token(token, 32 * 1024) { return Err(invalid.into()); }
    let (signed, signature) = token.rsplit_once('.').ok_or(invalid)?;
    let (header, claims) = signed.split_once('.').ok_or(invalid)?;
    let header: Header = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(header).map_err(|_| invalid)?).map_err(|_| invalid)?;
    if header.alg != "RS256" || header.kid.is_empty() { return Err(invalid.into()); }
    let response = http::request(&Url::parse(JWKS).unwrap(), "none", None, None, cancel, Duration::from_secs(15))?;
    if response.status != 200 { return Err(invalid.into()); }
    let keys: Keys = serde_json::from_slice(&response.body).map_err(|_| invalid)?;
    let key = keys.keys.into_iter().find(|key| key.kid == header.kid && key.kty == "RSA" &&
        key.alg.as_deref().is_none_or(|alg| alg == "RS256") && key.purpose.as_deref().is_none_or(|value| value == "sig"))
        .ok_or(invalid)?;
    let modulus = URL_SAFE_NO_PAD.decode(key.n.ok_or(invalid)?).map_err(|_| invalid)?;
    let exponent = URL_SAFE_NO_PAD.decode(key.e.ok_or(invalid)?).map_err(|_| invalid)?;
    let signature = URL_SAFE_NO_PAD.decode(signature).map_err(|_| invalid)?;
    if !rsa_verify(&modulus, &exponent, signed.as_bytes(), &signature) { return Err(invalid.into()); }
    let claims: Claims = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(claims).map_err(|_| invalid)?).map_err(|_| invalid)?;
    validate_claims(claims, client, nonce, now()).ok_or_else(|| invalid.into())
}

fn validate_claims(claims: Claims, client: &str, nonce: &str, now: u64) -> Option<Identity> {
    let audience_matches = match &claims.aud {
        Audience::Single(value) => value == client,
        Audience::Multiple(values) => values.iter().any(|value| value == client)
            && (values.len() == 1 || claims.azp.as_deref() == Some(client)),
    };
    if claims.iss != ISSUER || claims.nonce != nonce || !audience_matches || claims.exp <= now ||
        claims.nbf.is_some_and(|value| value > now) || claims.azp.as_deref().is_some_and(|value| value != client) ||
        claims.sub.trim().is_empty() || claims.sub.len() > 1024 {
        return None;
    }
    Some(Identity { subject: claims.sub, email: claims.email.filter(|value| !value.trim().is_empty() && value.len() <= 320) })
}

fn rsa_verify(modulus: &[u8], exponent: &[u8], input: &[u8], signature: &[u8]) -> bool {
    if !(256..=1024).contains(&modulus.len()) || exponent.is_empty() || exponent.len() > 8 || signature.len() != modulus.len() {
        return false;
    }
    // CNG's RSA public blob is six little-endian ULONGs followed by the big-endian exponent and modulus.
    let mut blob = Vec::with_capacity(24 + exponent.len() + modulus.len());
    for value in [BCRYPT_RSAPUBLIC_MAGIC, (modulus.len() * 8) as u32, exponent.len() as u32, modulus.len() as u32, 0, 0] {
        blob.extend(value.to_le_bytes());
    }
    blob.extend_from_slice(exponent);
    blob.extend_from_slice(modulus);
    let hash = Sha256::digest(input);
    let padding = BCRYPT_PKCS1_PADDING_INFO { pszAlgId: BCRYPT_SHA256_ALGORITHM };
    let mut algorithm = null_mut();
    let mut key = null_mut();
    unsafe {
        if BCryptOpenAlgorithmProvider(&mut algorithm, BCRYPT_RSA_ALGORITHM, std::ptr::null(), 0) != 0 { return false; }
        let imported = BCryptImportKeyPair(algorithm, null_mut(), BCRYPT_RSAPUBLIC_BLOB, &mut key, blob.as_ptr(), blob.len() as u32, 0) == 0;
        let verified = imported && BCryptVerifySignature(key, (&padding as *const BCRYPT_PKCS1_PADDING_INFO).cast(),
            hash.as_ptr(), hash.len() as u32, signature.as_ptr(), signature.len() as u32, BCRYPT_PAD_PKCS1) == 0;
        if imported { BCryptDestroyKey(key); }
        BCryptCloseAlgorithmProvider(algorithm, 0);
        verified
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn callbacks_require_the_exact_state_and_registration() {
        let redirect = Url::parse("http://127.0.0.1:1455/auth/callback").unwrap();
        let good = "/auth/callback?state=x&code=abc&client_id=oaiapp_1";
        assert_eq!(parse_callback(good, &redirect, "x", None).unwrap().unwrap().1, "oaiapp_1");
        assert!(parse_callback(good, &redirect, "y", None).is_none());
        assert!(parse_callback(good, &redirect, "x", Some("oaiapp_2")).unwrap().is_err());
        assert!(parse_callback("/auth/callback?state=x&state=x&code=abc", &redirect, "x", None).is_none());
        assert!(parse_callback("/auth/callback?state=x&error=access_denied", &redirect, "x", None).unwrap().is_err());
        assert!(parse_callback("/auth/callback?state=x&code=abc", &redirect, "x", None).unwrap().is_err());
        assert!(parse_callback("/auth/callback?state=x&code=abc", &redirect, "x", Some("oaiapp_1")).unwrap().is_ok());
    }

    #[test]
    fn signed_claims_still_require_issuer_audience_nonce_and_expiry() {
        let claims = || serde_json::from_str::<Claims>(
            r#"{"iss":"https://auth.openai.com","sub":"subject","aud":"oaiapp_1","nonce":"x","exp":100}"#).unwrap();
        assert_eq!(validate_claims(claims(), "oaiapp_1", "x", 99).unwrap().subject, "subject");
        assert!(validate_claims(claims(), "oaiapp_2", "x", 99).is_none());
        assert!(validate_claims(claims(), "oaiapp_1", "other", 99).is_none());
        assert!(validate_claims(claims(), "oaiapp_1", "x", 100).is_none());
        assert!(plan_allowed(SCOPES));
        assert!(!plan_allowed("openid profile email"));
    }
}
