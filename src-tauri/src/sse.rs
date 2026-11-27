// Chat Completions SSE only. Split bytes at ASCII line boundaries before UTF-8
// decoding, so neither multibyte characters nor CRLF are damaged by chunking.
use serde_json::{json, Value};
use std::collections::HashSet;
#[derive(Default)]
pub struct Completion {
    bytes: Vec<u8>, data: Vec<String>, event: String, event_id: Option<String>, ids: HashSet<String>,
    first_line: bool, skip_lf: bool, finished: Option<String>, done: bool,
    pub text: String, pub reasoning: String, pub model: String, pub usage: Option<Value>,
}
#[derive(Default)]
pub struct Delta { pub content: String, pub reasoning: String }
impl Completion {
    pub fn is_done(&self) -> bool { self.done }
    pub fn push(&mut self, input: &[u8]) -> Result<Delta, String> {
        let mut delta = Delta::default();
        for &byte in input {
            if self.done { break; }
            if self.skip_lf { self.skip_lf = false; if byte == b'\n' { continue; } }
            if byte == b'\r' || byte == b'\n' {
                self.skip_lf = byte == b'\r';
                let line = String::from_utf8(std::mem::take(&mut self.bytes)).map_err(|_| "流式响应含无效 UTF-8，未得到完整正文。")?;
                self.line(&line, &mut delta)?;
            } else {
                if self.bytes.len() >= 256 * 1024 { return Err("单条流式事件过大。".into()); }
                self.bytes.push(byte);
            }
        }
        Ok(delta)
    }
    fn line(&mut self, input: &str, delta: &mut Delta) -> Result<(), String> {
        let line = if !self.first_line { self.first_line = true; input.trim_start_matches('\u{feff}') } else { input };
        if line.is_empty() { return self.dispatch(delta); }
        if line.starts_with(':') { return Ok(()); }
        let (field, value) = line.split_once(':').unwrap_or((line, ""));
        let value = value.strip_prefix(' ').unwrap_or(value);
        match field {
            "data" => { if self.data.iter().map(String::len).sum::<usize>() + value.len() > 512 * 1024 { return Err("流式事件超过大小限制。".into()); } self.data.push(value.into()); },
            "event" => self.event = value.into(),
            "id" if !value.contains('\0') => self.event_id = Some(value.into()),
            _ => {}, // retry/id do not cause automatic reconnection or a paid retry.
        }
        Ok(())
    }
    fn dispatch(&mut self, delta: &mut Delta) -> Result<(), String> {
        let event = std::mem::take(&mut self.event);
        let id = self.event_id.take();
        let data = std::mem::take(&mut self.data).join("\n");
        if event == "error" { return Err("服务发送了流式错误；当前内容未完成，请手动重试。".into()); }
        if data.is_empty() || matches!(event.as_str(), "ping" | "heartbeat") { return Ok(()); }
        if let Some(id) = id.filter(|s| !s.is_empty()) {
            if !self.ids.insert(id) { return Ok(()); }
            if self.ids.len() > 32768 { return Err("流式事件标识过多。".into()); }
        }
        if data.trim() == "[DONE]" { self.done = true; return Ok(()); }
        let value: Value = serde_json::from_str(&data).map_err(|_| "流式事件不是有效 JSON；当前内容未完成。")?;
        if value.get("error").is_some() { return Err("服务发送了流式错误；当前内容未完成，请手动重试。".into()); }
        if let Some(model) = value["model"].as_str().filter(|s| s.len() <= 256) { self.model = model.into(); }
        if value["usage"].is_object() { self.usage = Some(value["usage"].clone()); }
        let choices = value["choices"].as_array().ok_or("流式响应缺少 choices。")?;
        for choice in choices {
            if choice["index"].as_u64().unwrap_or(0) != 0 { continue; }
            if ["content", "reasoning_content", "reasoning"].iter().any(|field| !choice["delta"][field].is_null() && !choice["delta"][field].is_string()) { return Err("流式正文类型无效，当前回复未完成。".into()); }
            let content = choice["delta"]["content"].as_str().unwrap_or("");
            let reasoning = choice["delta"]["reasoning_content"].as_str().or_else(|| choice["delta"]["reasoning"].as_str()).unwrap_or("");
            if self.finished.is_some() && (!content.is_empty() || !reasoning.is_empty()) { return Err("服务在结束事件后继续返回正文，当前回复未完成。".into()); }
            self.text.push_str(content); delta.content.push_str(content);
            self.reasoning.push_str(reasoning); delta.reasoning.push_str(reasoning);
            if self.text.len() + self.reasoning.len() > 2 * 1024 * 1024 { return Err("流式回复超过大小限制。".into()); }
            if let Some(reason) = choice["finish_reason"].as_str() {
                if reason != "stop" {
                    return Err(match reason { "length" => "输出被截断，请缩短上下文后重试。", "content_filter" => "输出被服务过滤。", _ => "流式响应异常结束。" }.into());
                }
                self.finished = Some(reason.into());
            }
        }
        Ok(())
    }
    pub fn complete(&self) -> Result<Value, String> {
        if !self.done || self.finished.as_deref() != Some("stop") { return Err("流式连接中断或未正常结束；当前内容未完成，可切换非流式后手动重试。".into()); }
        if self.text.trim().is_empty() { return Err("未得到正式译文，只有思考内容或空响应。".into()); }
        Ok(json!({"model":self.model,"choices":[{"finish_reason":"stop","message":{"content":self.text,"reasoning_content":self.reasoning}}],"usage":self.usage}))
    }
    pub fn confirm_chat(&self) -> Result<(), String> {
        // Some compatible gateways close the stream immediately after a terminal stop event.
        if self.finished.as_deref() != Some("stop") || !self.bytes.is_empty() || !self.data.is_empty() || !self.event.is_empty() {
            return Err("API 流式回复未正常结束。可在 AI设置中关闭流式输出后手动重试。".into());
        }
        if self.text.trim().is_empty() { return Err("API 没有返回正文。".into()); }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn stream() -> Vec<u8> { concat!("\u{feff}: heartbeat\r\n\r\n", "id: 1\r\ndata: {\"choices\":[{\"delta\":{\"reasoning_content\":\"分析 α\"}}]}\r\n\r\n", "data: {\"model\":\"actual\",\n", "data: \"choices\":[{\"index\":0,\"delta\":{\"content\":\"中文 $x_1$\"}}]}\n\n", "data: {\"choices\":[{\"delta\":{\"content\":\"$\"},\"finish_reason\":\"stop\"}],\"usage\":{\"total_tokens\":7}}\r\r", "data: [DONE]\n\n").as_bytes().to_vec() }
    #[test]
    fn every_byte_split_preserves_utf8_crlf_multiline_events_and_reasoning() {
        let bytes = stream();
        for split in 0..=bytes.len() {
            let mut completion = Completion::default(); completion.push(&bytes[..split]).unwrap(); completion.push(&bytes[split..]).unwrap();
            assert_eq!(completion.text, "中文 $x_1$$"); assert_eq!(completion.reasoning, "分析 α"); assert_eq!(completion.complete().unwrap()["usage"]["total_tokens"], 7);
        }
        let mut completion = Completion::default(); for byte in bytes { completion.push(&[byte]).unwrap(); } assert!(completion.complete().is_ok());
    }
    #[test]
    fn explicit_duplicate_event_ids_are_ignored_but_equal_tokens_are_not() {
        let mut c = Completion::default();
        for text in ["id: one\ndata: {\"choices\":[{\"delta\":{\"content\":\"哈\"}}]}\n\n", "id: one\ndata: {\"choices\":[{\"delta\":{\"content\":\"哈\"}}]}\n\n", "data: {\"choices\":[{\"delta\":{\"content\":\"哈\"}}]}\n\n"] { c.push(text.as_bytes()).unwrap(); }
        assert_eq!(c.text, "哈哈");
    }
    #[test]
    fn truncated_invalid_error_and_thinking_only_streams_never_complete() {
        for data in ["data: [DONE]\n\n", "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"only thought\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n", "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"},\"finish_reason\":\"stop\"}]}\n\n"] {
            let mut c = Completion::default(); c.push(data.as_bytes()).unwrap(); assert!(c.complete().is_err());
        }
        for data in ["event: error\n\n", "event: error\ndata: private-key-should-not-echo\n\n", "data: {\"error\":\"private-key-should-not-echo\"}\n\n", "data: broken\n\n", "data: {\"choices\":[{\"delta\":{\"content\":123}}]}\n\n", "data: {\"choices\":[{\"finish_reason\":\"length\"}]}\n\n"] {
            let mut c = Completion::default(); let error = c.push(data.as_bytes()).err().unwrap(); assert!(!error.contains("private-key"));
        }
    }
}
