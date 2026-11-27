use crate::{chatgpt_oauth as oauth, http, local, secrets::Secret};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs, io::ErrorKind, path::Path, sync::{Arc, Mutex, Weak, atomic::{AtomicBool, Ordering}},
    time::Duration,
};
use tauri::{AppHandle, Manager, State};

const ACCOUNTS_ERROR: &str = "无法读取 ChatGPT 账户配置。";
const MAX_ACCOUNTS: usize = 20;

#[derive(Default)]
pub struct ChatGptState {
    login: Mutex<Option<Arc<AtomicBool>>>,
    accounts: Mutex<AccountsState>,
}
#[derive(Default)]
struct AccountsState {
    running: Vec<Weak<AtomicBool>>,
}
impl AccountsState {
    fn stop_requests(&mut self) {
        for request in self.running.drain(..).filter_map(|request| request.upgrade()) {
            request.store(true, Ordering::SeqCst);
        }
    }
}

#[derive(Default, Deserialize, Serialize)]
struct AccountFile {
    host: String,
    active_id: Option<String>,
    accounts: Vec<Account>,
}
#[derive(Deserialize, Serialize)]
struct Account {
    id: String,
    subject: String,
    email: Option<String>,
    tokens: Option<Tokens>,
    welcomed: bool,
}
#[derive(Deserialize, Serialize)]
struct Tokens {
    access: String,
    refresh: Option<String>,
    identity: String,
    expiry: u64,
    scope: String,
}
impl Tokens {
    fn plan_enabled(&self) -> bool { oauth::plan_allowed(&self.scope) }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountSummary {
    id: String,
    email: Option<String>,
    connected: bool,
    plan_enabled: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    active_id: Option<String>,
    accounts: Vec<AccountSummary>,
    signing_in: bool,
}
#[derive(Serialize)]
pub struct Model {
    slug: String,
    name: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    account_id: String,
    models: Vec<Model>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignInResult {
    status: Status,
    first_plan_use: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignOutResult {
    status: Status,
    revoked: bool,
}

fn read(path: &Path) -> Result<AccountFile, String> {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(AccountFile::default()),
        Err(_) => return Err(ACCOUNTS_ERROR.into()),
    };
    use std::io::Read;
    let mut encrypted = Vec::new();
    file.take(http::MAX_RESPONSE as u64 + 1).read_to_end(&mut encrypted).map_err(|_| ACCOUNTS_ERROR)?;
    if encrypted.is_empty() || encrypted.len() > http::MAX_RESPONSE { return Err(ACCOUNTS_ERROR.into()); }
    let data = oauth::protect(&encrypted, false)?;
    serde_json::from_slice(&data.0).map_err(|_| ACCOUNTS_ERROR.into())
}

fn write(path: &Path, file: &AccountFile) -> Result<(), String> {
    let data = Secret(serde_json::to_vec(file).map_err(|_| ACCOUNTS_ERROR)?);
    let encrypted = oauth::protect(&data.0, true)?;
    if encrypted.0.len() > http::MAX_RESPONSE { return Err("ChatGPT 账户数据已达到保存上限。".into()); }
    local::atomic_write(path, &encrypted.0)
}

fn accounts<T>(app: &AppHandle, operation: impl FnOnce(&Path, &mut AccountFile, &mut AccountsState) -> Result<T, String>) -> Result<T, String> {
    let dir = app.path().app_local_data_dir().map_err(|_| ACCOUNTS_ERROR)?;
    fs::create_dir_all(&dir).map_err(|_| ACCOUNTS_ERROR)?;
    let path = dir.join("chatgpt-auth.dat");
    let state = app.state::<ChatGptState>();
    let mut guard = state.accounts.lock().map_err(|_| ACCOUNTS_ERROR)?;
    let _file_lock = local::lock(&path)?;
    operation(&path, &mut read(&path)?, &mut guard)
}

fn status(file: &AccountFile, signing_in: bool) -> Status {
    Status {
        active_id: file.active_id.clone(),
        accounts: file.accounts.iter().map(|account| AccountSummary {
            id: account.id.clone(), email: account.email.clone(), connected: account.tokens.is_some(),
            plan_enabled: account.tokens.as_ref().is_some_and(Tokens::plan_enabled),
        }).collect(),
        signing_in,
    }
}

fn sign_in(app: &AppHandle, account_id: Option<&str>, consent: bool, cancel: &AtomicBool) -> Result<SignInResult, String> {
    let (host, subject, email, id_token) = accounts(app, |path, file, _| {
        if file.host.is_empty() {
            file.host = oauth::host_id()?;
            write(path, file)?;
        }
        let account = match account_id {
            Some(id) => Some(file.accounts.iter().find(|account| account.id == id).ok_or("该 ChatGPT 账户已不存在。")?),
            None if file.accounts.len() >= MAX_ACCOUNTS => return Err("已达到 ChatGPT 账户数量上限。".into()),
            None => None,
        };
        Ok((file.host.clone(), account.map(|account| account.subject.clone()),
            account.and_then(|account| account.email.clone()),
            account.and_then(|account| account.tokens.as_ref()).map(|token| token.identity.clone())))
    })?;
    let flow = oauth::Authorization::new(account_id)?;
    let url = flow.url(&host, email.as_deref(), id_token.as_deref(), consent && account_id.is_some());
    if cancel.load(Ordering::SeqCst) { return Err("已取消 ChatGPT 登录。".into()); }
    oauth::open_browser(url.as_str())?;
    let mut callback = flow.wait(cancel)?;
    let result = (|| {
        let (code, client) = callback.result.as_ref().map_err(Clone::clone)?;
        let token = flow.exchange(code, client, cancel)?;
        let identity_token = token.id_token.ok_or("OpenAI 未返回可验证的 ChatGPT 账户身份。")?;
        let identity = flow.identity(&identity_token, client, cancel)?;
        if subject.as_ref().is_some_and(|subject| *subject != identity.subject) {
            return Err("浏览器授权的 ChatGPT 账户与所选账户不同。".into());
        }
        accounts(app, |path, file, state| {
            if cancel.load(Ordering::SeqCst) { return Err("已取消 ChatGPT 登录。".into()); }
            let tokens = Tokens { access: token.access_token, refresh: token.refresh_token, identity: identity_token,
                expiry: oauth::now().saturating_add(token.expires_in), scope: token.scope.unwrap_or_default() };
            let granted = tokens.plan_enabled();
            let first_plan_use = if let Some(account) = file.accounts.iter_mut().find(|account| account.id == *client) {
                if account.subject != identity.subject { return Err("ChatGPT 返回的注册账户与本机记录不符。".into()); }
                let first = granted && !account.welcomed;
                account.tokens = Some(tokens);
                account.email = identity.email;
                account.welcomed |= granted;
                first
            } else {
                if file.accounts.len() >= MAX_ACCOUNTS { return Err("已达到 ChatGPT 账户数量上限。".into()); }
                file.accounts.push(Account { id: client.clone(), subject: identity.subject,
                    email: identity.email, tokens: Some(tokens), welcomed: granted });
                granted
            };
            file.active_id = Some(client.clone());
            write(path, file)?;
            state.stop_requests();
            Ok(SignInResult { status: status(file, false), first_plan_use })
        })
    })();
    callback.finish(result.is_ok());
    result
}

pub fn access_token(app: &AppHandle, id: &str, cancel: &Arc<AtomicBool>) -> Result<Secret, String> {
    accounts(app, |path, file, state| {
        if file.active_id.as_deref() != Some(id) { return Err("所选 ChatGPT 账户已变更，请重新选择模型并发送。".into()); }
        if cancel.load(Ordering::SeqCst) { return Err("已停止请求。".into()); }
        let account = file.accounts.iter_mut().find(|account| account.id == id).ok_or("请先在「AI设置」中登录 ChatGPT。")?;
        let tokens = account.tokens.as_mut().ok_or("请先在「AI设置」中登录 ChatGPT。")?;
        if !tokens.plan_enabled() { return Err("请在「AI设置」中授权使用 ChatGPT 订阅。".into()); }
        let now = oauth::now();
        if tokens.expiry <= now + 60 && tokens.refresh.is_some() {
            match oauth::refresh(id, tokens.refresh.as_deref().unwrap(), &AtomicBool::new(false)) {
                Ok(response) => {
                    let refresh = response.refresh_token.ok_or("ChatGPT 未返回续期凭据，请重新登录。")?;
                    tokens.access = response.access_token;
                    tokens.refresh = Some(refresh);
                    tokens.expiry = oauth::now().saturating_add(response.expires_in);
                    if let Some(scope) = response.scope { tokens.scope = scope; }
                    let access = tokens.plan_enabled().then(|| Secret(tokens.access.as_bytes().to_vec()));
                    // A completed rotation must be persisted even if this chat was just cancelled.
                    write(path, file)?;
                    if cancel.load(Ordering::SeqCst) { return Err("已停止请求。".into()); }
                    let access = access.ok_or("ChatGPT 订阅授权已变更，请在设置中重新授权。")?;
                    state.running.retain(|job| job.strong_count() > 0);
                    state.running.push(Arc::downgrade(cancel));
                    return Ok(access);
                }
                Err(oauth::TokenError::Expired) => {
                    account.tokens = None;
                    write(path, file)?;
                    state.stop_requests();
                    return Err("ChatGPT 登录已过期或已解除授权，请重新登录。".into());
                }
                Err(oauth::TokenError::Unavailable) => return Err("暂时无法续期 ChatGPT 登录，请稍后重试。".into()),
            }
        }
        if tokens.expiry <= now { return Err("ChatGPT 登录已过期，请重新登录。".into()); }
        state.running.retain(|job| job.strong_count() > 0);
        state.running.push(Arc::downgrade(cancel));
        Ok(Secret(tokens.access.as_bytes().to_vec()))
    })
}

pub fn response_error(status: u32, code: Option<&str>) -> String {
    let message = match code {
        Some("subscription_sharing_user_not_eligible") => "这个 ChatGPT 账户或工作区暂不支持在 PDFreader 使用订阅额度。",
        Some("subscription_sharing_usage_limit_exceeded") => "已达到 ChatGPT 订阅或此应用的用量上限，请查看「管理 ChatGPT 用量」。",
        Some("subscription_sharing_usage_unavailable" | "subscription_sharing_user_unavailable") => "暂时无法读取 ChatGPT 订阅用量，请稍后重试。",
        Some("subscription_sharing_unsupported_capability") => "所选模型或请求使用了 ChatGPT 订阅暂不支持的功能，请切换模型或调整问题。",
        Some("subscription_sharing_invalid_user") => "ChatGPT 登录已失效，请在「AI设置」中重新登录。",
        Some("chatpass_v2_scope_not_authorized" | "chatpass_v2_invalid_authorization_context") => "ChatGPT 未授权 PDFreader 使用订阅，请在设置中检查授权。",
        _ => match status {
            401 => "ChatGPT 未接受本次登录凭据，请在设置中重新登录。",
            403 => "ChatGPT 订阅请求未获许可，请检查账户权限或适用地区。",
            429 => "已达到 ChatGPT 订阅或此应用的用量上限，请查看「管理 ChatGPT 用量」。",
            503 => "ChatGPT 订阅服务暂不可用，请稍后重试。",
            0 => "ChatGPT 未完成本次回复，请稍后重试。",
            _ => return format!("ChatGPT 订阅请求失败（HTTP {status}）。"),
        },
    };
    message.into()
}

#[tauri::command]
pub async fn chatgpt_status(app: AppHandle) -> Result<Status, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let signing = app.state::<ChatGptState>().login.lock().map_err(|_| ACCOUNTS_ERROR)?.is_some();
        accounts(&app, |_, file, _| Ok(status(file, signing)))
    }).await.map_err(|_| ACCOUNTS_ERROR)?
}

