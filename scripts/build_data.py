#!/usr/bin/env python3
"""Scarica bacari/bar da OpenStreetMap e orari vaporetti dal GTFS ACTV,
e li converte nei JSON che legge la webapp (cartella data/).

Uso:
    python scripts/build_data.py                    # scarica tutto
    python scripts/build_data.py --osm-file x.json --gtfs-file y.zip   # da file locali
"""
import argparse
import csv
import io
import json
import math
import os
import re
import sys
import urllib.parse
import urllib.request
import zipfile
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")

OVERPASS_URLS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]
GTFS_URL = os.environ.get(
    "ACTV_GTFS_URL",
    "https://actv.avmspa.it/sites/default/files/attachments/opendata/navigazione/actv_nav.zip",
)

# Laguna: centro storico, Giudecca, Lido, Murano, Burano, Torcello. Esclude Mestre.
BBOX = (45.25, 12.295, 45.50, 12.45)  # sud, ovest, nord, est

BACARO_RE = re.compile(r"bacar|cicchet|cichet|cantin|enotec|ombr|osteri|ostaria|vin|bàcaro", re.I)

OVERPASS_QUERY = """
[out:json][timeout:120];
(
  nwr["amenity"~"^(bar|pub|wine_bar|cafe)$"]({s},{w},{n},{e});
  nwr["amenity"="restaurant"]["name"~"bacar|cicchet|cichet|cantin|enotec|ombr|osteri|ostaria",i]({s},{w},{n},{e});
  nwr["shop"="wine"]["drink:wine"="served"]({s},{w},{n},{e});
);
out center tags;
""".format(s=BBOX[0], w=BBOX[1], n=BBOX[2], e=BBOX[3])

UA = "bacari-venezia-webapp/1.0 (+https://github.com)"


