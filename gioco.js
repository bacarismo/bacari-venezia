// Gioco a punti del Bacaro Tour: profili, punti, classifica, foto, avvisi dell'admin.
// Backend Supabase (CONFIG.supabase in config.js); le regole di sicurezza sono in supabase/schema.sql.
(function () {
  "use strict";

  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const num = (n) => { const v = Number(n); return (Number.isInteger(v) ? String(v) : v.toFixed(1)).replace(".", ","); };
  const segno = (n) => (Number(n) >= 0 ? "+" : "") + num(n);
  const hhmm = (d) => new Date(d).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });
  const SESTIERI = ["Cannaregio", "Castello", "Dorsoduro", "San Marco", "San Polo", "Santa Croce"];
  const EMOJI = ["❤️", "😂", "🔥"];
  const PAGINA = 30;

  const cfg = window.CONFIG && CONFIG.supabase;
  const App = new Proxy({}, { get: (_, k) => window.App[k] }); // app.js si carica dopo
  let pronto;
  const giocoPronto = new Promise((ok) => { pronto = ok; });
  const G = { sb: null, uid: null, io: null, profili: new Map(), regole: [], avvisi: [], pagina: null, visti: new Set(), imp: {} };
  const toast = (m) => App.toast(m);
  const isAdmin = () => !!(G.io && G.io.ruolo === "admin");
  const fotoUrl = (path) => path ? `${cfg.url}/storage/v1/object/public/foto/${path.split("/").map(encodeURIComponent).join("/")}` : "";
  const errore = (e) => toast((e && (e.message || e.error_description)) || "Qualcosa è andato storto, riprova");

  function quando(d) {
    const s = (Date.now() - new Date(d)) / 1000;
    if (s < 60) return "adesso";
    if (s < 3600) return Math.floor(s / 60) + " min fa";
    const oggi = new Date().toDateString() === new Date(d).toDateString();
    return (oggi ? "" : new Date(d).toLocaleDateString("it-IT", { weekday: "short" }) + " ") + hhmm(d);
  }
  function avatar(p, cls = "") {
    if (p && p.foto) return `<img class="av ${cls}" src="${esc(fotoUrl(p.foto))}" alt="" loading="lazy">`;
    const n = (p && p.nome) || "?";
    let h = 0;
    for (const c of n) h = (h * 31 + c.charCodeAt(0)) % 360;
    return `<span class="av ${cls}" style="background:hsl(${h} 45% 42%)">${esc(n.slice(0, 1).toUpperCase())}</span>`;
  }
  const nomeDi = (id) => (G.profili.get(id) || {}).nome || "?";
  const regola = (c) => G.regole.find((r) => r.codice === c) || { nome: c, emoji: "", punti: 0 };

  // ------------------------------------------------------------ avvio
  async function avvia() {
    if (!cfg || !cfg.url || !cfg.key || !window.supabase) return pronto();
    document.body.classList.add("gioco");
    G.sb = supabase.createClient(cfg.url, cfg.key, { auth: { persistSession: true, autoRefreshToken: true, storageKey: "bacaro-gioco" } });
    try { G.visti = new Set(JSON.parse(localStorage.getItem("avvisiVisti") || "[]")); } catch (e) { /* ignora */ }
    montaUI();
    aggiornaMenu();
    if (await collega()) {
      ascolta();
      if (!G.io) apriEntra();
    }
    pronto();
  }

  // sessione e dati di base; se fallisce si riprova dal menu (Iscriviti / Accedi)
  async function collega() {
    try {
      let { data: { session } } = await G.sb.auth.getSession();
      if (!session) {
        const r = await G.sb.auth.signInAnonymously();
        if (r.error) throw r.error;
        session = r.data.session;
      }
      G.uid = session.user.id;
      await Promise.all([caricaProfili(), caricaRegole(), caricaAvvisi(), caricaImpostazioni()]);
      G.io = [...G.profili.values()].find((p) => p.user_id === G.uid) || null;
      G.collegato = true;
      aggiornaMenu();
      return true;
    } catch (e) {
      console.warn(e);
      toast("Gioco non raggiungibile: " + spiegaErrore(e));
      return false;
    }
  }

  async function caricaProfili() {
    const { data, error } = await G.sb.from("profili").select("id,user_id,nome,bio,foto,ruolo");
    if (error) throw error;
    G.profili = new Map(data.map((p) => [p.id, p]));
    if (G.io) G.io = G.profili.get(G.io.id) || null;
  }
  async function caricaRegole() {
    const { data, error } = await G.sb.from("regole").select("*").order("ordine");
    if (error) throw error;
    G.regole = data;
  }
  // se manca la tabella (script SQL non ancora rilanciato) il gioco va avanti con le foto facoltative
  async function caricaImpostazioni() {
    const { data } = await G.sb.from("impostazioni").select("*");
    for (const r of data || []) G.imp[r.chiave] = r.valore;
  }
  // foto obbligatoria solo per le sfide, e solo se l'admin l'ha attivata
  const vuoleFoto = (r) => !!G.imp.foto_sfide && (r.categoria === "Sfide" || r.codice === "sfida_lampo");
  async function caricaAvvisi() {
    const da = new Date(Date.now() - 6 * 3600e3).toISOString();
    const { data, error } = await G.sb.from("avvisi").select("*").gte("created_at", da).order("created_at");
    if (error) throw error;
    G.avvisi = data;
    mostraAvvisi();
  }
  const attivo = (a) => new Date(a.inizio) <= new Date() && (!a.fine || new Date(a.fine) > new Date());
  const doppiAttivo = () => G.avvisi.find((a) => a.tipo === "doppi" && attivo(a));
  const sfideAttive = () => G.avvisi.filter((a) => a.tipo === "sfida" && attivo(a));

  // tempo reale: avvisi dell'admin come banner, log e foto che si aggiornano
  function ascolta() {
    const ch = G.sb.channel("gioco");
    ch.on("postgres_changes", { event: "*", schema: "public", table: "avvisi" }, (ev) => {
      const a = ev.new;
      if (ev.eventType === "INSERT") { if (!G.avvisi.some((x) => x.id === a.id)) G.avvisi.push(a); }
      else if (ev.eventType === "UPDATE") G.avvisi = G.avvisi.map((x) => (x.id === a.id ? a : x));
      else G.avvisi = G.avvisi.filter((x) => x.id !== ev.old.id);
      mostraAvvisi();
    });
    ch.on("postgres_changes", { event: "INSERT", schema: "public", table: "punti" }, async (ev) => {
      const p = ev.new;
      if (!G.profili.has(p.profilo_id)) await caricaProfili().catch(() => {});
      if (p.profilo_id !== (G.io && G.io.id) && /^(checkin|primo|canta|balla|personaggio|sfida_lampo|badge)/.test(p.codice)) {
        toast(`${nomeDi(p.profilo_id)} ${segno(p.punti)} ${regola(p.codice).emoji} ${regola(p.codice).nome}`);
      }
      if (p.profilo_id === (G.io && G.io.id)) aggiornaMenu();
      if (G.pagina && G.pagina.live) G.pagina.live("punti", p);
    });
    ch.on("postgres_changes", { event: "INSERT", schema: "public", table: "foto" }, (ev) => { if (G.pagina && G.pagina.live) G.pagina.live("foto", ev.new); });
    ch.on("postgres_changes", { event: "*", schema: "public", table: "commenti" }, (ev) => { if (G.pagina && G.pagina.live) G.pagina.live("commenti", ev.new || ev.old); });
    ch.on("postgres_changes", { event: "*", schema: "public", table: "reazioni" }, (ev) => { if (G.pagina && G.pagina.live) G.pagina.live("reazioni", ev.new || ev.old); });
    ch.on("postgres_changes", { event: "*", schema: "public", table: "impostazioni" }, (ev) => {
      if (ev.new && ev.new.chiave) G.imp[ev.new.chiave] = ev.new.valore;
    });
    // se il canale cade (rete del telefono) riprova da solo
    ch.subscribe((stato) => {
      if (stato === "CHANNEL_ERROR" || stato === "TIMED_OUT") {
        console.warn("realtime", stato);
        setTimeout(() => { G.sb.removeChannel(ch); ascolta(); }, 5000);
      }
    });
    if (ascolta.fatto) return;
    ascolta.fatto = true;
    // al rientro nell'app (telefono in tasca) si rilegge tutto: il canale potrebbe essersi perso qualcosa
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") return;
      caricaAvvisi().catch(() => {});
      caricaImpostazioni().catch(() => {});
      if (G.pagina && G.pagina.ricarica) G.pagina.ricarica();
    });
    // rete di sicurezza: anche senza tempo reale gli avvisi arrivano entro 15 secondi
    setInterval(() => {
      if (document.visibilityState === "visible") caricaAvvisi().catch(() => {});
      else mostraAvvisi();
    }, 15000);
  }

  // ------------------------------------------------------------ interfaccia di base
  function montaUI() {
    const d = document.createElement("div");
    d.innerHTML = `
      <div class="gfab">
        <button id="g-piu" class="gbtn-piu" aria-label="Segna punti">+</button>
        <button id="g-foto" class="gbtn-foto" aria-label="Aggiungi una foto"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg></button>
      </div>
      <div id="g-avvisi" class="g-avvisi" aria-live="polite"></div>
      <div id="g-drawer" class="g-drawer" hidden><div class="g-drawer-in" role="dialog" aria-label="Menu"></div></div>
      <section id="g-pagina" class="g-pagina" hidden><header><button class="g-x" data-chiudi aria-label="Chiudi">‹</button><h2></h2></header><div class="g-pagina-body"></div></section>
      <div id="g-modale" class="g-modale" hidden><div class="g-modale-in" role="dialog"></div></div>
      <input id="g-file" type="file" accept="image/*" hidden>`;
    document.body.append(...d.children);
    $("#menuBtn").hidden = false;
    $("#menuBtn").addEventListener("click", apriMenu);
    $("#g-drawer").addEventListener("click", (e) => {
      if (e.target.id === "g-drawer") return chiudiMenu();
      const b = e.target.closest("[data-p]");
      if (!b) return;
      chiudiMenu();
      if (b.dataset.p === "entra") entra();
      else apriPagina(b.dataset.p);
    });
    $("#g-pagina").addEventListener("click", (e) => { if (e.target.closest("[data-chiudi]")) chiudiPagina(); });
    $("#g-modale").addEventListener("click", (e) => { if (e.target.id === "g-modale" || e.target.closest("[data-chiudi]")) chiudiModale(); });
    $("#g-piu").addEventListener("click", () => conProfilo(() => apriSegna()));
    $("#g-foto").addEventListener("click", () => conProfilo(() => apriNuovaFoto()));
    $("#g-avvisi").addEventListener("click", (e) => {
      const b = e.target.closest("[data-a]");
      if (!b) return;
      const a = G.avvisi.find((x) => x.id === +b.dataset.a);
      if (b.dataset.azione === "sfida") conProfilo(() => apriSegnaSfida(a));
      segnaVisto(a.id);
      mostraAvvisi();
    });
    addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (!$("#g-modale").hidden) chiudiModale();
      else if (!$("#g-drawer").hidden) chiudiMenu();
      else if (!$("#g-pagina").hidden) chiudiPagina();
    });
  }

  async function entra() {
    if (!G.collegato && !(await collega())) return;
    if (!G.io) apriEntra();
  }

  function conProfilo(fn) {
    if (!G.collegato || !G.io) return entra();
    fn();
  }

  async function mieiPunti() {
    if (!G.io) return null;
    const { data } = await G.sb.from("classifica").select("totale").eq("id", G.io.id).maybeSingle();
    return data ? data.totale : 0;
  }

  async function aggiornaMenu() {
    const box = $("#g-drawer .g-drawer-in");
    // senza profilo il menu offre solo l'ingresso
    const voci = G.io ? [["classifica", "🏆", "Classifica"], ["punteggi", "📜", "Punteggi"], ["foto", "📸", "Foto"], ["regolamento", "📖", "Regolamento"], ["profilo", "👤", "Profilo"]] : [["entra", "👋", "Iscriviti / Accedi"]];
    if (isAdmin()) voci.push(["admin", "⚙️", "Admin"]);
    box.innerHTML = `
      <div class="g-me">${G.io ? `${avatar(G.io, "big")}<div><b>${esc(G.io.nome)}</b><span id="g-mieipunti">…</span></div>` : `<div><b>Bacaro Tour 2026</b><span>Crea il tuo profilo per giocare</span></div>`}</div>
      <nav>${voci.map(([p, e, t]) => `<button data-p="${p}"><span>${e}</span>${t}</button>`).join("")}</nav>`;
    const t = await mieiPunti().catch(() => null);
    const el = $("#g-mieipunti");
    if (el && t != null) el.textContent = `${num(t)} punti`;
  }
  function apriMenu() {
    if (!G.sb) return;
    aggiornaMenu();
    $("#g-drawer").hidden = false;
    requestAnimationFrame(() => $("#g-drawer").classList.add("open"));
  }
  function chiudiMenu() { $("#g-drawer").classList.remove("open"); $("#g-drawer").hidden = true; }

  function apriModale(html, onMount) {
    const m = $("#g-modale");
    // elemento nuovo a ogni apertura: i listener della modale precedente non restano attaccati
    const vecchio = $(".g-modale-in", m);
    const box = vecchio.cloneNode(false);
    vecchio.replaceWith(box);
    box.innerHTML = `<button class="g-x g-x-mod" data-chiudi aria-label="Chiudi">✕</button>${html}`;
    m.hidden = false;
    if (onMount) onMount(box);
    return box;
  }
  function chiudiModale() { $("#g-modale").hidden = true; $("#g-modale .g-modale-in").innerHTML = ""; }

  const PAGINE = { classifica: pagClassifica, punteggi: pagPunteggi, foto: pagFoto, regolamento: pagRegolamento, profilo: pagProfilo, admin: pagAdmin };
  function apriPagina(nome, arg) {
    if (!G.io) return entra();
    const sec = $("#g-pagina");
    const v = PAGINE[nome](arg);
    G.pagina = v;
    $("h2", sec).textContent = v.titolo;
    const body = $(".g-pagina-body", sec).cloneNode(false);
    $(".g-pagina-body", sec).replaceWith(body);
    sec.hidden = false;
    v.render(body);
  }
  function chiudiPagina() { $("#g-pagina").hidden = true; G.pagina = null; }

  // ------------------------------------------------------------ entra / crea profilo
  // Pagina di avvio dopo la password del gruppo: iscriviti o accedi (o rimanda e vai alla mappa).
  function apriEntra() {
    if ($(".g-benvenuto")) return;
    let foto = null;
    const pag = document.createElement("div");
    pag.className = "g-benvenuto";
    pag.innerHTML = `
      <button type="button" class="g-benv-x" data-chiudi aria-label="Torna alla mappa">‹ Mappa</button>
      <div class="g-benv-in">
        <img src="icons/icon-192.png" alt="" width="64" height="64">
        <h1>Bacaro Tour 2026</h1>
        <p class="muted">Punti, classifica e foto del gruppo.</p>
        <div class="g-seg"><button type="button" data-m="nuovo" aria-pressed="true">Iscriviti</button><button type="button" data-m="entra" aria-pressed="false">Accedi</button></div>
        <form id="g-entra" class="g-form">
          <button type="button" class="g-avpick solo-nuovo" id="g-avpick" aria-label="Aggiungi la tua foto"><span>📷</span><small>Foto</small></button>
          <label>Nome <input name="nome" required maxlength="24" minlength="2" autocomplete="nickname" placeholder="Come ti chiamano"></label>
          <label id="g-pinbox" hidden>PIN <input name="pin" inputmode="numeric" pattern="\\d{4}" maxlength="4" autocomplete="off" placeholder="••••"></label>
          <label class="solo-nuovo">Bio <span class="muted">(facoltativa)</span><input name="bio" maxlength="160" placeholder="Ombra preferita, superpotere…"></label>
          <button class="btn primary" type="submit">Iscriviti</button>
          <p class="g-err" id="g-err" role="alert" hidden></p>
          <p class="muted g-nota" id="g-nota">Su questo telefono resti collegato. Da un altro telefono, o dopo aver messo l'app nella Home, usa Accedi col tuo nome.</p>
          <button type="button" class="g-dopo" data-chiudi>Più tardi, vai alla mappa</button>
        </form>
      </div>`;
    document.body.append(pag);
    document.body.classList.add("benvenuto");
    let modo = "nuovo";
    const f = $("#g-entra", pag);
    // si può rimandare: poi dal menu ☰ si torna qui con Iscriviti / Accedi
    const chiudi = () => { pag.remove(); document.body.classList.remove("benvenuto"); };
    pag.querySelectorAll("[data-chiudi]").forEach((b) => b.addEventListener("click", chiudi));
    pag.querySelectorAll("[data-m]").forEach((b) => b.addEventListener("click", () => {
      modo = b.dataset.m;
      pag.querySelectorAll("[data-m]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      pag.querySelectorAll(".solo-nuovo").forEach((x) => { x.hidden = modo !== "nuovo"; });
      $("button[type=submit]", f).textContent = modo === "nuovo" ? "Iscriviti" : "Accedi";
      $("#g-nota", pag).textContent = modo === "nuovo"
        ? "Su questo telefono resti collegato. Da un altro telefono, o dopo aver messo l'app nella Home, usa Accedi col tuo nome."
        : "Scrivi il nome con cui ti sei iscritto.";
      $("#g-pinbox", pag).hidden = true;
      f.pin.value = "";
    }));
    // il selettore del telefono offre sia la fotocamera sia il rullino
    $("#g-avpick", pag).addEventListener("click", async () => {
      const file = await scegliFile();
      if (!file) return;
      try {
        foto = await ritagliaAvatar(file);
        $("#g-avpick", pag).innerHTML = `<img src="${URL.createObjectURL(foto)}" alt="La tua foto">`;
      } catch (e) { errore(e); }
    });
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = $("button[type=submit]", f);
      const box = $("#g-err", pag);
      box.hidden = true;
      btn.disabled = true;
      const testo = btn.textContent;
      btn.textContent = "Un attimo…";
      const nome = f.nome.value.trim(), pin = f.pin.value.trim();
      try {
        const r = modo === "nuovo"
          ? await G.sb.rpc("crea_profilo", { p_nome: nome, p_bio: f.bio.value.trim() })
          : await G.sb.rpc("entra_profilo", { p_nome: nome, p_pin: pin || null });
        // solo il profilo dell'admin ha un PIN: il server lo chiede e il campo compare
        if (r.error && /PIN richiesto/.test(r.error.message)) {
          $("#g-pinbox", pag).hidden = false;
          f.pin.focus();
          throw new Error("Questo profilo è protetto da PIN");
        }
        if (r.error) throw r.error;
        if (!r.data) throw new Error("PIN sbagliato");
        await caricaProfili();
        G.io = G.profili.get(r.data);
        if (modo === "nuovo" && foto) await salvaAvatar(foto).catch(() => toast("Profilo creato, ma la foto non è partita: riprova da Profilo"));
        chiudi();
        aggiornaMenu();
        toast(modo === "nuovo" ? `Benvenuto ${G.io.nome}! Tocca + per segnare punti` : `Bentornato ${G.io.nome}`);
      } catch (err) {
        // l'errore resta scritto sotto il pulsante (un toast finirebbe dietro la pagina)
        console.warn(err);
        box.textContent = spiegaErrore(err);
        box.hidden = false;
      }
      btn.disabled = false;
      btn.textContent = testo;
    });
  }

  function spiegaErrore(e) {
    const m = (e && (e.message || e.error_description)) || "";
    if (/could not find the function|schema cache/i.test(m)) return "Il database non è aggiornato: va lanciato di nuovo lo script schema.sql in Supabase.";
    if (/permission denied/i.test(m)) return `Il database non ha i permessi (${m.replace(/^.*permission denied for /i, "")}): va lanciato di nuovo lo script schema.sql in Supabase.`;
    if (/failed to fetch|network/i.test(m)) return "Nessuna connessione con il server, riprova.";
    return m || "Qualcosa è andato storto, riprova";
  }

  // foto profilo: ritaglio quadrato al centro, 256 px
  async function ritagliaAvatar(file) {
    const src = await decodifica(file);
    const s = Math.min(src.width, src.height);
    const c = tela(src, (src.width - s) / 2, (src.height - s) / 2, s, s, 400, 400);
    const blob = await new Promise((ok) => c.toBlob(ok, "image/jpeg", 0.85));
    if (!blob) throw new Error("Non riesco a leggere questa foto");
    return blob;
  }
  // la foto va nella cartella di chi la carica (anche quando l'admin la mette a un altro profilo)
  async function salvaAvatar(blob, io = G.io) {
    const path = `${G.io.id}/avatar-${Date.now()}.jpg`;
    const up = await G.sb.storage.from("foto").upload(path, blob, { contentType: "image/jpeg", cacheControl: "31536000" });
    if (up.error) throw up.error;
    const { error } = await G.sb.from("profili").update({ foto: path }).eq("id", io.id);
    if (error) throw error;
    if (io.foto) G.sb.storage.from("foto").remove([io.foto]);
    await caricaProfili();
  }

  // ------------------------------------------------------------ segna punti
  function selettoreGiocatore() {
    if (!isAdmin()) return "";
    const ps = [...G.profili.values()].sort((a, b) => a.nome.localeCompare(b.nome));
    return `<label class="g-per">Punti per <select id="g-per">${ps.map((p) => `<option value="${p.id}"${p.id === G.io.id ? " selected" : ""}>${esc(p.nome)}</option>`).join("")}</select></label>`;
  }
  const perChi = (box) => { const s = $("#g-per", box); return s && s.value !== G.io.id ? s.value : null; };

  // Bevi e Mangia hanno la quantità (− 1 +) e un solo Registra; il resto si apre con un tocco.
  // solo: una sola categoria (scorciatoie dalla scheda locale); extra: bacaro da attaccare ai punti
  const CON_QTA = ["Bevi", "Mangia"];
  function apriSegna(solo = null, extra = {}) {
    const x2 = doppiAttivo();
    const cat = solo ? [solo] : ["Bevi", "Mangia", "Esplora", "Sfide"];
    const sfide = solo ? [] : sfideAttive();
    const qta = {};
    const titolo = solo ? ({ Bevi: "🍷 Bevi", Mangia: "🍢 Mangia" }[solo] || solo) : "Segna punti";
    apriModale(`
      <h3>${titolo}</h3>
      ${extra.p_bacaro_nome ? `<p class="muted">da ${esc(extra.p_bacaro_nome)}</p>` : ""}
      ${x2 ? `<p class="g-x2">⚡ Punti doppi fino alle ${hhmm(x2.fine)}</p>` : ""}
      ${selettoreGiocatore()}
      ${sfide.map((a) => `<button class="g-sfida" data-sfida="${a.id}"><b>⚡ ${esc(a.titolo)}</b><span>${num(a.punti || 0)} punti${a.fine ? " · entro le " + hhmm(a.fine) : ""}${G.imp.foto_sfide ? " · con foto" : ""}</span></button>`).join("")}
      ${cat.map((c) => {
        const rr = G.regole.filter((r) => r.categoria === c && r.segnabile);
        if (CON_QTA.includes(c)) return `${solo ? "" : `<div class="section-t">${c}</div>`}<div class="g-qlista">${rr.map((r) =>
          `<div class="g-qrow" data-q="${r.codice}"><span class="e">${r.emoji}</span><span class="n">${esc(r.nome)}<span class="p">${segno(r.punti)}</span></span>
            <div class="g-step"><button type="button" data-meno aria-label="Uno in meno" disabled>−</button><b>0</b><button type="button" data-piu aria-label="Uno in più">+</button></div></div>`).join("")}</div>`;
        return `<div class="section-t">${c}</div><div class="g-azioni">${rr.map((r) =>
          `<button data-c="${r.codice}"><span class="e">${r.emoji}</span><span class="n">${esc(r.codice === "checkin" ? "Check-in in un bacaro" : r.nome)}</span><span class="p">${segno(r.punti)}${vuoleFoto(r) ? " 📷" : ""}</span></button>`).join("")}</div>`;
      }).join("")}
      ${cat.some((c) => CON_QTA.includes(c)) ? `<div class="g-registra"><button class="btn primary" id="g-reg" disabled>Scegli cosa segnare</button></div>` : ""}`, (box) => {
      const reg = $("#g-reg", box);
      const totale = () => Object.entries(qta).reduce((t, [c, n]) => t + regola(c).punti * n, 0) * (x2 ? 2 : 1);
      const aggiorna = () => {
        const t = totale();
        reg.disabled = t === 0;
        reg.textContent = t ? `Registra ${segno(t)}${x2 ? " (doppi!)" : ""}` : "Scegli cosa segnare";
      };
      reg?.addEventListener("click", async () => {
        const voci = Object.entries(qta).filter(([, n]) => n > 0);
        if (!voci.length) return;
        const per = perChi(box), t = totale();
        reg.disabled = true;
        reg.textContent = "Segno…";
        try {
          for (const [c, n] of voci) {
            const { error } = await G.sb.rpc("segna", { p_codice: c, p_qta: n, p_per: per, ...extra });
            if (error) throw error;
            delete qta[c]; // se una voce dopo fallisce, Riprova non rimanda quelle già segnate
          }
          chiudiModale();
          toast(`${segno(t)} ${voci.map(([c, n]) => (n > 1 ? n + "× " : "") + regola(c).emoji).join(" ")}`);
          aggiornaMenu();
        } catch (err) {
          errore(err);
          box.querySelectorAll("[data-q]").forEach((row) => { const n = qta[row.dataset.q] || 0; $("b", row).textContent = n; row.classList.toggle("on", n > 0); $("[data-meno]", row).disabled = !n; });
          aggiorna();
          if (!reg.disabled) reg.textContent = "Riprova " + reg.textContent.replace("Registra ", "");
        }
      });
      box.addEventListener("click", (e) => {
        const q = e.target.closest("[data-q]");
        if (q) {
          const c = q.dataset.q;
          const d = e.target.closest("[data-piu]") ? 1 : e.target.closest("[data-meno]") ? -1 : 0;
          if (!d) return;
          const n = Math.max(0, Math.min(10, (qta[c] || 0) + d));
          qta[c] = n;
          $("b", q).textContent = n;
          q.classList.toggle("on", n > 0);
          $("[data-meno]", q).disabled = n === 0;
          $("[data-piu]", q).disabled = n === 10;
          return aggiorna();
        }
        const s = e.target.closest("[data-sfida]");
        if (s) return apriSegnaSfida(G.avvisi.find((a) => a.id === +s.dataset.sfida), perChi(box));
        const b = e.target.closest("[data-c]");
        if (!b) return;
        const per = perChi(box);
        if (b.dataset.c === "checkin") return apriCheckin(null, per);
        apriConferma(regola(b.dataset.c), {}, per);
      });
    });
  }

  function apriSegnaSfida(a, per = null) {
    if (!a || !attivo(a)) return toast("Questa sfida è scaduta");
    apriConferma({ codice: "sfida_lampo", nome: a.titolo, emoji: "⚡", punti: a.punti || 0 }, { p_avviso: a.id }, per);
  }

  // Ultimo passo: nota, foto (obbligatoria per le sfide solo se l'admin lo decide) e invio
  function apriConferma(r, extra, per) {
    const obbl = vuoleFoto(r), sfida = r.categoria === "Sfide" || r.codice === "sfida_lampo";
    const x2 = doppiAttivo() && !/^badge|correzione/.test(r.codice) ? 2 : 1;
    let foto = null;
    apriModale(`
      <h3>${r.emoji} ${esc(r.nome)}</h3>
      <p class="g-tot">${segno(r.punti * x2)} punti${x2 > 1 ? " (doppi!)" : ""}${per ? " per " + esc(nomeDi(per)) : ""}${extra.p_bacaro_nome ? " · " + esc(extra.p_bacaro_nome) : ""}</p>
      <form class="g-form" id="g-conf">
        <label>Nota <span class="muted">(facoltativa)</span><input name="nota" maxlength="140" placeholder="${sfida ? "Cosa hai fatto?" : "Dove, con chi…"}"></label>
        <div class="g-fotobox" id="g-fb">
          <button type="button" class="btn" id="g-scegli">📷 ${obbl ? "Aggiungi la foto (obbligatoria)" : "Aggiungi una foto"}</button>
        </div>
        <button class="btn primary" type="submit">Segna ${segno(r.punti * x2)}</button>
      </form>`, (box) => {
      $("#g-scegli", box).addEventListener("click", async () => {
        const f = await scegliFile();
        if (!f) return;
        try {
          foto = await preparaFoto(f);
          $("#g-fb", box).innerHTML = `<img class="g-anteprima" src="${foto.anteprima}" alt="Anteprima"><button type="button" class="btn" id="g-togli">Togli la foto</button>`;
          $("#g-togli", box).addEventListener("click", () => apriConferma(r, extra, per));
        } catch (e) { errore(e); }
      });
      $("#g-conf", box).addEventListener("submit", async (e) => {
        e.preventDefault();
        if (obbl && !foto && !isAdmin()) return toast("Per questa serve una foto");
        const btn = $("button[type=submit]", e.target);
        btn.disabled = true;
        btn.textContent = foto ? "Carico la foto…" : "Segno…";
        try {
          const nota = e.target.nota.value.trim();
          let fotoId = null;
          // la foto è di chi prende i punti: se l'admin segna per un altro resta nel suo profilo
          if (foto && !per) fotoId = await caricaFoto(foto, nota || r.nome);
          const { error } = await G.sb.rpc("segna", { p_codice: r.codice, p_nota: nota, p_foto: fotoId, p_per: per, ...extra });
          if (error) throw error;
          chiudiModale();
          toast(`${segno(r.punti * x2)} ${r.emoji} ${r.nome}`);
          aggiornaMenu();
          if (extra.p_bacaro_id) segnaCheckinFatto(extra.p_bacaro_id);
        } catch (err) {
          errore(err);
          btn.disabled = false;
          btn.textContent = "Riprova";
        }
      });
    });
  }

  // ------------------------------------------------------------ check-in
  const bacari = () => App.locali().filter((l) => l.tipo === "bacaro" || l.tipo === "osteria");
  const sestiereDa = (l) => SESTIERI.find((s) => new RegExp("\\b" + s + "\\b", "i").test(l.indirizzo || "")) || "";
  let mieiCheckin = null;
  async function caricaMieiCheckin() {
    if (!G.io) return new Set();
    const { data } = await G.sb.from("punti").select("bacaro_id").eq("profilo_id", G.io.id).eq("codice", "checkin").eq("annullato", false);
    mieiCheckin = new Set((data || []).map((x) => x.bacaro_id));
    return mieiCheckin;
  }
  function segnaCheckinFatto(id) { if (mieiCheckin) mieiCheckin.add(id); }

  async function apriCheckin(scelto, per) {
    const fatti = per ? new Set() : await caricaMieiCheckin();
    const ref = App.posizione();
    const tutti = bacari().map((l) => [App.dist(ref, l), l]).sort((a, b) => a[0] - b[0]);
    const riga = ([d, l]) => `<button class="row" data-b="${esc(l.id)}"${fatti.has(l.id) ? " disabled" : ""}><div><div class="t">${fatti.has(l.id) ? "✓ " : ""}${esc(l.nome)}</div><div class="s">${esc(l.indirizzo || "")}</div></div><div class="m">${d < 1000 ? Math.round(d / 10) * 10 + " m" : (d / 1000).toFixed(1).replace(".", ",") + " km"}</div></button>`;
    if (scelto) return confermaCheckin(scelto, per);
    apriModale(`
      <h3>📍 Check-in</h3>
      <p class="muted">${App.haPosizione() ? "I bacari più vicini a te." : "Bacari vicini al centro della mappa (tocca il mirino per usare la tua posizione)."} Vale una volta per bacaro.</p>
      <input class="g-cerca" id="g-cb" type="search" placeholder="Cerca un bacaro" autocomplete="off">
      <div class="list" id="g-lb">${tutti.slice(0, 12).map(riga).join("")}</div>`, (box) => {
      $("#g-cb", box).addEventListener("input", (e) => {
        const s = App.norm(e.target.value.trim());
        $("#g-lb", box).innerHTML = (s.length < 2 ? tutti.slice(0, 12) : tutti.filter(([, l]) => App.norm(l.nome).includes(s)).slice(0, 30)).map(riga).join("");
      });
      $("#g-lb", box).addEventListener("click", (e) => {
        const b = e.target.closest("[data-b]");
        if (b) confermaCheckin(App.locali().find((l) => l.id === b.dataset.b), per);
      });
    });
  }
  function confermaCheckin(l, per) {
    apriConferma(regola("checkin"), { p_bacaro_id: l.id, p_bacaro_nome: l.nome, p_sestiere: sestiereDa(l) || null }, per);
  }

  // dalla scheda di un locale
  async function schedaLocale(l, el) {
    if (!(l.tipo === "bacaro" || l.tipo === "osteria")) return;
    await giocoPronto; // la scheda può aprirsi da un link prima che il gioco sia collegato
    if (!G.uid) return;
    const box = document.createElement("div");
    box.className = "g-locale";
    const act = $(".actions", el);
    const fatti = G.io ? (mieiCheckin || await caricaMieiCheckin().catch(() => new Set())) : new Set();
    if (!act || !act.isConnected) return; // nel frattempo si è aperta un'altra scheda
    box.innerHTML = fatti.has(l.id)
      ? `<button class="btn" disabled>✓ Check-in fatto qui</button>`
      : `<button class="btn primary" id="g-ci">📍 Check-in da ${esc(l.nome)} ${segno(regola("checkin").punti || 3)}</button>`;
    box.insertAdjacentHTML("beforeend", `<div class="g-scorc"><button class="btn" data-cat="Bevi">🍷 Bevi</button><button class="btn" data-cat="Mangia">🍢 Mangia</button></div>`);
    act.before(box);
    $("#g-ci", box)?.addEventListener("click", () => conProfilo(() => confermaCheckin(l, null)));
    box.querySelectorAll("[data-cat]").forEach((b) => b.addEventListener("click", () =>
      conProfilo(() => apriSegna(b.dataset.cat, { p_bacaro_id: l.id, p_bacaro_nome: l.nome }))));
  }

  // ------------------------------------------------------------ foto: compressione sul telefono e caricamento
  function scegliFile() {
    return new Promise((ok) => {
      const inp = $("#g-file");
      inp.value = "";
      const h = () => { inp.removeEventListener("change", h); ok(inp.files[0] || null); };
      inp.addEventListener("change", h);
      inp.click();
    });
  }
  async function decodifica(file) {
    if (window.createImageBitmap) {
      try { return await createImageBitmap(file, { imageOrientation: "from-image" }); } catch (e) { /* si prova con <img> */ }
    }
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
  }
  // ridimensiona a metà per volta: un solo salto da 4000px a 1600px su Safari viene sgranato
  function tela(src, sx, sy, sw, sh, w, h) {
    let img = src, x = sx, y = sy, cw = sw, ch = sh;
    while (cw / 2 >= w && ch / 2 >= h) {
      const t = document.createElement("canvas");
      t.width = Math.round(cw / 2); t.height = Math.round(ch / 2);
      const g = t.getContext("2d");
      g.imageSmoothingQuality = "high";
      g.drawImage(img, x, y, cw, ch, 0, 0, t.width, t.height);
      img = t; x = 0; y = 0; cw = t.width; ch = t.height;
    }
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const g = c.getContext("2d");
    g.imageSmoothingQuality = "high";
    g.drawImage(img, x, y, cw, ch, 0, 0, w, h);
    return c;
  }
  async function riduci(src, lato, maxByte) {
    const w0 = src.width, h0 = src.height;
    let k = Math.min(1, lato / Math.max(w0, h0));
    let q = 0.85, blob = null, w, h;
    for (let i = 0; i < 6; i++) {
      w = Math.round(w0 * k); h = Math.round(h0 * k);
      const c = tela(src, 0, 0, w0, h0, w, h);
      blob = await new Promise((ok) => c.toBlob(ok, "image/jpeg", q));
      if (!blob) throw new Error("Non riesco a leggere questa foto");
      if (blob.size <= maxByte) break;
      if (q > 0.6) q -= 0.1; else k *= 0.8;
    }
    return { blob, w, h };
  }
  async function preparaFoto(file) {
    if (!/^image\//.test(file.type) && !/\.(jpe?g|png|heic|heif|webp)$/i.test(file.name)) throw new Error("Solo foto, niente video");
    let src;
    try { src = await decodifica(file); } catch (e) { throw new Error("Il telefono non riesce a leggere questa foto (" + (file.type || file.name) + ")"); }
    const grande = await riduci(src, 1600, 450 * 1024);
    const piccola = await riduci(src, 480, 45 * 1024);
    return { grande, piccola, anteprima: URL.createObjectURL(grande.blob) };
  }
  async function caricaFoto(f, didascalia) {
    const base = `${G.io.id}/${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const st = G.sb.storage.from("foto");
    const opt = { contentType: "image/jpeg", cacheControl: "31536000", upsert: false };
    const [a, b] = await Promise.all([st.upload(base + ".jpg", f.grande.blob, opt), st.upload(base + "_p.jpg", f.piccola.blob, opt)]);
    if (a.error || b.error) throw new Error("Caricamento della foto non riuscito: " + (a.error || b.error).message);
    const { data, error } = await G.sb.from("foto").insert({
      profilo_id: G.io.id, path: base + ".jpg", thumb: base + "_p.jpg", larghezza: f.grande.w, altezza: f.grande.h, didascalia: (didascalia || "").slice(0, 140),
    }).select("id").single();
    if (error) throw error;
    return data.id;
  }

  async function apriNuovaFoto() {
    const file = await scegliFile();
    if (!file) return;
    let f;
    try { f = await preparaFoto(file); } catch (e) { return errore(e); }
    apriModale(`
      <h3>📸 Nuova foto</h3>
      <img class="g-anteprima" src="${f.anteprima}" alt="Anteprima">
      <form class="g-form" id="g-nf">
        <label>Didascalia <input name="d" maxlength="140" placeholder="Dove siamo, chi c'è…"></label>
        <button class="btn primary" type="submit">Pubblica</button>
        <p class="muted">Per una sfida (canta, balla, personaggio) usa il + così prendi anche i punti.</p>
      </form>`, (box) => {
      $("#g-nf", box).addEventListener("submit", async (e) => {
        e.preventDefault();
        const btn = $("button", e.target);
        btn.disabled = true; btn.textContent = "Carico…";
        try {
          await caricaFoto(f, e.target.d.value.trim());
          chiudiModale();
          toast("Foto pubblicata");
        } catch (err) { errore(err); btn.disabled = false; btn.textContent = "Riprova"; }
      });
    });
  }

  // ------------------------------------------------------------ avvisi in-app
  function segnaVisto(id) {
    G.visti.add(id);
    try { localStorage.setItem("avvisiVisti", JSON.stringify([...G.visti].slice(-100))); } catch (e) { /* ignora */ }
  }
  function mostraAvvisi() {
    const box = $("#g-avvisi");
    if (!box) return;
    const x2 = doppiAttivo();
    const nuovi = G.avvisi.filter((a) => !G.visti.has(a.id) && (a.tipo === "messaggio" ? Date.now() - new Date(a.created_at) < 3 * 3600e3 : attivo(a)));
    let h = x2 ? `<div class="g-pill">⚡ Punti doppi fino alle ${hhmm(x2.fine)}</div>` : "";
    h += nuovi.slice(-2).map((a) => `<div class="g-banner ${a.tipo}">
      <div><b>${a.tipo === "doppi" ? "⚡ " : a.tipo === "sfida" ? "🎯 " : "📣 "}${esc(a.titolo)}</b>${a.testo ? `<span>${esc(a.testo)}</span>` : ""}${a.tipo === "sfida" ? `<span>${num(a.punti || 0)} punti${a.fine ? ", entro le " + hhmm(a.fine) : ""}</span>` : ""}</div>
      ${a.tipo === "sfida" ? `<button class="btn primary" data-a="${a.id}" data-azione="sfida">Partecipa</button>` : ""}
      <button class="g-x" data-a="${a.id}" aria-label="Chiudi">✕</button></div>`).join("");
    box.innerHTML = h;
  }

  // ------------------------------------------------------------ pagine del menu
  function pagClassifica() {
    return {
      titolo: "Classifica",
      async render(el) {
        el.innerHTML = `<p class="empty">Carico…</p>`;
        const { data, error } = await G.sb.from("classifica").select("*").order("totale", { ascending: false });
        if (error) { el.innerHTML = `<p class="empty">Classifica non disponibile.</p>`; return; }
        let pos = 0, prev = null;
        el.innerHTML = data.length ? `<ol class="g-classifica">${data.map((r, i) => {
          if (r.totale !== prev) { pos = i + 1; prev = r.totale; }
          const p = G.profili.get(r.id) || r;
          return `<li class="${G.io && r.id === G.io.id ? "io" : ""}"><button data-u="${r.id}"><span class="pos">${pos <= 3 ? ["🥇", "🥈", "🥉"][pos - 1] : pos}</span>${avatar(p)}<span class="n"><b>${esc(r.nome)}</b><small>${r.bacari} bacari</small></span><span class="pt">${num(r.totale)}</span></button></li>`;
        }).join("")}</ol>` : `<p class="empty">Ancora nessun giocatore.</p>`;
        el.addEventListener("click", (e) => { const b = e.target.closest("[data-u]"); if (b) apriGiocatore(b.dataset.u); });
      },
      ricarica() { apriPagina("classifica"); },
    };
  }

  async function apriGiocatore(id) {
    const p = G.profili.get(id);
    if (!p) return;
    const { data } = await G.sb.from("punti").select("*").eq("profilo_id", id).order("created_at", { ascending: false }).limit(50);
    const tot = (data || []).filter((x) => !x.annullato).reduce((s, x) => s + Number(x.punti), 0);
    apriModale(`
      <div class="g-prof">${avatar(p, "big")}<div><h3>${esc(p.nome)}${p.ruolo === "admin" ? ' <span class="tag">admin</span>' : ""}</h3>${p.bio ? `<p>${esc(p.bio)}</p>` : ""}</div></div>
      <p class="g-tot">${num(tot)} punti</p>
      <div class="g-log">${(data || []).map(rigaLog).join("") || '<p class="empty">Nessun punto ancora.</p>'}</div>`);
  }

  function rigaLog(x) {
    const r = regola(x.codice);
    const p = G.profili.get(x.profilo_id);
    const det = [x.bacaro_nome, x.nota].filter(Boolean);
    const da = x.creato_da && x.creato_da !== x.profilo_id ? ` · da ${esc(nomeDi(x.creato_da))}` : "";
    return `<div class="g-riga${x.annullato ? " annullato" : ""}" data-id="${x.id}">
      ${avatar(p, "sm")}
      <div class="g-riga-t"><div><b>${esc(nomeDi(x.profilo_id))}</b> ${x.qta > 1 ? x.qta + "× " : ""}${r.emoji} ${esc(x.codice === "sfida_lampo" && x.nota ? "Sfida lampo" : r.nome)}</div>
        <small>${esc(det.join(" · "))}${det.length ? " · " : ""}${quando(x.created_at)}${da}${x.molt > 1 ? " · ×2" : ""}</small>
        ${isAdmin() ? `<div class="g-adm"><button data-mod="${x.id}">Modifica</button><button data-ann="${x.id}">${x.annullato ? "Ripristina" : "Annulla"}</button></div>` : ""}</div>
      ${x.foto_id ? `<button class="g-thumb" data-foto="${x.foto_id}"><img alt="" loading="lazy" data-thumb="${x.foto_id}"></button>` : ""}
      <span class="g-pt">${segno(x.punti)}</span></div>`;
  }
  // miniature del log: un'unica richiesta per le foto della pagina
  async function riempiMiniature(el) {
    const imgs = [...el.querySelectorAll("img[data-thumb]:not([src])")];
    if (!imgs.length) return;
    const ids = [...new Set(imgs.map((i) => +i.dataset.thumb))];
    const { data } = await G.sb.from("foto").select("id,thumb").in("id", ids);
    const m = new Map((data || []).map((f) => [f.id, f.thumb]));
    for (const i of imgs) { const t = m.get(+i.dataset.thumb); if (t) i.src = fotoUrl(t); else i.closest(".g-thumb").remove(); }
  }

  function pagPunteggi() {
    let ultimo = null;
    let lista;
    return {
      titolo: "Punteggi",
      async render(el) {
        el.innerHTML = `<div class="g-log" id="g-log"></div><button class="btn" id="g-altri" hidden>Carica altri</button>`;
        lista = $("#g-log", el);
        const altri = $("#g-altri", el);
        const carica = async () => {
          let q = G.sb.from("punti").select("*").order("id", { ascending: false }).limit(PAGINA);
          if (ultimo) q = q.lt("id", ultimo);
          const { data, error } = await q;
          if (error) return errore(error);
          if (!ultimo && !data.length) lista.innerHTML = '<p class="empty">Ancora nessun punto. Tocca + sulla mappa per iniziare.</p>';
          lista.insertAdjacentHTML("beforeend", data.map(rigaLog).join(""));
          if (data.length) ultimo = data[data.length - 1].id;
          altri.hidden = data.length < PAGINA;
          riempiMiniature(lista);
        };
        altri.addEventListener("click", carica);
        lista.addEventListener("click", (e) => {
          const f = e.target.closest("[data-foto]");
          if (f) return apriFoto(+f.dataset.foto);
          const a = e.target.closest("[data-ann]");
          if (a) return adminAnnulla(+a.dataset.ann, a);
          const m = e.target.closest("[data-mod]");
          if (m) return adminModifica(+m.dataset.mod);
        });
        await carica();
      },
      live(tipo, x) {
        if (tipo !== "punti" || !lista) return;
        if (lista.querySelector(`[data-id="${x.id}"]`)) return;
        lista.querySelector(".empty")?.remove();
        lista.insertAdjacentHTML("afterbegin", rigaLog(x));
        riempiMiniature(lista);
      },
      ricarica() { apriPagina("punteggi"); },
    };
  }

  async function adminAnnulla(id, btn) {
    const riga = btn.closest(".g-riga");
    const ann = !riga.classList.contains("annullato");
    const { error } = await G.sb.from("punti").update({ annullato: ann }).eq("id", id);
    if (error) return errore(error);
    riga.classList.toggle("annullato", ann);
    btn.textContent = ann ? "Ripristina" : "Annulla";
    toast(ann ? "Punti annullati" : "Punti ripristinati");
  }
  async function adminModifica(id) {
    const { data: x } = await G.sb.from("punti").select("*").eq("id", id).single();
    if (!x) return;
    apriModale(`<h3>Modifica punteggio</h3><p class="muted">${esc(nomeDi(x.profilo_id))} · ${esc(regola(x.codice).nome)}</p>
      <form class="g-form" id="g-mf"><label>Punti <input name="p" type="number" step="0.5" value="${x.punti}" required></label>
      <label>Nota <input name="n" maxlength="140" value="${esc(x.nota)}"></label><button class="btn primary">Salva</button></form>`, (box) => {
      $("#g-mf", box).addEventListener("submit", async (e) => {
        e.preventDefault();
        const { error } = await G.sb.from("punti").update({ punti: Number(e.target.p.value), nota: e.target.n.value.trim() }).eq("id", id);
        if (error) return errore(error);
        chiudiModale();
        toast("Punteggio aggiornato");
        if (G.pagina && G.pagina.ricarica) G.pagina.ricarica();
      });
    });
  }

  // ------------------------------------------------------------ feed foto
  function cardFoto(f, reaz, comm) {
    const p = G.profili.get(f.profilo_id);
    const mie = new Set(reaz.filter((r) => G.io && r.profilo_id === G.io.id).map((r) => r.emoji));
    const ratio = f.larghezza && f.altezza ? ` width="${f.larghezza}" height="${f.altezza}"` : "";
    return `<article class="g-card${f.nascosta ? " annullato" : ""}" data-f="${f.id}">
      <header>${avatar(p, "sm")}<b>${esc(nomeDi(f.profilo_id))}</b><small>${quando(f.created_at)}</small>
        ${isAdmin() ? `<span class="g-adm"><button data-nasc="${f.id}">${f.nascosta ? "Mostra" : "Nascondi"}</button><button data-del="${f.id}">Elimina</button></span>`
          : G.io && f.profilo_id === G.io.id ? `<span class="g-adm"><button data-del="${f.id}">Elimina</button></span>` : ""}</header>
      <img src="${esc(fotoUrl(f.path))}" alt="${esc(f.didascalia || "Foto")}" loading="lazy" decoding="async"${ratio}>
      ${f.didascalia ? `<p class="g-did">${esc(f.didascalia)}</p>` : ""}
      <div class="g-reaz">${EMOJI.map((e) => { const n = reaz.filter((r) => r.emoji === e).length; return `<button data-r="${e}" aria-pressed="${mie.has(e)}">${e}${n ? ` <span>${n}</span>` : ""}</button>`; }).join("")}</div>
      <div class="g-comm">${comm.map((c) => `<p data-c="${c.id}"><b>${esc(nomeDi(c.profilo_id))}</b> ${esc(c.testo)}${isAdmin() || (G.io && c.profilo_id === G.io.id) ? ` <button class="g-delc" data-delc="${c.id}" aria-label="Cancella commento">✕</button>` : ""}</p>`).join("")}</div>
      <form class="g-scrivi"><input name="t" maxlength="200" placeholder="Commenta…" autocomplete="off" enterkeyhint="send"><button aria-label="Invia">↑</button></form>
    </article>`;
  }

  function pagFoto(soloId) {
    let ultimo = null, feed;
    const dati = new Map(); // id → {f, reaz, comm}
    const disegna = (id) => {
      const d = dati.get(id);
      const vecchia = feed.querySelector(`[data-f="${id}"]`);
      if (vecchia) vecchia.outerHTML = cardFoto(d.f, d.reaz, d.comm);
    };
    async function arricchisci(foto) {
      const ids = foto.map((f) => f.id);
      if (!ids.length) return;
      const [r, c] = await Promise.all([
        G.sb.from("reazioni").select("*").in("foto_id", ids),
        G.sb.from("commenti").select("*").in("foto_id", ids).order("created_at"),
      ]);
      for (const f of foto) dati.set(f.id, { f, reaz: (r.data || []).filter((x) => x.foto_id === f.id), comm: (c.data || []).filter((x) => x.foto_id === f.id) });
    }
    return {
      titolo: soloId ? "Foto" : "Foto del gruppo",
      async render(el) {
        el.innerHTML = `<div class="g-feed" id="g-feed"></div><button class="btn" id="g-altre" hidden>Carica altre</button>`;
        feed = $("#g-feed", el);
        const altre = $("#g-altre", el);
        const carica = async () => {
          let q = G.sb.from("foto").select("*").order("id", { ascending: false }).limit(10);
          if (soloId) q = q.eq("id", soloId);
          else if (ultimo) q = q.lt("id", ultimo);
          const { data, error } = await q;
          if (error) return errore(error);
          await arricchisci(data);
          if (!ultimo && !data.length) feed.innerHTML = '<p class="empty">Ancora nessuna foto. Tocca la fotocamera sulla mappa.</p>';
          feed.insertAdjacentHTML("beforeend", data.map((f) => { const d = dati.get(f.id); return cardFoto(f, d.reaz, d.comm); }).join(""));
          if (data.length) ultimo = data[data.length - 1].id;
          altre.hidden = !!soloId || data.length < 10;
        };
        altre.addEventListener("click", carica);
        feed.addEventListener("click", async (e) => {
          const card = e.target.closest("[data-f]");
          if (!card) return;
          const id = +card.dataset.f, d = dati.get(id);
          const r = e.target.closest("[data-r]");
          if (r) {
            if (!G.io) return apriEntra();
            const em = r.dataset.r, mia = d.reaz.find((x) => x.profilo_id === G.io.id && x.emoji === em);
            const res = mia
              ? await G.sb.from("reazioni").delete().match({ foto_id: id, profilo_id: G.io.id, emoji: em })
              : await G.sb.from("reazioni").insert({ foto_id: id, profilo_id: G.io.id, emoji: em });
            if (res.error) return errore(res.error);
            d.reaz = mia ? d.reaz.filter((x) => x !== mia) : [...d.reaz, { foto_id: id, profilo_id: G.io.id, emoji: em }];
            return disegna(id);
          }
          const dc = e.target.closest("[data-delc]");
          if (dc) {
            const { error } = await G.sb.from("commenti").delete().eq("id", +dc.dataset.delc);
            if (error) return errore(error);
            d.comm = d.comm.filter((c) => c.id !== +dc.dataset.delc);
            return disegna(id);
          }
          const n = e.target.closest("[data-nasc]");
          if (n) {
            const { error } = await G.sb.from("foto").update({ nascosta: !d.f.nascosta }).eq("id", id);
            if (error) return errore(error);
            d.f.nascosta = !d.f.nascosta;
            toast(d.f.nascosta ? "Foto nascosta agli altri" : "Foto di nuovo visibile");
            return disegna(id);
          }
          const del = e.target.closest("[data-del]");
          if (del) {
            if (del.dataset.conferma !== "1") { del.dataset.conferma = "1"; del.textContent = "Sicuro?"; return; }
            const { error } = await G.sb.from("foto").delete().eq("id", id);
            if (error) return errore(error);
            G.sb.storage.from("foto").remove([d.f.path, d.f.thumb]);
            card.remove();
            toast("Foto eliminata");
          }
        });
        feed.addEventListener("submit", async (e) => {
          e.preventDefault();
          if (!G.io) return apriEntra();
          const card = e.target.closest("[data-f]");
          const id = +card.dataset.f, t = e.target.t.value.trim();
          if (!t) return;
          const { data, error } = await G.sb.from("commenti").insert({ foto_id: id, profilo_id: G.io.id, testo: t }).select("*").single();
          if (error) return errore(error);
          const d = dati.get(id);
          if (!d.comm.some((c) => c.id === data.id)) d.comm.push(data);
          disegna(id);
        });
        await carica();
      },
      async live(tipo, x) {
        if (!feed) return;
        if (tipo === "foto" && !soloId && !dati.has(x.id)) {
          await arricchisci([x]);
          feed.querySelector(".empty")?.remove();
          feed.insertAdjacentHTML("afterbegin", cardFoto(x, [], []));
          return;
        }
        const d = dati.get(x.foto_id);
        if (!d) return;
        // per commenti e reazioni si rilegge la foto toccata (le cancellazioni arrivano senza dettagli)
        await arricchisci([d.f]);
        disegna(d.f.id);
      },
      ricarica() { apriPagina("foto", soloId); },
    };
  }
  function apriFoto(id) { apriPagina("foto", id); }

  function pagRegolamento() {
    return {
      titolo: "Regolamento",
      render(el) {
        const cat = ["Bevi", "Mangia", "Esplora", "Sfide", "Badge"];
        el.innerHTML = cat.map((c) => `<div class="section-t">${c}</div><table class="g-tab">${G.regole.filter((r) => r.categoria === c).map((r) =>
          `<tr><td>${r.emoji}</td><td>${esc(r.nome)}${vuoleFoto(r) ? " <small>(con foto)</small>" : ""}</td><td>${segno(r.punti)}</td></tr>`).join("")}</table>`).join("")
          + `<div class="section-t">Admin</div><table class="g-tab"><tr><td>⚡</td><td>Sfida lampo${G.imp.foto_sfide ? " (con foto)" : ""}</td><td>a scelta</td></tr><tr><td>⏱️</td><td>Punti doppi per un tempo limitato</td><td>×2</td></tr></table>
          <div class="section-t">Regole</div>
          <ul class="g-regole"><li>Il check-in vale una volta per bacaro. Il primo del gruppo a entrarci prende +1.</li>
          <li>${G.imp.foto_sfide ? "Le sfide valgono solo con la foto, che finisce nel feed." : "La foto è sempre facoltativa: se la aggiungi finisce nel feed."}</li>
          <li>Durante i punti doppi tutto vale ×2, tranne badge e correzioni.</li>
          <li>I badge arrivano da soli: 10 bacari diversi, 10 cicchetti.</li>
          <li>L'admin può correggere o annullare qualsiasi punteggio. Si gioca sulla fiducia: niente furbate.</li></ul>`;
      },
    };
  }

  function pagProfilo() {
    return {
      titolo: "Il mio profilo",
      render(el) {
        const io = G.io;
        el.innerHTML = `
          <div class="g-prof">${avatar(io, "big")}<button class="btn" id="g-av">Cambia foto</button></div>
          <form class="g-form" id="g-pf">
            <label>Nome <input name="nome" required maxlength="24" minlength="2" value="${esc(io.nome)}"></label>
            <label>Bio <textarea name="bio" maxlength="160" rows="3">${esc(io.bio)}</textarea></label>
            <button class="btn primary">Salva</button>
          </form>
          <div class="section-t">Questo telefono</div>
          <p class="muted">Per entrare da un altro telefono usa "Accedi" con il tuo nome.</p>
          <button class="btn" id="g-esci">Esci da questo telefono</button>`;
        $("#g-pf", el).addEventListener("submit", async (e) => {
          e.preventDefault();
          const { error } = await G.sb.from("profili").update({ nome: e.target.nome.value.trim(), bio: e.target.bio.value.trim() }).eq("id", io.id);
          if (error) return errore(/profili_nome_unico|duplicate/.test(error.message) ? new Error("Nome già preso") : error);
          await caricaProfili();
          toast("Profilo salvato");
          aggiornaMenu();
        });
        $("#g-av", el).addEventListener("click", async () => {
          const file = await scegliFile();
          if (!file) return;
          try {
            await salvaAvatar(await ritagliaAvatar(file));
            aggiornaMenu();
            apriPagina("profilo");
            toast("Foto del profilo aggiornata");
          } catch (err) { errore(err); }
        });
        $("#g-esci", el).addEventListener("click", async (e) => {
          if (e.target.dataset.conferma !== "1") { e.target.dataset.conferma = "1"; e.target.textContent = "Tocca di nuovo per uscire"; return; }
          await G.sb.auth.signOut();
          const r = await G.sb.auth.signInAnonymously();
          G.uid = r.data && r.data.session ? r.data.session.user.id : null;
          G.io = null;
          mieiCheckin = null;
          chiudiPagina();
          aggiornaMenu();
          apriEntra();
        });
      },
    };
  }

  // ------------------------------------------------------------ pannello admin
  function pagAdmin() {
    const opzGiocatori = () => [...G.profili.values()].sort((a, b) => a.nome.localeCompare(b.nome)).map((p) => `<option value="${p.id}">${esc(p.nome)}</option>`).join("");
    const durate = (def) => [10, 15, 30, 45, 60, 120].map((m) => `<option value="${m}"${m === def ? " selected" : ""}>${m} min</option>`).join("");
    return {
      titolo: "Admin",
      render(el) {
        if (!isAdmin()) { el.innerHTML = '<p class="empty">Solo per l\'admin.</p>'; return; }
        el.innerHTML = `<div class="g-seg"><button data-tab="profili" aria-pressed="${G.schedaAdmin !== "gioco"}">👥 Profili</button><button data-tab="gioco" aria-pressed="${G.schedaAdmin === "gioco"}">🎲 Gioco</button></div><div id="g-adm-body"></div>`;
        el.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => { G.schedaAdmin = b.dataset.tab; this.render(el); }));
        const corpo = $("#g-adm-body", el);
        if (G.schedaAdmin !== "gioco") return adminProfili(corpo);
        this.gioco(corpo);
      },
      gioco(el) {
        const att = G.avvisi.filter((a) => a.tipo !== "messaggio" && attivo(a));
        el.innerHTML = `
          ${att.length ? `<div class="section-t">In corso</div><div class="list">${att.map((a) => `<div class="row"><div><div class="t">${a.tipo === "doppi" ? "⚡ Punti doppi" : "🎯 " + esc(a.titolo)}</div><div class="s">fino alle ${a.fine ? hhmm(a.fine) : "—"}</div></div><button class="btn" data-stop="${a.id}">Termina</button></div>`).join("")}</div>` : ""}
          <div class="section-t">📷 Foto nelle sfide</div>
          <label class="g-switch"><input type="checkbox" id="g-fotosfide"${G.imp.foto_sfide ? " checked" : ""}><span>Foto obbligatoria per sfide e sfide lampo</span></label>
          <div class="section-t">📣 Messaggio a tutti</div>
          <form class="g-form" data-f="messaggio"><input name="titolo" required maxlength="80" placeholder="Titolo (es. Ci vediamo a Rialto!)"><input name="testo" maxlength="300" placeholder="Testo (facoltativo)"><button class="btn primary">Invia</button></form>
          <div class="section-t">⚡ Punti doppi</div>
          <form class="g-form" data-f="doppi"><select name="durata">${durate(30)}</select><button class="btn primary">Lancia i punti doppi</button></form>
          <div class="section-t">🎯 Sfida lampo</div>
          <form class="g-form" data-f="sfida"><input name="titolo" required maxlength="80" placeholder="Es. Foto con un gondoliere"><input name="testo" maxlength="300" placeholder="Dettagli (facoltativo)">
            <div class="g-riga2"><label>Punti <input name="punti" type="number" step="0.5" value="3" required></label><label>Durata <select name="durata">${durate(30)}</select></label></div>
            <button class="btn primary">Lancia la sfida</button></form>
          <div class="section-t">✏️ Correggi un punteggio</div>
          <form class="g-form" data-f="correzione"><select name="chi">${opzGiocatori()}</select>
            <div class="g-riga2"><label>Punti (anche negativi) <input name="punti" type="number" step="0.5" value="1" required></label></div>
            <input name="nota" maxlength="140" placeholder="Motivo"><button class="btn primary">Assegna</button></form>
          <p class="muted">Per annullare o cambiare un singolo punteggio: menu → Punteggi, ogni riga ha Modifica e Annulla. Foto e commenti si moderano dal feed Foto.</p>`;
        $("#g-fotosfide", el).addEventListener("change", async (e) => {
          const v = e.target.checked;
          const { data, error } = await G.sb.from("impostazioni").update({ valore: v }).eq("chiave", "foto_sfide").select();
          if (error || !data || !data.length) { e.target.checked = !v; return errore(error || new Error("Rilancia schema.sql in Supabase per attivare questa opzione")); }
          G.imp.foto_sfide = v;
          toast(v ? "Foto obbligatoria nelle sfide" : "Foto facoltativa anche nelle sfide");
        });
        el.addEventListener("click", async (e) => {
          const b = e.target.closest("[data-stop]");
          if (!b) return;
          const { error } = await G.sb.from("avvisi").update({ fine: new Date().toISOString() }).eq("id", +b.dataset.stop);
          if (error) return errore(error);
          await caricaAvvisi();
          toast("Terminato");
          apriPagina("admin");
        });
        el.addEventListener("submit", async (e) => {
          e.preventDefault();
          const f = e.target, tipo = f.dataset.f;
          const btn = $("button", f);
          btn.disabled = true;
          try {
            let res;
            const fine = f.durata ? new Date(Date.now() + +f.durata.value * 60000).toISOString() : null;
            if (tipo === "messaggio") res = await G.sb.from("avvisi").insert({ tipo, titolo: f.titolo.value.trim(), testo: f.testo.value.trim(), creato_da: G.io.id });
            if (tipo === "doppi") res = await G.sb.from("avvisi").insert({ tipo, titolo: "Punti doppi!", testo: `Tutto vale doppio per ${f.durata.value} minuti`, fine, creato_da: G.io.id });
            if (tipo === "sfida") res = await G.sb.from("avvisi").insert({ tipo, titolo: f.titolo.value.trim(), testo: f.testo.value.trim(), punti: Number(f.punti.value), fine, creato_da: G.io.id });
            if (tipo === "correzione") res = await G.sb.rpc("segna", { p_codice: "correzione", p_nota: f.nota.value.trim(), p_per: f.chi.value, p_punti: Number(f.punti.value) });
            if (res.error) throw res.error;
            toast({ messaggio: "Messaggio inviato", doppi: "Punti doppi lanciati", sfida: "Sfida lanciata", correzione: "Punti assegnati" }[tipo]);
            if (tipo !== "correzione") { await caricaAvvisi(); apriPagina("admin"); } else f.reset();
          } catch (err) { errore(err); }
          btn.disabled = false;
        });
      },
    };
  }

  // ------------------------------------------------------------ admin: profili (aggiungi, modifica, elimina)
  async function adminProfili(cont) {
    // contenitore nuovo a ogni giro, così i listener non si sommano
    const el = document.createElement("div");
    cont.replaceChildren(el);
    el.innerHTML = '<p class="empty">Carico…</p>';
    await caricaProfili().catch(() => {});
    const [cl, cp] = await Promise.all([G.sb.from("classifica").select("id,totale"), G.sb.rpc("admin_con_pin")]);
    if (cl.error || cp.error) { el.innerHTML = `<p class="g-err">${esc(spiegaErrore(cl.error || cp.error))}</p>`; return; }
    const tot = new Map(cl.data.map((r) => [r.id, r.totale]));
    const conPin = new Set(cp.data.map((x) => (typeof x === "string" ? x : Object.values(x)[0])));
    const ps = [...G.profili.values()].sort((a, b) => a.nome.localeCompare(b.nome));
    el.innerHTML = `
      <button class="btn primary g-nuovo" id="g-np">+ Nuovo profilo</button>
      <div class="g-plist">${ps.map((p) => `<div class="g-prow" data-id="${p.id}">${avatar(p)}
        <div class="g-prow-t"><b>${esc(p.nome)}</b>${p.ruolo === "admin" ? ' <span class="tag">admin</span>' : ""}${conPin.has(p.id) ? " 🔒" : ""}
          <small>${num(tot.get(p.id) || 0)} punti${p.user_id ? "" : " · non ancora entrato"}${p.bio ? " · " + esc(p.bio) : ""}</small></div>
        <span class="g-adm"><button data-edit="${p.id}">Modifica</button>${p.id === G.io.id ? "" : `<button data-elimina="${p.id}">Elimina</button>`}</span></div>`).join("")}</div>
      <p class="muted">Un profilo creato qui non è legato a nessun telefono: l'amico entra con Accedi e il suo nome (più il PIN, se gliel'hai messo). Eliminare un profilo cancella anche i suoi punti, foto e commenti.</p>`;
    $("#g-np", el).addEventListener("click", () => modaleProfilo(null, false, () => adminProfili(cont)));
    el.addEventListener("click", async (e) => {
      const ed = e.target.closest("[data-edit]");
      if (ed) return modaleProfilo(G.profili.get(ed.dataset.edit), conPin.has(ed.dataset.edit), () => adminProfili(cont));
      const del = e.target.closest("[data-elimina]");
      if (!del) return;
      const p = G.profili.get(del.dataset.elimina);
      if (del.dataset.conferma !== "1") { del.dataset.conferma = "1"; del.textContent = `Elimina ${p.nome}?`; return; }
      del.disabled = true;
      const { error } = await G.sb.rpc("admin_elimina_profilo", { p_profilo: p.id });
      if (error) { del.disabled = false; return errore(error); }
      if (p.foto) G.sb.storage.from("foto").remove([p.foto]);
      toast(`${p.nome} eliminato`);
      adminProfili(cont);
    });
  }

  // nuovo profilo (p = null) o modifica
  function modaleProfilo(p, haPin, fatto) {
    let foto = null;
    apriModale(`
      <h3>${p ? "Modifica " + esc(p.nome) : "Nuovo profilo"}</h3>
      <form class="g-form" id="g-mp">
        <button type="button" class="g-avpick" id="g-mpav" aria-label="Foto del profilo">${p && p.foto ? `<img src="${esc(fotoUrl(p.foto))}" alt="">` : "<span>📷</span><small>Foto</small>"}</button>
        <label>Nome <input name="nome" required maxlength="24" minlength="2" value="${esc(p ? p.nome : "")}"></label>
        <label>Bio <span class="muted">(facoltativa)</span><input name="bio" maxlength="160" value="${esc(p ? p.bio : "")}"></label>
        <label>PIN <span class="muted">${p ? (haPin ? "(ce l'ha: scrivine uno nuovo per cambiarlo)" : "(facoltativo: protegge il profilo)") : "(facoltativo)"}</span>
          <input name="pin" inputmode="numeric" pattern="\\d{4}" maxlength="4" autocomplete="off" placeholder="••••"></label>
        ${p && haPin && p.ruolo !== "admin" ? '<label class="g-check"><input type="checkbox" name="togli"> Togli il PIN</label>' : ""}
        <button class="btn primary" type="submit">${p ? "Salva" : "Crea il profilo"}</button>
      </form>`, (box) => {
      $("#g-mpav", box).addEventListener("click", async () => {
        const file = await scegliFile();
        if (!file) return;
        try { foto = await ritagliaAvatar(file); $("#g-mpav", box).innerHTML = `<img src="${URL.createObjectURL(foto)}" alt="">`; } catch (e) { errore(e); }
      });
      $("#g-mp", box).addEventListener("submit", async (e) => {
        e.preventDefault();
        const f = e.target, btn = $("button[type=submit]", f);
        btn.disabled = true;
        try {
          const nome = f.nome.value.trim(), bio = f.bio.value.trim(), pin = f.pin.value.trim();
          let id = p && p.id;
          if (!p) {
            const r = await G.sb.rpc("admin_crea_profilo", { p_nome: nome, p_bio: bio, p_pin: pin || null });
            if (r.error) throw r.error;
            id = r.data;
          } else {
            const r = await G.sb.from("profili").update({ nome, bio }).eq("id", id);
            if (r.error) throw /profili_nome_unico|duplicate/.test(r.error.message) ? new Error("Nome già preso") : r.error;
            if (pin || (f.togli && f.togli.checked)) {
              const r2 = await G.sb.rpc("admin_pin", { p_profilo: id, p_pin: pin || null });
              if (r2.error) throw r2.error;
            }
          }
          await caricaProfili();
          if (foto) await salvaAvatar(foto, G.profili.get(id));
          if (id === G.io.id) G.io = G.profili.get(id);
          chiudiModale();
          aggiornaMenu();
          toast(p ? "Profilo aggiornato" : `Profilo ${nome} creato`);
          fatto();
        } catch (err) { errore(err); btn.disabled = false; }
      });
    });
  }

  window.Gioco = { avvia, schedaLocale };
})();
