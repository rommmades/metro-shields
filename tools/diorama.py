"""Диорама-вырез участка линии: кусок города «как торт», под ним грунт, тоннели, станция, шахты, щит.
Запуск (Blender как модуль, pip install bpy):  python tools/diorama.py <имя>
Параметры берутся из .github/diorama-request.txt; на выходе renders/<имя>-raw.png и renders/<имя>-labels.json,
подписи и заголовок дорисовывает tools/annotate.py."""
import json, math, os, sys
import bpy, bmesh
from mathutils import Vector, Matrix
from bpy_extras.object_utils import world_to_camera_view

NAME = sys.argv[-1] if len(sys.argv) > 1 else "borovaya"
cfg = {}
for line in open(".github/diorama-request.txt", encoding="utf-8"):
    line = line.split("#")[0].strip()
    if not line: continue
    p = line.split()
    if p[0] == NAME:
        cfg = dict(area=p[1], lng=float(p[2]), lat=float(p[3]), L=float(p[4]), W=float(p[5]), az=float(p[6]), el=float(p[7]),
                   samples=int(p[8]) if len(p) > 8 else 64)
assert cfg, "нет строки для " + NAME
AREA = json.load(open(f"data/osm/area-{cfg['area']}.json", encoding="utf-8"))
DATA = json.load(open("data/shields.json", encoding="utf-8"))
GROUP = [s for s in DATA["shields"] if "Красносельско" in s.get("line", "")]

# --- координаты: метры от центра, x — восток, y — север ---
LAT0 = math.radians(cfg["lat"]); KX = 111320 * math.cos(LAT0); KY = 110540
def loc(ll): return Vector(((ll[0] - cfg["lng"]) * KX, (ll[1] - cfg["lat"]) * KY, 0))

# ось блока: вдоль трассы «Любви» у центра
def path_local(sh): return [loc(p) for p in sh["path"]]
def nearest_dir(pts, c):
    best, d = 1e18, Vector((1, 0, 0))
    for a, b in zip(pts, pts[1:]):
        m = (a + b) / 2
        if (m - c).length < best: best, d = (m - c).length, (b - a).normalized()
    return d
AX = nearest_dir(path_local(GROUP[0]), Vector((0, 0, 0))); AX.z = 0; AX.normalize()
AV = Vector((-AX.y, AX.x, 0))          # поперёк блока
HL, HW = cfg["L"] / 2, cfg["W"] / 2
# Вырез как у макета: передняя грань блока идёт в ~30 м перед тоннелем, а сам блок уходит назад, в сторону вестибюля
_vs = [loc(s["vestibule"]["lnglat"]) for s in GROUP[0]["stations"] if s.get("vestibule", {}).get("lnglat")]
_v = min(_vs, key=lambda q: q.length) if _vs else None      # вестибюль ближайшей к центру станции
_p0 = path_local(GROUP[0]); _near = min(_p0, key=lambda q: q.length)
VT = _near.dot(AV)                     # где тоннель проходит поперёк блока
SIDE = 1 if _v is None or _v.dot(AV) >= VT else -1
CEN = AV * (VT + SIDE * (HW - 30))
def inside(p, m=0): q = p - CEN; q.z = 0; u, v = q.dot(AX), q.dot(AV); return abs(u) <= HL - m and abs(v) <= HW - m
def corner(u, v, z): return CEN + AX * u + AV * v + Vector((0, 0, z))

# --- сцена ---
bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
def mat(name, rgb, rough=0.8, alpha=1.0, emit=0.0, metal=0.0):
    m = bpy.data.materials.new(name); m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*rgb, 1); b.inputs["Roughness"].default_value = rough; b.inputs["Metallic"].default_value = metal
    if alpha < 1: b.inputs["Alpha"].default_value = alpha
    if emit:
        b.inputs["Emission Color"].default_value = (*rgb, 1); b.inputs["Emission Strength"].default_value = emit
    return m
