"""成品自動審片：review_video.py <video.mp4> <輸出資料夾> [subtitles.srt]
1. 反聽：Breeze ASR 把整片旁白聽回文字（含時間），逐條字幕比對 → 差異大的字幕條列出（唸錯、漏字、字幕對不上）
2. 停格：ffmpeg freezedetect 找畫面靜止 ≥ 5 秒的區段
3. 空白：silencedetect 找 ≥ 2.5 秒沒有聲音的區段
4. 音量：ebur128 整體響度（YouTube 約 -14 LUFS）
5. 縮圖頁：每 2 秒一格，下方印當下字幕 → <輸出>/page_NN.png
輸出 <輸出>/report.md、asr.json。用 backend venv 執行（需要 faster_whisper、PIL）；GPU 跑 ASR，低優先權。"""
__import__('ctypes').windll.kernel32.SetPriorityClass(__import__('ctypes').c_void_p(-1), 0x4000)
import os, sys, re, io, json, difflib, subprocess, pathlib
sys.stdout.reconfigure(encoding='utf-8')

video, out = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
srt = pathlib.Path(sys.argv[3]) if len(sys.argv) > 3 else video.with_name('subtitles.srt')
out.mkdir(parents=True, exist_ok=True)


def run(cmd):
    return subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8', errors='replace')