#[tauri::command]
pub async fn chatgpt_sign_in(app: AppHandle, state: State<'_, ChatGptState>, account_id: Option<String>, consent: bool) -> Result<SignInResult, String> {
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut login = state.login.lock().map_err(|_| ACCOUNTS_ERROR)?;
        if login.is_some() { return Err("请先完成或取消正在进行的 ChatGPT 登录。".into()); }
        *login = Some(cancel.clone());
    }
    let result = tauri::async_runtime::spawn_blocking(move || sign_in(&app, account_id.as_deref(), consent, &cancel))
        .await.map_err(|_| "ChatGPT 登录未完成。".to_string());
    *state.login.lock().map_err(|_| ACCOUNTS_ERROR)? = None;
    result?
}

#[tauri::command]
pub fn chatgpt_cancel_sign_in(state: State<ChatGptState>) -> Result<(), String> {
    if let Some(cancel) = state.login.lock().map_err(|_| ACCOUNTS_ERROR)?.as_ref() {
        cancel.store(true, Ordering::SeqCst);
    }
    Ok(())
}

#[tauri::command]
pub async fn chatgpt_select_account(app: AppHandle, account_id: String) -> Result<Status, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let auth = app.state::<ChatGptState>();
        let login = auth.login.lock().map_err(|_| ACCOUNTS_ERROR)?;
        if login.is_some() { return Err("请先完成或取消正在进行的 ChatGPT 登录。".into()); }
        accounts(&app, |path, file, state| {
            if !file.accounts.iter().any(|account| account.id == account_id) { return Err("该 ChatGPT 账户已不存在。".into()); }
            if file.active_id.as_ref() != Some(&account_id) {
                file.active_id = Some(account_id);
                write(path, file)?;
                state.stop_requests();
            }
            Ok(status(file, false))
        })
    }).await.map_err(|_| ACCOUNTS_ERROR)?
}

