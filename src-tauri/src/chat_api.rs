use crate::{local, openai_compat, secrets::{Secret, SecretStatus}, translation::ApiState};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{fs, io::{ErrorKind, Read}, path::Path, sync::atomic::AtomicBool, time::Duration};
use tauri::{AppHandle, Manager, State};

const MAX_PROFILES: usize = 20;
const MAX_CONFIG_SIZE: u64 = 96 * 1024;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Profile {
    id: String,
    name: String,
    base_url: String,
    model: String,
    auth: Auth,
    pub streaming: bool,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
enum Auth { Bearer, ApiKey, None }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedProfile {
    #[serde(flatten)]
    profile: Profile,
    route: String,
}

#[derive(Serialize)]
pub struct SavedChange {
    profile: SavedProfile,
    warning: Option<String>,
}

impl Profile {
    fn validate(&mut self) -> Result<(), String> {
        self.name = self.name.trim().into();
        self.model = self.model.trim().into();
        if self.id.is_empty() || self.id.len() > 80 || !self.id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            || self.name.is_empty() || self.name.len() > 160 || self.model.len() > 256 || self.base_url.len() > 2048 {
            return Err("API 配置名称、地址或模型名称无效。".into());
        }
        let url = openai_compat::normalize_base_url(&self.base_url)?;
        self.base_url = url.as_str().trim_end_matches('/').into();
        Ok(())
    }
    pub fn auth(&self) -> &'static str {
        match self.auth { Auth::Bearer => "bearer", Auth::ApiKey => "api-key", Auth::None => "none" }
    }
    fn route(&self) -> String {
        let mut digest = Sha256::new();
        digest.update(self.id.as_bytes());
        digest.update([0]);
        digest.update(self.base_url.as_bytes());
        digest.update([0]);
        digest.update(self.auth().as_bytes());
        format!("{:x}", digest.finalize())
    }
    fn binding(&self) -> String { format!("chat-api|{}", self.route()) }
    fn snapshot(self) -> SavedProfile { SavedProfile { route: self.route(), profile: self } }
    pub fn endpoint(&self, endpoint: &str) -> Result<url::Url, String> {
        let base = url::Url::parse(&self.base_url).map_err(|_| "API 请求地址无效。")?;
        openai_compat::endpoint_url(&base, endpoint)
    }
}

fn read(path: &Path) -> Result<Vec<Profile>, String> {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err("无法读取 AI API 配置。".into()),
    };
    let mut data = Vec::new();
    file.take(MAX_CONFIG_SIZE + 1).read_to_end(&mut data).map_err(|_| "无法读取 AI API 配置。")?;
    if data.len() as u64 > MAX_CONFIG_SIZE { return Err("AI API 配置文件过大。".into()); }
    let mut profiles: Vec<Profile> = serde_json::from_slice(&data).map_err(|_| "AI API 配置文件损坏，原文件保留。")?;
    let mut ids = std::collections::HashSet::new();
    if profiles.len() > MAX_PROFILES { return Err("AI API 配置数量超出上限。".into()); }
    for profile in &mut profiles {
        profile.validate()?;
        if !ids.insert(profile.id.clone()) { return Err("AI API 配置含重复标识。".into()); }
    }
    Ok(profiles)
}

fn write(path: &Path, profiles: &[Profile]) -> Result<(), String> {
    let data = serde_json::to_vec(profiles).map_err(|_| "无法生成 AI API 配置文件。")?;
    if data.len() as u64 > MAX_CONFIG_SIZE { return Err("AI API 配置文件过大。".into()); }
    local::atomic_write(path, &data)
}

