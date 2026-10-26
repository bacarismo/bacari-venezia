(function () {
  "use strict";

  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const TIPI = { bacaro: "Bacaro", bar: "Bar", caffe: "Caffè" };
  const GIORNI = ["dom", "lun", "mar", "mer", "gio", "ven", "sab"];

  const state = {
    locali: [],
    actv: null,
    filtri: { bacaro: true, bar: true, caffe: false, fermate: true, aperti: false },
    me: null,
    stack: [],
    cache: new Map(),
  };
  try {
    const f = JSON.parse(localStorage.getItem("filtri") || "null");
    if (f) Object.assign(state.filtri, f);
  } catch (e) { /* storage non disponibile */ }

  // ------------------------------------------------------------ mappa
  const map = L.map("map", { zoomControl: false, preferCanvas: true, minZoom: 11, maxZoom: 19 })
    .setView([45.4372, 12.3346], 15);
  // Sfondo vettoriale OpenFreeMap (gratis, senza chiave): nitido a ogni zoom.
  // Dallo stile si tolgono numeri civici e punti di interesse, così restano solo i nostri locali.
  // Se il telefono non ha WebGL o lo stile non si carica, si torna alle immagini OSM (ferme allo zoom 16).
  const ATTR = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · <a href="https://openfreemap.org">OpenFreeMap</a> · Orari ACTV';
  const darkMq = matchMedia("(prefers-color-scheme: dark)");
  let base = null;
  function rasterBase() {
    return L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19, maxNativeZoom: 16, className: "osm-raster",
      attribution: ATTR.replace(" · <a href=\"https://openfreemap.org\">OpenFreeMap</a>", ""),
    });
  }
  async function setBase() {
    let layer;
    try {
      const c = document.createElement("canvas");
      if (!L.maplibreGL || !window.maplibregl || !(c.getContext("webgl2") || c.getContext("webgl"))) throw new Error("niente WebGL");
      const url = `https://tiles.openfreemap.org/styles/${darkMq.matches ? "dark" : "positron"}`;
      const style = await (await fetch(url)).json();
      style.layers = style.layers.filter((l) => !/housenumber|poi/i.test(l.id));
      layer = L.maplibreGL({ style, attribution: ATTR });
    } catch (e) {
      layer = rasterBase();
    }
    if (base) map.removeLayer(base);
    base = layer.addTo(map);
  }
  setBase();
  darkMq.addEventListener?.("change", () => { setBase(); drawLocali(); });

  const layerLocali = L.layerGroup().addTo(map);
  const layerFermate = L.layerGroup().addTo(map);
  const layerLinea = L.layerGroup().addTo(map);
  let meMarker = null;
  let nav = null; // navigazione "in cammino" attiva
  let sceltaSuMappa = false; // si sta scegliendo la partenza toccando la mappa
  L.Path.mergeOptions({ bubblingMouseEvents: false }); // il tocco su un pallino non arriva alla mappa
  let selMarker = null;

  // ------------------------------------------------------------ utilità
  function dist(a, b) {
    const R = 6371000, toR = Math.PI / 180;
    const dLat = (b.lat - a.lat) * toR, dLon = (b.lon - a.lon) * toR;
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  }
  // a Venezia si cammina a zig-zag: +35% sulla linea d'aria, 75 m/min
  const piedi = (m) => Math.max(1, Math.round((m * 1.35) / 75));
  const distPiedi = (m) => (m > 1500 ? fmtDist(m) : piedi(m) + " min");
  const fmtDist = (m) => (m < 1000 ? Math.round(m / 10) * 10 + " m" : (m / 1000).toFixed(1).replace(".", ",") + " km");
  const hhmm = (m) => String(Math.floor(m / 60) % 24).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
  const ymd = (d) => d.getFullYear() + String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0");
  const nowMin = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };
  const center = () => state.me || { lat: map.getCenter().lat, lon: map.getCenter().lng };

  async function getJSON(url) {
    if (state.cache.has(url)) return state.cache.get(url);
    const p = fetch(url).then((r) => { if (!r.ok) throw new Error(r.status + " " + url); return r.json(); });
    state.cache.set(url, p);
    p.catch(() => state.cache.delete(url));
    return p;
  }

  function toast(msg) {
    const t = document.createElement("div");
    t.className = "toast";
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2600);
  }

  function lineaBadge(r) {
    const l = state.actv.linee[r];
    const style = l.colore ? ` style="background:${l.colore};color:${l.testo || contrast(l.colore)}${/^#f{6}$/i.test(l.colore) ? ";box-shadow:inset 0 0 0 1.5px #1d2422" : ""}"` : "";
    return `<span class="linea"${style}>${esc(l.nome)}</span>`;
  }
  function contrast(hex) {
    const n = parseInt(hex.slice(1), 16);
    const y = ((n >> 16) * 299 + ((n >> 8) & 255) * 587 + (n & 255) * 114) / 1000;
    return y > 150 ? "#1d2422" : "#fff";
  }

  const ICON_BOAT = '<svg viewBox="0 0 24 24"><path d="M4 15h16l-2.5 4h-11zM7 14V9h10v5zM9 8V5h6v3z"/></svg>';
  const ICON_GLASS = '<svg viewBox="0 0 24 24"><path d="M7 3h10l-1 6a4 4 0 0 1-3 3.9V19h3v2H8v-2h3v-6.1A4 4 0 0 1 8 9z"/></svg>';
  const ICON_CUP = '<svg viewBox="0 0 24 24"><path d="M4 8h13v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5zM17 9h1.5a2.5 2.5 0 0 1 0 5H17zM3 20h15v1.5H3z"/></svg>';
  const tipoIcon = (t) => `<span class="ico ${t}">${t === "caffe" ? ICON_CUP : ICON_GLASS}</span>`;

  // ------------------------------------------------------------ marker
  function visibile(l) {
    if (!state.filtri[l.tipo] && !l.preferito) return false;
    if (state.filtri.aperti) {
      const st = Orari.status(l.orari);
      if (!st || !st.aperto) return false;
    }
    return true;
  }

  function drawLocali() {
    layerLocali.clearLayers();
    const col = { bacaro: css("--ombra"), bar: css("--bar"), caffe: css("--caffe") };
    const ring = css("--surface");
    for (const l of state.locali) {
      if (!visibile(l)) continue;
      let mk;
      if (l.preferito) {
        mk = L.marker([l.lat, l.lon], {
          icon: L.divIcon({ className: "", html: '<span class="star-ic">★</span>', iconSize: [26, 26] }),
          zIndexOffset: 500,
        });
      } else {
        mk = L.circleMarker([l.lat, l.lon], {
          radius: l.tipo === "bacaro" ? 7 : l.tipo === "bar" ? 5.5 : 4.5,
          color: ring, weight: 1.5, fillColor: col[l.tipo], fillOpacity: 1,
        });
      }
      mk.bindTooltip(l.nome, { direction: "top", offset: [0, -6] });
      mk.on("click", () => openLocale(l));
      mk.addTo(layerLocali);
    }
  }

  // Casa: unica, sempre visibile, fuori dai filtri
  const casa = window.CONFIG && CONFIG.casa;
  const ICON_CASA = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 11.5 12 4l9 7.5M5.5 9.5V20h13V9.5M10 20v-5h4v5"/></svg>';
  if (casa) {
    L.marker([casa.lat, casa.lon], { icon: L.divIcon({ className: "", html: `<span class="casa-ic">${ICON_CASA}</span>`, iconSize: [26, 26] }), zIndexOffset: 900 })
      .bindTooltip(casa.nome, { direction: "top", offset: [0, -11] })
      .on("click", () => openPercorso(casa))
      .addTo(map);
    const btn = $("#casa");
    btn.hidden = false;
    btn.addEventListener("click", (e) => { e.stopPropagation(); $("#q").value = ""; openPercorso(casa); });
    // nella barra in alto: non è un filtro, porta la mappa su casa
    const chip = $("#chipcasa");
    chip.hidden = false;
    chip.addEventListener("click", () => focus(casa.lat, casa.lon));
  }

  function drawFermate() {
    layerFermate.clearLayers();
    if (!state.actv || !state.filtri.fermate || map.getZoom() < 13) return;
    const icon = L.divIcon({ className: "", html: '<span class="stop-ic"></span>', iconSize: [14, 14] });
    state.actv.fermate.forEach((f, i) => {
      L.marker([f.lat, f.lon], { icon, zIndexOffset: 200 })
        .bindTooltip(f.nome, { direction: "top", offset: [0, -8] })
        .on("click", () => openFermata(i))
        .addTo(layerFermate);
    });
  }
  map.on("zoomend", drawFermate);

  function select(lat, lon) {
    if (selMarker) map.removeLayer(selMarker);
    selMarker = L.circleMarker([lat, lon], { radius: 16, color: css("--ink"), weight: 3, fill: false, interactive: false }).addTo(map);
  }
  function clearSelect() { if (selMarker) map.removeLayer(selMarker); selMarker = null; }

  function focus(lat, lon) {
    const h = sheetHeight();
    const p = map.project([lat, lon], Math.max(map.getZoom(), 16));
    const off = window.innerWidth >= 900 ? 0 : h / 2 - 40;
    map.setView(map.unproject(p.add([0, off]), Math.max(map.getZoom(), 16)), Math.max(map.getZoom(), 16));
  }

  // ------------------------------------------------------------ foglio
  const sheet = $("#sheet");
  const tabsEl = () => $("#tabs");
  const body = $("#body");
  const SIZES = { peek: () => 160, half: () => Math.round(innerHeight * 0.5), full: () => innerHeight - 120 };
  function sheetHeight() { return SIZES[sheet.dataset.state](); }
  function setSheet(s) {
    sheet.dataset.state = s;
    document.body.dataset.sheet = s;
    document.documentElement.style.setProperty("--sheet-h", sheetHeight() + "px");
  }
  setSheet("peek");
  addEventListener("resize", () => setSheet(sheet.dataset.state));

  // la tendina si trascina dalla maniglia e dalla barra delle schede; un tocco sulla maniglia la cambia di altezza
  (function drag() {
    const h = $("#handle");
    let y0 = null, hh0 = 0, t0 = 0, moved = false, presa = null;
    sheet.addEventListener("pointerdown", (e) => {
      presa = !e.target.closest("#casa") && e.target.closest("#handle, #tabs");
      if (!presa || e.button > 0) return;
      y0 = e.clientY; hh0 = sheet.offsetHeight; t0 = e.timeStamp; moved = false;
    });
    sheet.addEventListener("pointermove", (e) => {
      if (y0 == null) return;
      const dy = y0 - e.clientY;
      if (!moved && Math.abs(dy) < 6) return;
      if (!moved) { moved = true; sheet.style.transition = "none"; presa.setPointerCapture(e.pointerId); }
      const nh = Math.min(SIZES.full(), Math.max(90, hh0 + dy));
      document.documentElement.style.setProperty("--sheet-h", nh + "px");
    });
    const fine = (e) => {
      if (y0 == null) return;
      sheet.style.transition = "";
      const dy = y0 - e.clientY, dt = e.timeStamp - t0;
      y0 = null;
      if (!moved) {
        if (presa === h) setSheet({ peek: "half", half: "full", full: "peek" }[sheet.dataset.state]);
        return;
      }
      const order = ["peek", "half", "full"];
      const i = order.indexOf(sheet.dataset.state);
      // colpo veloce: passa all'altezza successiva nella direzione del gesto
      if (dt < 250 && Math.abs(dy) > 30) return setSheet(order[Math.max(0, Math.min(2, i + (dy > 0 ? 1 : -1)))]);
      const cur = sheet.offsetHeight;
      setSheet(order.slice().sort((a, b) => Math.abs(SIZES[a]() - cur) - Math.abs(SIZES[b]() - cur))[0]);
    };
    sheet.addEventListener("pointerup", fine);
    sheet.addEventListener("pointercancel", fine);
    // dopo un trascinamento sulle schede non parte il click
    tabsEl().addEventListener("click", (e) => { if (moved) { e.stopPropagation(); moved = false; } }, true);
  })();

  function grow(min) {
    const order = ["peek", "half", "full"];
    if (order.indexOf(sheet.dataset.state) < order.indexOf(min)) setSheet(min);
  }

  function show(view, push = true) {
    if (nav) nav.stop();
    if (push) state.stack.push(view);
    else state.stack = [view];
    body.innerHTML = "";
    body.scrollTop = 0;
    if (view.sel) select(view.sel[0], view.sel[1]);
    view.render(body);
    if (view.hash !== undefined) {
      try { history.replaceState(null, "", view.hash ? "#" + view.hash : location.pathname + location.search); } catch (e) { /* ignora */ }
    }
  }
  function back() {
    state.stack.pop();
    const v = state.stack.pop();
    clearSelect();
    layerLinea.clearLayers();
    if (v) show(v);
    else showTab(currentTab);
  }
  function backButton() {
    return state.stack.length > 1 ? '<button class="back" data-back>‹ Indietro</button>' : "";
  }
  body.addEventListener("click", (e) => {
    if (e.target.closest("[data-back]")) back();
  });

  // ------------------------------------------------------------ tab
  let currentTab = "vicini";
  const tabs = tabsEl();
  tabs.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-tab]");
    if (!b) return;
    showTab(b.dataset.tab);
    grow("half");
  });
  function showTab(t) {
    currentTab = t;
    for (const b of tabs.children) b.setAttribute("aria-selected", String(b.dataset.tab === t));
    clearSelect();
    layerLinea.clearLayers();
    const v = { vicini: viewVicini, linee: viewLinee, preferiti: viewPreferiti }[t]();
    show(v, false);
  }

  function rowLocale(l, ref) {
    const st = Orari.status(l.orari);
    const sub = [TIPI[l.tipo], st ? (st.aperto ? "aperto" : "chiuso") : "", l.indirizzo].filter(Boolean).join(" · ");
    return `<button class="row" data-loc="${esc(l.id)}">${tipoIcon(l.tipo)}<div><div class="t">${l.preferito ? "★ " : ""}${esc(l.nome)}</div><div class="s">${esc(sub)}</div></div><div class="m">${ref ? distPiedi(dist(ref, l)) : ""}</div></button>`;
  }
  function rowFermata(i, ref) {
    const f = state.actv.fermate[i];
    const linee = f.linee.slice(0, 6).map((r) => state.actv.linee[r].nome).join(" · ");
    return `<button class="row" data-stop="${i}"><span class="ico fermata">${ICON_BOAT}</span><div><div class="t">${esc(f.nome)}</div><div class="s">${esc(linee)}</div></div><div class="m">${ref ? piedi(dist(ref, f)) + " min" : ""}</div></button>`;
  }
  body.addEventListener("click", (e) => {
    const l = e.target.closest("[data-loc]");
    if (l) return openLocale(state.locali.find((x) => x.id === l.dataset.loc));
    const s = e.target.closest("[data-stop]");
    if (s) return openFermata(+s.dataset.stop);
    const r = e.target.closest("[data-line]");
    if (r) return openLinea(+r.dataset.line);
  });

  function vicine(ref, n) {
    if (!state.actv) return [];
    return state.actv.fermate.map((f, i) => [dist(ref, f), i]).sort((a, b) => a[0] - b[0]).slice(0, n).map((x) => x[1]);
  }

  const RAGGIO = 300;
  function viewVicini() {
    return {
      hash: "",
      vicini: true,
      render(el) {
        const ref = center();
        // entro 300 m, prima gli aperti, poi i più vicini
        const aperto = (l) => { const st = Orari.status(l.orari); return st ? (st.aperto ? 0 : 2) : 1; };
        const list = state.locali.filter(visibile).map((l) => [dist(ref, l), l]).filter(([d]) => d <= RAGGIO)
          .sort((a, b) => aperto(a[1]) - aperto(b[1]) || a[0] - b[0]);
        let h = `<div class="section-t">${state.me ? "Vicino a te" : "In questa zona"} · entro ${RAGGIO} m</div>`;
        h += list.length ? `<div class="list">${list.map(([, l]) => rowLocale(l, ref)).join("")}</div>` : `<p class="empty">Nessun locale entro ${RAGGIO} m con questi filtri. Sposta la mappa o attiva altre categorie in alto.</p>`;
        if (state.actv && state.filtri.fermate) {
          h += `<div class="section-t">Vaporetti vicini</div><div class="list">${vicine(ref, 3).map((i) => rowFermata(i, ref)).join("")}</div>`;
        }
        h += foot();
        el.innerHTML = h;
      },
    };
  }
  // tocco su un punto vuoto della mappa: si torna come all'avvio
  map.on("click", () => {
    if (sceltaSuMappa || nav) return;
    q.value = "";
    q.blur();
    showTab("vicini");
    setSheet("peek");
  });

  let moveTimer;
  map.on("moveend", () => {
    clearTimeout(moveTimer);
    moveTimer = setTimeout(() => {
      const v = state.stack[state.stack.length - 1];
      if (v && v.vicini && state.stack.length === 1) show(v, false);
    }, 250);
  });

  function viewLinee() {
    return {
      hash: "",
      render(el) {
        if (!state.actv) { el.innerHTML = `<p class="empty">Orari dei vaporetti non ancora disponibili.</p>`; return; }
        el.innerHTML = `<div class="list">${state.actv.linee.map((l, i) => l.corse ? `<button class="row" data-line="${i}">${lineaBadge(i)}<div><div class="t">${esc(l.descr || "Linea " + l.nome)}</div><div class="s">${l.corse} corse in archivio</div></div><div class="m">›</div></button>` : "").join("")}</div>${foot()}`;
      },
    };
  }

  function viewPreferiti() {
    return {
      hash: "",
      render(el) {
        const pref = state.locali.filter((l) => l.preferito);
        const ref = center();
        el.innerHTML = pref.length
          ? `<div class="list">${pref.map((l) => rowLocale(l, ref)).join("")}</div>`
          : `<p class="empty">Ancora nessun preferito. Si aggiungono nel file <code>data/preferiti.json</code> del progetto, con le vostre note.</p>`;
      },
    };
  }

  function foot() {
    const parts = [];
    if (state.locali.length) parts.push(`${state.locali.length} locali da OpenStreetMap`);
    if (state.actv) {
      const g = state.actv.generato ? new Date(state.actv.generato) : null;
      parts.push(`orari ACTV programmati${g ? ", aggiornati il " + g.toLocaleDateString("it-IT") : ""}`);
    }
    return `<p class="foot">${parts.join(" · ")}. Gli orari possono cambiare per scioperi, acqua alta o lavori: in caso di dubbio controlla al pontile.</p>`;
  }

  // ------------------------------------------------------------ scheda locale
  function openLocale(l) {
    if (!l) return;
    layerLinea.clearLayers();
    select(l.lat, l.lon);
    grow("half");
    focus(l.lat, l.lon);
    show({
      hash: "l=" + encodeURIComponent(l.id),
      sel: [l.lat, l.lon],
      render(el) {
        const st = Orari.status(l.orari);
        let stato = "";
        if (st) stato = st.aperto ? `<span class="tag open">Aperto${st.fino ? " fino alle " + st.fino : ""}</span>` : `<span class="tag closed">Chiuso${st.apre ? ", apre " + st.apre : ""}</span>`;
        const facts = [];
        if (l.indirizzo) facts.push(["Indirizzo", esc(l.indirizzo)]);
        if (l.orari) facts.push(["Orari", `<span class="hours">${esc(Orari.pretty(l.orari))}</span>`]);
        if (l.tel) facts.push(["Telefono", `<a href="tel:${esc(l.tel.replace(/[^\d+]/g, ""))}">${esc(l.tel)}</a>`]);
        if (l.web) facts.push(["Sito", `<a href="${esc(/^https?:/.test(l.web) ? l.web : "https://" + l.web)}" target="_blank" rel="noopener">${esc(l.web.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, ""))}</a>`]);
        if (l.instagram) facts.push(["Instagram", `<a href="${esc(/^https?:/.test(l.instagram) ? l.instagram : "https://instagram.com/" + l.instagram.replace("@", ""))}" target="_blank" rel="noopener">${esc(l.instagram.replace(/^https?:\/\/(www\.)?instagram\.com\//, "@").replace(/\/$/, ""))}</a>`]);
        if (l.prezzo_ombra) facts.push(["Ombra", esc(l.prezzo_ombra)]);
        if (l.fuori) facts.push(["Tavoli fuori", l.fuori === "yes" ? "sì" : l.fuori === "no" ? "no" : esc(l.fuori)]);
        if (l.carte) facts.push(["Carte", l.carte === "yes" ? "accettate" : l.carte === "no" ? "solo contanti" : esc(l.carte)]);
        if (l.cucina) facts.push(["Cucina", esc(l.cucina.replace(/;/g, ", ").replace(/_/g, " "))]);

        const notes = [];
        if (l.nota) notes.push(`<div class="note"><b>La nostra nota</b>${esc(l.nota)}</div>`);
        if (l.consigli) notes.push(`<div class="note"><b>Da prendere</b>${esc(l.consigli)}</div>`);
        if (l.descrizione && !l.nota) notes.push(`<div class="note"><b>Descrizione</b>${esc(l.descrizione)}</div>`);

        const near = vicine(l, 2);
        const isOsm = /^(node|way|relation)\//.test(l.id);
        el.innerHTML = `${backButton()}
          <h2>${esc(l.nome)}</h2>
          <div class="kind"><span class="tag ${l.tipo}">${TIPI[l.tipo]}</span>${l.preferito ? '<span class="tag star">★ Preferito</span>' : ""}${stato}</div>
          ${googleKey() ? '<div id="gfoto" class="gfoto" aria-live="polite"></div>' : ""}
          ${notes.join("")}
          <div class="actions">
            <button class="btn" id="go">Portami qui</button>
            <button class="btn" id="share">Condividi</button>
            ${isOsm ? `<a class="btn" target="_blank" rel="noopener" href="https://www.openstreetmap.org/${esc(l.id)}">Correggi su OSM</a>` : ""}
          </div>
          ${facts.length ? `<dl class="facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>` : `<p class="muted">Di questo locale OpenStreetMap non ha orari né contatti.</p>`}
          ${near.length ? `<div class="section-t">Vaporetto più vicino</div><div class="list">${near.map((i) => rowFermata(i, l)).join("")}</div>` : ""}
          ${googleKey() ? '<div class="section-t">Su Google Maps</div><div id="gscheda"><button class="btn" id="gopen">Mostra la scheda Google</button></div>' : ""}`;
        if (googleKey()) caricaGoogle(l, el);
        $("#share", el).addEventListener("click", () => share(l.nome, "l=" + encodeURIComponent(l.id)));
        $("#go", el).addEventListener("click", () => openPercorso(l));
      },
    });
  }

  // ------------------------------------------------------------ Google: foto e scheda del locale
  // Per risparmiare: una sola ricerca per locale (solo campi id, nome, foto, link) e solo quando si apre la scheda.
  const googleKey = () => state.googleKey || "";
  const gCache = new Map();
  function gPlace(l) {
    if (gCache.has(l.id)) return gCache.get(l.id);
    const p = fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      // manda l'URL completo come referrer: la restrizione della chiave su Google lo confronta
      referrerPolicy: "no-referrer-when-downgrade",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": googleKey(),
        "X-Goog-FieldMask": "places.id,places.displayName,places.location,places.photos,places.googleMapsUri",
      },
      body: JSON.stringify({
        textQuery: `${l.nome}, Venezia`,
        languageCode: "it",
        maxResultCount: 1,
        locationBias: { circle: { center: { latitude: l.lat, longitude: l.lon }, radius: 100 } },
      }),
    }).then(async (r) => {
      if (r.ok) return r.json();
      // il messaggio di Google dice cosa manca (API non attiva, referrer, quota...)
      let msg = "";
      try { msg = (await r.json()).error.message; } catch (e) { /* risposta non JSON */ }
      throw new Error(`Google ${r.status}${msg ? ": " + msg : ""}`);
    })
      .then((j) => {
        const g = j.places && j.places[0];
        // se Google trova un posto lontano non è lo stesso locale
        if (!g || !g.location || dist(l, { lat: g.location.latitude, lon: g.location.longitude }) > 150) return null;
        return g;
      });
    gCache.set(l.id, p);
    p.catch(() => gCache.delete(l.id));
    return p;
  }
  async function caricaGoogle(l, el) {
    const box = $("#gfoto", el);
    const sc = $("#gscheda", el);
    box.innerHTML = '<p class="gstato">Cerco la foto su Google…</p>';
    let g = null;
    try { g = await gPlace(l); } catch (e) {
      console.warn(e);
      // in alto, ben visibile: il messaggio di Google dice cosa sistemare nella console
      box.innerHTML = `<p class="gstato err">Foto Google non disponibile.<br><small>${esc(e.message)}</small></p>`;
      if (sc) sc.innerHTML = '<p class="muted">Scheda Google non disponibile.</p>';
      return;
    }
    if (!box.isConnected) return;
    if (!g) { box.innerHTML = '<p class="gstato">Locale non trovato su Google Maps.</p>'; if (sc) sc.innerHTML = ""; return; }
    const ph = g.photos && g.photos[0];
    if (ph) {
      const autore = (ph.authorAttributions || [])[0];
      box.innerHTML = `<img alt="Foto di ${esc(l.nome)}" loading="lazy" referrerpolicy="no-referrer-when-downgrade" src="https://places.googleapis.com/v1/${esc(ph.name)}/media?maxWidthPx=800&key=${encodeURIComponent(googleKey())}">
        <p class="credit">Foto${autore ? ` di <a href="${esc(autore.uri)}" target="_blank" rel="noopener">${esc(autore.displayName)}</a>` : ""} · Google Maps</p>`;
      box.querySelector("img").addEventListener("error", () => {
        box.innerHTML = '<p class="gstato err">Google non ha restituito la foto (controlla che la chiave possa usare Places API New).</p>';
      });
    } else box.innerHTML = '<p class="gstato">Su Google questo locale non ha foto.</p>';
    $("#gopen", el)?.addEventListener("click", () => {
      $("#gscheda", el).innerHTML = `<iframe class="gembed" title="Scheda Google di ${esc(l.nome)}" loading="lazy" referrerpolicy="no-referrer-when-downgrade"
        src="https://www.google.com/maps/embed/v1/place?key=${encodeURIComponent(googleKey())}&q=place_id:${encodeURIComponent(g.id)}&language=it"></iframe>
        ${g.googleMapsUri ? `<a class="btn" href="${esc(g.googleMapsUri)}" target="_blank" rel="noopener">Recensioni su Google Maps</a>` : ""}`;
    });
  }

  async function share(title, hash) {
    const url = location.origin + location.pathname + "#" + hash;
    try {
      if (navigator.share) await navigator.share({ title, url });
      else { await navigator.clipboard.writeText(url); toast("Link copiato"); }
    } catch (e) { /* annullato */ }
  }

  // ------------------------------------------------------------ scheda fermata
  function serviziDel(d) {
    return new Set(state.actv.date[ymd(d)] || []);
  }

  async function partenze(g, giorno) {
    const rows = await getJSON(`data/actv/fermate/${g}.json`);
    const oggi = serviziDel(giorno);
    const ieri = serviziDel(new Date(giorno.getFullYear(), giorno.getMonth(), giorno.getDate() - 1));
    const out = [];
    for (const [r, h, s, m, t, p] of rows) {
      if (oggi.has(s)) out.push({ r, h, m, t, p });
      if (m >= 1440 && ieri.has(s)) out.push({ r, h, m: m - 1440, t, p, ieri: true });
    }
    out.sort((a, b) => a.m - b.m);
    return out;
  }

  function openFermata(g, opts = {}) {
    const f = state.actv.fermate[g];
    layerLinea.clearLayers();
    select(f.lat, f.lon);
    grow("half");
    if (!opts.noFocus) focus(f.lat, f.lon);
    let giornoOff = 0;
    let filtro = new Set();
    let tutte = false;
    show({
      hash: "f=" + encodeURIComponent(f.nome),
      sel: [f.lat, f.lon],
      render(el) {
        el.innerHTML = `${backButton()}
          <h2>${esc(f.nome)}</h2>
          ${f.linee.length > 1 ? "" : `<div class="kind">${f.linee.map(lineaBadge).join("")}</div>`}
          <div class="daybar" id="days"></div>
          <div class="linefilter" id="lf"></div>
          <div id="deps"><p class="empty">Carico gli orari…</p></div>
          <div class="section-t">Bacari vicini</div>
          <div class="list">${state.locali.filter((l) => l.tipo === "bacaro" || l.preferito).map((l) => [dist(f, l), l]).sort((a, b) => a[0] - b[0]).slice(0, 4).map(([, l]) => rowLocale(l, f)).join("")}</div>
          ${foot()}`;
        const days = $("#days", el);
        const lf = $("#lf", el);
        const deps = $("#deps", el);
        const draw = async () => {
          const base = new Date();
          const giorno = new Date(base.getFullYear(), base.getMonth(), base.getDate() + giornoOff);
          days.innerHTML = [0, 1, 2].map((o) => {
            const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + o);
            const lab = o === 0 ? "Oggi" : o === 1 ? "Domani" : GIORNI[d.getDay()] + " " + d.getDate();
            return `<button data-off="${o}" aria-pressed="${o === giornoOff}">${lab}</button>`;
          }).join("") + `<input type="date" id="dpick" aria-label="Scegli un giorno" value="" style="max-width:150px">`;
          lf.innerHTML = f.linee.length > 1 ? f.linee.map((r) => `<button data-r="${r}" aria-pressed="${!filtro.size || filtro.has(r)}">${lineaBadge(r)}</button>`).join("") : "";
          let list;
          try { list = await partenze(g, giorno); }
          catch (e) { deps.innerHTML = `<p class="empty">Non riesco a caricare gli orari di questa fermata. Sei offline? Riprova quando hai campo.</p>`; return; }
          if (filtro.size) list = list.filter((x) => filtro.has(x.r));
          if (!list.length) {
            const inFeed = state.actv.date[ymd(giorno)];
            deps.innerHTML = `<p class="empty">${inFeed ? "Nessuna partenza in questo giorno." : "Gli orari di questo giorno non sono ancora pubblicati da ACTV."}</p>`;
            return;
          }
          const now = giornoOff === 0 ? nowMin() : -1;
          let first = list.findIndex((x) => x.m >= now);
          if (first < 0) first = list.length;
          const startAt = tutte ? 0 : Math.max(0, first - 2);
          const shown = list.slice(startAt, tutte ? undefined : startAt + 30);
          deps.innerHTML = `<div class="list">${shown.map((x) => {
            const past = x.m < now;
            const tra = giornoOff === 0 && !past ? (x.m - now < 60 ? `tra ${x.m - now} min` : "") : "";
            return `<button class="row dep${past ? " past" : ""}" data-trip="${x.r}:${x.t}:${x.p}">${lineaBadge(x.r)}<div><div class="t">${state.actv.capolinea[x.h] === f.nome ? "Giro completo" : esc(state.actv.capolinea[x.h] || "")}</div><div class="s">${tra}</div></div><div class="m"><b>${hhmm(x.m)}</b></div></button>`;
          }).join("")}</div>
          ${!tutte && (startAt > 0 || startAt + 30 < list.length) ? `<button class="btn" id="all" style="margin-top:8px">Tutte le ${list.length} partenze del giorno</button>` : ""}`;
          $("#all", deps)?.addEventListener("click", () => { tutte = true; draw(); });
        };
        days.addEventListener("click", (e) => { const b = e.target.closest("[data-off]"); if (b) { giornoOff = +b.dataset.off; tutte = false; draw(); } });
        days.addEventListener("change", (e) => {
          if (e.target.id !== "dpick" || !e.target.value) return;
          const [y, mo, d] = e.target.value.split("-").map(Number);
          const t = new Date(); t.setHours(0, 0, 0, 0);
          giornoOff = Math.round((new Date(y, mo - 1, d) - t) / 86400000);
          tutte = false;
          draw();
        });
        lf.addEventListener("click", (e) => {
          const b = e.target.closest("[data-r]");
          if (!b) return;
          const r = +b.dataset.r;
          if (filtro.has(r)) filtro.delete(r);
          else filtro.add(r);
          if (filtro.size === f.linee.length) filtro.clear();
          draw();
        });
        deps.addEventListener("click", (e) => {
          const b = e.target.closest("[data-trip]");
          if (!b) return;
          const [r, t, p] = b.dataset.trip.split(":").map(Number);
          openCorsa(r, t, p);
        });
        draw();
      },
    });
  }

  // ------------------------------------------------------------ corsa e linea
  async function openCorsa(r, t, pos) {
    const corse = await getJSON(`data/actv/corse/${r}.json`);
    const [, h, ferm] = corse[t];
    show({
      render(el) {
        drawPercorso(r, ferm.map(([g]) => g), ferm[pos][0]);
        el.innerHTML = `${backButton()}
          <h2>${lineaBadge(r)} → ${esc(state.actv.capolinea[h])}</h2>
          <p class="muted">Orari programmati di questa corsa. Tocca una fermata per vederne le partenze.</p>
          <ol class="timeline">${ferm.map(([g, m], i) => `<li class="${i === pos ? "here" : ""}"><span class="tm">${hhmm(m)}</span><span class="pin"></span><button class="nm" data-stop="${g}">${esc(state.actv.fermate[g].nome)}</button></li>`).join("")}</ol>`;
      },
    });
  }

  function drawPercorso(r, gs, here) {
    layerLinea.clearLayers();
    clearSelect();
    const l = state.actv.linee[r];
    const color = l.colore || css("--actv");
    const pts = gs.map((g) => [state.actv.fermate[g].lat, state.actv.fermate[g].lon]);
    const lines = l.tracciato && l.tracciato.length ? l.tracciato : [pts];
    for (const ln of lines) {
      L.polyline(ln, { color: css("--ink"), weight: 7, opacity: 0.5, interactive: false }).addTo(layerLinea);
      L.polyline(ln, { color, weight: 4, interactive: false }).addTo(layerLinea);
    }
    for (const g of gs) {
      const f = state.actv.fermate[g];
      L.circleMarker([f.lat, f.lon], { radius: g === here ? 8 : 5, color: css("--actv-ink"), weight: 2, fillColor: color, fillOpacity: 1 })
        .bindTooltip(f.nome).on("click", () => openFermata(g)).addTo(layerLinea);
    }
    const b = L.latLngBounds(pts);
    if (b.isValid()) map.fitBounds(b, { paddingTopLeft: [30, 130], paddingBottomRight: [30, sheetHeight() + 20], maxZoom: 16 });
  }

  async function openLinea(r) {
    grow("half");
    const corse = await getJSON(`data/actv/corse/${r}.json`);
    // per ogni direzione (capolinea) la corsa con più fermate
    const dirs = new Map();
    for (const c of corse) {
      const k = c[1];
      if (!dirs.has(k) || c[2].length > dirs.get(k)[2].length) dirs.set(k, c);
    }
    const lista = [...dirs.values()].sort((a, b) => b[2].length - a[2].length).slice(0, 4);
    let sel = 0;
    show({
      render(el) {
        const draw = () => {
          const c = lista[sel];
          drawPercorso(r, c[2].map(([g]) => g));
          el.innerHTML = `${backButton()}
            <h2>${lineaBadge(r)} ${esc(state.actv.linee[r].descr || "")}</h2>
            <div class="daybar">${lista.map((c, i) => `<button data-d="${i}" aria-pressed="${i === sel}">→ ${esc(state.actv.capolinea[c[1]])}</button>`).join("")}</div>
            <ol class="timeline">${c[2].map(([g]) => `<li><span class="tm"></span><span class="pin"></span><button class="nm" data-stop="${g}">${esc(state.actv.fermate[g].nome)}</button></li>`).join("")}</ol>`;
          el.querySelectorAll("[data-d]").forEach((b) => b.addEventListener("click", () => { sel = +b.dataset.d; draw(); }));
        };
        draw();
      },
    });
  }

  // ------------------------------------------------------------ indicazioni (a piedi e in vaporetto)
  function setMe(p) {
    state.me = { lat: p.coords.latitude, lon: p.coords.longitude };
    $("#locate").classList.add("on");
    if (!meMarker) meMarker = L.marker([state.me.lat, state.me.lon], { icon: L.divIcon({ className: "", html: '<span class="me-ic"></span>', iconSize: [16, 16] }), interactive: false, zIndexOffset: 1000 }).addTo(map);
    else meMarker.setLatLng([state.me.lat, state.me.lon]);
  }
  function posizione() {
    if (state.me) return Promise.resolve(state.me);
    if (!navigator.geolocation) return Promise.resolve(null);
    return new Promise((ok) => {
      navigator.geolocation.getCurrentPosition((p) => { setMe(p); ok(state.me); }, () => ok(null),
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 });
    });
  }

  // Indirizzi con Nominatim (OpenStreetMap), solo su richiesta e solo dentro la laguna
  async function geocodifica(testo) {
    const u = new URL("https://nominatim.openstreetmap.org/search");
    u.search = new URLSearchParams({ q: /venezia|venice|mestre|lido|murano|burano|giudecca/i.test(testo) ? testo : testo + ", Venezia",
      format: "jsonv2", limit: "6", "accept-language": "it", countrycodes: "it", viewbox: "12.17,45.55,12.47,45.36", bounded: "1" });
    try {
      const r = await fetch(u);
      if (!r.ok) throw new Error(r.status);
      return (await r.json()).map((x) => {
        const parti = x.display_name.split(", ");
        return { lat: +x.lat, lon: +x.lon, nome: parti.slice(0, 2).join(", "), sub: parti.slice(2, 4).join(", ") };
      });
    } catch (e) {
      toast("Ricerca indirizzi non disponibile ora");
      return [];
    }
  }

  const minuti = (m) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`);
  let stopNodes = null;

  async function pianifica(orig, dest) {
    const P = Percorsi;
    await P.load();
    const o = P.nearest(orig.lat, orig.lon), d = P.nearest(dest.lat, dest.lon);
    const daO = P.dijkstra(o.node), daD = P.dijkstra(d.node);
    const walkMin = (res, node, extra) => (res.dist[node] + extra) / P.PASSO;
    const piedi = P.path(daO, d.node);
    const res = { o, d, daO, daD, piedi, piediMin: piedi ? Math.max(1, Math.round(walkMin(daO, d.node, o.dist + d.dist))) : null, opzioni: [] };
    if (!state.actv) return res;
    // per ogni fermata, il nodo pedonale di ciascun pontile (Rialto "A", "B"...): si usa il più comodo
    if (!stopNodes) stopNodes = state.actv.fermate.map((f) => (f.pontili && f.pontili.length ? f.pontili : [[f.lat, f.lon]]).map(([la, lo]) => P.nearest(la, lo)));
    const verso = (res2, extra, max) => stopNodes
      .map((pts, i) => {
        let bestMin = Infinity, node = -1;
        for (const sn of pts) {
          const m = walkMin(res2, sn.node, extra + sn.dist);
          if (m < bestMin) { bestMin = m; node = sn.node; }
        }
        return { i, min: bestMin, node };
      })
      .filter((x) => isFinite(x.min) && x.min <= max)
      .sort((a, b) => a.min - b.min).slice(0, 8);
    const salita = verso(daO, o.dist, 20);
    const scese = verso(daD, d.dist, 20);
    const discesa = new Map(scese.map((x) => [x.i, x.min]));
    res.nodoFermata = new Map([...salita.map((x) => ["a" + x.i, x.node]), ...scese.map((x) => ["b" + x.i, x.node])]);
    if (!salita.length || !discesa.size) return res;
    const ora = nowMin();
    const oggi = new Date();
    const best = new Map();
    for (const a of salita) {
      const pronto = ora + Math.ceil(a.min);
      let deps;
      try { deps = await partenze(a.i, oggi); } catch (e) { continue; }
      deps = deps.filter((x) => x.m >= pronto && x.m <= pronto + 90);
      for (const dep of deps) {
        let corse;
        try { corse = await getJSON(`data/actv/corse/${dep.r}.json`); } catch (e) { continue; }
        const ferm = corse[dep.t][2];
        for (let k = dep.p + 1; k < ferm.length; k++) {
          const b = ferm[k][0];
          if (!discesa.has(b) || b === a.i) continue;
          const arrivo = (dep.ieri ? ferm[k][1] - 1440 : ferm[k][1]) + Math.ceil(discesa.get(b));
          const key = `${dep.r}|${dep.t}${dep.ieri ? "i" : ""}|${b}`; // per corsa e fermata di discesa
          const walk = Math.ceil(a.min) + Math.ceil(discesa.get(b));
          const cur = best.get(key);
          if (!cur || cur.arrivo > arrivo || (cur.arrivo === arrivo && cur.walkA + cur.walkB > walk)) {
            best.set(key, { r: dep.r, h: dep.h, a: a.i, b, parte: dep.m, scende: dep.ieri ? ferm[k][1] - 1440 : ferm[k][1],
              arrivo, walkA: Math.ceil(a.min), walkB: Math.ceil(discesa.get(b)), tappe: ferm.slice(dep.p, k + 1).map(([g]) => g) });
          }
        }
      }
    }
    const limite = res.piediMin != null ? ora + res.piediMin : Infinity;
    // per ogni corsa si tiene la discesa che fa arrivare prima (a pari arrivo, meno strada a piedi)
    const perCorsa = new Map();
    for (const x of best.values()) {
      const k = `${x.r}|${x.parte}|${x.a}`;
      const c = perCorsa.get(k);
      if (!c || x.arrivo < c.arrivo || (x.arrivo === c.arrivo && x.walkA + x.walkB < c.walkA + c.walkB)) perCorsa.set(k, x);
    }
    res.opzioni = [...perCorsa.values()].filter((x) => x.arrivo < limite)
      .sort((x, y) => x.arrivo - y.arrivo || (x.walkA + x.walkB) - (y.walkA + y.walkB)).slice(0, 4);
    return res;
  }

  function disegnaPiedi(coords, dashed) {
    L.polyline(coords, { color: css("--surface"), weight: 8, opacity: 0.9, interactive: false }).addTo(layerLinea);
    L.polyline(coords, { color: "#2b7bd8", weight: 5, dashArray: dashed ? "2 9" : null, lineCap: "round", interactive: false }).addTo(layerLinea);
  }

  function openPercorso(dest) {
    let piano = null, modo = "piedi", scelta = 0, origine = null, etichetta = "", errore = "";
    let scelto = null;      // partenza scelta a mano: { lat, lon, nome }
    let cerca = null;       // testo della ricerca partenza (null = ricerca chiusa)
    let indirizzi = null;   // risultati della ricerca indirizzo (null = non cercato)
    show({
      sel: [dest.lat, dest.lon],
      render(el) {
        const draw = () => {
          layerLinea.clearLayers();
          let h = `${backButton()}<h2>Come arrivo a ${esc(dest.nome)}</h2>
            <p class="muted">Partenza: <b>${esc(etichetta)}</b> · <button class="linkbtn" id="chorig">${cerca === null ? "cambia" : "chiudi"}</button></p>
            ${cerca !== null ? htmlPartenza() : ""}
            <div class="daybar"><button data-m="piedi" aria-pressed="${modo === "piedi"}">A piedi</button><button data-m="vap" aria-pressed="${modo === "vap"}">Vaporetto + piedi</button></div>`;
          if (errore) h += `<p class="empty">${esc(errore)}</p>`;
          else if (!piano) h += `<p class="empty">Calcolo il percorso…</p>`;
          else if (modo === "piedi") h += htmlPiedi();
          else h += htmlVap();
          el.innerHTML = h;
          el.querySelectorAll("[data-m]").forEach((b) => b.addEventListener("click", () => { modo = b.dataset.m; scelta = 0; draw(); }));
          el.querySelectorAll("[data-o]").forEach((b) => b.addEventListener("click", () => { scelta = +b.dataset.o; draw(); }));
          $("#chorig", el).addEventListener("click", () => { cerca = cerca === null ? "" : null; draw(); if (cerca !== null) $("#oq", el)?.focus(); });
          const oq = $("#oq", el);
          if (oq) {
            oq.value = cerca;
            oq.addEventListener("input", () => { cerca = oq.value; indirizzi = null; $("#ores", el).innerHTML = risultatiPartenza(); });
            oq.addEventListener("keydown", (e) => { if (e.key === "Enter" && cerca.trim().length >= 3) { e.preventDefault(); $('[data-orig="ind:"]', el)?.click(); } });
          }
          el.querySelector(".origini")?.addEventListener("click", async (e) => {
            const b = e.target.closest("[data-orig]");
            if (!b) return;
            const [tipo, id] = b.dataset.orig.split(":");
            if (tipo === "gps") {
              const me = await posizione();
              if (!me) return toast("Posizione non disponibile: controlla i permessi del browser");
              scelto = null;
            } else if (tipo === "mappa") {
              toast("Tocca la mappa nel punto da cui parti");
              setSheet("peek");
              sceltaSuMappa = true;
              map.once("click", (ev) => { sceltaSuMappa = false; scelto = { lat: ev.latlng.lat, lon: ev.latlng.lng, nome: "punto sulla mappa" }; cerca = null; grow("half"); calcola(); });
              return;
            } else if (tipo === "ind") {
              b.querySelector(".t").textContent = "Cerco l'indirizzo…";
              indirizzi = await geocodifica(cerca.trim());
              $("#ores", el).innerHTML = risultatiPartenza();
              return;
            } else if (tipo === "a") {
              scelto = { ...indirizzi[+id] };
              indirizzi = null;
            } else if (tipo === "f") {
              const f = state.actv.fermate[+id];
              scelto = { lat: f.lat, lon: f.lon, nome: "fermata " + f.nome };
            } else {
              const l = state.locali.find((x) => x.id === decodeURIComponent(id));
              scelto = { lat: l.lat, lon: l.lon, nome: l.nome };
            }
            cerca = null;
            calcola();
          });
          $("#avvia", el)?.addEventListener("click", avvia);
          if (piano) disegna();
        };
        // ---- in cammino: la mappa segue la posizione e in alto c'è l'istruzione del momento
        const avvia = () => {
          if (!navigator.geolocation) return toast("Posizione non disponibile su questo dispositivo");
          if (nav) nav.stop();
          const vap = modo === "vap" && piano.opzioni.length ? piano.opzioni[Math.min(scelta, piano.opzioni.length - 1)] : null;
          const leg = (p, verso) => {
            if (!p) return null;
            const coords = verso ? p.coords.slice().reverse() : p.coords;
            const cum = [0];
            for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + Percorsi.metri(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]));
            return { coords, cum, tot: cum[cum.length - 1], passi: verso ? null : Percorsi.steps(p) };
          };
          const gambe = vap
            ? { a: leg(Percorsi.path(piano.daO, piano.nodoFermata.get("a" + vap.a))), b: leg(Percorsi.path(piano.daD, piano.nodoFermata.get("b" + vap.b)), true) }
            : { a: leg(piano.piedi) };
          const bar = document.createElement("div");
          bar.className = "navbar";
          bar.innerHTML = '<div class="nav-txt"><b></b><span></span></div><button class="btn" data-nav="centra" hidden>Ricentra</button><button class="btn" data-nav="fine">Fine</button>';
          document.body.append(bar);
          document.body.classList.add("navigando");
          let segui = true;
          const pausa = () => { segui = false; bar.querySelector('[data-nav="centra"]').hidden = false; };
          map.on("dragstart", pausa);
          bar.addEventListener("click", (e) => {
            const b = e.target.closest("[data-nav]");
            if (!b) return;
            if (b.dataset.nav === "fine") return nav && nav.stop();
            segui = true; b.hidden = true;
            if (state.me) segui && segui_(state.me);
          });
          const segui_ = (me) => {
            const z = Math.max(map.getZoom(), 17);
            const p = map.project([me.lat, me.lon], z).add([0, sheetHeight() / 2 - 60]);
            map.setView(map.unproject(p, z), z, { animate: true });
          };
          const lungo = (g, me) => {
            let best = Infinity, k = 0;
            g.coords.forEach(([la, lo], i) => { const d = Percorsi.metri(me.lat, me.lon, la, lo); if (d < best) { best = d; k = i; } });
            return { fatto: g.cum[k], manca: g.tot - g.cum[k], fuori: best };
          };
          const istruzione = (g, me, meta) => {
            const { fatto, manca, fuori } = lungo(g, me);
            if (manca < 25) return null;
            const sub = fuori > 60 ? `Sei a ${fmtDist(fuori)} dal percorso` : `${meta}: ancora ${fmtDist(manca)}`;
            if (!g.passi) return [`Cammina fino a ${dest.nome}`, sub];
            const scala = g.tot / g.passi.reduce((t, x) => t + x.len, 0);
            let c = 0;
            for (let i = 0; i < g.passi.length; i++) {
              const fine = c + g.passi[i].len * scala;
              if (fatto < fine || i === g.passi.length - 1) {
                const prossimo = g.passi[i + 1];
                return [g.passi[i].txt, prossimo ? `Fra ${fmtDist(Math.max(10, fine - fatto))}: ${prossimo.txt.charAt(0).toLowerCase() + prossimo.txt.slice(1)}` : sub];
              }
              c = fine;
            }
          };
          const aggiorna = (me) => {
            let r;
            if (!vap) r = gambe.a ? istruzione(gambe.a, me, dest.nome) : null;
            else {
              const t = nowMin(), F = (g) => state.actv.fermate[g].nome, linea = state.actv.linee[vap.r].nome;
              const fa = state.actv.fermate[vap.a];
              if (t < vap.parte) {
                const vicino = Percorsi.metri(me.lat, me.lon, fa.lat, fa.lon) < 60;
                r = !vicino && gambe.a && istruzione(gambe.a, me, `Pontile ${F(vap.a)}`);
                if (r) r[1] = `Linea ${linea} alle ${hhmm(vap.parte)} · ` + r[1];
                else r = [`Aspetta la linea ${linea} a ${F(vap.a)}`, `Parte alle ${hhmm(vap.parte)}, fra ${vap.parte - t} min`];
              } else if (t < vap.scende) r = [`Sei sulla linea ${linea}`, `Scendi a ${F(vap.b)} alle ${hhmm(vap.scende)}`];
              else r = gambe.b ? istruzione(gambe.b, me, dest.nome) : null;
            }
            if (!r) r = [`Sei arrivato a ${dest.nome}`, "Salute!"];
            bar.querySelector("b").textContent = r[0];
            bar.querySelector("span").textContent = r[1];
            if (segui) segui_(me);
          };
          bar.querySelector("b").textContent = "Cerco la tua posizione…";
          const id = navigator.geolocation.watchPosition((p) => { setMe(p); aggiorna(state.me); },
            () => { bar.querySelector("b").textContent = "Posizione non disponibile"; bar.querySelector("span").textContent = "Controlla i permessi del browser"; },
            { enableHighAccuracy: true, maximumAge: 5000 });
          nav = { stop() {
            navigator.geolocation.clearWatch(id);
            map.off("dragstart", pausa);
            bar.remove();
            document.body.classList.remove("navigando");
            nav = null;
          } };
          setSheet("peek");
          if (state.me) aggiorna(state.me);
        };
        const risultatiPartenza = () => {
          const q = norm(cerca.trim());
          let righe = [];
          if (q.length < 2) {
            righe.push('<button class="row" data-orig="gps:"><span class="ico fermata" style="background:#2b7bd8;color:#fff">●</span><div><div class="t">La mia posizione</div></div><div class="m"></div></button>');
            righe.push('<button class="row" data-orig="mappa:"><span class="ico bar">✛</span><div><div class="t">Scegli un punto sulla mappa</div></div><div class="m"></div></button>');
            if (state.actv) righe.push(...vicine(dest, 4).map((i) => rowOrig("f", i, state.actv.fermate[i].nome, "Fermata vaporetto")));
          } else {
            if (state.actv) state.actv.fermate.forEach((f, i) => { if (norm(f.nome).includes(q)) righe.push(rowOrig("f", i, f.nome, "Fermata vaporetto")); });
            state.locali.filter((l) => norm(l.nome).includes(q)).slice(0, 10)
              .forEach((l) => righe.push(rowOrig("l", encodeURIComponent(l.id), l.nome, TIPI[l.tipo])));
            righe = righe.slice(0, 12);
            righe.unshift(`<button class="row" data-orig="ind:"><span class="ico bar">⌕</span><div><div class="t">Cerca l'indirizzo “${esc(cerca.trim())}”</div><div class="s">es. Cannaregio 1234, Campo Santa Margherita</div></div><div class="m"></div></button>`);
            if (indirizzi) righe.unshift(...(indirizzi.length ? indirizzi.map((a, i) => rowOrig("a", i, a.nome, a.sub))
              : [`<p class="empty">Nessun indirizzo trovato per “${esc(cerca.trim())}”.</p>`]));
          }
          return righe.join("");
        };
        const rowOrig = (tipo, id, nome, sub) => `<button class="row" data-orig="${tipo}:${id}">${tipo === "f" ? `<span class="ico fermata">${ICON_BOAT}</span>` : tipo === "a" ? '<span class="ico bar">⌖</span>' : tipoIcon("bacaro")}<div><div class="t">${esc(nome)}</div><div class="s">${esc(sub)}</div></div><div class="m"></div></button>`;
        const htmlPartenza = () => `<div class="origini"><div class="searchbox inline"><input id="oq" type="search" placeholder="Indirizzo, fermata o locale" autocomplete="off"></div>
          <div class="list" id="ores">${risultatiPartenza()}</div></div>`;
        const htmlPiedi = () => {
          const p = piano.piedi;
          if (!p) return `<p class="empty">Non trovo un percorso a piedi: forse partenza e arrivo sono su isole diverse. Prova col vaporetto.</p>`;
          const passi = Percorsi.steps(p);
          return `<p class="summary"><b>${minuti(piano.piediMin)}</b> a piedi · ${fmtDist(p.len)}${p.ponti ? ` · ${p.ponti} ${p.ponti === 1 ? "ponte" : "ponti"}` : ""}</p>
            <button class="btn primary avvia" id="avvia">Avvia: la mappa ti segue</button>
            <ol class="steps">${passi.map((s) => `<li class="${s.ponte ? "ponte" : s.verso}"><span>${esc(s.txt)}</span><span class="m">${fmtDist(s.len)}</span></li>`).join("")}
            <li class="arrivo"><span>Sei arrivato a ${esc(dest.nome)}</span><span></span></li></ol>`;
        };
        const htmlVap = () => {
          const ops = piano.opzioni;
          if (!state.actv) return `<p class="empty">Orari dei vaporetti non disponibili.</p>`;
          if (!ops.length) return `<p class="empty">${piano.piediMin != null && piano.piediMin <= 25 ? `Fai prima a piedi: ${minuti(piano.piediMin)}.` : "Nessun vaporetto diretto utile nei prossimi 90 minuti."}</p>`;
          const o = ops[Math.min(scelta, ops.length - 1)];
          const F = (g) => esc(state.actv.fermate[g].nome);
          return `<button class="btn primary avvia" id="avvia">Avvia: la mappa ti segue</button><div class="list">${ops.map((x, i) => `<button class="row opt${i === scelta ? " on" : ""}" data-o="${i}">${lineaBadge(x.r)}<div><div class="t">${hhmm(x.parte)} da ${F(x.a)}</div><div class="s">scendi a ${F(x.b)} · arrivo ${hhmm(x.arrivo)} · ${x.walkA + x.walkB} min a piedi</div></div><div class="m"><b>${minuti(x.arrivo - nowMin())}</b></div></button>`).join("")}</div>
            <ol class="steps">
              ${o.walkA > 1 ? `<li class="piedi"><span>Cammina fino al pontile ${F(o.a)}</span><span class="m">${o.walkA} min</span></li>` : ""}
              <li class="vap"><span>Prendi la linea ${esc(state.actv.linee[o.r].nome)} → ${esc(state.actv.capolinea[o.h])} alle <b>${hhmm(o.parte)}</b></span><span class="m">${o.tappe.length - 1} ferm.</span></li>
              <li class="vap"><span>Scendi a ${F(o.b)} alle ${hhmm(o.scende)}</span><span></span></li>
              <li class="piedi"><span>Cammina fino a ${esc(dest.nome)}</span><span class="m">${o.walkB} min</span></li>
              <li class="arrivo"><span>Arrivo previsto alle ${hhmm(o.arrivo)}</span><span></span></li>
            </ol>
            ${piano.piediMin != null ? `<p class="muted">A piedi ci metteresti ${minuti(piano.piediMin)}.</p>` : ""}
            <p class="foot">Solo corse dirette, orari programmati ACTV.</p>`;
        };
        const disegna = () => {
          const pts = [];
          if (modo === "piedi" && piano.piedi) {
            disegnaPiedi(piano.piedi.coords);
            pts.push(...piano.piedi.coords);
          } else if (modo === "vap" && piano.opzioni.length) {
            const o = piano.opzioni[Math.min(scelta, piano.opzioni.length - 1)];
            const p1 = Percorsi.path(piano.daO, piano.nodoFermata.get("a" + o.a));
            const p2 = Percorsi.path(piano.daD, piano.nodoFermata.get("b" + o.b));
            if (p1) { disegnaPiedi(p1.coords, true); pts.push(...p1.coords); }
            if (p2) { disegnaPiedi(p2.coords.slice().reverse(), true); pts.push(...p2.coords); }
            const ride = o.tappe.map((g) => [state.actv.fermate[g].lat, state.actv.fermate[g].lon]);
            const col = state.actv.linee[o.r].colore || css("--actv");
            L.polyline(ride, { color: css("--ink"), weight: 8, opacity: 0.5, interactive: false }).addTo(layerLinea);
            L.polyline(ride, { color: col, weight: 5, interactive: false }).addTo(layerLinea);
            for (const g of [o.a, o.b]) {
              const f = state.actv.fermate[g];
              L.circleMarker([f.lat, f.lon], { radius: 7, color: css("--actv-ink"), weight: 2, fillColor: css("--actv"), fillOpacity: 1 }).bindTooltip(f.nome).addTo(layerLinea);
            }
            pts.push(...ride);
          }
          if (origine) L.circleMarker([origine.lat, origine.lon], { radius: 6, color: "#fff", weight: 3, fillColor: "#2b7bd8", fillOpacity: 1, interactive: false }).addTo(layerLinea);
          if (pts.length) {
            const b = L.latLngBounds(pts);
            map.fitBounds(b, { paddingTopLeft: [30, 130], paddingBottomRight: [30, sheetHeight() + 20], maxZoom: 17 });
          }
        };
        const calcola = async () => {
          piano = null; errore = "";
          if (scelto) { origine = scelto; etichetta = scelto.nome; }
          else {
            const me = await posizione();
            origine = me || center();
            etichetta = me ? "la tua posizione" : "centro della mappa";
          }
          draw();
          try {
            piano = await pianifica(origine, dest);
            if (!piano.piedi && piano.opzioni.length) modo = "vap";
          }
          catch (e) { errore = "Non riesco a caricare la mappa dei percorsi. Sei offline? Riprova quando hai campo."; }
          draw();
        };
        grow("half");
        calcola();
      },
    });
  }

  // ------------------------------------------------------------ ricerca
  const q = $("#q");
  let searchTimer;
  q.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(cerca, 120);
  });
  q.addEventListener("keydown", (e) => { if (e.key === "Escape") { q.value = ""; showTab(currentTab); q.blur(); } });
  function cerca() {
    const s = norm(q.value.trim());
    if (s.length < 2) { showTab(currentTab); return; }
    const ref = center();
    const loc = state.locali.filter((l) => norm(l.nome).includes(s)).slice(0, 30);
    const st = state.actv ? state.actv.fermate.map((f, i) => [f, i]).filter(([f]) => norm(f.nome).includes(s)).slice(0, 10) : [];
    grow("full");
    show({
      render(el) {
        el.innerHTML = (st.length ? `<div class="section-t">Fermate</div><div class="list">${st.map(([, i]) => rowFermata(i, ref)).join("")}</div>` : "")
          + (loc.length ? `<div class="section-t">Locali</div><div class="list">${loc.map((l) => rowLocale(l, ref)).join("")}</div>` : "")
          + (!st.length && !loc.length ? `<p class="empty">Niente per “${esc(q.value)}”.</p>` : "");
      },
    }, false);
  }

  // ------------------------------------------------------------ filtri e posizione
  const chips = document.querySelectorAll(".chip[data-f]");
  chips.forEach((c) => {
    c.setAttribute("aria-pressed", String(!!state.filtri[c.dataset.f]));
    c.addEventListener("click", () => {
      const k = c.dataset.f;
      state.filtri[k] = !state.filtri[k];
      c.setAttribute("aria-pressed", String(state.filtri[k]));
      try { localStorage.setItem("filtri", JSON.stringify(state.filtri)); } catch (e) { /* ignora */ }
      drawLocali();
      drawFermate();
      if (state.stack.length === 1 && state.stack[0].vicini) show(state.stack[0], false);
    });
  });

  let watchId = null;
  $("#locate").addEventListener("click", () => {
    if (!navigator.geolocation) return toast("Il telefono non condivide la posizione");
    if (state.me) map.setView([state.me.lat, state.me.lon], Math.max(map.getZoom(), 16));
    if (watchId != null) return;
    watchId = navigator.geolocation.watchPosition((p) => {
      const first = !state.me;
      setMe(p);
      if (first) {
        map.setView([state.me.lat, state.me.lon], 16);
        if (currentTab === "vicini" && state.stack.length === 1) showTab("vicini");
      }
    }, () => { toast("Posizione non disponibile: controlla i permessi di Safari"); watchId = null; }, { enableHighAccuracy: true, maximumAge: 15000 });
  });

  // ------------------------------------------------------------ avvio
  function fromHash(raw) {
    const h = decodeURIComponent(raw.slice(1));
    if (h.startsWith("l=")) {
      const l = state.locali.find((x) => x.id === h.slice(2));
      if (l) { openLocale(l); return true; }
    }
    if (h.startsWith("f=") && state.actv) {
      const i = state.actv.fermate.findIndex((f) => f.nome === h.slice(2));
      if (i >= 0) { openFermata(i); return true; }
    }
    return false;
  }

  // Password del gruppo: sblocca la chiave Google cifrata in config.js e si ricorda su questo dispositivo
  async function sblocca() {
    const blob = window.CONFIG && CONFIG.protetto;
    if (!blob) return;
    const memo = "accesso:" + blob.ct.slice(0, 16);
    try {
      const salvato = JSON.parse(localStorage.getItem(memo) || "null");
      if (salvato) { state.googleKey = salvato.googleKey; return; }
    } catch (e) { /* storage non disponibile */ }
    const form = $("#lock"), pw = $("#pw"), err = $("#pwerr");
    form.hidden = false;
    document.body.classList.add("locked");
    pw.focus();
    await new Promise((ok) => {
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        err.hidden = true;
        form.querySelector("button").disabled = true;
        const dati = await Cripto.decifra(blob, pw.value);
        form.querySelector("button").disabled = false;
        if (!dati) { err.hidden = false; pw.select(); return; }
        state.googleKey = dati.googleKey;
        try { localStorage.setItem(memo, JSON.stringify(dati)); } catch (e2) { /* ignora */ }
        ok();
      });
    });
    form.hidden = true;
    document.body.classList.remove("locked");
  }

  async function init() {
    const hash = location.hash; // va letto subito: le viste riscrivono l'indirizzo
    await sblocca();
    body.innerHTML = `<p class="empty">Carico la mappa…</p>`;
    const [loc, actv] = await Promise.allSettled([getJSON("data/locali.json"), getJSON("data/actv/index.json")]);
    if (loc.status === "fulfilled") state.locali = loc.value.locali;
    if (actv.status === "fulfilled") state.actv = actv.value;
    drawLocali();
    drawFermate();
    showTab("vicini");
    if (loc.status !== "fulfilled" && actv.status !== "fulfilled") {
      body.innerHTML = `<p class="empty">Non trovo i dati dei locali e dei vaporetti. Se sei offline, riapri l'app quando hai campo.</p>`;
      return;
    }
    fromHash(hash);
    invitoHome();
  }

  // iPhone/iPad in Safari: la prima volta spiega come aggiungere l'app alla schermata Home
  function invitoHome() {
    const ios = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    if (!ios || navigator.standalone || matchMedia("(display-mode: standalone)").matches) return;
    try { if (localStorage.getItem("invitoHome")) return; localStorage.setItem("invitoHome", "1"); } catch (e) { return; }
    const d = document.createElement("div");
    d.className = "invito";
    d.innerHTML = `<img src="icons/icon-192.png" alt="" width="44" height="44">
      <div><b>Mettila nella Home</b><span>Tocca <svg viewBox="0 0 24 24" aria-label="Condividi"><path d="M12 3v12M7 8l5-5 5 5M5 12v8h14v-8"/></svg> in basso, poi “Aggiungi alla schermata Home”. Si apre a tutto schermo come un'app (ti chiederà di nuovo la password).</span></div>
      <button class="x" aria-label="Chiudi">✕</button>`;
    d.querySelector(".x").addEventListener("click", () => d.remove());
    document.body.append(d);
  }
  init();

  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
})();