def hexc(h): h = h.lstrip("#"); return tuple((int(h[i:i + 2], 16) / 255) ** 2.2 for i in (0, 2, 4))
M = {
    "ground": mat("ground", hexc("#e9e6df")), "road": mat("road", hexc("#d3d1cb")), "rail": mat("rail", hexc("#b8b4ab")),
    "green": mat("green", hexc("#d5dcc9")), "bld": mat("bld", hexc("#f5f3ee"), 0.9),
    "fill": mat("fill", hexc("#dcc79c")), "loam": mat("loam", hexc("#c19a6b")), "clay": mat("clay", hexc("#8ea39a")), "clay2": mat("clay2", hexc("#74897f")),
    "glass": mat("glass", hexc("#c8d2cf"), 0.3, alpha=0.0),
    "future": mat("future", hexc("#fbf7f0"), 0.5, alpha=0.7), "hall": mat("hall", hexc("#f6f1e7"), 0.6),
    "esc": mat("esc", hexc("#efe9de"), 0.5), "shaft": mat("shaft", hexc("#aeb9bd"), 0.5), "kiosk": mat("kiosk", hexc("#5f6a6e")),
    "beam": mat("beam", hexc("#f0b43a"), 0.4, alpha=0.35, emit=2.0),
}
for s in GROUP:
    M["done-" + s["id"]] = mat("done-" + s["id"], hexc(s.get("lineColor", "#8a5a36")), 0.45, emit=0.25)
    M["sh-" + s["id"]] = mat("sh-" + s["id"], hexc(s.get("color", "#e3a21a")), 0.35, emit=4.0, metal=0.3)
M["vest"] = mat("vest", hexc(GROUP[0].get("lineColor", "#8a5a36")), 0.6)

def obj_from_bm(bm, name, m):
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free()
    ob = bpy.data.objects.new(name, me); sc.collection.objects.link(ob)
    if isinstance(m, list):
        for x in m: ob.data.materials.append(x)
    else: ob.data.materials.append(m)
    return ob

# --- поверхность и грунт ---
TOP = 0.0
def slab(z0, z1, m, name, glass_front=False, glass_flat=False, floor=False):
    bm = bmesh.new()
    vs = [bm.verts.new(corner(u, v, z)) for z in (z0, z1) for (u, v) in ((-HL, -HW), (HL, -HW), (HL, HW), (-HL, HW))]
    faces = [(0, 1, 2, 3), (4, 7, 6, 5), (0, 4, 5, 1), (1, 5, 6, 2), (2, 6, 7, 3), (3, 7, 4, 0)]
    for i, f in enumerate(faces):
        fc = bm.faces.new([vs[k] for k in f])
        # 0 — низ, 1 — верх, 2 — передняя грань (v = −HW, к камере)
        if (glass_front and i == (2 if SIDE > 0 else 4)) or (glass_flat and i in ((1,) if floor else (0, 1))): fc.material_index = 1
    bm.normal_update()
    fm = M["glass"]
    if glass_front:
        fm = m.copy(); fm.name = m.name + "-cut"; b = fm.node_tree.nodes["Principled BSDF"]; b.inputs["Alpha"].default_value = 0.0
    return obj_from_bm(bm, name, [m, fm])
VEX = 1.5                                     # глубина утрирована в 1,5 раза, чтобы подземная часть читалась
D_SOIL = 100 * VEX
slab(-2, TOP, M["ground"], "surface")
layers = [(-2, -14 * VEX, "fill"), (-14 * VEX, -32 * VEX, "loam"), (-32 * VEX, -72 * VEX, "clay"), (-72 * VEX, -D_SOIL, "clay2")]
for z1, z0, k in layers: slab(z0, z1, M[k], "soil-" + k, glass_front=True, glass_flat=True, floor=(k == "clay2"))

# --- дома, улицы, рельсы, зелень ---
def poly_ok(pts): return len(pts) >= 3 and all(inside(p, 2) for p in pts)
bm_b = bmesh.new()
for b in AREA["buildings"]:
    pts = [loc(p) for p in b["g"]]
    if pts[0] == pts[-1]: pts = pts[:-1]
    if not poly_ok(pts): continue
    h = b["h"] or 14.0
    vs = [bm_b.verts.new((p.x, p.y, TOP)) for p in pts]
    try: f = bm_b.faces.new(vs)
    except ValueError: continue
    r = bmesh.ops.extrude_face_region(bm_b, geom=[f])
    top = [e for e in r["geom"] if isinstance(e, bmesh.types.BMVert)]
    bmesh.ops.translate(bm_b, verts=top, vec=(0, 0, h))
bmesh.ops.recalc_face_normals(bm_b, faces=bm_b.faces)
obj_from_bm(bm_b, "buildings", M["bld"])

