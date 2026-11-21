# 示範場景：結構柱逐根長出 → 管線延伸 → 標題字亮起，相機繞場 100 度（6 秒）。
# 用法：ljcut_blender_preview name=bim_intro script=<本檔內容>
kit.setup(seconds=6)
kit.sky(strength=0.25, sun_elevation=30)
kit.sun(rotation=(55, 0, 35), energy=2.2)

ground = kit.mat("地坪", "#7D7A74", roughness=0.85)
concrete = kit.mat("混凝土", "#A9ABAE", roughness=0.7)
slab_m = kit.mat("樓板", "#8E949C", roughness=0.6)
pipe_m = kit.mat("給水管", "#2E86DE", roughness=0.35, metallic=0.3)
pipe_m2 = kit.mat("排水管", "#E67E22", roughness=0.35, metallic=0.3)
title_m = kit.mat("標題", "#FFCC00", roughness=0.4, emission=1.5)

kit.plane(size=60, material=ground)

# 3 x 3 柱網，間距 6 m，柱高 3.6 m，依序長出
cols = []
for i, x in enumerate((-6, 0, 6)):
    for j, y in enumerate((-6, 0, 6)):
        c = kit.box((x, y, 0), (0.5, 0.5, 3.6), material=concrete, bevel=0.02, base=True)
        kit.grow(c, start=0.2 + (i * 3 + j) * 0.12, duration=0.6)
        cols.append(c)

slab = kit.box((0, 0, 3.75), (13, 13, 0.3), material=slab_m)
kit.key(slab, 0.0, scale=(1, 1, 1), location=(0, 0, 8))
kit.key(slab, 1.6, location=(0, 0, 8))
kit.key(slab, 2.3, location=(0, 0, 3.75))

# 管線：在樓板下沿柱網走，2.3 秒後從起點長到終點
for pts, m, z in (([(-7, -3, 3.2), (7, -3, 3.2)], pipe_m, 3.2), ([(-3, -7, 3.0), (-3, 7, 3.0)], pipe_m2, 3.0)):
    p = kit.pipe(pts, radius=0.09, material=m)
    p.data.bevel_factor_mapping_end = "SPLINE"
    p.data.bevel_factor_end = 0.0
    p.data.keyframe_insert("bevel_factor_end", frame=kit.frame(2.3))
    p.data.bevel_factor_end = 1.0
    p.data.keyframe_insert("bevel_factor_end", frame=kit.frame(3.6))

title = kit.text3d("林境資訊 BIM", (0, -9.5, 0.9), size=1.4, extrude=0.08, material=title_m)
kit.key(title, 0.0, scale=(0.001, 0.001, 0.001))
kit.key(title, 3.8, scale=(0.001, 0.001, 0.001))
kit.key(title, 4.4, scale=(1, 1, 1))

kit.orbit(target=(0, -1, 1.8), radius=20, height=4.5, degrees=100, start_deg=-130, lens=30)
# 標題放在「目標 → 最後相機位置」連線的 55% 處（在柱列前面）、比視線低 1.3 m，正面朝向相機
cam_end = kit.camera_at(5.5)
spot = Vector((0, -1, 1.8)).lerp(cam_end, 0.55)
title.location = (spot.x, spot.y, spot.z - 1.3)
kit.face(title, cam_end)
