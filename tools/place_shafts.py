"""Выносит шахты из домов: адрес из тендера геокодируется в точку самого здания, а стройплощадка
обычно во дворе или на пустыре рядом. Для каждой шахты, которая попала в дом (или вплотную к нему),
ищется ближайшее свободное место: не ближе 6 м к домам, не на крупной улице и не на путях.
Запуск: python tools/place_shafts.py [area-файлы]  (по умолчанию все data/osm/area-*.json)
Меняет data/shields.json; исходная точка адреса сохраняется в поле "addr"."""
import json, math, sys

import glob
area = {"buildings": [], "roads": [], "rail": []}
for f in sys.argv[1:] or glob.glob("data/osm/area-*.json"):
    a = json.load(open(f, encoding="utf-8"))
    for k in area: area[k] += a.get(k, [])
data = json.load(open("data/shields.json", encoding="utf-8"))
LAT0 = 59.9
KX, KY = 111320 * math.cos(math.radians(LAT0)), 110540
xy = lambda ll: (ll[0] * KX, ll[1] * KY)
ll_ = lambda p: [round(p[0] / KX, 6), round(p[1] / KY, 6)]

blds = [[xy(p) for p in b["g"]] for b in area["buildings"]]
bbox = [(min(x for x, _ in g), min(y for _, y in g), max(x for x, _ in g), max(y for _, y in g)) for g in blds]
BIG = {"motorway", "trunk", "primary", "secondary", "tertiary"}
roads = [[xy(p) for p in r["g"]] for r in area["roads"] if r["k"] in BIG]
rails = [[xy(p) for p in r] for r in area["rail"]]

def inside(p, g):
    x, y = p; c = False
    for (x1, y1), (x2, y2) in zip(g, g[1:] + g[:1]):
        if (y1 > y) != (y2 > y) and x < x1 + (y - y1) * (x2 - x1) / (y2 - y1): c = not c
    return c
def dseg(p, a, b):
    (px, py), (ax, ay), (bx, by) = p, a, b; dx, dy = bx - ax, by - ay
    t = 0 if dx == dy == 0 else max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - ax - t * dx, py - ay - t * dy)
def dline(p, g): return min(dseg(p, a, b) for a, b in zip(g, g[1:]))
def dbld(p, lim=30):
    best = 1e9
    for g, (x0, y0, x1, y1) in zip(blds, bbox):
        if p[0] < x0 - lim or p[0] > x1 + lim or p[1] < y0 - lim or p[1] > y1 + lim: continue
        if inside(p, g): return -1
        best = min(best, dline(p, g + g[:1]))
    return best
def free(p):
    if dbld(p) < 6: return False
    if any(dline(p, r) < 12 for r in roads if len(r) > 1): return False
    if any(dline(p, r) < 8 for r in rails if len(r) > 1): return False
    return True

for sh in data["shields"]:
    for v in sh.get("shafts", []):
        if not v.get("lnglat"): continue
        src = v.get("addr") or v["lnglat"]; p0 = xy(src)
        d0 = dbld(p0)
        if d0 >= 4 and not v.get("addr"):
            print(v["name"], "не в доме, оставляю", round(d0, 1), "м до ближайшего"); continue
        cand = None
        for r in range(3, 160, 3):
            ring = [(p0[0] + r * math.cos(a), p0[1] + r * math.sin(a)) for a in [k * math.pi / max(8, r // 2) for k in range(2 * max(8, r // 2))]]
            ok = [q for q in ring if free(q)]
            if ok: cand = ok[0]; break
        if not cand: print(v["name"], "свободного места в 160 м не нашлось"); continue
        v["addr"] = src; v["lnglat"] = ll_(cand)
        v["placed"] = "площадка подобрана рядом с адресом: ближайшее место не в доме (OSM)"
        print(v["name"], "перенесена на", round(math.dist(p0, cand)), "м")
json.dump(data, open("data/shields.json", "w", encoding="utf-8"), ensure_ascii=False, indent=2)