fn profiles<T>(app: &AppHandle, operation: impl FnOnce(&Path, Vec<Profile>) -> Result<T, String>) -> Result<T, String> {
    let state = app.state::<local::LocalState>();
    let _guard = state.0.lock().map_err(|_| "无法读取 AI API 配置。")?;
    let directory = app.path().app_config_dir().map_err(|_| "无法定位 AI API 配置目录。")?;
    fs::create_dir_all(&directory).map_err(|_| "无法创建 AI API 配置目录。")?;
    let path = directory.join("chat-api-profiles-v1.json");
    let _lock = local::lock(&path)?;
    operation(&path, read(&path)?)
}

fn selected<'a>(profiles: &'a [Profile], id: &str, route: &str) -> Result<&'a Profile, String> {
    let profile = profiles.iter().find(|profile| profile.id == id).ok_or("找不到此 AI API 配置，请重新选择。")?;
    if profile.route() != route { return Err("此 API 配置的地址或鉴权方式已变更。请确认后重新发送。".into()); }
    Ok(profile)
}

pub fn connection(app: &AppHandle, id: &str, route: &str) -> Result<(Profile, Option<Secret>), String> {
    profiles(app, |_, profiles| {
        let profile = selected(&profiles, id, route)?;
        let secret = if matches!(profile.auth, Auth::None) { None } else {
            Some(app.state::<ApiState>().secrets.get(&profile.binding()).map_err(|_| "请为所选 AI API 配置保存密钥。")?)
        };
        Ok((profile.clone(), secret))
    })
}

#[tauri::command]
pub fn chat_api_profiles(app: AppHandle) -> Result<Vec<SavedProfile>, String> {
    profiles(&app, |_, profiles| Ok(profiles.into_iter().map(Profile::snapshot).collect()))
}

fn clear_key(app: &AppHandle, profile: &Profile) -> Option<String> {
    if matches!(profile.auth, Auth::None) { return None; }
    app.state::<ApiState>().secrets.delete(&profile.binding()).err()
}

#[tauri::command]
pub fn chat_api_save_profile(app: AppHandle, mut profile: Profile, expected_route: Option<String>) -> Result<SavedChange, String> {
    profile.validate()?;
    profiles(&app, |path, mut profiles| {
        let old = if let Some(route) = expected_route {
            let old = selected(&profiles, &profile.id, &route)?.clone();
            if let Some(item) = profiles.iter_mut().find(|item| item.id == profile.id) { *item = profile.clone(); }
            Some(old)
        } else {
            if profiles.len() >= MAX_PROFILES || profiles.iter().any(|item| item.id == profile.id) {
                return Err("配置数量已达上限，或配置已保存。请重新打开设置。".into());
            }
            profiles.push(profile.clone());
            None
        };
        write(path, &profiles)?;
        let warning = old.filter(|old| old.route() != profile.route()).and_then(|old| clear_key(&app, &old));
        Ok(SavedChange { profile: profile.snapshot(), warning })
    })
}

#[tauri::command]
pub fn chat_api_delete_profile(app: AppHandle, id: String, route: String) -> Result<Option<String>, String> {
    profiles(&app, |path, mut profiles| {
        let removed = selected(&profiles, &id, &route)?.clone();
        profiles.retain(|item| item.id != id);
        write(path, &profiles)?;
        Ok(clear_key(&app, &removed))
    })
}

#[tauri::command]
pub fn chat_api_secret_status(app: AppHandle, state: State<ApiState>, id: String, route: String) -> Result<SecretStatus, String> {
    profiles(&app, |_, profiles| Ok(state.secrets.status(&selected(&profiles, &id, &route)?.binding())))
}

#[tauri::command]
pub fn chat_api_secret_save(app: AppHandle, state: State<ApiState>, id: String, route: String, key: String, session_only: bool) -> Result<SecretStatus, String> {
    let secret = Secret(key.into_bytes());
    profiles(&app, |_, profiles| {
        let profile = selected(&profiles, &id, &route)?;
        if matches!(profile.auth, Auth::None) { return Err("该配置不使用 API 密钥。".into()); }
        state.secrets.save(&profile.binding(), secret, session_only)
    })
}

