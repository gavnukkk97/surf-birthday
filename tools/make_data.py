#!/usr/bin/env python3
"""Финальная сборка: ручные фиксы + уточнение адресов + генерация data.js."""
import json, time, urllib.parse, urllib.request, re

UA = "surf-birthday-route/1.0 (personal project)"

# Ручные фиксы, найденные через веб-поиск и Nominatim POI-поиск
MANUAL = {
    "TAKEOFF": (55.7978871, 37.5220924),   # проезд Аэропорта 8с9 (Loft Studio 8)
    "SWALLOW": (55.8210000, 37.4975000),   # Кривоградская 13А — ТЦ Метрополис, южная сторона
    "SALARIS": (55.6233817, 37.4223505),   # ТРЦ «Саларис», 23-й км Киевского шосса
}

# Точки, вставшие на середину улицы — пробуем уточнить структурированным запросом
REFINE = {
    "OGNI": ("улица Лобачевского", "124 к1"),
    "AMUR": ("Амурская улица", "1А"),
    "PICTURE DISC": ("улица Авиаконструктора Миля", "3А"),
    "GLOW": ("улица Михайлова", "30А к1"),
}

def ssearch(street, hn):
    params = {"format": "jsonv2", "limit": "3", "accept-language": "ru",
              "city": "Москва", "street": street, "housenumber": hn}
    url = "https://nominatim.openstreetmap.org/search?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            return json.load(r)
    except Exception:
        return []

rows = json.load(open("/tmp/surf_geo_progress.json"))
by_name = {r["name"]: r for r in rows}

for name, (lat, lon) in MANUAL.items():
    by_name[name].update(lat=lat, lon=lon, display="ручной фикс")
    print(f"SET  {name:14s} {lat}, {lon}")

for name, (street, hn) in REFINE.items():
    res = ssearch(street, hn)
    time.sleep(1.1)
    if res:
        r = res[0]
        lat, lon = float(r["lat"]), float(r["lon"])
        bb = [float(x) for x in r.get("boundingbox", [])]
        if len(bb) == 4 and (bb[2] - bb[0]) < 0.01 and (bb[3] - bb[1]) < 0.01:
            print(f"REFINE {name:14s} -> {lat}, {lon}  {r.get('display_name','')[:60]}")
            by_name[name].update(lat=lat, lon=lon, display=r.get("display_name", "")[:160])
        else:
            print(f"SKIP  {name:14s} bbox слишком большой, оставляем как есть")
    else:
        print(f"SKIP  {name:14s} не нашлось, оставляем как есть")

rows.sort(key=lambda r: r["name"])
fails = [r for r in rows if r["lat"] is None]
print(f"\nитого: {len(rows) - len(fails)}/{len(rows)} координат; провалы: {[r['name'] for r in fails]}")

def esc(s):
    return json.dumps(s, ensure_ascii=False)

out = "// Surf Coffee — точки Москвы. Источник адресов: surfcoffee.ru (октябрь 2026).\n" \
      "// Координаты: Nominatim/OpenStreetMap + ручные фиксы. Часы работы — по умолчанию для сети.\n" \
      "window.SURF_SPOTS = [\n"
for r in rows:
    if r["lat"] is None:
        continue
    out += f"  {{name: {esc(r['name'])}, addr: {esc(r['addr'])}, lat: {r['lat']}, lon: {r['lon']}}},\n"
out += "];\n"

with open("/Users/user/.zcode/workspace/default/surf-birthday/data.js", "w") as f:
    f.write(out)
print(f"data.js записан: {len(rows) - len(fails)} точек")