def ribbons(lines, width_of, z, m, name):
    bm = bmesh.new()
    for g, w in lines:
        pts = [loc(p) for p in g]
        for a, b in zip(pts, pts[1:]):
            if not (inside(a, 1) and inside(b, 1)): continue
            d = (b - a);
            if d.length < 0.1: continue
            n = Vector((-d.y, d.x, 0)).normalized() * w / 2
            zz = z + (len(bm.faces) % 7) * 0.012   # без совпадающих плоскостей: иначе чёрные пятна
            bm.faces.new([bm.verts.new((q.x, q.y, zz)) for q in (a - n, b - n, b + n, a + n)])
    ob = obj_from_bm(bm, name, m); ob.visible_shadow = False; return ob
RW = {"motorway": 16, "trunk": 16, "primary": 14, "secondary": 12, "tertiary": 10, "residential": 7, "unclassified": 7, "living_street": 5, "service": 4, "pedestrian": 5}
ribbons([(r["g"], RW[r["k"]]) for r in AREA["roads"] if r["k"] in RW], None, TOP + 0.05, M["road"], "roads")
ribbons([(g, 3) for g in AREA["rail"]], None, TOP + 0.08, M["rail"], "rail")
bm_g = bmesh.new()
for g in AREA["green"]:
    pts = [loc(p) for p in g]
    if pts[0] == pts[-1]: pts = pts[:-1]
    if not poly_ok(pts): continue
    try: bm_g.faces.new([bm_g.verts.new((p.x, p.y, TOP + 0.03)) for p in pts])
    except ValueError: pass
obj_from_bm(bm_g, "green", M["green"]).visible_shadow = False

# --- трассы щитов ---
def arc(pts):
    c = [0.0]
    for a, b in zip(pts, pts[1:]): c.append(c[-1] + (b - a).length)
    return c
def t_of_ring(sh, r):
    k = sh["ringKnots"]
    for a, b in zip(k, k[1:]):
        if r <= b[0]: return a[1] + (b[1] - a[1]) * (r - a[0]) / (b[0] - a[0])
    return k[-1][1]
def sample(pts, t0, t1, step=4.0):
    c = arc(pts); L = c[-1]; out = []; s = t0 * L
    while s <= t1 * L + 1e-6:
        for i in range(1, len(c)):
            if s <= c[i]:
                f = (s - c[i - 1]) / ((c[i] - c[i - 1]) or 1); out.append(pts[i - 1].lerp(pts[i], f)); break
        s += step
    return out
def tube(pts, r, m, name):
    """Труба по точкам, обрезанная рамкой блока; каждый непрерывный кусок — отдельный сплайн."""
    cu = bpy.data.curves.new(name, "CURVE"); cu.dimensions = "3D"; cu.bevel_depth = r; cu.bevel_resolution = 6; cu.use_fill_caps = True
    run = []
    def flush():
        if len(run) > 1:
            sp = cu.splines.new("POLY"); sp.points.add(len(run) - 1)
            for i, p in enumerate(run): sp.points[i].co = (p.x, p.y, p.z, 1)
        run.clear()
    for p in pts:
        if inside(p, 1): run.append(p)
        else: flush()
    flush()
    ob = bpy.data.objects.new(name, cu); sc.collection.objects.link(ob); cu.materials.append(m); return ob
def cyl(a, b, r, m, name, verts=24):
    d = b - a; L = d.length
    bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=r, depth=L, location=(a + b) / 2)
    ob = bpy.context.active_object; ob.name = name
    ob.rotation_euler = Vector((0, 0, 1)).rotation_difference(d.normalized()).to_euler(); ob.data.materials.append(m); return ob
def box(c, size, ang, m, name):
    bpy.ops.mesh.primitive_cube_add(size=1, location=c); ob = bpy.context.active_object; ob.name = name
    ob.scale = size; ob.rotation_euler = (0, 0, ang); ob.data.materials.append(m); return ob

