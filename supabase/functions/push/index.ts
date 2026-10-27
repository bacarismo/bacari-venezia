// Notifiche push del Bacaro Tour (Supabase Edge Function "push").
// { azione: "chiave" }                     -> chiave pubblica VAPID per iscrivere il telefono
// { azione: "invia", titolo, testo, tag }  -> solo l'admin: manda la notifica a tutti i telefoni iscritti
// Segreti da impostare in Supabase: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY (generati con vapid.html).
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2.117.3";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const pub = Deno.env.get("VAPID_PUBLIC_KEY"), priv = Deno.env.get("VAPID_PRIVATE_KEY");
  if (!pub || !priv) return json({ error: "Mancano i segreti VAPID_PUBLIC_KEY e VAPID_PRIVATE_KEY" }, 500);
  const body = await req.json().catch(() => ({}));
  if (body.azione === "chiave") return json({ chiave: pub });

  // si agisce con il login di chi chiama: admin_iscrizioni risponde solo all'admin
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const { data: iscritti, error } = await sb.rpc("admin_iscrizioni");
  if (error) return json({ error: error.message }, 403);

  webpush.setVapidDetails("https://bacarismo.github.io/bacari-venezia/", pub, priv);
  const payload = JSON.stringify({
    titolo: String(body.titolo ?? "Bacaro Tour").slice(0, 80),
    testo: String(body.testo ?? "").slice(0, 200),
    tag: String(body.tag ?? "avviso").slice(0, 40),
  });
  let inviate = 0, scadute = 0;
  await Promise.all((iscritti ?? []).map(async (s: { endpoint: string; p256dh: string; auth: string }) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 1800 });
      inviate++;
    } catch (e) {
      // telefono che ha tolto il permesso o disinstallato l'app: si toglie dalla lista
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) {
        scadute++;
        await sb.rpc("togli_iscrizione", { p_endpoint: s.endpoint });
      } else console.warn("push", code, (e as Error).message);
    }
  }));
  return json({ inviate, scadute, totali: (iscritti ?? []).length });
});
