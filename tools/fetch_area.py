"""Скачивает из OpenStreetMap дома, улицы и воду в рамке для диорамы.
Запуск: python tools/fetch_area.py <имя> <юг> <запад> <север> <восток>
Результат: data/osm/area-<имя>.json"""
import json, os, sys, time, urllib.request, urllib.parse

name, s, w, n, e = sys.argv[1], *sys.argv[2:6]
bb = f"{s},{w},{n},{e}"
q = f"""[out:json][timeout:120];
(way["building"]({bb}); way["highway"]({bb}); way["railway"="rail"]({bb});
 way["natural"="water"]({bb}); way["waterway"~"canal|river"]({bb}); way["leisure"="park"]({bb}); way["landuse"~"grass|forest"]({bb}););
out geom;"""
HOSTS = ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter",
         "https://maps.mail.ru/osm/tools/overpass/api/interpreter", "https://overpass.kumi.systems/api/interpreter"]
res = None
for attempt in range(3):                       # серверы Overpass бывают перегружены: несколько зеркал и повторы
    for host in HOSTS:
        try:
            req = urllib.request.Request(host, data=urllib.parse.urlencode({"data": q}).encode(), headers={"User-Agent": "metro-shields/1.0"})
            res = json.load(urllib.request.urlopen(req, timeout=180)); break
        except Exception as ex:
            print("fail", host, ex); time.sleep(5)
    if res: break
    time.sleep(60)
if not res: sys.exit(1)

def hgt(t):
    for k in ("height", "building:height"):
        try: return float(str(t[k]).split()[0].replace(",", "."))
        except Exception: pass
    try: return float(t["building:levels"]) * 3.2 + 1
    except Exception: return None

out = {"bbox": [float(s), float(w), float(n), float(e)], "buildings": [], "roads": [], "rail": [], "water": [], "waterways": [], "green": []}
for el in res["elements"]:
    t = el.get("tags", {}); g = [[round(p["lon"], 7), round(p["lat"], 7)] for p in el.get("geometry", [])]
    if len(g) < 2: continue
    if "building" in t: out["buildings"].append({"g": g, "h": hgt(t), "lv": t.get("building:levels")})
    elif "highway" in t: out["roads"].append({"g": g, "k": t["highway"]})
    elif t.get("railway") == "rail": out["rail"].append(g)
    elif t.get("natural") == "water": out["water"].append(g)
    elif "waterway" in t: out["waterways"].append({"g": g, "k": t["waterway"]})
    else: out["green"].append(g)
os.makedirs("data/osm", exist_ok=True)
json.dump(out, open(f"data/osm/area-{name}.json", "w"), ensure_ascii=False, separators=(",", ":"))
print(name, {k: len(v) for k, v in out.items() if isinstance(v, list)})