#[tauri::command]
pub fn chat_api_secret_delete(app: AppHandle, state: State<ApiState>, id: String, route: String) -> Result<SecretStatus, String> {
    profiles(&app, |_, profiles| state.secrets.delete(&selected(&profiles, &id, &route)?.binding()))
}

pub fn check_status(status: u32) -> Result<(), String> {
    openai_compat::check_http_status(status)
}

pub fn usage(value: &Value) -> Value {
    if !value.is_object() { return Value::Null; }
    json!({
        "input_tokens":value["prompt_tokens"].as_u64(),
        "output_tokens":value["completion_tokens"].as_u64()
    })
}

pub fn reply(body: &[u8]) -> Result<(String, String, Value), String> {
    let value: Value = serde_json::from_slice(body).map_err(|_| "API 返回了无法识别的回复格式。")?;
    let choice = value["choices"].get(0).ok_or("API 回复缺少正文。")?;
    match choice["finish_reason"].as_str() {
        Some("stop") => {}
        Some("length") => return Err("API 回复被截断，请缩短上下文后重试。".into()),
        Some("content_filter") => return Err("API 服务过滤了回复。".into()),
        _ => return Err("API 回复未正常结束。".into()),
    }
    let text = choice["message"]["content"].as_str().filter(|text| !text.trim().is_empty()).ok_or("API 回复缺少正文。")?;
    let model = value["model"].as_str().filter(|name| name.len() <= 256).unwrap_or("");
    Ok((text.into(), model.into(), usage(&value["usage"])))
}

#[tauri::command]
pub async fn chat_api_models(app: AppHandle, id: String, route: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (profile, secret) = connection(&app, &id, &route)?;
        let base = url::Url::parse(&profile.base_url).map_err(|_| "API 请求地址无效。")?;
        openai_compat::fetch_models(&base, profile.auth(), secret.as_ref(), &AtomicBool::new(false), Duration::from_secs(15))
    }).await.map_err(|_| "读取模型列表的任务意外结束。".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(id: &str, address: &str, auth: Auth) -> Profile {
        Profile { id: id.into(), name: "测试".into(), base_url: address.into(), model: "mock".into(), auth, streaming: true }
    }

    #[test]
    fn credentials_and_retries_are_bound_to_a_chat_api_profile_and_route() {
        let mut first = profile("one", " HTTPS://Example.com/v1/ ", Auth::Bearer);
        first.validate().unwrap();
        assert_eq!(first.endpoint("chat/completions").unwrap().as_str(), "https://example.com/v1/chat/completions");
        for mut changed in [profile("two", "https://example.com/v1", Auth::Bearer),
            profile("one", "https://example.net/v1", Auth::Bearer), profile("one", "https://example.com/v1", Auth::ApiKey)] {
            changed.validate().unwrap();
            assert_ne!(first.binding(), changed.binding());
            assert!(selected(&[changed.clone()], &changed.id, &first.route()).is_err());
        }
        for address in ["http://example.com/v1", "https://user:password@example.com/v1",
            "https://example.com/v1?key=test", "https://example.com/v1/chat/completions"] {
            assert!(profile("one", address, Auth::Bearer).validate().is_err());
        }
        assert!(profile("local", "http://127.0.0.1:4001/v1", Auth::None).validate().is_ok());
    }

    #[test]
    fn non_streaming_chat_uses_answer_text_and_normalizes_usage() {
        let (text, model, usage) = reply(br#"{"model":"mock","choices":[{"finish_reason":"stop","message":{"content":"Answer","reasoning_content":"hidden"}}],"usage":{"prompt_tokens":4,"completion_tokens":2}}"#).unwrap();
        assert_eq!(text, "Answer");
        assert_eq!(model, "mock");
        assert_eq!(usage["input_tokens"], 4);
        assert_eq!(usage["output_tokens"], 2);
        assert!(reply(br#"{"choices":[{"finish_reason":"tool_calls","message":{"content":"ignored"}}]}"#).is_err());
    }
}