LABELS = []
R_T = 4.2                                     # тоннель КТ-5,63 (R 2,8 м), увеличен в 1,5 раза для читаемости
for n, sh in enumerate(GROUP):
    D = sh.get("depth", 60) * VEX
    pts = [p + Vector((0, 0, -D)) for p in path_local(sh)]
    t = max(0, min(1, t_of_ring(sh, sh["ring"])))
    tube(sample(pts, 0, t), R_T, M["done-" + sh["id"]], "done-" + sh["id"])
    tube(sample(pts, t, 1), R_T, M["future"], "future-" + sh["id"])
    tip = sample(pts, max(0, t - 0.0005), t + 0.0005, 1.0)
    if len(tip) >= 2 and inside(tip[-1]):
        a, b = tip[0], tip[-1]; d = (b - a).normalized()
        cyl(b - d * 9, b + d * 1, R_T * 1.12, M["sh-" + sh["id"]], "shield-" + sh["id"])
        cyl(b + Vector((0, 0, 4)), Vector((b.x, b.y, 3)), 0.9, M["beam"], "beam-" + sh["id"], 8)
        lt = bpy.data.lights.new("glow-" + sh["id"], "POINT"); lt.energy = 60000; lt.color = hexc(sh.get("color", "#e3a21a")); lt.shadow_soft_size = 6
        lo = bpy.data.objects.new("glow-" + sh["id"], lt); lo.location = b - AV * SIDE * 12; sc.collection.objects.link(lo)
        M_ = sh["unit"] == "m"
        LABELS.append({"kind": "shield", "pos": list(b), "top": [b.x, b.y, 3], "text": "«%s»" % sh["name"],
                       "sub": ("%d м" % round(sh["ring"])) if M_ else ("кольцо %d" % round(sh["ring"])), "color": sh.get("color", "#e3a21a")})

# --- наземные вестибюли ---
M["brick"] = mat("brick", hexc("#7c2f24"), 0.7); M["vglass"] = mat("vglass", hexc("#33505c"), 0.08, metal=0.6)
M["silver"] = mat("silver", hexc("#c9ced1"), 0.25, metal=0.8); M["granite"] = mat("granite", hexc("#8d9194"), 0.8)
M["canopy"] = mat("canopy", hexc("#9fc3cf"), 0.05, alpha=0.5)
def place(ob, c, ang):
    ob.location = c + Matrix.Rotation(ang, 4, "Z") @ ob.location; ob.rotation_euler = (ob.rotation_euler.x, ob.rotation_euler.y, ob.rotation_euler.z + ang)
def lbox(c, ang, off, size, m, name="v"):
    ob = box(Vector(off), size, 0, m, name); place(ob, c, ang); return ob
def lcyl(c, ang, off, r, h, m, verts=48, name="v"):
    bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=r, depth=h, location=Vector(off)); ob = bpy.context.active_object; ob.name = name
    ob.data.materials.append(m); place(ob, c, ang); return ob
def simple_vestibule(c, ang, size):
    l, w = size or (42, 26); lbox(c, ang, (0, 0, 5), (l, w, 10), M["vest"], "vestibule")
def rotunda_vestibule(c, ang, size):
    """Упрощённая модель по перспективе «Боровая 2» (Ленметрогипротранс): корпус с кирпичными торцами и лентой
    остекления, стеклянная ротонда со светлой крышей и куполом, козырьки над входами, подиум со ступенями, пилоны."""
    l, w = size or (46, 30); k = l / 46
    lbox(c, ang, (0, -2 * k, 0.4), (l + 16 * k, w + 14 * k, 0.8), M["granite"], "podium")
    lbox(c, ang, (0, -2 * k, 1.0), (l + 10 * k, w + 9 * k, 0.6), M["granite"], "step")
    lbox(c, ang, (0, 0, 5.2), (l - 6 * k, w - 2 * k, 8.4), M["vglass"], "body-glass")
    for sx in (-1, 1): lbox(c, ang, (sx * (l / 2 - 3 * k), 0, 5.6), (6 * k, w, 9.2), M["brick"], "body-end")
    lbox(c, ang, (0, w / 2 - 1.5 * k, 5.6), (l, 3 * k, 9.2), M["brick"], "body-back")
    lbox(c, ang, (0, 0, 9.9), (l + 0.6, w + 0.6, 0.8), M["brick"], "parapet")
    lbox(c, ang, (0, 0, 10.35), (l - 1, w - 1, 0.2), M["silver"], "roof")
    R_ = 13 * k; cy = -w / 2 + 4 * k
    lcyl(c, ang, (0, cy, 6.2), R_, 10.4, M["vglass"], name="rotunda")
    lcyl(c, ang, (0, cy, 11.8), R_ + 1.4 * k, 1.0, M["silver"], name="rotunda-roof")
    bpy.ops.mesh.primitive_uv_sphere_add(radius=6 * k, location=(0, cy, 12.2)); dm = bpy.context.active_object; dm.scale = (1, 1, 0.38)
    dm.data.materials.append(M["silver"]); place(dm, c, ang)
    for sx in (-1, 1): lbox(c, ang, (sx * (l / 2 - 10 * k), -w / 2 - 4 * k, 4.6), (12 * k, 7 * k, 0.25), M["canopy"], "canopy")
    for i in range(6): lbox(c, ang, ((i - 2.5) * 9 * k, -w / 2 - 8.5 * k, 4.2), (0.6, 0.6, 7.6), M["brick"], "pylon")