def http_get(url, data=None, timeout=180):
    req = urllib.request.Request(url, data=data, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


# ---------------------------------------------------------------- OSM

def fetch_osm():
    body = urllib.parse.urlencode({"data": OVERPASS_QUERY}).encode()
    last = None
    for url in OVERPASS_URLS:
        try:
            print(f"Overpass: {url}", file=sys.stderr)
            return json.loads(http_get(url, body))
        except Exception as ex:  # prova il mirror successivo
            last = ex
            print(f"  fallito: {ex}", file=sys.stderr)
    raise RuntimeError(f"Overpass non raggiungibile: {last}")


def classify(tags):
    amenity = tags.get("amenity", "")
    name = tags.get("name", "")
    if amenity == "wine_bar" or tags.get("shop") == "wine":
        return "bacaro"
    if amenity == "restaurant":
        return "bacaro"
    if "cicchetti" in tags.get("cuisine", "").lower() or "tapas" in tags.get("cuisine", "").lower():
        return "bacaro"
    if amenity in ("bar", "pub") and BACARO_RE.search(name):
        return "bacaro"
    if amenity == "cafe":
        return "caffe"
    return "bar"


def address(tags):
    street = tags.get("addr:street") or tags.get("addr:place") or ""
    num = tags.get("addr:housenumber", "")
    parts = [p for p in (street, num) if p]
    addr = " ".join(parts)
    sest = tags.get("addr:suburb") or tags.get("addr:quarter") or ""
    if sest and sest not in addr:
        addr = f"{addr}, {sest}" if addr else sest
    return addr


KEEP = {
    "opening_hours": "orari",
    "phone": "tel",
    "contact:phone": "tel",
    "website": "web",
    "contact:website": "web",
    "contact:instagram": "instagram",
    "outdoor_seating": "fuori",
    "wheelchair": "sedia_rotelle",
    "cuisine": "cucina",
    "description": "descrizione",
    "payment:cards": "carte",
    "payment:credit_cards": "carte",
    "check_date": "verificato",
}


def build_locali(osm):
    out = []
    seen = set()
    for el in osm.get("elements", []):
        tags = el.get("tags", {})
        name = tags.get("name")
        if not name:
            continue
        lat = el.get("lat") or el.get("center", {}).get("lat")
        lon = el.get("lon") or el.get("center", {}).get("lon")
        if lat is None or lon is None:
            continue
        key = (name.lower(), round(lat, 4), round(lon, 4))
        if key in seen:
            continue
        seen.add(key)
        loc = {
            "id": f"{el['type']}/{el['id']}",
            "nome": name,
            "lat": round(lat, 6),
            "lon": round(lon, 6),
            "tipo": classify(tags),
        }
        a = address(tags)
        if a:
            loc["indirizzo"] = a
        for k, field in KEEP.items():
            if tags.get(k) and field not in loc:
                loc[field] = tags[k]
        out.append(loc)
    return out


def read_kml(path):
    """Placemark di una mappa Google My Maps esportata in KML -> voci preferite."""
    import xml.etree.ElementTree as ET
    ns = {"k": "http://www.opengis.net/kml/2.2"}
    out = []
    if path.endswith(".kmz"):
        with zipfile.ZipFile(path) as z:
            name = next(n for n in z.namelist() if n.endswith(".kml"))
            root = ET.fromstring(z.read(name))
    else:
        root = ET.parse(path).getroot()
    for pm in root.iter("{http://www.opengis.net/kml/2.2}Placemark"):
        name = (pm.findtext("k:name", default="", namespaces=ns) or "").strip()
        coords = pm.findtext(".//k:Point/k:coordinates", default="", namespaces=ns).strip()
        if not name or not coords:
            continue
        lon, lat = (float(x) for x in coords.split(",")[:2])
        desc = pm.findtext("k:description", default="", namespaces=ns) or ""
        desc = re.sub(r"<br\s*/?>", "\n", desc)
        desc = re.sub(r"<[^>]+>", "", desc).strip()
        item = {"nome": name, "lat": round(lat, 6), "lon": round(lon, 6)}
        if desc:
            item["nota"] = desc
        out.append(item)
    return out


def _dist(a, b):
    dy = (a["lat"] - b["lat"]) * 111320
    dx = (a["lon"] - b["lon"]) * 111320 * math.cos(math.radians(a["lat"]))
    return math.hypot(dx, dy)


def apply_kml(locali, path):
    """Unisce la mappa KML: se c'è un locale OSM entro 40 m lo marca preferito, altrimenti lo aggiunge."""
    if not os.path.exists(path):
        return locali
    for p in read_kml(path):
        near = min(locali, key=lambda l: _dist(l, p), default=None)
        if near is not None and _dist(near, p) < 40:
            near["preferito"] = True
            if p.get("nota"):
                near.setdefault("nota", p["nota"])
        else:
            locali.append({"id": "manuale/" + re.sub(r"\W+", "-", p["nome"].lower()).strip("-"),
                           "tipo": "bacaro", "preferito": True, **p})
    return locali


def apply_preferiti(locali, path):
    """Unisce data/preferiti.json: note degli amici e locali aggiunti a mano."""
    if not os.path.exists(path):
        return locali
    with open(path, encoding="utf-8") as f:
        pref = json.load(f).get("locali", [])
    by_id = {l["id"]: l for l in locali}
    by_name = defaultdict(list)
    for l in locali:
        by_name[l["nome"].lower()].append(l)
    for p in pref:
        target = None
        if p.get("osm") and p["osm"] in by_id:
            target = by_id[p["osm"]]
        elif p.get("nome") and by_name.get(p["nome"].lower()):
            target = by_name[p["nome"].lower()][0]
        if target is None:
            if "lat" not in p or "lon" not in p:
                print(f"  preferito non trovato in OSM e senza coordinate: {p.get('nome')}", file=sys.stderr)
                continue
            target = {"id": p.get("osm") or "manuale/" + re.sub(r"\W+", "-", p["nome"].lower()),
                      "nome": p["nome"], "lat": p["lat"], "lon": p["lon"], "tipo": "bacaro"}
            locali.append(target)
            by_id[target["id"]] = target
        target["preferito"] = True
        for k, v in p.items():
            if k not in ("osm",):
                target[k] = v
    return locali


# ---------------------------------------------------------------- GTFS

def read_csv(z, name):
    try:
        raw = z.read(name)
    except KeyError:
        return []
    text = raw.decode("utf-8-sig", errors="replace")
    return [{k.strip(): (v or "").strip() for k, v in row.items() if k}
            for row in csv.DictReader(io.StringIO(text))]


def to_min(t):
    h, m, *_ = t.split(":")
    return int(h) * 60 + int(m)


PLATFORM_RE = re.compile(r'\s*["“”\'][A-Z0-9]{1,2}["“”\']\s*$')


def stop_group_name(name):
    return PLATFORM_RE.sub("", name).strip()


def simplify(points, tol=0.00005):
    """Douglas-Peucker sulle coordinate (gradi)."""
    if len(points) < 3:
        return points
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        a, b = stack.pop()
        ax, ay = points[a]
        bx, by = points[b]
        dx, dy = bx - ax, by - ay
        norm = math.hypot(dx, dy) or 1e-12
        best, idx = 0, None
        for i in range(a + 1, b):
            px, py = points[i]
            d = abs(dy * px - dx * py + bx * ay - by * ax) / norm
            if d > best:
                best, idx = d, i
        if idx is not None and best > tol:
            keep[idx] = True
            stack.append((a, idx))
            stack.append((idx, b))
    return [p for p, k in zip(points, keep) if k]


def build_gtfs(zip_bytes, horizon_days=120):
    z = zipfile.ZipFile(io.BytesIO(zip_bytes))
    routes = read_csv(z, "routes.txt")
    stops = read_csv(z, "stops.txt")
    trips = read_csv(z, "trips.txt")
    stop_times = read_csv(z, "stop_times.txt")
    calendar = read_csv(z, "calendar.txt")
    calendar_dates = read_csv(z, "calendar_dates.txt")
    shapes = read_csv(z, "shapes.txt")
    feed_info = (read_csv(z, "feed_info.txt") or [{}])[0]

    # --- fermate raggruppate (Rialto "A", Rialto "B"... -> Rialto)
    stop_by_id = {s["stop_id"]: s for s in stops}
    groups = {}
    stop_group = {}
    for s in stops:
        if s.get("location_type") in ("1", "2", "3", "4"):
            continue
        parent = s.get("parent_station")
        if parent and parent in stop_by_id:
            gname = stop_group_name(stop_by_id[parent]["stop_name"])
        else:
            gname = stop_group_name(s["stop_name"])
        g = groups.setdefault(gname, {"nome": gname, "pts": []})
        g["pts"].append((float(s["stop_lat"]), float(s["stop_lon"])))
        stop_group[s["stop_id"]] = gname
    gnames = sorted(groups)
    gidx = {n: i for i, n in enumerate(gnames)}

    # --- linee
    routes.sort(key=lambda r: (re.sub(r"\D.*", "", r.get("route_short_name", "")).zfill(3)
                               if r.get("route_short_name", "")[:1].isdigit() else "zzz",
                               r.get("route_short_name", "")))
    ridx = {r["route_id"]: i for i, r in enumerate(routes)}

    # --- servizi -> date
    today = datetime.now(timezone(timedelta(hours=1))).date() - timedelta(days=1)
    end = today + timedelta(days=horizon_days)
    active = defaultdict(set)  # yyyymmdd -> set(service_id)
    for c in calendar:
        start = datetime.strptime(c["start_date"], "%Y%m%d").date()
        stop = datetime.strptime(c["end_date"], "%Y%m%d").date()
        days = [c.get(d) == "1" for d in
                ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")]
        d = max(start, today)
        while d <= min(stop, end):
            if days[d.weekday()]:
                active[d.strftime("%Y%m%d")].add(c["service_id"])
            d += timedelta(days=1)
    for cd in calendar_dates:
        ds = cd["date"]
        dd = datetime.strptime(ds, "%Y%m%d").date()
        if dd < today or dd > end:
            continue
        if cd["exception_type"] == "1":
            active[ds].add(cd["service_id"])
        elif cd["exception_type"] == "2":
            active[ds].discard(cd["service_id"])
    used_services = sorted({s for v in active.values() for s in v})
    sidx = {s: i for i, s in enumerate(used_services)}

    # --- corse
    trip_info = {}
    headsigns = []
    hidx = {}
    for t in trips:
        if t["service_id"] not in sidx or t["route_id"] not in ridx:
            continue
        hs = stop_group_name(t.get("trip_headsign") or "")
        if hs not in hidx:
            hidx[hs] = len(headsigns)
            headsigns.append(hs)
        trip_info[t["trip_id"]] = {
            "r": ridx[t["route_id"]], "s": sidx[t["service_id"]], "h": hidx[hs],
            "shape": t.get("shape_id", ""), "dir": t.get("direction_id", "0"),
        }

    seq = defaultdict(list)
    for st in stop_times:
        tid = st["trip_id"]
        if tid not in trip_info or st["stop_id"] not in stop_group:
            continue
        tm = st.get("departure_time") or st.get("arrival_time")
        if not tm:
            continue
        seq[tid].append((int(st["stop_sequence"]), gidx[stop_group[st["stop_id"]]], to_min(tm)))

    per_stop = defaultdict(list)    # gidx -> [[r,h,s,min,tripIdx,pos]]
    per_route = defaultdict(list)   # r -> [[s,h,[[g,min],...]]]
    route_stops = defaultdict(set)
    longest = {}                    # (r,dir) -> (len, trip_id)
    for tid, rows in seq.items():
        rows.sort()
        ti = trip_info[tid]
        # headsign mancante: usa l'ultima fermata
        h = ti["h"]
        if headsigns[h] == "":
            last = gnames[rows[-1][1]]
            if last not in hidx:
                hidx[last] = len(headsigns)
                headsigns.append(last)
            h = hidx[last]
        trip_list = per_route[ti["r"]]
        tpos = len(trip_list)
        trip_list.append([ti["s"], h, [[g, m] for _, g, m in rows]])
        for pos, (_, g, m) in enumerate(rows[:-1]):  # all'ultima fermata non si parte
            per_stop[g].append([ti["r"], h, ti["s"], m, tpos, pos])
        for _, g, _ in rows:
            route_stops[ti["r"]].add(g)
        k = (ti["r"], ti["dir"])
        if k not in longest or len(rows) > longest[k][0]:
            longest[k] = (len(rows), tid)

    # --- tracciati delle linee
    shape_pts = defaultdict(list)
    for p in shapes:
        shape_pts[p["shape_id"]].append((int(p["shape_pt_sequence"]),
                                         float(p["shape_pt_lat"]), float(p["shape_pt_lon"])))
    route_lines = defaultdict(list)
    for (r, _d), (_n, tid) in longest.items():
        sid = trip_info[tid]["shape"]
        if sid and shape_pts.get(sid):
            pts = [(la, lo) for _, la, lo in sorted(shape_pts[sid])]
        else:
            pts = [_centroid(groups[gnames[g]]["pts"]) for _, g, _ in sorted(seq[tid])]
        pts = simplify(pts)
        route_lines[r].append([[round(a, 5), round(b, 5)] for a, b in pts])

    out_routes = []
    for i, r in enumerate(routes):
        color = r.get("route_color") or ""
        text = r.get("route_text_color") or ""
        out_routes.append({
            "id": r["route_id"],
            "nome": r.get("route_short_name") or r.get("route_long_name") or r["route_id"],
            "descr": " - ".join(stop_group_name(x) for x in r.get("route_long_name", "").split(" - ")),
            "colore": "#" + color if re.fullmatch(r"[0-9A-Fa-f]{6}", color) else None,
            "testo": "#" + text if re.fullmatch(r"[0-9A-Fa-f]{6}", text) else None,
            "tracciato": route_lines.get(i, []),
            "corse": len(per_route.get(i, [])),
        })

    out_stops = []
    for i, n in enumerate(gnames):
        la, lo = _centroid(groups[n]["pts"])
        out_stops.append({
            "nome": n, "lat": round(la, 6), "lon": round(lo, 6),
            "linee": sorted(r for r in route_stops if i in route_stops[r]),
        })

    index = {
        "generato": datetime.now(timezone.utc).isoformat(timespec="minutes"),
        "feed": {k: feed_info.get(k) for k in ("feed_publisher_name", "feed_start_date",
                                                "feed_end_date", "feed_version") if feed_info.get(k)},
        "linee": out_routes,
        "fermate": out_stops,
        "capolinea": headsigns,
        "date": {d: sorted(sidx[s] for s in v) for d, v in sorted(active.items())},
    }
    for v in per_stop.values():
        v.sort(key=lambda x: x[3])
    return index, per_stop, per_route


def _centroid(pts):
    return (sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts))


# ---------------------------------------------------------------- main

def write_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--osm-file")
    ap.add_argument("--gtfs-file")
    ap.add_argument("--out", default=DATA)
    ap.add_argument("--skip-osm", action="store_true")
    ap.add_argument("--skip-gtfs", action="store_true")
    args = ap.parse_args()

    if not args.skip_osm:
        if args.osm_file:
            with open(args.osm_file, encoding="utf-8") as f:
                osm = json.load(f)
        else:
            osm = fetch_osm()
        locali = build_locali(osm)
        for ext in ("kml", "kmz"):
            locali = apply_kml(locali, os.path.join(ROOT, "data", "preferiti." + ext))
        locali = apply_preferiti(locali, os.path.join(ROOT, "data", "preferiti.json"))
        locali.sort(key=lambda l: l["nome"].lower())
        write_json(os.path.join(args.out, "locali.json"), {
            "generato": datetime.now(timezone.utc).isoformat(timespec="minutes"),
            "fonte": "© OpenStreetMap contributors (ODbL)",
            "locali": locali,
        })
        counts = defaultdict(int)
        for l in locali:
            counts[l["tipo"]] += 1
        print(f"Locali: {len(locali)} {dict(counts)}", file=sys.stderr)

    if not args.skip_gtfs:
        if args.gtfs_file:
            with open(args.gtfs_file, "rb") as f:
                raw = f.read()
        else:
            print(f"GTFS: {GTFS_URL}", file=sys.stderr)
            raw = http_get(GTFS_URL)
        index, per_stop, per_route = build_gtfs(raw)
        base = os.path.join(args.out, "actv")
        write_json(os.path.join(base, "index.json"), index)
        for g, deps in per_stop.items():
            write_json(os.path.join(base, "fermate", f"{g}.json"), deps)
        for r, tr in per_route.items():
            write_json(os.path.join(base, "corse", f"{r}.json"), tr)
        print(f"ACTV: {len(index['linee'])} linee, {len(index['fermate'])} fermate, "
              f"{sum(len(v) for v in per_route.values())} corse, {len(index['date'])} giorni",
              file=sys.stderr)


if __name__ == "__main__":
    main()
