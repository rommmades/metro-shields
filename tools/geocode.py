"""Геокодирует адреса через Nominatim (OpenStreetMap).
Вход: .github/geocode-request.txt, строки вида  id | адрес
Выход: data/osm/geocode.json  {id: {"q": адрес, "lnglat": [lon, lat], "name": ...}}"""
import json, os, time, urllib.parse, urllib.request
out = {}
for line in open('.github/geocode-request.txt', encoding='utf-8'):
    if '|' not in line: continue
    key, q = [s.strip() for s in line.split('|', 1)]
    url = 'https://nominatim.openstreetmap.org/search?' + urllib.parse.urlencode({'q': q + ', Санкт-Петербург', 'format': 'jsonv2', 'limit': 1, 'countrycodes': 'ru'})
    req = urllib.request.Request(url, headers={'User-Agent': 'metro-shields/1.0 (github.com/rommmades/metro-shields)'})
    try:
        r = json.load(urllib.request.urlopen(req, timeout=30))
        out[key] = {'q': q, 'lnglat': [round(float(r[0]['lon']), 6), round(float(r[0]['lat']), 6)], 'name': r[0].get('display_name', '')} if r else {'q': q, 'lnglat': None}
    except Exception as e:
        out[key] = {'q': q, 'lnglat': None, 'error': str(e)}
    print(key, out[key].get('lnglat'))
    time.sleep(1.2)  # правила Nominatim: не чаще раза в секунду
os.makedirs('data/osm', exist_ok=True)
json.dump(out, open('data/osm/geocode.json', 'w'), ensure_ascii=False, indent=1)
