use serde::Serialize;
use std::{collections::HashMap, sync::Mutex};
use windows_sys::Win32::{Foundation::{GetLastError, ERROR_NOT_FOUND}, Security::Credentials::*};

// No Serialize/Debug implementation: a secret can only cross IPC on submission.
pub struct Secret(pub Vec<u8>);
impl Drop for Secret {
    fn drop(&mut self) { for byte in &mut self.0 { unsafe { std::ptr::write_volatile(byte, 0) }; } }
}
#[derive(Default)]
pub struct SecretStore { session: Mutex<HashMap<String, Secret>> }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretStatus { pub mode: &'static str, pub available: bool }
fn wide(value: &str) -> Vec<u16> { value.encode_utf16().chain(Some(0)).collect() }
fn target(binding: &str) -> Vec<u16> { wide(&format!("PDFreader/v1/{binding}")) }

fn read_credential(binding: &str) -> Result<Option<Secret>, String> {
    let mut credential = std::ptr::null_mut();
    unsafe {
        if CredReadW(target(binding).as_ptr(), CRED_TYPE_GENERIC, 0, &mut credential) == 0 {
            return if GetLastError() == ERROR_NOT_FOUND { Ok(None) } else { Err("Windows 凭据管理器不可用；可以明确选择仅本次会话。".into()) };
        }
        let item = &*credential;
        let secret = if item.CredentialBlobSize == 0 { Vec::new() }
            else { std::slice::from_raw_parts(item.CredentialBlob, item.CredentialBlobSize as usize).to_vec() };
        CredFree(credential.cast());
        Ok(Some(Secret(secret)))
    }
}
fn delete_credential(binding: &str) -> Result<(), String> {
    unsafe {
        if CredDeleteW(target(binding).as_ptr(), CRED_TYPE_GENERIC, 0) == 0 && GetLastError() != ERROR_NOT_FOUND {
            return Err("无法删除 Windows 中的密钥；未报告删除成功。".into());
        }
    }
    Ok(())
}
impl SecretStore {
    pub fn get(&self, binding: &str) -> Result<Secret, String> {
        if let Some(value) = self.session.lock().map_err(|_| "密钥状态不可用")?.get(binding) {
            return Ok(Secret(value.0.clone()));
        }
        read_credential(binding)?.ok_or_else(|| "请先在 API 设置中保存此地址对应的密钥。".into())
    }
    pub fn status(&self, binding: &str) -> SecretStatus {
        if self.session.lock().is_ok_and(|map| map.contains_key(binding)) { return SecretStatus { mode: "session", available: true }; }
        match read_credential(binding) {
            Ok(Some(_)) => SecretStatus { mode: "credential", available: true },
            Ok(None) => SecretStatus { mode: "missing", available: false },
            Err(_) => SecretStatus { mode: "unavailable", available: false },
        }
    }
    pub fn save(&self, binding: &str, secret: Secret, session_only: bool) -> Result<SecretStatus, String> {
        if secret.0.is_empty() || secret.0.len() > 2500 || !secret.0.iter().all(|b| (33..=126).contains(b)) {
            return Err("密钥应为 1–2500 个可见 ASCII 字符，不能包含空格或换行。".into());
        }
        if session_only {
            self.session.lock().map_err(|_| "密钥状态不可用")?.insert(binding.into(), secret);
            return Ok(SecretStatus { mode: "session", available: true });
        }
        let mut name = target(binding); let mut user = wide("PDFreader");
        let item = CREDENTIALW { Type: CRED_TYPE_GENERIC, TargetName: name.as_mut_ptr(),
            CredentialBlobSize: secret.0.len() as u32, CredentialBlob: secret.0.as_ptr() as *mut u8,
            Persist: CRED_PERSIST_LOCAL_MACHINE, UserName: user.as_mut_ptr(), ..Default::default() };
        if unsafe { CredWriteW(&item, 0) } == 0 { return Err("安全保存失败。密钥未保存；可重新输入并明确选择“仅本次会话”。".into()); }
        self.session.lock().map_err(|_| "密钥状态不可用")?.remove(binding);
        Ok(SecretStatus { mode: "credential", available: true })
    }
    pub fn delete(&self, binding: &str) -> Result<SecretStatus, String> {
        let removed = self.session.lock().map_err(|_| "密钥状态不可用")?.remove(binding).is_some();
        if delete_credential(binding).is_err() {
            return Err(if removed { "会话密钥已清除，但无法删除凭据管理器中的密钥；请在 Windows 凭据管理器中检查。" } else { "无法删除凭据管理器中的密钥，未报告删除成功。" }.into());
        }
        Ok(SecretStatus { mode: "missing", available: false })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn session_keys_are_native_only_and_invalid_headers_are_rejected() {
        let store = SecretStore::default(); let binding = "unit-test-not-a-real-account";
        assert!(store.save(binding, Secret(b"dummy\r\nheader".to_vec()), true).is_err());
        let status = store.save(binding, Secret(b"dummy-session-key".to_vec()), true).unwrap();
        assert_eq!(status.mode, "session"); assert_eq!(store.get(binding).unwrap().0, b"dummy-session-key");
        assert_eq!(serde_json::to_string(&store.status(binding)).unwrap(), "{\"mode\":\"session\",\"available\":true}");
        // Dropping this store discards all session keys without disk writes.
    }
    #[test]
    #[ignore = "Requires an interactive Windows credential store; run explicitly with a dummy unique target"]
    fn windows_credential_roundtrip() {
        let binding = format!("credential-probe-{}", std::process::id());
        let store = SecretStore::default();
        let result = store.save(&binding, Secret(b"dummy-key-for-credential-test".to_vec()), false);
        if result.is_ok() { assert_eq!(store.get(&binding).unwrap().0, b"dummy-key-for-credential-test"); store.delete(&binding).unwrap(); }
        assert!(result.is_ok(), "Windows credential store unavailable");
    }
}
