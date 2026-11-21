"""在 Blender 內執行（blender -b --factory-startup -P blender_entry.py -- ...），由 blender_run.py 呼叫。

1. 清空場景 → 預設 1920x1080／30fps／EEVEE
2. 執行場景腳本（全域可用 kit、bpy、math、Vector）
3. 沒有相機就依物件包圍盒自動放一台
4. preview：渲染指定影格成 PNG；final：整段渲染成 PNG 影格（可續算）
每個步驟都印 LJKIT 標記，執行器據此判讀成敗。
"""
import json
import math
import os
import sys
import traceback

import bpy
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
opts = dict(zip(argv[::2], argv[1::2]))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import blender_kit as kit  # noqa: E402

out = opts["--out"]
os.makedirs(out, exist_ok=True)
try:
    kit.reset()
    kit.setup()
    code = open(opts["--scene"], encoding="utf-8").read()
    g = {"kit": kit, "bpy": bpy, "math": math, "Vector": Vector, "__name__": "__ljscene__"}
    exec(compile(code, opts["--scene"], "exec"), g)
    print("LJKIT scene=OK")
except Exception:  # noqa: BLE001
    print("LJKIT scene=FAILED")
    traceback.print_exc()
    sys.exit(2)

sc = bpy.context.scene
if opts.get("--engine"):
    kit.set_engine(opts["--engine"], int(opts["--samples"]) if opts.get("--samples") else None)
if sc.camera is None:
    lo, hi, c, size = kit.bounds()
    r = max(size.length, 4)
    kit.camera((c.x + r * 0.8, c.y - r * 0.8, c.z + r * 0.5), tuple(c))
    print("LJKIT camera=AUTO")

sc.render.image_settings.file_format = "PNG"
sc.render.image_settings.color_mode = "RGBA" if sc.render.film_transparent else "RGB"
meta = {"frameStart": sc.frame_start, "frameEnd": sc.frame_end, "fps": sc.render.fps,
        "width": sc.render.resolution_x, "height": sc.render.resolution_y, "engine": sc.render.engine,
        "blender": bpy.app.version_string, "transparent": bool(sc.render.film_transparent)}
with open(os.path.join(out, "meta.json"), "w", encoding="utf-8") as f:
    json.dump(meta, f)
print("LJKIT meta=" + json.dumps(meta))

try:
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(out, "scene.blend"), compress=True)
except Exception as e:  # noqa: BLE001
    print("LJKIT blend=FAILED", e)

mode = opts.get("--mode", "preview")
try:
    if mode == "preview":
        sc.render.resolution_percentage = int(opts.get("--scale", 50))
        frames = opts.get("--frames", "auto")
        if frames == "auto":
            n = 6
            span = sc.frame_end - sc.frame_start
            frames = [sc.frame_start + round(span * i / (n - 1)) for i in range(n)] if span else [sc.frame_start]
        else:
            frames = [int(x) for x in frames.split(",")]
        for fr in frames:
            sc.frame_set(fr)
            sc.render.filepath = os.path.join(out, f"p_{fr:05d}.png")
            bpy.ops.render.render(write_still=True)
            print(f"LJKIT preview={fr}")
    else:
        fdir = os.path.join(out, "frames")
        os.makedirs(fdir, exist_ok=True)
        sc.render.filepath = os.path.join(fdir, "f_#####")
        sc.render.use_overwrite = False      # 中斷後重跑會從缺的影格續算
        sc.render.use_placeholder = True
        bpy.ops.render.render(animation=True)
    print("LJKIT render=OK")
except Exception:  # noqa: BLE001
    print("LJKIT render=FAILED")
    traceback.print_exc()
    sys.exit(3)
