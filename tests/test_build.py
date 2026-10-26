import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
sys.path.insert(0, os.path.dirname(__file__))
import build_data  # noqa: E402
from fixtures import OSM, gtfs_zip, walk_osm  # noqa: E402


class TestLocali(unittest.TestCase):
    def test_classificazione(self):
        loc = {l["nome"]: l for l in build_data.build_locali(OSM)}
        self.assertEqual(loc["Cantina Do Mori"]["tipo"], "bacaro")
        self.assertEqual(loc["Bar Esempio"]["tipo"], "bar")
        self.assertEqual(loc["Vineria Esempio"]["tipo"], "bacaro")
        self.assertEqual(loc["Caffè Esempio"]["tipo"], "caffe")
        self.assertEqual(loc["Osteria Esempio"]["tipo"], "osteria")
        self.assertEqual(loc["Cantina Do Mori"]["indirizzo"], "Calle dei Do Mori 429")
        self.assertEqual(loc["Vineria Esempio"]["lat"], 45.4352)
        self.assertEqual(len(loc), 5)  # quello senza nome è scartato

    def test_preferiti(self):
        locali = build_data.build_locali(OSM)
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            json.dump({"locali": [
                {"nome": "Bar Esempio", "nota": "ombra a 1,50"},
                {"nome": "Nuovo", "lat": 45.43, "lon": 12.33, "consigli": "polpette"},
                {"nome": "Senza coordinate"},
            ]}, f)
        out = build_data.apply_preferiti(locali, f.name)
        os.unlink(f.name)
        by = {l["nome"]: l for l in out}
        self.assertTrue(by["Bar Esempio"]["preferito"])
        self.assertEqual(by["Bar Esempio"]["nota"], "ombra a 1,50")
        self.assertTrue(by["Nuovo"]["preferito"])
        self.assertNotIn("Senza coordinate", by)


class TestKml(unittest.TestCase):
    def test_kml(self):
        kml = """<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><Folder>
<Placemark><name>Do Mori</name><description><![CDATA[polpette<br>e ombra]]></description>
<Point><coordinates>12.33582,45.43851,0</coordinates></Point></Placemark>
<Placemark><name>Bacaro segreto</name><Point><coordinates>12.3100,45.4300,0</coordinates></Point></Placemark>
</Folder></Document></kml>"""
        with tempfile.NamedTemporaryFile("w", suffix=".kml", delete=False) as f:
            f.write(kml)
        out = build_data.apply_kml(build_data.build_locali(OSM), f.name)
        os.unlink(f.name)
        by = {l["nome"]: l for l in out}
        self.assertTrue(by["Cantina Do Mori"]["preferito"])
        self.assertEqual(by["Cantina Do Mori"]["nota"], "polpette\ne ombra")
        self.assertTrue(by["Bacaro segreto"]["preferito"])
        self.assertEqual(by["Bacaro segreto"]["id"], "manuale/bacaro-segreto")


class TestGrafo(unittest.TestCase):
    def test_grafo(self):
        g, comps = build_data.build_graph(walk_osm(), min_component=5)
        self.assertEqual(len(g["n"]) // 2, 16)         # tutti incroci
        self.assertEqual(len(g["e"]) // 5, 24)         # 4*3 + 4*3 tratti, niente foot=no
        self.assertEqual(comps, [16])                   # il pezzetto isolato è scartato
        self.assertIn("Calle 0", g["w"])
        lens = g["e"][2::5]
        self.assertTrue(all(95 < l < 115 for l in lens), lens)


class TestGtfs(unittest.TestCase):
    def setUp(self):
        raw, self.holiday = gtfs_zip()
        self.index, self.per_stop, self.per_route = build_data.build_gtfs(raw)

    def test_fermate_raggruppate(self):
        nomi = [f["nome"] for f in self.index["fermate"]]
        self.assertIn("P.le Roma", nomi)
        self.assertIn("Rialto", nomi)
        self.assertIn("Lido S.M.E.", nomi)
        self.assertEqual(len(nomi), 4)

    def test_partenze(self):
        g = [f["nome"] for f in self.index["fermate"]].index("Rialto")
        deps = self.per_stop[g]
        times = [d[3] for d in deps]
        self.assertEqual(times, sorted(times))
        self.assertIn(8 * 60 + 20, times)
        self.assertIn(23 * 60 + 50, times)
        self.assertNotIn(10 * 60 + 25, times)  # capolinea di T3: si arriva, non si parte
        # headsign mancante -> ultima fermata
        heads = {self.index["capolinea"][d[1]] for d in deps}
        self.assertIn("Lido", heads)

    def test_calendario(self):
        self.assertEqual(self.index["date"][self.holiday], [])  # giorno coperto ma senza corse
        self.assertTrue(len(self.index["date"]) > 20)

    def test_linee(self):
        l = {x["nome"]: x for x in self.index["linee"]}
        self.assertEqual([x["nome"] for x in self.index["linee"]], ["1", "2", "N"])
        self.assertEqual(l["2"]["colore"], "#0066CC")
        self.assertTrue(l["1"]["tracciato"])
        r1 = self.per_route[0]
        self.assertEqual(len(r1), 2)


if __name__ == "__main__":
    unittest.main()
