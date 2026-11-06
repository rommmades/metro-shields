"""Скачивает из OpenStreetMap линии метро (действующие и строящиеся) и станции в заданной рамке.
Запуск: python tools/fetch_osm.py <имя> <юг> <запад> <север> <восток>
Результат: data/osm/<имя>.json с линиями [[lon,lat],...] и станциями."""
import json, sys, time, urllib.request, urllib.parse

name, s, w, n, e = sys.argv[1], *sys.argv[2:6]
bbox = f"{s},{w},{n},{e}"
q = f"""[out:json][timeout:90];
(
  way["railway"~"subway|construction|proposed"]({bbox});
  way["construction:railway"="subway"]({bbox});
  node["station"="subway"]({bbox});
  node["railway"="station"]["subway"="yes"]({bbox});
  node["railway"~"station|construction|proposed"]["name"]({bbox});
);
out geom tags;"""
servers = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter",
           "https://maps.mail.ru/osm/tools/overpass/api/interpreter"]
data = None
for url in servers:
    try:
        req = urllib.request.Request(url, data=urllib.parse.urlencode({"data": q}).encode(),
                                     headers={"User-Agent": "metro-shields/1.0 (github.com/rommmades/metro-shields)"})
        data = json.load(urllib.request.urlopen(req, timeout=120))
        print("ok", url)
        break
    except Exception as ex:
        print("fail", url, ex)
        time.sleep(3)
if data is None:
    sys.exit(1)
ways, stations = [], []
for el in data["elements"]:
    t = el.get("tags", {})
    if el["type"] == "way" and "geometry" in el:
        rw = t.get("railway", "")
        if rw in ("subway", "construction", "proposed") and (rw == "subway" or t.get("construction") in ("subway", None) or t.get("construction:railway") == "subway" or "метро" in t.get("name", "").lower() or "лини" in t.get("name", "").lower()):
            ways.append({"id": el["id"], "name": t.get("name", ""), "railway": rw, "construction": t.get("construction", ""),
                         "tunnel": t.get("tunnel", ""), "pts": [[round(g["lon"], 6), round(g["lat"], 6)] for g in el["geometry"]]})
    elif el["type"] == "node":
        stations.append({"id": el["id"], "name": t.get("name", ""), "railway": t.get("railway", ""), "station": t.get("station", ""),
                         "lnglat": [round(el["lon"], 6), round(el["lat"], 6)]})
out = {"bbox": [float(s), float(w), float(n), float(e)], "ways": ways, "stations": stations}
json.dump(out, open(f"data/osm/{name}.json", "w"), ensure_ascii=False, indent=0)
print(len(ways), "ways,", len(stations), "stations")
