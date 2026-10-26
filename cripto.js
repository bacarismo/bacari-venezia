// Chiave Google cifrata con la password del gruppo (PBKDF2 + AES-GCM, Web Crypto).
// Nel repo pubblico c'è solo il testo cifrato: senza password non si legge.
(function () {
  const ITER = 310000;
  const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

  async function derive(password, salt) {
    const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: ITER, hash: "SHA-256" },
      base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }

  async function cifra(dati, password) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await derive(password, salt);
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(dati)));
    return { salt: b64(salt), iv: b64(iv), ct: b64(ct) };
  }

  // Restituisce i dati in chiaro, o null se la password è sbagliata
  async function decifra(blob, password) {
    try {
      const key = await derive(password, unb64(blob.salt));
      const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(blob.iv) }, key, unb64(blob.ct));
      return JSON.parse(new TextDecoder().decode(pt));
    } catch (e) {
      return null;
    }
  }

  window.Cripto = { cifra, decifra };
})();
