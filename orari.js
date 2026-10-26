// Interprete minimo di opening_hours di OpenStreetMap (i casi comuni).
// Restituisce null se il formato non è supportato: in quel caso si mostra il testo originale.
(function () {
  const DAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
  const NOMI = ["Lun", "Mar", "Mer", "Gio", "Ven", "Sab", "Dom"];

  function parseDays(sel) {
    const out = new Set();
    for (const part of sel.split(",")) {
      const m = part.trim().match(/^(Mo|Tu|We|Th|Fr|Sa|Su)(?:-(Mo|Tu|We|Th|Fr|Sa|Su))?$/);
      if (!m) return null;
      let a = DAYS.indexOf(m[1]);
      const b = m[2] ? DAYS.indexOf(m[2]) : a;
      for (let i = 0; i < 7; i++) {
        out.add(a);
        if (a === b) break;
        a = (a + 1) % 7;
      }
    }
    return out;
  }

  function hm(s) {
    const m = s.match(/^(\d{1,2}):(\d{2})$/);
    return m ? +m[1] * 60 + +m[2] : null;
  }

  function parseTimes(s) {
    if (/^(off|closed)$/i.test(s)) return [];
    const out = [];
    for (const part of s.split(",")) {
      const m = part.trim().match(/^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})\+?$/);
      if (!m) return null;
      const a = hm(m[1]);
      let b = hm(m[2]);
      if (a == null || b == null) return null;
      if (b <= a) b += 1440; // oltre mezzanotte
      out.push([a, b]);
    }
    return out;
  }

  function parse(src) {
    if (!src) return null;
    const s = src.trim();
    if (s === "24/7") return Array.from({ length: 7 }, () => [[0, 1440]]);
    const week = Array.from({ length: 7 }, () => []);
    // "Mo-Fr 10:00-20:00, Sa 10:00-14:00" usa la virgola come separatore di regole
    const rules = s.split(/;|,(?=\s*(?:Mo|Tu|We|Th|Fr|Sa|Su|PH)\b)/).map((r) => r.trim()).filter(Boolean);
    for (const rule of rules) {
      if (/^PH\b/.test(rule)) continue; // festivi: ignorati
      const m = rule.match(/^((?:(?:Mo|Tu|We|Th|Fr|Sa|Su)(?:-(?:Mo|Tu|We|Th|Fr|Sa|Su))?)(?:\s*,\s*(?:Mo|Tu|We|Th|Fr|Sa|Su)(?:-(?:Mo|Tu|We|Th|Fr|Sa|Su))?)*)(?:\s*,\s*PH)?\s+(.+)$/);
      let days, times;
      if (m) {
        days = parseDays(m[1].replace(/\s/g, ""));
        times = parseTimes(m[2].trim());
      } else {
        days = new Set([0, 1, 2, 3, 4, 5, 6]);
        times = parseTimes(rule);
      }
      if (!days || !times) return null;
      for (const d of days) week[d] = times;
    }
    return week;
  }

  const fmt = (m) => String(Math.floor(m / 60) % 24).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");

  function status(src, now = new Date()) {
    const week = parse(src);
    if (!week) return null;
    const d = (now.getDay() + 6) % 7;
    const m = now.getHours() * 60 + now.getMinutes();
    for (const [a, b] of week[d]) if (a <= m && m < b) return { aperto: true, fino: fmt(b) };
    for (const [, b] of week[(d + 6) % 7]) if (b > 1440 && m + 1440 < b) return { aperto: true, fino: fmt(b) };
    for (let i = 0; i < 7; i++) {
      const dd = (d + i) % 7;
      const next = week[dd].map(([a]) => a).filter((a) => i > 0 || a > m).sort((x, y) => x - y)[0];
      if (next != null) return { aperto: false, apre: (i === 0 ? "" : i === 1 ? "domani " : NOMI[dd] + " ") + fmt(next) };
    }
    return { aperto: false };
  }

  function pretty(src) {
    const week = parse(src);
    if (!week) return src;
    const txt = week.map((t) => (t.length ? t.map(([a, b]) => fmt(a) + "–" + fmt(b)).join(", ") : "chiuso"));
    const lines = [];
    let i = 0;
    while (i < 7) {
      let j = i;
      while (j + 1 < 7 && txt[j + 1] === txt[i]) j++;
      lines.push((i === j ? NOMI[i] : NOMI[i] + "–" + NOMI[j]) + "  " + txt[i]);
      i = j + 1;
    }
    return lines.join("\n");
  }

  window.Orari = { parse, status, pretty };
})();
