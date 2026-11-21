"""LJCUT 的 Blender 場景小工具（在 Blender 內的 Python 執行，由 blender_entry.py 匯入成 `kit`）。

場景腳本只負責「搭場景＋設定影格範圍」，渲染與輸出由執行器處理。範例：

    kit.setup(seconds=6)                        # 1920x1080、30fps、EEVEE
    kit.sky()                                   # 天空光
    kit.sun(rotation=(50, 0, 30))
    floor = kit.plane(size=40, material=kit.mat("地面", "#D9D4CC", roughness=0.9))
    col = kit.box((0, 0, 1.5), (0.4, 0.4, 3), material=kit.mat("柱", "#B0B6BF"))
    kit.text3d("林境資訊", (0, -3, 0.01), size=1.2, material=kit.mat("字", "#FFCC00", emission=2))
    kit.orbit((0, 0, 1), radius=10, height=4, degrees=120)   # 繞物件 120 度
    kit.key(col, 1, scale=(1, 1, 0.01)); kit.key(col, 45, scale=(1, 1, 1))

座標單位為公尺，Z 朝上；影格從 1 開始；角度用「度」。
"""
from __future__ import annotations

import math
import os

import bpy
from mathutils import Vector

FPS = 30


# ───────────────────────── 場景 ─────────────────────────
def reset():
    """清空預設場景（方塊、相機、燈）與孤立資料。"""
    bpy.ops.wm.read_factory_settings(use_empty=True)


def setup(seconds: float = 6, fps: int = 30, width: int = 1920, height: int = 1080, engine: str = "eevee",
          samples: int | None = None):
    """設定解析度、影格數、渲染引擎（eevee 快、cycles 寫實＋GPU）。"""
    global FPS
    FPS = fps
    sc = bpy.context.scene
    sc.render.resolution_x, sc.render.resolution_y, sc.render.resolution_percentage = width, height, 100
    sc.render.fps = fps
    sc.frame_start, sc.frame_end = 1, max(1, round(seconds * fps))
    set_engine(engine, samples)
    try:
        sc.view_settings.view_transform = "AgX"
    except TypeError:
        sc.view_settings.view_transform = "Filmic"
    return sc


def set_engine(engine: str = "eevee", samples: int | None = None):
    sc = bpy.context.scene
    if engine == "cycles":
        sc.render.engine = "CYCLES"
        enable_gpu()
        sc.cycles.samples = samples or 96
        sc.cycles.use_denoising = True
        try:
            sc.cycles.denoiser = "OPTIX"
        except TypeError:
            pass
    else:
        for name in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE"):   # 4.2–4.5 叫 NEXT，5.x 改回 EEVEE
            try:
                sc.render.engine = name
                break
            except TypeError:
                continue
        try:
            sc.eevee.taa_render_samples = samples or 32
        except AttributeError:
            pass
        for attr in ("use_raytracing", "use_shadows", "use_gtao"):
            try:
                setattr(sc.eevee, attr, True)
            except AttributeError:
                pass


def enable_gpu():
    """Cycles 用 GPU（OptiX → CUDA）。失敗時留在 CPU 並印出原因。"""
    try:
        prefs = bpy.context.preferences.addons["cycles"].preferences
        for kind in ("OPTIX", "CUDA"):
            try:
                prefs.compute_device_type = kind
                prefs.get_devices()
                devs = [d for d in prefs.devices if d.type == kind]
                if devs:
                    for d in prefs.devices:
                        d.use = d.type == kind
                    bpy.context.scene.cycles.device = "GPU"
                    print(f"LJKIT gpu={kind} devices={[d.name for d in devs]}")
                    return kind
            except TypeError:
                continue
    except Exception as e:  # noqa: BLE001
        print("LJKIT gpu=FAILED", e)
    return None


# ───────────────────────── 材質 ─────────────────────────
def _rgb(c):
    if isinstance(c, str):
        c = c.lstrip("#")
        c = tuple(int(c[i:i + 2], 16) / 255 for i in (0, 2, 4))
    # sRGB → 線性（Blender 色彩欄位是線性）
    return tuple(((x + 0.055) / 1.055) ** 2.4 if x > 0.04045 else x / 12.92 for x in c[:3]) + (1.0,)


