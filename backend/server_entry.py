"""PyInstaller 打包入口 — 以獨立 exe 形式啟動 LJCUT 後端

- 資料目錄（uploads/outputs/.env）一律放使用者可寫的 %APPDATA%/tw.ljcut.app/backend，
  不碰安裝目錄（Program Files 無寫入權限）。
- 用法：ljcut-backend.exe --port 12345
"""

import os
import sys
import argparse
from pathlib import Path


def main():
    # 凍結後 console 可能是 cp950：強制 stdout/stderr UTF-8，避免含 emoji 的 log 直接炸掉
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()

    # 使用者可寫的資料目錄
    appdata = os.getenv("APPDATA") or str(Path.home())
    data_dir = Path(os.getenv("LJCUT_DATA_DIR") or (Path(appdata) / "tw.ljcut.app" / "backend"))
    data_dir.mkdir(parents=True, exist_ok=True)
    os.environ["LJCUT_DATA_DIR"] = str(data_dir)
    os.chdir(data_dir)  # main.py 的 ./uploads ./outputs 與 load_dotenv 都以此為基準

    # 凍結模式下把打包目錄加入模組路徑（services 等）
    if getattr(sys, "frozen", False):
        sys.path.insert(0, str(Path(sys.executable).parent / "_internal"))

    import uvicorn
    from main import app

    print(f"🚀 LJCUT backend (frozen) data_dir={data_dir} port={args.port}", flush=True)
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
