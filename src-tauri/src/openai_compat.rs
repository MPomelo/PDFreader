use crate::{http, secrets::Secret};
use serde_json::Value;
use std::{collections::HashSet, sync::atomic::AtomicBool, time::Duration};

const FORBIDDEN_ENDPOINT_SUFFIXES: [&str; 3] = ["/chat/completions", "/responses", "/models"];

/// 规范化 OpenAI 兼容服务的 Base URL，并拒绝控制字符、占位符及完整端点路径。
pub fn normalize_base_url(raw: &str) -> Result<url::Url, String> {
    if raw.trim_matches(' ').chars().any(char::is_control) || raw.contains("{WorkspaceId}") {
        return Err("请填写 Base URL，例如 https://api.example.com/v1，而不是含占位符或非法字符的地址。".into());
    }
    let url = http::service_base_url(raw)?;
    if FORBIDDEN_ENDPOINT_SUFFIXES
        .iter()
        .any(|suffix| url.path().ends_with(suffix))
    {
        return Err("请填写 Base URL，例如 https://api.deepseek.com，而不是完整请求路径。".into());
    }
    Ok(url)
}

/// 在规范化后的 Base URL 后拼接相对端点（如 `models` 或 `chat/completions`）。
pub fn endpoint_url(base: &url::Url, endpoint: &str) -> Result<url::Url, String> {
    let base = base.as_str().trim_end_matches('/');
    let endpoint = endpoint.trim_start_matches('/');
    url::Url::parse(&format!("{base}/{endpoint}")).map_err(|_| "API 请求地址无效。".into())
}

/// 构造 HTTP 鉴权头行（以 `\r\n` 结尾）；当 `auth == "none"` 时返回 `Ok(None)`。
pub fn auth_header(auth: &str, secret: Option<&Secret>) -> Result<Option<String>, String> {
    if auth == "none" {
        return Ok(None);
    }
    let key = std::str::from_utf8(&secret.ok_or("未配置密钥")?.0).map_err(|_| "密钥编码无效")?;
    let prefix = match auth {
        "api-key" => "api-key: ",
        "anthropic" => "anthropic-version: 2023-06-01\r\nx-api-key: ",
        _ => "Authorization: Bearer ",
    };
    Ok(Some(format!("{prefix}{key}\r\n")))
}

/// 统一映射 OpenAI 兼容接口的常见 HTTP 状态码为中文错误提示（不回显响应体）。
pub fn check_http_status(status: u32) -> Result<(), String> {
    match status {
        200..=299 => Ok(()),
        300..=399 => Err("接口返回重定向，已阻止凭据转发；请核对 Base URL。".into()),
        401 => Err("401：密钥无效或已过期，请重新配置。".into()),
        403 => Err("403：当前密钥没有访问权限，请检查账户与接口权限。".into()),
        404 => Err("404：未找到接口或模型，请核对 Base URL 和模型名称。".into()),
        429 => Err("429：请求受限或额度不足；未自动重试，请稍后手动重试。".into()),
        code => Err(format!("服务返回 HTTP {code}；请检查地址、模型与账户。未自动重试。")),
    }
}

/// 从 OpenAI 兼容 `/models` JSON 响应中提取去重后的模型 ID 列表（最多 500 个）。
pub fn parse_models_response(body: &[u8]) -> Result<Vec<String>, String> {
    let value: Value =
        serde_json::from_slice(body).map_err(|_| "无法读取模型列表，请手动填写模型名称。")?;
    let data = value["data"]
        .as_array()
        .ok_or("当前接口不支持模型列表，请手填模型。")?;
    let mut seen = HashSet::new();
    Ok(data
        .iter()
        .filter_map(|item| item["id"].as_str())
        .filter(|id| !id.trim().is_empty() && id.len() <= 256 && seen.insert(*id))
        .take(500)
        .map(str::to_owned)
        .collect())
}

/// 拉取 OpenAI 兼容服务的 `/models` 列表。
pub fn fetch_models(
    base: &url::Url,
    auth: &str,
    secret: Option<&Secret>,
    cancel: &AtomicBool,
    timeout: Duration,
) -> Result<Vec<String>, String> {
    let url = endpoint_url(base, "models")?;
    let response = http::request(&url, auth, secret, None, cancel, timeout)?;
    if matches!(response.status, 404 | 405 | 501) {
        return Err("此服务未提供模型列表，请手动填写模型名称。".into());
    }
    check_http_status(response.status)?;
    parse_models_response(&response.body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_base_url_accepts_https_and_local_http_and_rejects_full_endpoints() {
        let normalized = normalize_base_url(" HTTPS://Example.com/v1/ ").unwrap();
        assert_eq!(normalized.as_str(), "https://example.com/v1");
        assert_eq!(
            endpoint_url(&normalized, "chat/completions").unwrap().as_str(),
            "https://example.com/v1/chat/completions"
        );
        assert_eq!(
            endpoint_url(&normalized, "/models").unwrap().as_str(),
            "https://example.com/v1/models"
        );
        assert!(normalize_base_url("http://127.0.0.1:4001/v1").is_ok());

        for bad in [
            "http://example.com/v1",
            "https://user:pass@example.com/v1",
            "https://example.com/v1?key=secret",
            "https://example.com/v1/chat/completions",
            "https://example.com/v1/responses",
            "https://example.com/v1/models",
            "https://{WorkspaceId}.example.com/v1",
            "https://example.com/v1\n",
        ] {
            assert!(normalize_base_url(bad).is_err(), "should reject {bad}");
        }
    }

    #[test]
    fn auth_header_formats_supported_modes_without_leaking_missing_secret() {
        assert_eq!(auth_header("none", None).unwrap(), None);
        assert!(auth_header("bearer", None).is_err());
        let secret = Secret(b"sk-test".to_vec());
        assert_eq!(
            auth_header("bearer", Some(&secret)).unwrap().as_deref(),
            Some("Authorization: Bearer sk-test\r\n")
        );
        assert_eq!(
            auth_header("api-key", Some(&secret)).unwrap().as_deref(),
            Some("api-key: sk-test\r\n")
        );
        assert_eq!(
            auth_header("anthropic", Some(&secret)).unwrap().as_deref(),
            Some("anthropic-version: 2023-06-01\r\nx-api-key: sk-test\r\n")
        );
    }

    #[test]
    fn status_mapping_and_model_parsing_deduplicate_and_filter_invalid_entries() {
        assert!(check_http_status(200).is_ok());
        for code in [302, 401, 403, 404, 429, 500] {
            assert!(check_http_status(code).is_err(), "status {code}");
        }
        let body = br#"{"data":[{"id":"m1"},{"id":"m1"},{"id":"   "},{"name":"missing"},{"id":"m2"}]}"#;
        assert_eq!(parse_models_response(body).unwrap(), vec!["m1", "m2"]);
        assert!(parse_models_response(br#"{"models":[]}"#).is_err());
    }
}