def mat(name: str, color="#CCCCCC", roughness=0.5, metallic=0.0, emission=0.0, alpha=1.0, transmission=0.0):
    """Principled BSDF 材質。color 可用 '#RRGGBB'。emission>0 會自發光（字卡、指示燈）。"""
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes.get("Principled BSDF")
    rgba = _rgb(color)
    b.inputs["Base Color"].default_value = rgba
    b.inputs["Roughness"].default_value = roughness
    b.inputs["Metallic"].default_value = metallic
    if emission:
        for key in ("Emission Color", "Emission"):
            if key in b.inputs:
                b.inputs[key].default_value = rgba
                break
        b.inputs["Emission Strength"].default_value = emission
    if transmission:
        key = "Transmission Weight" if "Transmission Weight" in b.inputs else "Transmission"
        b.inputs[key].default_value = transmission
    if alpha < 1:
        b.inputs["Alpha"].default_value = alpha
        try:
            m.surface_render_method = "BLENDED"
        except AttributeError:
            m.blend_method = "BLEND"
    return m


def assign(obj, material):
    if material is None:
        return obj
    if obj.data and hasattr(obj.data, "materials"):
        obj.data.materials.clear()
        obj.data.materials.append(material)
    return obj


# ───────────────────────── 物件 ─────────────────────────
def _new(op, location, rotation, **kw):
    op(location=location, rotation=tuple(math.radians(a) for a in rotation), **kw)
    return bpy.context.active_object


def box(location=(0, 0, 0), size=(1, 1, 1), rotation=(0, 0, 0), material=None, bevel=0.0, name=None, base=False):
    """方塊。base=True 時 location 是底面中心、原點也在底部（kit.grow 會從地面往上長）。"""
    o = _new(bpy.ops.mesh.primitive_cube_add, location, rotation, size=1)
    o.scale = size
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)   # 預設三項全套用，位置會被烘進網格
    if base:
        from mathutils import Matrix
        o.data.transform(Matrix.Translation((0, 0, size[2] / 2)))
    if bevel:
        mod = o.modifiers.new("Bevel", "BEVEL")
        mod.width, mod.segments = bevel, 3
    if name:
        o.name = name
    return assign(o, material)


def cylinder(location=(0, 0, 0), radius=0.5, depth=1, rotation=(0, 0, 0), material=None, vertices=48, name=None):
    o = _new(bpy.ops.mesh.primitive_cylinder_add, location, rotation, radius=radius, depth=depth, vertices=vertices)
    bpy.ops.object.shade_smooth()
    if name:
        o.name = name
    return assign(o, material)


def sphere(location=(0, 0, 0), radius=0.5, material=None, name=None):
    o = _new(bpy.ops.mesh.primitive_uv_sphere_add, location, (0, 0, 0), radius=radius, segments=48, ring_count=24)
    bpy.ops.object.shade_smooth()
    if name:
        o.name = name
    return assign(o, material)


def plane(size=20, location=(0, 0, 0), rotation=(0, 0, 0), material=None, name=None):
    o = _new(bpy.ops.mesh.primitive_plane_add, location, rotation, size=size)
    if name:
        o.name = name
    return assign(o, material)


def pipe(points, radius=0.05, material=None, name=None):
    """沿多個點（公尺）的圓管，適合畫管線、動線。"""
    cu = bpy.data.curves.new(name or "pipe", "CURVE")
    cu.dimensions = "3D"
    cu.bevel_depth, cu.bevel_resolution = radius, 6
    sp = cu.splines.new("POLY")
    sp.points.add(len(points) - 1)
    for p, xyz in zip(sp.points, points):
        p.co = (*xyz, 1)
    o = bpy.data.objects.new(name or "pipe", cu)
    bpy.context.collection.objects.link(o)
    if material:
        cu.materials.append(material)
    return o


FONTS = [r"C:\Windows\Fonts\msjhbd.ttc", r"C:\Windows\Fonts\msjh.ttc", r"C:\Windows\Fonts\mingliu.ttc"]


def face(obj, toward, upright=True):
    """讓物件（立體字、看板）正面朝向某點，例如最後一格相機的位置。"""
    d = Vector(toward) - obj.location
    yaw = math.atan2(d.y, d.x) + math.pi / 2     # 字預設正面朝 -Y
    obj.rotation_euler = (math.radians(90) if upright else 0, 0, yaw)
    return obj


def camera_at(seconds: float):
    """某秒時相機的位置（相機有動畫時用來讓字幕看板朝向它）。"""
    sc = bpy.context.scene
    cur = sc.frame_current
    sc.frame_set(frame(seconds))
    loc = sc.camera.matrix_world.translation.copy() if sc.camera else Vector((0, -10, 2))
    sc.frame_set(cur)
    return loc


