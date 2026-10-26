"""Dati finti (ma plausibili) per provare lo script senza rete."""
import io
import zipfile
from datetime import date, timedelta

OSM = {"elements": [
    {"type": "node", "id": 1, "lat": 45.4385, "lon": 12.3358,
     "tags": {"amenity": "bar", "name": "Cantina Do Mori", "opening_hours": "Mo-Sa 08:00-19:30; Su off",
              "addr:street": "Calle dei Do Mori", "addr:housenumber": "429"}},
    {"type": "node", "id": 2, "lat": 45.4380, "lon": 12.3352,
     "tags": {"amenity": "bar", "name": "Bar Esempio"}},
    {"type": "way", "id": 3, "center": {"lat": 45.4352, "lon": 12.3270},
     "tags": {"amenity": "wine_bar", "name": "Vineria Esempio", "outdoor_seating": "yes"}},
    {"type": "node", "id": 4, "lat": 45.4340, "lon": 12.3300, "tags": {"amenity": "cafe", "name": "Caffè Esempio"}},
    {"type": "node", "id": 5, "lat": 45.4340, "lon": 12.3300, "tags": {"amenity": "bar"}},
    {"type": "node", "id": 6, "lat": 45.4390, "lon": 12.3200,
     "tags": {"amenity": "restaurant", "name": "Osteria Esempio"}},
]}


def gtfs_zip(today=None):
    today = today or date.today()
    start = (today - timedelta(days=3)).strftime("%Y%m%d")
    end = (today + timedelta(days=30)).strftime("%Y%m%d")
    holiday = (today + timedelta(days=2)).strftime("%Y%m%d")
    files = {
        "agency.txt": "agency_id,agency_name,agency_url,agency_timezone\nACTV,ACTV,https://actv.it,Europe/Rome\n",
        "routes.txt": "route_id,agency_id,route_short_name,route_long_name,route_type,route_color\n"
                      "R1,ACTV,1,P.le Roma - Lido,4,\nR2,ACTV,2,Tronchetto - Rialto,4,0066CC\nRN,ACTV,N,Notturno,4,\n",
        "stops.txt": "﻿stop_id,stop_name,stop_lat,stop_lon\n"
                     "S1,P.le Roma \"A\",45.4380,12.3190\nS1B,P.le Roma \"B\",45.4382,12.3194\n"
                     "S2,Rialto \"C\",45.4378,12.3367\nS3,S. Marco,45.4330,12.3400\nS4,Lido S.M.E.,45.4180,12.3700\n",
        "calendar.txt": "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n"
                        f"FER,1,1,1,1,1,1,1,{start},{end}\n",
        "calendar_dates.txt": f"service_id,date,exception_type\nFER,{holiday},2\n",
        "trips.txt": "route_id,service_id,trip_id,trip_headsign,direction_id,shape_id\n"
                     "R1,FER,T1,Lido,0,SH1\nR1,FER,T2,P.le Roma,1,\nR2,FER,T3,,0,\nRN,FER,T4,Lido,0,\n",
        "stop_times.txt": "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n"
                          "T1,08:00:00,08:00:00,S1,1\nT1,08:20:00,08:20:00,S2,2\nT1,08:30:00,08:30:00,S3,3\nT1,08:45:00,08:45:00,S4,4\n"
                          "T2,09:00:00,09:00:00,S4,1\nT2,09:15:00,09:15:00,S3,2\nT2,09:25:00,09:25:00,S2,3\nT2,09:45:00,09:45:00,S1B,4\n"
                          "T3,10:00:00,10:00:00,S1,1\nT3,10:25:00,10:25:00,S2,2\n"
                          "T4,23:50:00,23:50:00,S2,1\nT4,24:20:00,24:20:00,S4,2\n",
        "shapes.txt": "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\n"
                      "SH1,45.4380,12.3190,1\nSH1,45.4379,12.3280,2\nSH1,45.4378,12.3367,3\nSH1,45.4330,12.3400,4\nSH1,45.4180,12.3700,5\n",
    }
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for k, v in files.items():
            z.writestr(k, v)
    return buf.getvalue(), holiday


def walk_osm():
    """Griglia 4x4 di calli (circa 100 m di passo) più un pezzetto isolato."""
    els = []
    nid = lambda i, j: 1000 + i * 10 + j
    for i in range(4):
        for j in range(4):
            els.append({"type": "node", "id": nid(i, j), "lat": 45.4370 + i * 0.0009, "lon": 12.3300 + j * 0.0013})
    wid = 1
    for i in range(4):  # calli est-ovest
        els.append({"type": "way", "id": wid, "nodes": [nid(i, j) for j in range(4)],
                    "tags": {"highway": "footway", "name": f"Calle {i}"}})
        wid += 1
    for j in range(4):  # fondamenta nord-sud
        els.append({"type": "way", "id": wid, "nodes": [nid(i, j) for i in range(4)],
                    "tags": {"highway": "pedestrian", "name": f"Fondamenta {j}"}})
        wid += 1
    els.append({"type": "way", "id": 99, "nodes": [nid(0, 0), nid(1, 1)],
                "tags": {"highway": "footway", "foot": "no"}})
    els += [{"type": "node", "id": 5, "lat": 45.5, "lon": 12.4}, {"type": "node", "id": 6, "lat": 45.5001, "lon": 12.4}]
    els.append({"type": "way", "id": 98, "nodes": [5, 6], "tags": {"highway": "footway"}})
    return {"elements": els}
