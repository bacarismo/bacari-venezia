// Percorsi a piedi sulla rete pedonale di OpenStreetMap (data/grafo.json), calcolati sul telefono.
(function () {
  "use strict";
  const PASSO = 75;          // metri al minuto (4,5 km/h)
  const PONTE = 15;          // ogni ponte o scalinata "costa" 15 m in più
  let G = null;
  let loading = null;

  function load() {
    if (G) return Promise.resolve(G);
    if (!loading) {
      loading = fetch("data/grafo.json")
        .then((r) => { if (!r.ok) throw new Error("grafo " + r.status); return r.json(); })
        .then(build)
        .catch((e) => { loading = null; throw e; });
    }
    return loading;
  }

  function build(raw) {
    const n = raw.n.length / 2;
    const lat = new Float64Array(n), lon = new Float64Array(n);
    for (let i = 0; i < n; i++) { lat[i] = raw.n[2 * i] / 1e5; lon[i] = raw.n[2 * i + 1] / 1e5; }
    const m = raw.e.length / 5;
    const deg = new Int32Array(n + 1);
    for (let k = 0; k < m; k++) { deg[raw.e[5 * k]]++; deg[raw.e[5 * k + 1]]++; }
    const off = new Int32Array(n + 1);
    for (let i = 0; i < n; i++) off[i + 1] = off[i] + deg[i];
    const fill = off.slice(0, n);
    const to = new Int32Array(2 * m), edge = new Int32Array(2 * m);
    for (let k = 0; k < m; k++) {
      const a = raw.e[5 * k], b = raw.e[5 * k + 1];
      to[fill[a]] = b; edge[fill[a]++] = k;
      to[fill[b]] = a; edge[fill[b]++] = k;
    }
    G = { n, m, lat, lon, off, to, edge, e: raw.e, g: raw.g, w: raw.w };
    return G;
  }

  function cost(k) {
    return G.e[5 * k + 2] + (G.e[5 * k + 4] ? PONTE : 0);
  }

  function metri(aLat, aLon, bLat, bLon) {
    const dy = (aLat - bLat) * 111320;
    const dx = (aLon - bLon) * 111320 * Math.cos(aLat * Math.PI / 180);
    return Math.hypot(dx, dy);
  }

  function nearest(la, lo) {
    let best = -1, bd = Infinity;
    for (let i = 0; i < G.n; i++) {
      const d = metri(la, lo, G.lat[i], G.lon[i]);
      if (d < bd) { bd = d; best = i; }
    }
    return { node: best, dist: bd };
  }

  // Dijkstra da un nodo verso tutti (il grafo di Venezia è piccolo: qualche decina di migliaia di nodi)
  function dijkstra(src) {
    const dist = new Float64Array(G.n).fill(Infinity);
    const via = new Int32Array(G.n).fill(-1);
    const heap = [];
    const push = (d, v) => {
      heap.push([d, v]);
      let i = heap.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (heap[p][0] <= heap[i][0]) break;
        [heap[p], heap[i]] = [heap[i], heap[p]];
        i = p;
      }
    };
    const pop = () => {
      const top = heap[0], last = heap.pop();
      if (heap.length) {
        heap[0] = last;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1, r = l + 1;
          let s = i;
          if (l < heap.length && heap[l][0] < heap[s][0]) s = l;
          if (r < heap.length && heap[r][0] < heap[s][0]) s = r;
          if (s === i) break;
          [heap[s], heap[i]] = [heap[i], heap[s]];
          i = s;
        }
      }
      return top;
    };
    dist[src] = 0;
    push(0, src);
    while (heap.length) {
      const [d, u] = pop();
      if (d > dist[u]) continue;
      for (let j = G.off[u]; j < G.off[u + 1]; j++) {
        const v = G.to[j], k = G.edge[j];
        const nd = d + cost(k);
        if (nd < dist[v]) { dist[v] = nd; via[v] = k; push(nd, v); }
      }
    }
    return { src, dist, via };
  }

  function edgeCoords(k, from) {
    const a = G.e[5 * k], b = G.e[5 * k + 1];
    const mid = [];
    const g = G.g[k];
    for (let i = 0; i < g.length; i += 2) mid.push([g[i] / 1e5, g[i + 1] / 1e5]);
    const pts = [[G.lat[a], G.lon[a]], ...mid, [G.lat[b], G.lon[b]]];
    return from === a ? pts : pts.reverse();
  }

  // Percorso dall'origine della Dijkstra al nodo target
  function path(res, target) {
    if (!isFinite(res.dist[target])) return null;
    const seq = [];
    let v = target;
    while (v !== res.src) {
      const k = res.via[v];
      const a = G.e[5 * k], b = G.e[5 * k + 1];
      const u = v === a ? b : a;
      seq.push({ k, from: u });
      v = u;
    }
    seq.reverse();
    const coords = [[G.lat[res.src], G.lon[res.src]]];
    let len = 0, ponti = 0;
    for (const s of seq) {
      coords.push(...edgeCoords(s.k, s.from).slice(1));
      len += G.e[5 * s.k + 2];
      if (G.e[5 * s.k + 4] & 1) ponti++;
    }
    return { seq, coords, len, ponti, costo: res.dist[target] };
  }

  function bearing(p, q) {
    const y = Math.sin((q[1] - p[1]) * Math.PI / 180) * Math.cos(q[0] * Math.PI / 180);
    const x = Math.cos(p[0] * Math.PI / 180) * Math.sin(q[0] * Math.PI / 180) -
      Math.sin(p[0] * Math.PI / 180) * Math.cos(q[0] * Math.PI / 180) * Math.cos((q[1] - p[1]) * Math.PI / 180);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }

  // Istruzioni leggibili: tratti consecutivi con lo stesso nome diventano un solo passo
  function steps(p) {
    const groups = [];
    for (const s of p.seq) {
      const name = G.w[G.e[5 * s.k + 3]] || "";
      const flag = G.e[5 * s.k + 4];
      const pts = edgeCoords(s.k, s.from);
      const len = G.e[5 * s.k + 2];
      const last = groups[groups.length - 1];
      if (last && last.name === name && !!(last.flag & 1) === !!(flag & 1)) {
        last.len += len;
        last.end = pts.slice(-2);
      } else {
        groups.push({ name, flag, len, start: pts.slice(0, 2), end: pts.slice(-2) });
      }
    }
    // i pezzetti senza nome sotto i 20 m si fondono col passo successivo
    const merged = [];
    for (const g of groups) {
      const prev = merged[merged.length - 1];
      if (prev && !prev.name && prev.len < 20 && !(prev.flag & 1)) {
        g.len += prev.len;
        g.start = prev.start;
        merged.pop();
      }
      merged.push(g);
    }
    const out = [];
    merged.forEach((g, i) => {
      let verso = "";
      if (i > 0) {
        const prev = merged[i - 1];
        let d = bearing(g.start[0], g.start[1]) - bearing(prev.end[0], prev.end[1]);
        d = ((d + 540) % 360) - 180;
        verso = Math.abs(d) < 30 ? "dritto" : d > 0 ? "destra" : "sinistra";
      }
      const dove = g.flag & 1 ? (g.name ? `attraversa il ${g.name}` : "attraversa il ponte")
        : g.name ? g.name : "la calle";
      let txt;
      if (g.flag & 1) txt = dove.charAt(0).toUpperCase() + dove.slice(1);
      else if (i === 0) txt = `Parti lungo ${dove}`;
      else if (verso === "dritto") txt = `Prosegui dritto su ${dove}`;
      else txt = `Gira a ${verso} in ${dove}`;
      out.push({ txt, len: g.len, verso, ponte: !!(g.flag & 1) });
    });
    return out;
  }

  window.Percorsi = { load, nearest, dijkstra, path, steps, PASSO, metri, get grafo() { return G; } };
})();
