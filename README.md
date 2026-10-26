# Bacarooooo

Webapp per amici: mappa di Venezia con solo bacari, bar e caffè (da OpenStreetMap),
scheda di ogni locale e orari programmati dei vaporetti ACTV.

Si installa su iPhone da Safari con **Condividi → Aggiungi alla schermata Home**
(su Android: menu di Chrome → Installa app). Funziona anche offline per quello che hai già aperto.

## Come funziona

- `scripts/build_data.py` scarica i locali da OpenStreetMap (Overpass) e il GTFS ACTV navigazione,
  e li trasforma nei file in `data/` letti dall'app.
- La GitHub Action `.github/workflows/pubblica.yml` lo esegue a ogni modifica e ogni lunedì,
  poi pubblica il sito su GitHub Pages.

## Pubblicarla la prima volta

1. Su GitHub: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. **Actions → Aggiorna dati e pubblica → Run workflow**.
3. Il link è `https://<utente>.github.io/<repo>/`.

## I vostri preferiti

- Mappa di Google My Maps: esportala in KML/KMZ e salvala come `data/preferiti.kml` (o `.kmz`).
  Ogni punto entro 40 m da un locale OSM lo marca come preferito; gli altri vengono aggiunti.
  La descrizione del punto diventa la nota.
- Oppure scrivi a mano in `data/preferiti.json`:

```json
{ "locali": [
  { "nome": "Cantina Do Mori", "nota": "Il più antico", "consigli": "francobolli", "prezzo_ombra": "1,50 €" }
] }
```

## Provarla in locale

```sh
python scripts/build_data.py        # serve la rete verso overpass-api.de e actv.avmspa.it
python -m http.server 8000          # poi apri http://localhost:8000
python -m unittest discover -s tests
```

Dati: © OpenStreetMap contributors (ODbL), orari © ACTV (open data). Mappa base © CARTO.