# --- станции: пилонная — три параллельных тоннеля с проёмами; эскалаторный ход к вестибюлю ---
sh0 = GROUP[0]; D0 = sh0.get("depth", 60) * VEX; pts0 = [p + Vector((0, 0, -D0)) for p in path_local(sh0)]
for s in sh0["stations"]:
    t1, t2 = t_of_ring(sh0, s["from"]), t_of_ring(sh0, s["to"])
    hall = sample(pts0, max(0, t1), min(1, t2), 3.0)
    if len(hall) < 3 or not any(inside(p) for p in hall): continue
    side = lambda p, i: (lambda d: Vector((-d.y, d.x, 0)).normalized())((hall[min(i + 1, len(hall) - 1)] - hall[max(i - 1, 0)]))
    offs = [side(p, i) for i, p in enumerate(hall)]
    tube(hall, 7, M["hall"], "hall-c-" + s["name"])
    for sgn in (-1, 1): tube([p + o * 17 * sgn for p, o in zip(hall, offs)], 6.5, M["hall"], "hall-s-" + s["name"])
    for i in range(2, len(hall) - 2, 3):  # проёмы между пилонами
        p, o = hall[i], offs[i]
        if inside(p): cyl(p - o * 16, p + o * 16, 2.6, M["hall"], "pass", 8)
    vest = s.get("vestibule", {}).get("lnglat")
    if vest:
        vx = loc(vest); e = min((hall[0], hall[-1]), key=lambda q: (Vector((q.x, q.y, 0)) - vx).length)
        d = Vector((vx.x - e.x, vx.y - e.y, 0)); dist = d.length; d.normalize()
        run = max(30, min(D0 / math.tan(math.radians(30)), dist - 20))
        T = Vector((vx.x, vx.y, -6)) - d * 14; B = T - d * run; B.z = e.z
        if inside(B) and inside(T):
            cyl(Vector((e.x, e.y, e.z)), B, 5, M["hall"], "passage")
            box(B, (20, 18, 14), math.atan2(d.y, d.x), M["hall"], "chamber-low")
            box(T, (22, 18, 12), math.atan2(d.y, d.x), M["hall"], "chamber-up")
            cyl(B + d * 8 + Vector((0, 0, 3)), T - d * 9 - Vector((0, 0, 2)), 5.2, M["esc"], "escalator")
        if inside(vx):
            vo = s.get("vestibule", {}); ang = math.radians(-vo["rot"]) if vo.get("rot") is not None else math.atan2(d.y, d.x)
            (rotunda_vestibule if vo.get("model") == "rotunda" else simple_vestibule)(Vector((vx.x, vx.y, 0)), ang, vo.get("size"))
            LABELS.append({"kind": "station", "pos": [vx.x, vx.y, 12], "text": s["name"], "sub": "вестибюль"})
    mid = hall[len(hall) // 2]
    if inside(mid): LABELS.append({"kind": "hall", "pos": list(mid), "text": "«%s»" % s["name"], "sub": "−%d м" % s.get("depth", sh0.get("depth", 60))})

# --- вентшахты ---
for v in sh0.get("shafts", []):
    if not v.get("lnglat"): continue
    top = loc(v["lnglat"])
    if not inside(top, 5): continue
    best = min(pts0, key=lambda q: (Vector((q.x, q.y, 0)) - top).length)
    cyl(Vector((top.x, top.y, best.z)), Vector((top.x, top.y, 0.5)), 4, M["shaft"], "shaft")
    box(Vector((top.x, top.y, best.z)), (16, 16, 12), 0, M["shaft"], "vent-chamber")
    g = Vector((best.x - top.x, best.y - top.y, 0))
    if g.length > 2: cyl(Vector((top.x, top.y, best.z)), Vector((best.x, best.y, best.z)), 3, M["shaft"], "gallery", 12)
    box(Vector((top.x, top.y, 3)), (14, 9, 6), math.atan2(AX.y, AX.x), M["kiosk"], "kiosk")
    LABELS.append({"kind": "shaft", "pos": [top.x, top.y, 8], "text": v.get("name", "Шахта")})

# --- свет, мир, камера ---
w = bpy.data.worlds.new("w"); sc.world = w; w.use_nodes = True
w.node_tree.nodes["Background"].inputs["Color"].default_value = (*hexc("#e4e9ec"), 1); w.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.9
sun = bpy.data.lights.new("sun", "SUN"); sun.energy = 3.2; sun.angle = math.radians(8)
so = bpy.data.objects.new("sun", sun); so.rotation_euler = (math.radians(50), 0, math.radians(cfg["az"] + 60)); sc.collection.objects.link(so)

# мягкий свет в разрез спереди, чтобы подземная часть не тонула в тени
fl = bpy.data.lights.new("fill", "AREA"); fl.energy = 4.0e6; fl.size = cfg["L"]; fl.color = (1.0, 0.97, 0.92)
fo = bpy.data.objects.new("fill", fl); sc.collection.objects.link(fo)
fo.location = CEN - AV * SIDE * (HW + 260) + Vector((0, 0, -40))
fo.rotation_euler = ((CEN + Vector((0, 0, -50))) - fo.location).to_track_quat("-Z", "Y").to_euler()
cam = bpy.data.cameras.new("cam"); cam.type = "ORTHO"; cam.ortho_scale = cfg["L"] * 1.3
co = bpy.data.objects.new("cam", cam); sc.collection.objects.link(co); sc.camera = co
az, el = math.radians(cfg["az"]), math.radians(cfg["el"])
look = CEN + Vector((0, 0, -D_SOIL * 0.3))
dirv = (-AV * SIDE * math.cos(az) + AX * math.sin(az)) * math.cos(el) + Vector((0, 0, math.sin(el)))
co.location = look + dirv * 3000
co.rotation_euler = (look - co.location).to_track_quat("-Z", "Y").to_euler()
cam.clip_end = 10000

r = sc.render; r.engine = "CYCLES"; r.resolution_x, r.resolution_y = 1600, 1000; r.film_transparent = False
sc.cycles.samples = cfg["samples"]; sc.cycles.use_denoising = True; sc.cycles.device = "CPU"
sc.cycles.transparent_max_bounces = 24; sc.cycles.max_bounces = 6
sc.view_settings.view_transform = "AgX"; sc.view_settings.look = "AgX - Medium High Contrast" if "AgX - Medium High Contrast" in [i.identifier for i in sc.view_settings.bl_rna.properties["look"].enum_items] else "None"

os.makedirs("renders", exist_ok=True)
r.filepath = os.path.abspath(f"renders/{NAME}-raw.png")
bpy.context.view_layer.update()
for L in LABELS:
    q = world_to_camera_view(sc, co, Vector(L["pos"]))
    L["px"] = [q.x * r.resolution_x, (1 - q.y) * r.resolution_y]
    if "top" in L:
        q2 = world_to_camera_view(sc, co, Vector(L["top"])); L["px_top"] = [q2.x * r.resolution_x, (1 - q2.y) * r.resolution_y]
json.dump({"labels": LABELS, "updated": DATA.get("updated"), "line": GROUP[0]["line"], "size": [r.resolution_x, r.resolution_y],
           "shields": [{"name": s["name"], "ring": s["ring"], "unit": s["unit"], "color": s.get("color"), "total": s["total"],
                        "stations": [[x["name"], x["from"], x["to"]] for x in s["stations"]]} for s in GROUP]},
          open(f"renders/{NAME}-labels.json", "w"), ensure_ascii=False, indent=1)
# модель для просмотра в браузере (diorama.html): та же сцена, без камеры и света
try:
    bpy.ops.export_scene.gltf(filepath=os.path.abspath(f"renders/{NAME}.glb"), export_format="GLB", export_cameras=False,
                              export_lights=False, export_apply=True, export_yup=True)
except Exception as ex:
    print("glb export failed:", ex)
json.dump({"center": [cfg["lng"], cfg["lat"]], "L": cfg["L"], "W": cfg["W"], "cen": [CEN.x, CEN.y], "ax": [AX.x, AX.y], "side": SIDE,
           "labels": LABELS}, open(f"renders/{NAME}-scene.json", "w"), ensure_ascii=False)
bpy.ops.render.render(write_still=True)
print("rendered", r.filepath)
