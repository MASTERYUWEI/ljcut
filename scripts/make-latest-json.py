# -*- coding: utf-8 -*-
"""產生 tauri updater 用的 latest.json（讀 NSIS 安裝檔 + .sig）

用法: python scripts/make-latest-json.py 0.2.0 "更新說明文字"
輸出: src-tauri/target/release/bundle/latest.json
"""
import io
import sys
import json
import glob
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BUNDLE = ROOT / "src-tauri" / "target" / "release" / "bundle"
REPO = "MASTERYUWEI/ljcut"


def main():
    if len(sys.argv) < 2:
        print("用法: python scripts/make-latest-json.py <version> [notes]")
        sys.exit(1)
    version = sys.argv[1].lstrip("v")
    notes = sys.argv[2] if len(sys.argv) > 2 else f"LJCUT v{version}"

    nsis = sorted(glob.glob(str(BUNDLE / "nsis" / "*-setup.exe")))
    if not nsis:
        print("找不到 NSIS 安裝檔，請先跑 build-release.ps1")
        sys.exit(1)
    exe = Path(nsis[-1])
    sig_path = Path(str(exe) + ".sig")
    if not sig_path.exists():
        print(f"找不到簽章檔: {sig_path}（確認 TAURI_SIGNING_PRIVATE_KEY_PATH 有設）")
        sys.exit(1)
    signature = sig_path.read_text(encoding="utf-8").strip()

    data = {
        "version": version,
        "notes": notes,
        "pub_date": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "platforms": {
            "windows-x86_64": {
                "signature": signature,
                "url": f"https://github.com/{REPO}/releases/download/v{version}/{exe.name.replace(' ', '.')}",
            }
        },
    }
    out = BUNDLE / "latest.json"
    io.open(out, "w", encoding="utf-8").write(json.dumps(data, ensure_ascii=False, indent=2))
    print(f"✅ {out}")
    print(f"   installer: {exe.name}")
    print(f"   url: {data['platforms']['windows-x86_64']['url']}")


if __name__ == "__main__":
    main()