dur = float(run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', str(video)]).stdout.strip())


def ts(t):
    return f'{int(t // 60)}:{t % 60:04.1f}'


# ---- 字幕 ----
cues = []
for blk in re.split(r'\n\s*\n', srt.read_text(encoding='utf-8-sig').strip()):
    lines = blk.strip().splitlines()
    m = re.match(r'(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)', lines[1] if len(lines) > 1 else '')
    if not m: continue
    g = list(map(int, m.groups()))
    a = g[0] * 3600 + g[1] * 60 + g[2] + g[3] / 1000; b = g[4] * 3600 + g[5] * 60 + g[6] + g[7] / 1000
    cues.append((a, b, ''.join(lines[2:]).strip()))

# ---- 反聽 ----
wav = out / 'audio16k.wav'
run(['ffmpeg', '-v', 'error', '-y', '-i', str(video), '-ac', '1', '-ar', '16000', str(wav)])
try:
    import nvidia
    for base in nvidia.__path__:
        for sub in ('cublas', 'cudnn'):
            d = pathlib.Path(base) / sub / 'bin'
            if d.is_dir(): os.add_dll_directory(str(d)); os.environ['PATH'] = str(d) + os.pathsep + os.environ['PATH']
except ImportError:
    pass
from faster_whisper import WhisperModel
m = WhisperModel('SoybeanMilk/faster-whisper-Breeze-ASR-25', device='cuda', compute_type='float16')
segs, _ = m.transcribe(str(wav), language='zh', beam_size=5, word_timestamps=True, condition_on_previous_text=False, vad_filter=True)
words = []
for s in segs:
    for w in (s.words or []):
        words.append((w.start, w.end, w.word))
json.dump(words, io.open(out / 'asr.json', 'w', encoding='utf-8'), ensure_ascii=False)
EQ = [('rabbit', 'revit'), ('revid', 'revit'), ('bin', 'bim'), ('3地', '3d'), ('三d', '3d'), ('試圖', '視圖'), ('fl二', 'fl2'), ('fl2', 'fl2')]
NUM = [('一百二十', '120'), ('兩百三十', '230'), ('一百四十', '140'), ('一百五十', '150'), ('兩百六十', '260'), ('三百', '300'), ('六十', '60'),
       ('負一百', '負100'), ('三十', '30'), ('零', '0'), ('一是', '1是'), ('二是', '2是'), ('三是', '3是')]


def norm(t):
    t = re.sub(r'[\W_]+', '', t).lower()
    for a, b in EQ + NUM: t = t.replace(a, b)
    return t


rows = []
for a, b, text in cues:
    hyp = ''.join(w for s, e, w in words if s < b + 0.15 and e > a - 0.15)
    r = difflib.SequenceMatcher(None, norm(text), norm(hyp)).ratio()
    rows.append((1 - r, a, b, text, hyp))

# ---- 停格、空白、音量 ----
fz = run(['ffmpeg', '-v', 'info', '-i', str(video), '-vf', 'scale=480:-1,freezedetect=n=0.002:d=5', '-an', '-f', 'null', '-']).stderr
freezes = [(float(a), float(b)) for a, b in re.findall(r'freeze_start: ([\d.]+).*?freeze_end: ([\d.]+)', fz, re.S)]
sl = run(['ffmpeg', '-v', 'info', '-i', str(video), '-af', 'silencedetect=n=-38dB:d=2.5', '-vn', '-f', 'null', '-']).stderr
sil = [(float(a), float(b)) for a, b in re.findall(r'silence_start: ([\d.]+).*?silence_end: ([\d.]+)', sl, re.S)]
lu = run(['ffmpeg', '-v', 'info', '-i', str(video), '-af', 'ebur128', '-vn', '-f', 'null', '-']).stderr
I = re.findall(r'I:\s+(-?[\d.]+) LUFS', lu); LRA = re.findall(r'LRA:\s+([\d.]+) LU', lu)

# ---- 縮圖頁 ----
from PIL import Image, ImageDraw, ImageFont
font = ImageFont.truetype(r'C:\Windows\Fonts\msjh.ttc', 18)
W, H, TH, COLS, ROWS, STEP = 480, 270, 46, 4, 5, 2.0
times = [t * STEP for t in range(int(dur / STEP) + 1)]
for f in out.glob('page_*.png'): f.unlink()
for p in range(0, len(times), COLS * ROWS):
    page = Image.new('RGB', (W * COLS, (H + TH) * ROWS), 'white'); d = ImageDraw.Draw(page)
    for k, t in enumerate(times[p:p + COLS * ROWS]):
        x, y = (k % COLS) * W, (k // COLS) * (H + TH)
        try:
            page.paste(Image.open(io.BytesIO(subprocess.run(['ffmpeg', '-v', 'error', '-ss', f'{t:.2f}', '-i', str(video), '-frames:v', '1', '-vf', f'scale={W}:{H}',
                                                             '-f', 'image2pipe', '-vcodec', 'png', '-'], capture_output=True).stdout)).convert('RGB'), (x, y))
        except Exception:
            pass
        sub = next((c[2] for c in cues if c[0] <= t + 0.3 <= c[1]), '')
        d.rectangle([x, y, x + 74, y + 22], fill='black'); d.text((x + 4, y + 1), ts(t), fill='yellow', font=font)
        d.text((x + 4, y + H + 4), sub[:24], fill='black', font=font)
    page.save(out / f'page_{p // (COLS * ROWS):02d}.png')

# ---- 報告 ----
bad = sorted([r for r in rows if r[0] > 0.25], key=lambda r: r[1])
L = [f'# 自動審片：{video.name}', '', f'- 片長 {ts(dur)}；字幕 {len(cues)} 條；整體響度 {I[-1] if I else "?"} LUFS（LRA {LRA[-1] if LRA else "?"} LU）',
     f'- 平均反聽差異 {sum(r[0] for r in rows) / max(1, len(rows)) * 100:.1f}%', '',
     '## 反聽差異 > 25% 的字幕（可能唸錯、漏字，或字幕和聲音沒對上）', '| 時間 | 差異 | 字幕 | 聽到 |', '|---|---|---|---|']
L += [f'| {ts(a)} | {c * 100:.0f}% | {t} | {h} |' for c, a, b, t, h in bad]
L += ['', '## 畫面靜止 ≥ 5 秒', ''] + [f'- {ts(a)}–{ts(b)}（{b - a:.1f}s）' for a, b in freezes]
L += ['', '## 無聲 ≥ 2.5 秒', ''] + [f'- {ts(a)}–{ts(b)}（{b - a:.1f}s）' for a, b in sil]
L += ['', f'縮圖頁：{len(list(out.glob("page_*.png")))} 頁（每 2 秒一格，下方是當下字幕）']
(out / 'report.md').write_text('\n'.join(L) + '\n', encoding='utf-8')
print('\n'.join(L))
