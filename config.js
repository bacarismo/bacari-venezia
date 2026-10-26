// Accesso protetto: "protetto" contiene la chiave Google cifrata con la password del gruppo.
// Si genera con la pagina cifra.html. null = app libera e senza foto Google.
window.CONFIG = {
  // "Casa": sempre sulla mappa (non si filtra) e bottone "Portami a casa" nella tendina
  casa: { nome: "Locanda Herion", lat: 45.4436791, lon: 12.3280036 },
  // Gioco a punti: progetto Supabase (la chiave "anon" è pubblica per natura, la sicurezza è in supabase/schema.sql)
  supabase: { url: "https://noqtoqybjclwhzspbsvi.supabase.co", key: "sb_publishable__q1loJt5SCcKXhZpF0Q0VA_YqFvX7YJ" },
  protetto: {"salt":"qSBZvwOV9xv7OmpvALywQA==","iv":"3srxgvLnHcSg9xRi","ct":"NvVEz4lXgBht/uvyf8w60Xu+xfNzg86quzTExGgO1s427LLRUnZjqYpn0Bu1lCV+DU59+KjY99IQ7nJSUyBINqXCeJfWStA="},
};
