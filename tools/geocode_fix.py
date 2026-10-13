#!/usr/bin/env python3
"""Второй проход геокодинга для точек, которые не нашлись с первого раза."""
import json, time, urllib.parse, urllib.request, os

UA = "surf-birthday-route/1.0 (one-time geocoding of coffee shop list; personal project)"
OUT = "/tmp/surf_geo_progress.json"
BBOX = (36.2, 54.8, 38.95, 56.5)

# дополнительные варианты для неудач
EXTRA = {
    "DREAM": ["Москва, Новослободская улица 16", "Москва, Новослободская 16"],
    "TAKEOFF": ["Москва, проспект Аэропорта 8", "Москва, улица Аэропорта 8"],
    "RED VILLAGE": ["Москва, улица Нижняя Красносельская 35", "Москва, Нижняя Красносельская улица 35"],
    "LE FORT": ["Москва, улица Красноказарменная 4А", "Москва, улица Красноказарменная 4", "Москва, Красноказарменная улица 14А"],
    "BONNIE": ["Москва, улица Большая Почтовая 28", "Москва, Большая Почтовая улица 28"],
    "BRAVE": ["Москва, улица Генерала Карбышева 11", "Москва, Карбышева 11"],
    "TAG": ["Москва, улица Верхняя Радищевская 13", "Москва, Верхняя Радищевская улица 13"],
    "SWALLOW": ["Surf Coffee SWALLOW Москва", "Москва, 1-й Криворожский переулок", "Москва, Криворожская набережная 13"],
    "RAIL": ["Москва, улица Кожевническая 1", "Москва, Кожевническая улица 1"],
    "SEVER": ["Москва, Дмитровское шоссе 107", "Москва, Дмитровское шоссе 107А"],
    "SALARIS": ["Торговый центр Саларис Москва", "Москва, Саларис, Киевское шоссе"],
    "TGL": ["Москва, улица Тагильская 4А", "Москва, Тагильская улица 4"],
    "HAPPINESS": ["Москва, улица Дубининская 59", "Москва, Дубининская улица 59"],
    "PIPE": ["Москва, улица Трубная 26", "Москва, Трубная улица 26"],
    "ABOVE": ["Москва, улица Академика Сахарова 7", "Москва, Академика Сахарова 7"],
    "RACE": ["Москва, улица Генерала Маргелова 3", "Москва, Маргелова 3"],
    "METROPOLIS": ["Торговый центр Метрополис Москва", "Москва, Ленинградское шоссе 16А"],
}


def geocode(query, bounded=True):
    params = {
        "format": "jsonv2", "limit": "3", "accept-language": "ru",
        "countrycodes": "ru", "q": query,
        "viewbox": f"{BBOX[0]},{BBOX[1]},{BBOX[2]},{BBOX[3]}",
    }
    if bounded:
        params["bounded"] = "1"
    url = "https://nominatim.openstreetmap.org/search?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            return json.load(r)
    except Exception as e:
        return {"error": str(e)}


def in_bbox(lat, lon):
    return BBOX[1] <= lat <= BBOX[3] and BBOX[0] <= lon <= BBOX[2]


def localized(res):
    bb = [float(x) for x in res.get("boundingbox", [])]
    return len(bb) == 4 and (bb[2] - bb[0]) < 0.05 and (bb[3] - bb[1]) < 0.05


def main():
    rows = json.load(open(OUT))
    for row in rows:
        if row["lat"] is not None:
            continue
        sid, name = row["id"], row["name"]
        variants = EXTRA.get(name, [])
        # авто-вариант: убрать строения/корпуса из исходного запроса
        base = row["query"].rsplit(",", 1)[-1].strip()
        stripped = base
        for sep in ("с", "к", "стр"):
            pass
        import re
        stripped = re.sub(r"\s*(стр|с|к)\d+[А-Яа-я]*", "", base).strip().rstrip(",")
        auto = "Москва, " + stripped if not stripped.lower().startswith(("москва", "вешки", "новоивановское", "мытищ")) else stripped
        if auto not in variants:
            variants.append(auto)
        found = None
        for q in variants:
            for bounded in (True, False):
                results = geocode(q, bounded)
                time.sleep(1.05)
                if isinstance(results, dict):
                    continue
                for res in results[:3]:
                    try:
                        lat, lon = float(res["lat"]), float(res["lon"])
                    except Exception:
                        continue
                    if in_bbox(lat, lon) and localized(res):
                        found = {"lat": lat, "lon": lon, "display": res.get("display_name", "")[:160]}
                        break
                if found:
                    break
            if found:
                break
        if found:
            row.update(found)
            print(f"FIXED {name:14s} {row['lat']}, {row['lon']}  <- {q}", flush=True)
        else:
            print(f"STILL FAIL {name}", flush=True)
    tmp = OUT + ".tmp"
    json.dump(rows, open(tmp, "w"), ensure_ascii=False, indent=1)
    os.replace(tmp, OUT)
    fails = [r for r in rows if r["lat"] is None]
    print(f"\nok={len(rows) - len(fails)}/{len(rows)}, остался провал: {[r['name'] for r in fails]}")


if __name__ == "__main__":
    main()
