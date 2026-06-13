//! LLM 服務 — Google Gemini API（繁體中文生成）

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

const GEMINI_MODEL: &str = "gemini-2.0-flash";
const GEMINI_BASE: &str = "https://generativelanguage.googleapis.com/v1beta";

/// Prompt 模板
fn get_prompt(prompt_type: &str, transcript: &str) -> Option<String> {
    let template = match prompt_type {
        "summary" => "你是一位專業的影片內容分析師。請根據以下影片逐字稿，產生一份簡潔的影片摘要。\n\n要求：\n- 用繁體中文撰寫\n- 200 字以內\n- 包含影片主題、重點內容、結論\n- 語氣專業但易讀\n\n逐字稿：\n{transcript}",
        "marketing" => "你是一位專業的社群媒體行銷文案撰稿人。請根據以下影片逐字稿，撰寫一篇吸引人的社群媒體貼文。\n\n要求：\n- 用繁體中文撰寫\n- 適合 Instagram / Facebook 貼文\n- 包含 emoji 和 hashtag\n- 開頭要有吸引人的 hook\n- 字數 150-300 字\n- 結尾加上 5-8 個相關 hashtag\n\n逐字稿：\n{transcript}",
        "youtube" => "你是一位專業的 YouTube 內容創作者。請根據以下影片逐字稿，撰寫 YouTube 影片描述欄。\n\n要求：\n- 用繁體中文撰寫\n- 第一行：一句話簡述影片內容（會顯示在搜尋結果）\n- 空行後：詳細描述（150-250 字）\n- 最後加上時間軸章節標記（如果逐字稿內容有明顯段落）\n- 結尾附上相關標籤\n\n逐字稿：\n{transcript}",
        _ => return None,
    };
    Some(template.replace("{transcript}", transcript))
}

#[derive(Serialize)]
struct GeminiRequest {
    contents: Vec<GeminiContent>,
    #[serde(rename = "generationConfig")]
    generation_config: GeminiGenConfig,
}

#[derive(Serialize)]
struct GeminiContent {
    parts: Vec<GeminiPart>,
}

#[derive(Serialize)]
struct GeminiPart {
    text: String,
}

#[derive(Serialize)]
struct GeminiGenConfig {
    temperature: f64,
    #[serde(rename = "topP")]
    top_p: f64,
    #[serde(rename = "maxOutputTokens")]
    max_output_tokens: u32,
}

#[derive(Deserialize)]
struct GeminiResponse {
    candidates: Option<Vec<GeminiCandidate>>,
}

#[derive(Deserialize)]
struct GeminiCandidate {
    content: Option<GeminiCandidateContent>,
}

#[derive(Deserialize)]
struct GeminiCandidateContent {
    parts: Option<Vec<GeminiResponsePart>>,
}

#[derive(Deserialize)]
struct GeminiResponsePart {
    text: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiStatusResult {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// 檢查 Gemini API 是否可用
pub async fn check_status(api_key: &str) -> AiStatusResult {
    if api_key.is_empty() {
        return AiStatusResult {
            available: false,
            model: None,
            provider: None,
            error: Some("未設定 GEMINI_API_KEY".into()),
        };
    }

    let url = format!("{GEMINI_BASE}/models/{GEMINI_MODEL}?key={api_key}");
    match reqwest::get(&url).await {
        Ok(res) if res.status().is_success() => AiStatusResult {
            available: true,
            model: Some(GEMINI_MODEL.into()),
            provider: Some("google".into()),
            error: None,
        },
        Ok(res) => AiStatusResult {
            available: false,
            model: None,
            provider: None,
            error: Some(format!("HTTP {}", res.status())),
        },
        Err(e) => AiStatusResult {
            available: false,
            model: None,
            provider: None,
            error: Some(e.to_string()),
        },
    }
}

/// 把字幕段落組成逐字稿文字
pub fn build_transcript(segments: &[HashMap<String, serde_json::Value>]) -> String {
    segments
        .iter()
        .filter_map(|seg| seg.get("text").and_then(|v| v.as_str()))
        .collect::<Vec<_>>()
        .join("\n")
}

/// AI 生成文案（含 429 重試）
pub async fn generate(
    api_key: &str,
    segments: &[HashMap<String, serde_json::Value>],
    prompt_type: &str,
) -> Result<String, String> {
    let transcript = build_transcript(segments);

    let prompt = get_prompt(prompt_type, &transcript)
        .ok_or_else(|| format!("[錯誤] 未知的 prompt 類型: {prompt_type}"))?;

    log::info!("📝 Gemini: type={prompt_type}, transcript={} chars", transcript.len());

    let payload = GeminiRequest {
        contents: vec![GeminiContent {
            parts: vec![GeminiPart { text: prompt }],
        }],
        generation_config: GeminiGenConfig {
            temperature: 0.7,
            top_p: 0.9,
            max_output_tokens: 2048,
        },
    };

    let client = reqwest::Client::new();
    let url = format!(
        "{GEMINI_BASE}/models/{GEMINI_MODEL}:generateContent?key={api_key}"
    );

    let max_retries = 3;
    for attempt in 0..=max_retries {
        match client.post(&url).json(&payload).send().await {
            Ok(res) => {
                if res.status().as_u16() == 429 {
                    let wait = 5 * (1 << attempt);
                    log::warn!("⏳ Rate limited, retry {}/{max_retries} after {wait}s", attempt + 1);
                    if attempt < max_retries {
                        tokio::time::sleep(std::time::Duration::from_secs(wait)).await;
                        continue;
                    }
                    return Err("[錯誤] Gemini API 頻率限制，請稍後再試".into());
                }

                if !res.status().is_success() {
                    let status = res.status();
                    let text = res.text().await.unwrap_or_default();
                    log::error!("❌ Gemini error {status}: {}", &text[..text.len().min(200)]);
                    return Err(format!("[錯誤] Gemini API 回傳 {status}"));
                }

                let data: GeminiResponse = res
                    .json()
                    .await
                    .map_err(|e| format!("[錯誤] 解析回應失敗: {e}"))?;

                let result = data
                    .candidates
                    .and_then(|c| c.into_iter().next())
                    .and_then(|c| c.content)
                    .and_then(|c| c.parts)
                    .map(|parts| {
                        parts
                            .into_iter()
                            .filter_map(|p| p.text)
                            .collect::<String>()
                    })
                    .unwrap_or_default();

                if result.is_empty() {
                    return Err("[錯誤] Gemini 沒有回傳內容".into());
                }

                log::info!("✅ Gemini done: type={prompt_type}, result={} chars", result.len());
                return Ok(result);
            }
            Err(e) => {
                return Err(format!("[錯誤] {e}"));
            }
        }
    }

    Err("[錯誤] 重試次數已用盡".into())
}