#[tauri::command]
pub async fn chatgpt_sign_out(app: AppHandle, account_id: String) -> Result<SignOutResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let auth = app.state::<ChatGptState>();
        // Prevent a concurrent sign-in from exchanging a code while this account is being signed out.
        let login = auth.login.lock().map_err(|_| ACCOUNTS_ERROR)?;
        if login.is_some() { return Err("请先完成或取消正在进行的 ChatGPT 登录。".into()); }
        accounts(&app, |path, file, state| {
            if file.active_id.as_ref() == Some(&account_id) { state.stop_requests(); }
            let account = file.accounts.iter_mut().find(|account| account.id == account_id).ok_or("该 ChatGPT 账户已不存在。")?;
            let revoked = account.tokens.take().and_then(|token| token.refresh)
                .is_none_or(|token| oauth::revoke(&account_id, &token));
            write(path, file)?;
            Ok(SignOutResult { status: status(file, false), revoked })
        })
    }).await.map_err(|_| ACCOUNTS_ERROR)?
}

#[tauri::command]
pub async fn chatgpt_models(app: AppHandle, account_id: String) -> Result<Catalog, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let cancel = Arc::new(AtomicBool::new(false));
        let access = access_token(&app, &account_id, &cancel)?;
        let url = url::Url::parse("https://api.openai.com/v1/models").unwrap();
        let response = http::request(&url, "bearer", Some(&access), None, &cancel, Duration::from_secs(15))?;
        let value: Value = serde_json::from_slice(&response.body).unwrap_or_default();
        if response.status != 200 { return Err(response_error(response.status, value["error"]["code"].as_str())); }
        let models = value["models"].as_array().ok_or("ChatGPT 返回了无法识别的模型列表。")?;
        let mut seen = std::collections::HashSet::new();
        let models = models.iter().filter_map(|model| {
            let slug = model["slug"].as_str()?;
            let name = model["display_name"].as_str()?;
            (model["visibility"] == "list" && oauth::visible_token(slug, 256) &&
                !name.trim().is_empty() && name.len() <= 256 && seen.insert(slug))
                .then(|| Model { slug: slug.into(), name: name.into() })
        }).collect();
        Ok(Catalog { account_id, models })
    }).await.map_err(|_| "无法读取 ChatGPT 模型列表。".to_string())?
}

#[tauri::command]
pub fn chatgpt_open_usage() -> Result<(), String> {
    oauth::open_browser("https://chatgpt.com/settings/usage")
}
