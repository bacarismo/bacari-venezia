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
  const body = $("#body");
  const SIZES = { peek: () => 160, half: () => Math.round(innerHeight * 0.5), full: () => innerHeight - 120 };
  function sheetHeight() { return SIZES[sheet.dataset.state](); }
  function setSheet(s) {
    sheet.dataset.state = s;
    document.documentElement.style.setProperty("--sheet-h", sheetHeight() + "px");
  }
  setSheet("peek");
  addEventListener("resize", () => setSheet(sheet.dataset.state));

  (function drag() {
    const h = $("#handle");
    let y0 = null, hh0 = 0, moved = false;
    const start = (e) => { y0 = e.clientY; hh0 = sheet.offsetHeight; moved = false; sheet.style.transition = "none"; h.setPointerCapture(e.pointerId); };
    h.addEventListener("pointerdown", start);
    h.addEventListener("pointermove", (e) => {
      if (y0 == null) return;
      const dy = y0 - e.clientY;
      if (Math.abs(dy) > 4) moved = true;
      const nh = Math.min(SIZES.full(), Math.max(110, hh0 + dy));
      document.documentElement.style.setProperty("--sheet-h", nh + "px");
    });
    h.addEventListener("pointerup", () => {
      sheet.style.transition = "";
      if (y0 == null) return;
      y0 = null;
      const cur = sheet.offsetHeight;
      if (!moved) {
        setSheet({ peek: "half", half: "full", full: "peek" }[sheet.dataset.state]);
        return;
      }
      const best = Object.keys(SIZES).sort((a, b) => Math.abs(SIZES[a]() - cur) - Math.abs(SIZES[b]() - cur))[0];
      setSheet(best);
    });
  })();

  function grow(min) {
    const order = ["peek", "half", "full"];
    if (order.indexOf(sheet.dataset.state) < order.indexOf(min)) setSheet(min);
  }

  function show(view, push = true) {
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
  const tabs = $("#tabs");
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
    return `<button class="row" data-loc="${esc(l.id)}">${tipoIcon(l.tipo)}<div><div class="t">${l.preferito ? "★ " : ""}${esc(l.nome)}</div><div class="s">${esc(sub)}</div></div><div class="m">${ref ? fmtDist(dist(ref, l)) : ""}</div></button>`;
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

  function viewVicini() {
    return {
      hash: "",
      vicini: true,
      render(el) {
        const ref = center();
        const list = state.locali.filter(visibile).map((l) => [dist(ref, l), l]).sort((a, b) => a[0] - b[0]).slice(0, 40);
        let h = "";
        if (state.actv && state.filtri.fermate) {
          h += `<div class="section-t">Vaporetti vicini</div><div class="list">${vicine(ref, 3).map((i) => rowFermata(i, ref)).join("")}</div>`;
        }
        h += `<div class="section-t">${state.me ? "Vicino a te" : "In questa zona"}</div>`;
        h += list.length ? `<div class="list">${list.map(([, l]) => rowLocale(l, ref)).join("")}</div>` : `<p class="empty">Nessun locale con questi filtri. Prova ad attivare altre categorie in alto.</p>`;
        h += foot();
        el.innerHTML = h;
      },
    };
  }
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
          ${notes.join("")}
          <div class="actions">
            <a class="btn primary" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=${l.lat},${l.lon}&travelmode=walking">Portami qui</a>
            <button class="btn" id="share">Condividi</button>
            ${isOsm ? `<a class="btn" target="_blank" rel="noopener" href="https://www.openstreetmap.org/${esc(l.id)}">Correggi su OSM</a>` : ""}
          </div>
          ${facts.length ? `<dl class="facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>` : `<p class="muted">Di questo locale OpenStreetMap non ha orari né contatti.</p>`}
          ${near.length ? `<div class="section-t">Vaporetto più vicino</div><div class="list">${near.map((i) => rowFermata(i, l)).join("")}</div>` : ""}`;
        $("#share", el).addEventListener("click", () => share(l.nome, "l=" + encodeURIComponent(l.id)));
      },
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
  const chips = document.querySelectorAll(".chip");
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
      state.me = { lat: p.coords.latitude, lon: p.coords.longitude };
      $("#locate").classList.add("on");
      if (!meMarker) meMarker = L.marker([state.me.lat, state.me.lon], { icon: L.divIcon({ className: "", html: '<span class="me-ic"></span>', iconSize: [16, 16] }), interactive: false, zIndexOffset: 1000 }).addTo(map);
      else meMarker.setLatLng([state.me.lat, state.me.lon]);
      if (first) {
        map.setView([state.me.lat, state.me.lon], 16);
        if (currentTab === "vicini" && state.stack.length === 1) showTab("vicini");
      }
    }, () => { toast("Posizione non disponibile: controlla i permessi di Safari"); watchId = null; }, { enableHighAccuracy: true, maximumAge: 15000 });
  });

  // ------------------------------------------------------------ avvio
  function fromHash() {
    const h = decodeURIComponent(location.hash.slice(1));
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

  async function init() {
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
    if (fromHash()) state.stack.unshift(viewVicini());
  }
  init();

  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
})();
