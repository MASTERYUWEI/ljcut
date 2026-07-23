"""YouTube 上傳服務 — OAuth(loopback 授權) + 斷點續傳上傳 + 縮圖 + SRT 字幕注入

憑證與權杖存 backend/.env（已 .gitignore）：
  YT_CLIENT_ID / YT_CLIENT_SECRET  — Google Cloud OAuth 用戶端（電腦版應用程式）
  YT_REFRESH_TOKEN                 — 使用者授權後取得，長期有效
"""

import os
import json
import time
import socket
import secrets
import threading
import urllib.parse
from pathlib import Path

import httpx

from services.llm_service import _persist_env_var

_client_id = os.getenv("YT_CLIENT_ID", "").strip()
_client_secret = os.getenv("YT_CLIENT_SECRET", "").strip()
_refresh_token = os.getenv("YT_REFRESH_TOKEN", "").strip()
_access_token = ""
_access_expiry = 0.0
_channel_name = ""

# 授權流程狀態（loopback listener）
_auth = {"listening": False, "error": ""}

SCOPES = (
    "https://www.googleapis.com/auth/youtube.upload "
    "https://www.googleapis.com/auth/youtube.force-ssl"
)
AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
API = "https://www.googleapis.com/youtube/v3"
UPLOAD_API = "https://www.googleapis.com/upload/youtube/v3"

CHUNK = 8 * 1024 * 1024  # 8MB


def _respond_html(conn, message: str):
    body = (
        "<!doctype html><meta charset='utf-8'>"
        "<body style='font-family:sans-serif;background:#1e1e2e;color:#eee;"
        "display:flex;align-items:center;justify-content:center;height:100vh'>"
        f"<h2>{message}</h2></body>"
    ).encode("utf-8")
    resp = (
        b"HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n"
        + f"Content-Length: {len(body)}\r\n".encode()
        + b"Connection: close\r\n\r\n"
        + body
    )
    try:
        conn.sendall(resp)
    except Exception:
        pass


def _exchange_code(code: str, port: int) -> tuple[bool, str]:
    """authorization_code → refresh_token，成功即持久化。"""
    global _refresh_token, _access_token, _access_expiry
    try:
        res = httpx.post(TOKEN_URL, data={
            "code": code,
            "client_id": _client_id,
            "client_secret": _client_secret,
            "redirect_uri": f"http://127.0.0.1:{port}",
            "grant_type": "authorization_code",
        }, timeout=20)
        if res.status_code != 200:
            return False, f"HTTP {res.status_code}: {res.text[:150]}"
        data = res.json()
        rt = data.get("refresh_token", "")
        if not rt:
            return False, "Google 未回傳 refresh_token（請移除先前授權後重試）"
        _refresh_token = rt
        _access_token = data.get("access_token", "")
        _access_expiry = time.time() + float(data.get("expires_in", 3600)) - 60
        _persist_env_var("YT_REFRESH_TOKEN", rt)
        print("✅ YouTube 已連結（refresh token 已存）", flush=True)
        return True, ""
    except Exception as e:
        return False, str(e)


def _listen(srv: socket.socket, port: int, expected_state: str):
    """迷你 HTTP listener：接 Google OAuth redirect，抓 code 換 token。"""
    try:
        srv.settimeout(300)
        while True:
            conn, _ = srv.accept()
            try:
                conn.settimeout(10)
                data = conn.recv(8192).decode("utf-8", "replace")
                line = data.split("\r\n", 1)[0]
                parts = line.split(" ")
                if len(parts) < 2:
                    continue
                qs = urllib.parse.parse_qs(urllib.parse.urlparse(parts[1]).query)
                if "error" in qs:
                    _auth["error"] = f"授權被拒絕：{qs['error'][0]}"
                    _respond_html(conn, "❌ 授權被拒絕，請回 LJCUT 重試")
                    return
                if "code" not in qs:
                    _respond_html(conn, "LJCUT：等待授權中…")
                    continue
                if qs.get("state", [""])[0] != expected_state:
                    _auth["error"] = "state 驗證失敗（可能是過期的授權頁）"
                    _respond_html(conn, "❌ 驗證失敗，請回 LJCUT 重新按「連結」")
                    return
                ok, err = _exchange_code(qs["code"][0], port)
                if ok:
                    _respond_html(conn, "✅ YouTube 已連結成功！可以關閉此分頁，回到 LJCUT")
                else:
                    _auth["error"] = err
                    _respond_html(conn, f"❌ 連結失敗：{err}")
                return
            finally:
                try:
                    conn.close()
                except Exception:
                    pass
    except socket.timeout:
        _auth["error"] = "等待授權逾時（5 分鐘），請重試"
    except Exception as e:
        _auth["error"] = str(e)
    finally:
        _auth["listening"] = False
        try:
            srv.close()
        except Exception:
            pass