def text3d(body: str, location=(0, 0, 0), size=1.0, extrude=0.05, rotation=(90, 0, 0), material=None,
           align="CENTER", font=None, name=None):
    """立體字（支援中文，預設微軟正黑體）。rotation 預設立起來面向 -Y（相機在前方時正對）。"""
    cu = bpy.data.curves.new(name or "text", "FONT")
    cu.body = body
    cu.size, cu.extrude = size, extrude
    cu.align_x, cu.align_y = align, "CENTER"
    for path in ([font] if font else []) + FONTS:
        if path and os.path.isfile(path):
            try:
                cu.font = bpy.data.fonts.load(path, check_existing=True)
                break
            except RuntimeError:
                continue
    o = bpy.data.objects.new(name or "text", cu)
    bpy.context.collection.objects.link(o)
    o.location = location
    o.rotation_euler = tuple(math.radians(a) for a in rotation)
    if material:
        cu.materials.append(material)
    return o


def import_model(path: str, location=None, scale=None, rotation=None):
    """匯入 FBX／OBJ／glTF／GLB／STL／PLY（Revit 可匯出 FBX）。回傳匯入的物件清單。"""
    before = set(bpy.data.objects)
    ext = os.path.splitext(path)[1].lower()
    if ext == ".fbx":
        bpy.ops.import_scene.fbx(filepath=path)
    elif ext in (".gltf", ".glb"):
        bpy.ops.import_scene.gltf(filepath=path)
    elif ext == ".obj":
        bpy.ops.wm.obj_import(filepath=path)
    elif ext == ".stl":
        bpy.ops.wm.stl_import(filepath=path)
    elif ext == ".ply":
        bpy.ops.wm.ply_import(filepath=path)
    else:
        raise ValueError(f"不支援的模型格式：{ext}")
    objs = [o for o in bpy.data.objects if o not in before]
    roots = [o for o in objs if o.parent is None]
    for o in roots:
        if location is not None:
            o.location = location
        if scale is not None:
            o.scale = (scale,) * 3 if isinstance(scale, (int, float)) else scale
        if rotation is not None:
            o.rotation_euler = tuple(math.radians(a) for a in rotation)
    return objs


def bounds(objs=None):
    """物件群的包圍盒（世界座標）→ (min, max, center, size)。用來自動對準相機。"""
    objs = [o for o in (objs or bpy.context.scene.objects) if o.type == "MESH"]
    pts = [o.matrix_world @ Vector(c) for o in objs for c in o.bound_box]
    if not pts:
        z = Vector((0, 0, 0))
        return z, z, z, z
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    return lo, hi, (lo + hi) / 2, hi - lo


# ───────────────────────── 燈光與環境 ─────────────────────────
def sky(strength=1.0, sun_elevation=35, sun_rotation=40):
    """物理天空當環境光；新版沒有 Nishita 時退回柔和漸層色。"""
    w = bpy.data.worlds.get("World") or bpy.data.worlds.new("World")
    bpy.context.scene.world = w
    w.use_nodes = True
    nt = w.node_tree
    bg = nt.nodes.get("Background") or nt.nodes.new("ShaderNodeBackground")
    bg.inputs["Strength"].default_value = strength
    try:
        sk = nt.nodes.new("ShaderNodeTexSky")
        for t in ("NISHITA", "MULTIPLE_SCATTERING", "SINGLE_SCATTERING"):
            try:
                sk.sky_type = t
                break
            except TypeError:
                continue
        try:
            sk.sun_elevation, sk.sun_rotation = math.radians(sun_elevation), math.radians(sun_rotation)
        except AttributeError:
            pass
        nt.links.new(sk.outputs["Color"], bg.inputs["Color"])
    except Exception as e:  # noqa: BLE001
        print("LJKIT sky fallback", e)
        bg.inputs["Color"].default_value = _rgb("#BFD4E8")
    return w


def background(color="#1A1C22", strength=1.0):
    """純色背景（簡報風、產品展示）。"""
    w = bpy.data.worlds.get("World") or bpy.data.worlds.new("World")
    bpy.context.scene.world = w
    w.use_nodes = True
    bg = w.node_tree.nodes.get("Background")
    bg.inputs["Color"].default_value = _rgb(color)
    bg.inputs["Strength"].default_value = strength
    return w


def sun(rotation=(50, 0, 30), energy=3.0, angle=2.0, color="#FFF4E5"):
    d = bpy.data.lights.new("Sun", "SUN")
    d.energy, d.angle, d.color = energy, math.radians(angle), _rgb(color)[:3]
    o = bpy.data.objects.new("Sun", d)
    bpy.context.collection.objects.link(o)
    o.rotation_euler = tuple(math.radians(a) for a in rotation)
    return o


def area_light(location, look_at=(0, 0, 0), size=4, energy=800, color="#FFFFFF"):
    d = bpy.data.lights.new("Area", "AREA")
    d.size, d.energy, d.color = size, energy, _rgb(color)[:3]
    o = bpy.data.objects.new("Area", d)
    bpy.context.collection.objects.link(o)
    o.location = location
    _aim(o, look_at)
    return o


