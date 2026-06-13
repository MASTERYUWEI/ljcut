"""LLM 服務 — Google Gemini API（繁體中文生成）"""

import os
import httpx
from dotenv import load_dotenv

load_dotenv()

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_MODEL = "gemini-2.0-flash"
GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta"

# ── Prompt 模板 ──

PROMPTS = {
    "summary": """你是一位專業的影片內容分析師。請根據以下影片逐字稿，產生一份簡潔的影片摘要。

要求：
- 用繁體中文撰寫
- 200 字以內
- 包含影片主題、重點內容、結論
- 語氣專業但易讀

逐字稿：
{transcript}""",

    "marketing": """你是一位專業的社群媒體行銷文案撰稿人。請根據以下影片逐字稿，撰寫一篇吸引人的社群媒體貼文。

要求：
- 用繁體中文撰寫
- 適合 Instagram / Facebook 貼文
- 包含 emoji 和 hashtag
- 開頭要有吸引人的 hook
- 字數 150-300 字
- 結尾加上 5-8 個相關 hashtag

逐字稿：
{transcript}""",

    "youtube": """你是一位專業的 YouTube 內容創作者。請根據以下影片逐字稿，撰寫 YouTube 影片描述欄。

要求：
- 用繁體中文撰寫
- 第一行：一句話簡述影片內容（會顯示在搜尋結果）
- 空行後：詳細描述（150-250 字）
- 最後加上時間軸章節標記（如果逐字稿內容有明顯段落）
- 結尾附上相關標籤

逐字稿：
{transcript}""",
}


class LLMService:
    """Google Gemini LLM 服務"""

    @staticmethod
    async def check_status() -> dict:
        """檢查 Gemini API 是否可用"""
        if not GEMINI_API_KEY:
            return {"available": False, "error": "未設定 GEMINI_API_KEY"}
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                res = await client.get(
                    f"{GEMINI_BASE}/models/{GEMINI_MODEL}",
                    params={"key": GEMINI_API_KEY},
                )
                if res.status_code == 200:
                    return {
                        "available": True,
                        "model": GEMINI_MODEL,
                        "provider": "google",
                    }
                return {"available": False, "error": f"HTTP {res.status_code}"}
        except Exception as e:
            return {"available": False, "error": str(e)}

    @staticmethod
    def build_transcript(segments: list) -> str:
        """把字幕段落組成逐字稿文字"""
        lines = []
        for seg in segments:
            text = seg.get("text", "") if isinstance(seg, dict) else str(seg)
            lines.append(text)
        return "\n".join(lines)

    @staticmethod
    async def generate(
        segments: list,
        prompt_type: str = "summary",
    ) -> str:
        """
        一次性生成 AI 文案（含 429 重試）

        Returns:
            完整的生成文字
        """
        import asyncio

        transcript = LLMService.build_transcript(segments)

        if prompt_type not in PROMPTS:
            return f"[錯誤] 未知的 prompt 類型: {prompt_type}"

        prompt = PROMPTS[prompt_type].format(transcript=transcript)
        print(f"📝 Gemini: type={prompt_type}, transcript={len(transcript)} chars", flush=True)

        payload = {
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {
                "temperature": 0.7,
                "topP": 0.9,
                "maxOutputTokens": 2048,
            },
        }

        max_retries = 3
        for attempt in range(max_retries + 1):
            try:
                async with httpx.AsyncClient(timeout=60) as client:
                    res = await client.post(
                        f"{GEMINI_BASE}/models/{GEMINI_MODEL}:generateContent",
                        params={"key": GEMINI_API_KEY},
                        json=payload,
                    )

                    if res.status_code == 429:
                        wait = 5 * (2 ** attempt)  # 5, 10, 20 秒
                        print(f"⏳ Rate limited, retry {attempt+1}/{max_retries} after {wait}s", flush=True)
                        if attempt < max_retries:
                            await asyncio.sleep(wait)
                            continue
                        return "[錯誤] Gemini API 頻率限制，請稍後再試"

                    if res.status_code != 200:
                        err = res.text[:200]
                        print(f"❌ Gemini error {res.status_code}: {err}", flush=True)
                        return f"[錯誤] Gemini API 回傳 {res.status_code}"

                    data = res.json()
                    candidates = data.get("candidates", [])
                    if not candidates:
                        print(f"❌ No candidates in response", flush=True)
                        return "[錯誤] Gemini 沒有回傳內容"

                    parts = candidates[0].get("content", {}).get("parts", [])
                    result = "".join(p.get("text", "") for p in parts)
                    print(f"✅ Gemini done: type={prompt_type}, result={len(result)} chars", flush=True)
                    return result

            except httpx.ConnectError:
                return "[錯誤] 無法連接 Gemini API"
            except httpx.TimeoutException:
                return "[錯誤] Gemini API 請求逾時"
            except Exception as e:
                return f"[錯誤] {str(e)}"

        return "[錯誤] 重試次數已用盡"