def _get_access_token() -> str:
    """refresh_token → access token（快取到過期前 60 秒）。"""
    global _access_token, _access_expiry
    if _access_token and time.time() < _access_expiry:
        return _access_token
    if not (_client_id and _client_secret and _refresh_token):
        raise RuntimeError("尚未連結 YouTube 帳號")
    res = httpx.post(TOKEN_URL, data={
        "client_id": _client_id,
        "client_secret": _client_secret,
        "refresh_token": _refresh_token,
        "grant_type": "refresh_token",
    }, timeout=20)
    if res.status_code != 200:
        raise RuntimeError(f"更新權杖失敗 HTTP {res.status_code}: {res.text[:150]}")
    data = res.json()
    _access_token = data.get("access_token", "")
    _access_expiry = time.time() + float(data.get("expires_in", 3600)) - 60
    return _access_token


class YouTubeService:
    @staticmethod
    def set_credentials(client_id: str, client_secret: str) -> dict:
        """儲存（或清除）OAuth 用戶端憑證。"""
        global _client_id, _client_secret, _refresh_token, _access_token, _channel_name
        _client_id = (client_id or "").strip()
        _client_secret = (client_secret or "").strip()
        _persist_env_var("YT_CLIENT_ID", _client_id)
        _persist_env_var("YT_CLIENT_SECRET", _client_secret)
        if not _client_id:
            # 清憑證時連 token 一起清
            _refresh_token = ""
            _access_token = ""
            _channel_name = ""
            _persist_env_var("YT_REFRESH_TOKEN", "")
        return YouTubeService.status(skip_channel=True)

    @staticmethod
    def status(skip_channel: bool = False) -> dict:
        """{configured, connected, channel, auth_error}"""
        global _channel_name
        connected = bool(_refresh_token)
        if connected and not _channel_name and not skip_channel:
            try:
                token = _get_access_token()
                res = httpx.get(
                    f"{API}/channels",
                    params={"part": "snippet", "mine": "true"},
                    headers={"Authorization": f"Bearer {token}"},
                    timeout=10,
                )
                if res.status_code == 200:
                    items = res.json().get("items", [])
                    if items:
                        _channel_name = items[0]["snippet"]["title"]
            except Exception as e:
                print(f"⚠️ 取得頻道資訊失敗: {e}", flush=True)
        return {
            "configured": bool(_client_id and _client_secret),
            "connected": connected,
            "channel": _channel_name,
            "auth_error": _auth["error"],
        }

    @staticmethod
    def start_auth() -> dict:
        """啟動 loopback listener，回傳讓使用者開的授權網址。"""
        if not (_client_id and _client_secret):
            return {"ok": False, "error": "請先填入 OAuth 用戶端 ID 與密鑰"}
        _auth["error"] = ""
        srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        srv.bind(("127.0.0.1", 0))
        srv.listen(1)
        port = srv.getsockname()[1]
        state = secrets.token_urlsafe(16)
        _auth["listening"] = True
        threading.Thread(target=_listen, args=(srv, port, state), daemon=True).start()
        params = {
            "client_id": _client_id,
            "redirect_uri": f"http://127.0.0.1:{port}",
            "response_type": "code",
            "scope": SCOPES,
            "access_type": "offline",
            "prompt": "consent",
            "state": state,
        }
        return {"ok": True, "auth_url": f"{AUTH_URL}?{urllib.parse.urlencode(params)}"}

    @staticmethod
    def disconnect() -> dict:
        global _refresh_token, _access_token, _channel_name
        _refresh_token = ""
        _access_token = ""
        _channel_name = ""
        _persist_env_var("YT_REFRESH_TOKEN", "")
        return YouTubeService.status(skip_channel=True)

    @staticmethod
    def upload_with_progress(
        video_path: str,
        title: str,
        description: str = "",
        tags: list | None = None,
        privacy: str = "private",
        thumbnail_path: str | None = None,
        srt_path: str | None = None,
        caption_name: str = "中文字幕",
    ):
        """generator：邊上傳邊 yield 進度 dict（給 SSE）。"""
        warnings: list[str] = []
        total = os.path.getsize(video_path)
        yield {"progress": 1, "stage": "init"}

        # 1) resumable session
        meta = {
            "snippet": {
                "title": title[:100] or "LJCUT 影片",
                "description": description[:4900],
                "tags": (tags or [])[:30],
                "categoryId": "27",  # 教育
                # 標影片/音訊語言 → Studio 字幕欄不會反灰、CC 顯示正確
                "defaultLanguage": "zh-TW",
                "defaultAudioLanguage": "zh-TW",
            },
            "status": {
                "privacyStatus": privacy if privacy in ("private", "unlisted", "public") else "private",
                "selfDeclaredMadeForKids": False,
            },
        }
        token = _get_access_token()
        with httpx.Client(timeout=120) as client:
            res = client.post(
                f"{UPLOAD_API}/videos",
                params={"uploadType": "resumable", "part": "snippet,status"},
                headers={
                    "Authorization": f"Bearer {token}",
                    "Content-Type": "application/json; charset=UTF-8",
                    "X-Upload-Content-Length": str(total),
                    "X-Upload-Content-Type": "video/mp4",
                },
                json=meta,
            )
            if res.status_code != 200:
                yield {"error": f"建立上傳工作失敗 HTTP {res.status_code}: {res.text[:200]}"}
                return
            upload_url = res.headers.get("Location", "")
            if not upload_url:
                yield {"error": "Google 未回傳上傳網址"}
                return

            # 2) 分塊上傳（8MB / 塊）
            video_id = ""
            sent = 0
            with open(video_path, "rb") as f:
                while sent < total:
                    chunk = f.read(CHUNK)
                    if not chunk:
                        break
                    start, end = sent, sent + len(chunk) - 1
                    token = _get_access_token()  # 長片上傳跨 1hr 也不斷線
                    r = client.put(
                        upload_url,
                        headers={
                            "Authorization": f"Bearer {token}",
                            "Content-Length": str(len(chunk)),
                            "Content-Range": f"bytes {start}-{end}/{total}",
                        },
                        content=chunk,
                    )
                    if r.status_code in (200, 201):
                        video_id = r.json().get("id", "")
                        sent = total
                    elif r.status_code == 308:
                        sent = end + 1
                    else:
                        yield {"error": f"上傳中斷 HTTP {r.status_code}: {r.text[:200]}"}
                        return
                    pct = 2 + int(sent / total * 88)
                    yield {"progress": min(pct, 90), "stage": "upload"}

            if not video_id:
                yield {"error": "上傳完成但未取得影片 ID"}
                return
            print(f"✅ YouTube 上傳完成: {video_id}", flush=True)

            # 3) 縮圖
            if thumbnail_path and os.path.exists(thumbnail_path):
                yield {"progress": 92, "stage": "thumbnail"}
                try:
                    with open(thumbnail_path, "rb") as tf:
                        img = tf.read()
                    r = client.post(
                        f"{UPLOAD_API}/thumbnails/set",
                        params={"videoId": video_id, "uploadType": "media"},
                        headers={
                            "Authorization": f"Bearer {_get_access_token()}",
                            "Content-Type": "image/jpeg",
                        },
                        content=img,
                    )
                    if r.status_code != 200:
                        warnings.append(f"縮圖設定失敗 HTTP {r.status_code}（頻道可能未通過手機驗證）")
                except Exception as e:
                    warnings.append(f"縮圖設定失敗: {e}")

            # 4) SRT 字幕
            if srt_path and os.path.exists(srt_path):
                yield {"progress": 96, "stage": "caption"}
                try:
                    with open(srt_path, "rb") as sf:
                        srt_bytes = sf.read()
                    boundary = "ljcut_" + secrets.token_hex(8)
                    cap_meta = json.dumps({
                        "snippet": {
                            "videoId": video_id,
                            "language": "zh-TW",
                            "name": caption_name,
                        }
                    }, ensure_ascii=False).encode("utf-8")
                    body = (
                        f"--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n".encode()
                        + cap_meta
                        + f"\r\n--{boundary}\r\nContent-Type: application/octet-stream\r\n\r\n".encode()
                        + srt_bytes
                        + f"\r\n--{boundary}--".encode()
                    )
                    r = client.post(
                        f"{UPLOAD_API}/captions",
                        params={"uploadType": "multipart", "part": "snippet"},
                        headers={
                            "Authorization": f"Bearer {_get_access_token()}",
                            "Content-Type": f"multipart/related; boundary={boundary}",
                        },
                        content=body,
                    )
                    if r.status_code not in (200, 201):
                        warnings.append(f"字幕注入失敗 HTTP {r.status_code}: {r.text[:120]}")
                except Exception as e:
                    warnings.append(f"字幕注入失敗: {e}")

        yield {
            "progress": 100,
            "done": True,
            "video_id": video_id,
            "watch_url": f"https://youtu.be/{video_id}",
            "studio_url": f"https://studio.youtube.com/video/{video_id}/edit",
            "warnings": warnings,
        }