def studio(target=(0, 0, 1), distance=8, energy=1000):
    """三點打光：主光、補光、輪廓光。"""
    t = Vector(target)
    area_light(t + Vector((distance * 0.7, -distance * 0.7, distance * 0.6)), t, size=5, energy=energy)
    area_light(t + Vector((-distance * 0.8, -distance * 0.4, distance * 0.3)), t, size=6, energy=energy * 0.35)
    area_light(t + Vector((0, distance * 0.9, distance * 0.7)), t, size=3, energy=energy * 0.6)


# ───────────────────────── 相機與動畫 ─────────────────────────
def _aim(o, target):
    d = Vector(target) - o.location
    o.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()


def camera(location=(8, -8, 5), look_at=(0, 0, 1), lens=35):
    sc = bpy.context.scene
    cam = sc.camera
    if cam is None:
        cam = bpy.data.objects.new("Camera", bpy.data.cameras.new("Camera"))
        sc.collection.objects.link(cam)
        sc.camera = cam
    cam.data.lens = lens
    cam.location = location
    _aim(cam, look_at)
    return cam


def camera_path(keys, lens=35, ease="BEZIER"):
    """相機運鏡：keys = [(秒, (x,y,z) 位置, (x,y,z) 看向), ...]。各關鍵點之間平滑過渡。"""
    cam = camera(keys[0][1], keys[0][2], lens)
    tgt = bpy.data.objects.get("CamTarget") or bpy.data.objects.new("CamTarget", None)
    if tgt.name not in bpy.context.scene.collection.objects:
        bpy.context.scene.collection.objects.link(tgt)
    con = cam.constraints.get("Track") or cam.constraints.new("TRACK_TO")
    con.name, con.target = "Track", tgt
    con.track_axis, con.up_axis = "TRACK_NEGATIVE_Z", "UP_Y"
    for sec, loc, look in keys:
        f = frame(sec)
        cam.location = loc
        cam.keyframe_insert("location", frame=f)
        tgt.location = look
        tgt.keyframe_insert("location", frame=f)
    _interp(cam, ease)
    _interp(tgt, ease)
    return cam


def orbit(target=(0, 0, 0), radius=10, height=4, degrees=90, start_deg=-45, lens=35, seconds=None):
    """繞目標轉（等速、首尾緩動）。seconds 預設為整段長度。"""
    sc = bpy.context.scene
    total = seconds if seconds is not None else (sc.frame_end - sc.frame_start + 1) / FPS
    steps = max(2, int(abs(degrees) / 10) + 1)
    keys = []
    t = Vector(target)
    for i in range(steps):
        a = math.radians(start_deg + degrees * i / (steps - 1))
        keys.append((total * i / (steps - 1), (t.x + radius * math.cos(a), t.y + radius * math.sin(a), t.z + height), tuple(t)))
    return camera_path(keys, lens, ease="LINEAR" if steps > 2 else "BEZIER")


def frame(seconds: float) -> int:
    return 1 + round(seconds * FPS)


def key(obj, seconds: float, ease="BEZIER", **props):
    """在某秒設關鍵影格：key(o, 1.5, location=(0,0,1), scale=(1,1,1), rotation=(0,0,90))。rotation 用度。"""
    f = frame(seconds)
    for k, v in props.items():
        if k == "rotation":
            obj.rotation_euler = tuple(math.radians(a) for a in v)
            obj.keyframe_insert("rotation_euler", frame=f)
        elif k == "hide":
            obj.hide_render = bool(v)
            obj.keyframe_insert("hide_render", frame=f)
        else:
            setattr(obj, k, v)
            obj.keyframe_insert(k, frame=f)
    _interp(obj, ease)
    return obj


def _interp(obj, ease):
    ad = obj.animation_data
    if not ad or not ad.action:
        return
    curves = getattr(ad.action, "fcurves", None)
    if curves is None:   # Blender 4.4+／5.x 分層動畫：曲線在 layers→strips→channelbags
        curves = [fc for layer in getattr(ad.action, "layers", []) for st in layer.strips
                  for bag in getattr(st, "channelbags", []) for fc in bag.fcurves]
    for fc in curves:
        for kp in fc.keyframe_points:
            kp.interpolation = ease
            if ease == "BEZIER":
                kp.easing = "AUTO"


def grow(obj, start: float, duration: float = 0.8, axis="z"):
    """物件從 0 長到原大小（建造、出現效果）。"""
    full = tuple(obj.scale)
    s = list(full)
    s["xyz".index(axis)] = 0.001
    key(obj, start, scale=tuple(s))
    key(obj, start + duration, scale=full)
    return obj
