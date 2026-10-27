-- Bacaro Tour 2026 · gioco a punti
-- Da incollare in Supabase: SQL Editor → New query → Run.
-- Si può rilanciare quando si vuole: crea quello che manca e aggiorna il resto, senza toccare i dati.
-- Tutte le regole di sicurezza stanno qui (Row Level Security): la chiave "anon" nel codice
-- pubblico permette solo quello che queste regole consentono.

create extension if not exists pgcrypto with schema extensions;

-- ------------------------------------------------------------ profili
create table if not exists public.profili (
  id uuid primary key default gen_random_uuid(),
  user_id uuid unique references auth.users on delete set null,
  nome text not null check (char_length(trim(nome)) between 2 and 24),
  bio text not null default '' check (char_length(bio) <= 160),
  foto text,                                  -- percorso nel bucket "foto"
  ruolo text not null default 'basic' check (ruolo in ('basic', 'admin')),
  created_at timestamptz not null default now()
);
create unique index if not exists profili_nome_unico on public.profili (lower(trim(nome)));

-- PIN separati: nessuna regola li rende leggibili, li usano solo le funzioni qui sotto
create table if not exists public.pin (
  profilo_id uuid primary key references public.profili on delete cascade,
  hash text not null,
  errori int not null default 0,
  bloccato_fino timestamptz
);

create or replace function public.mio_profilo() returns uuid
language sql stable security definer set search_path = public as $$
  select id from profili where user_id = auth.uid()
$$;

create or replace function public.sono_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profili where user_id = auth.uid() and ruolo = 'admin')
$$;

-- Nuovo profilo legato a questo dispositivo (sessione anonima di Supabase).
-- PIN facoltativo: lo usa solo l'admin; un profilo con PIN lo chiede sempre per entrare.
create or replace function public.crea_profilo(p_nome text, p_pin text default null, p_bio text default '') returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare v uuid;
begin
  if auth.uid() is null then raise exception 'Sessione mancante'; end if;
  if p_pin is not null and p_pin <> '' and p_pin !~ '^\d{4}$' then raise exception 'Il PIN deve avere 4 cifre'; end if;
  if exists (select 1 from profili where lower(trim(nome)) = lower(trim(p_nome))) then
    raise exception 'Nome già preso: se sei tu, usa Accedi';
  end if;
  update profili set user_id = null where user_id = auth.uid();
  insert into profili (user_id, nome, bio) values (auth.uid(), trim(p_nome), coalesce(p_bio, '')) returning id into v;
  if p_pin ~ '^\d{4}$' then insert into pin (profilo_id, hash) values (v, crypt(p_pin, gen_salt('bf'))); end if;
  return v;
end $$;

create or replace function public.entra_profilo(p_nome text, p_pin text default null) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare r record;
begin
  if auth.uid() is null then raise exception 'Sessione mancante'; end if;
  select p.id, k.hash, k.errori, k.bloccato_fino into r
    from profili p left join pin k on k.profilo_id = p.id
    where lower(trim(p.nome)) = lower(trim(p_nome));
  if not found then raise exception 'Nessun profilo con questo nome'; end if;
  if r.hash is not null then
    if coalesce(p_pin, '') = '' then raise exception 'PIN richiesto'; end if;
    if r.bloccato_fino > now() then raise exception 'Troppi tentativi, riprova tra qualche minuto'; end if;
    if crypt(p_pin, r.hash) <> r.hash then
      update pin set errori = errori + 1,
        bloccato_fino = case when errori + 1 >= 5 then now() + interval '10 minutes' end
        where profilo_id = r.id;
      return null;  -- PIN sbagliato (un'eccezione annullerebbe il conteggio dei tentativi)
    end if;
    update pin set errori = 0, bloccato_fino = null where profilo_id = r.id;
  end if;
  update profili set user_id = null where user_id = auth.uid() and id <> r.id;
  update profili set user_id = auth.uid() where id = r.id;
  return r.id;
end $$;

-- ------------------------------------------------------------ regolamento
create table if not exists public.regole (
  codice text primary key,
  categoria text not null,
  nome text not null,
  emoji text not null default '',
  punti numeric(5,1) not null,
  richiede_foto boolean not null default false,
  segnabile boolean not null default true,    -- false: li assegna l'app o l'admin
  ordine int not null default 0
);
insert into public.regole (codice, categoria, nome, emoji, punti, richiede_foto, segnabile, ordine) values
  ('ombra',           'Bevi',    'Ombra di vino',                 '🍷', 1,   false, true,  10),
  ('spritz',          'Bevi',    'Spritz',                        '🍹', 1,   false, true,  11),
  ('birra',           'Bevi',    'Birra',                         '🍺', 1,   false, true,  12),
  ('drink',           'Bevi',    'Drink / cocktail',              '🍸', 2,   false, true,  13),
  ('cicchetto_carne', 'Mangia',  'Cicchetto di carne o pesce',    '🐟', 0.5, false, true,  20),
  ('cicchetto_veg',   'Mangia',  'Cicchetto vegetariano',         '🥦', 0.5, false, true,  21),
  ('checkin',         'Esplora', 'Check-in in un bacaro nuovo',   '📍', 3,   false, true,  30),
  ('primo',           'Esplora', 'Primo del gruppo in quel bacaro','🥇', 1,  false, false, 31),
  ('vaporetto',       'Esplora', 'Giro in vaporetto',             '⛴️', 1,   false, true,  33),
  ('canta',           'Sfide',   'Canta una canzone',             '🎤', 3,   false,  true,  40),
  ('balla',           'Sfide',   'Fai un ballo',                  '💃', 3,   false,  true,  41),
  ('personaggio',     'Sfide',   'Foto con un personaggio',       '🎭', 3,   false,  true,  42),
  ('sfida_lampo',     'Admin',   'Sfida lampo',                   '⚡', 0,   false,  true,  50),
  ('badge_bacari',    'Badge',   'Badge: 10 bacari',              '🏅', 5,   false, false, 60),
  ('badge_cicchetto', 'Badge',   'Badge: re del cicchetto (10 cicchetti)', '👑', 5, false, false, 62),
  ('correzione',      'Admin',   'Correzione dell''admin',        '✏️', 0,   false, false, 90)
on conflict (codice) do update set categoria = excluded.categoria, nome = excluded.nome, emoji = excluded.emoji,
  punti = excluded.punti, richiede_foto = excluded.richiede_foto, segnabile = excluded.segnabile, ordine = excluded.ordine;

-- ------------------------------------------------------------ impostazioni del gioco (le cambia l'admin)
create table if not exists public.impostazioni (
  chiave text primary key,
  valore boolean not null
);
-- foto_sfide: se true le sfide (canta, balla, personaggio, sfida lampo) vogliono la foto
insert into public.impostazioni (chiave, valore) values ('foto_sfide', false) on conflict (chiave) do nothing;

-- ------------------------------------------------------------ avvisi (messaggi, punti doppi, sfide lampo)
create table if not exists public.avvisi (
  id bigint generated always as identity primary key,
  tipo text not null check (tipo in ('messaggio', 'doppi', 'sfida')),
  titolo text not null check (char_length(titolo) between 1 and 80),
  testo text not null default '' check (char_length(testo) <= 300),
  punti numeric(5,1),
  inizio timestamptz not null default now(),
  fine timestamptz,
  creato_da uuid references public.profili on delete set null,
  created_at timestamptz not null default now()
);

-- ------------------------------------------------------------ foto, reazioni, commenti
create table if not exists public.foto (
  id bigint generated always as identity primary key,
  profilo_id uuid not null references public.profili on delete cascade,
  path text not null,       -- grande (~300 KB)
  thumb text not null,      -- piccola, per log e griglie
  larghezza int, altezza int,
  didascalia text not null default '' check (char_length(didascalia) <= 140),
  nascosta boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.reazioni (
  foto_id bigint not null references public.foto on delete cascade,
  profilo_id uuid not null references public.profili on delete cascade,
  emoji text not null check (emoji in ('❤️', '😂', '🔥')),
  primary key (foto_id, profilo_id, emoji)
);

create table if not exists public.commenti (
  id bigint generated always as identity primary key,
  foto_id bigint not null references public.foto on delete cascade,
  profilo_id uuid not null references public.profili on delete cascade,
  testo text not null check (char_length(trim(testo)) between 1 and 200),
  created_at timestamptz not null default now()
);

-- ------------------------------------------------------------ punti
create table if not exists public.punti (
  id bigint generated always as identity primary key,
  profilo_id uuid not null references public.profili on delete cascade,
  codice text not null references public.regole,
  punti numeric(6,1) not null,          -- già moltiplicati
  molt numeric(3,1) not null default 1,
  nota text not null default '' check (char_length(nota) <= 140),
  bacaro_id text, bacaro_nome text, sestiere text,
  foto_id bigint references public.foto on delete set null,
  avviso_id bigint references public.avvisi on delete set null,
  creato_da uuid references public.profili on delete set null,
  annullato boolean not null default false,
  created_at timestamptz not null default now()
);
-- quantità: 3 cicchetti in un colpo solo = una riga da 3 × 0,5
alter table public.punti add column if not exists qta int not null default 1 check (qta between 1 and 10);
create index if not exists punti_profilo on public.punti (profilo_id) where not annullato;
-- niente più punti per i sestieri (il sestiere resta solo come indicazione sul check-in)
delete from public.punti where codice in ('sestiere', 'badge_sestieri');
delete from public.regole where codice in ('sestiere', 'badge_sestieri');
create index if not exists punti_data on public.punti (created_at desc);

create or replace view public.classifica with (security_invoker = true) as
  select p.id, p.nome, p.foto,
    coalesce(sum(x.punti) filter (where not x.annullato), 0) as totale,
    count(distinct x.bacaro_id) filter (where x.codice = 'checkin' and not x.annullato) as bacari
  from public.profili p left join public.punti x on x.profilo_id = p.id
  group by p.id;

-- Segna punti. I punti li calcola il server dal regolamento (niente furbate dal telefono):
-- punti doppi se c'è un evento attivo, check-in una volta per bacaro, bonus e badge automatici.
-- L'admin può segnare per altri (p_per) e con punti a scelta (p_punti, anche negativi).
-- p_qta (1-10) solo per Bevi e Mangia: i punti si moltiplicano per la quantità.
drop function if exists public.segna(text, text, text, text, text, bigint, bigint, uuid, numeric);
create or replace function public.segna(
  p_codice text, p_nota text default '', p_bacaro_id text default null, p_bacaro_nome text default null,
  p_sestiere text default null, p_foto bigint default null, p_avviso bigint default null,
  p_per uuid default null, p_punti numeric default null, p_qta int default 1
) returns bigint
language plpgsql security definer set search_path = public as $$
declare
  me uuid := mio_profilo();
  adm boolean := sono_admin();
  chi uuid;
  r regole;
  a avvisi;
  base numeric;
  m numeric := 1;
  nuovo bigint;
  sestieri constant text[] := array['Cannaregio', 'Castello', 'Dorsoduro', 'San Marco', 'San Polo', 'Santa Croce'];
begin
  if me is null then raise exception 'Prima crea il tuo profilo'; end if;
  chi := coalesce(p_per, me);
  if chi <> me and not adm then raise exception 'Puoi segnare punti solo per te'; end if;
  select * into r from regole where codice = p_codice;
  if not found then raise exception 'Azione sconosciuta'; end if;
  if not r.segnabile and not (adm and p_codice in ('correzione', 'badge_bacari', 'badge_cicchetto')) then
    raise exception 'Questi punti li assegna l''app';
  end if;
  if p_foto is not null and not exists (select 1 from foto where id = p_foto and profilo_id = chi) then
    raise exception 'Foto non valida';
  end if;
  if p_foto is null and not adm and (r.categoria = 'Sfide' or p_codice = 'sfida_lampo')
     and coalesce((select valore from impostazioni where chiave = 'foto_sfide'), false) then
    raise exception 'Per questa serve una foto';
  end if;
  if p_sestiere is not null and not (p_sestiere = any (sestieri)) then p_sestiere := null; end if;
  if p_qta is null or p_qta < 1 or p_qta > 10 then raise exception 'Quantità da 1 a 10'; end if;
  if r.categoria not in ('Bevi', 'Mangia') then p_qta := 1; end if;

  base := r.punti;
  if p_codice = 'sfida_lampo' then
    select * into a from avvisi where id = p_avviso and tipo = 'sfida';
    if not found then raise exception 'Sfida non trovata'; end if;
    if now() < a.inizio or (a.fine is not null and now() > a.fine) then raise exception 'Sfida scaduta'; end if;
    if exists (select 1 from punti where profilo_id = chi and avviso_id = a.id and not annullato) then
      raise exception 'Hai già fatto questa sfida';
    end if;
    base := coalesce(a.punti, 0);
  elsif p_avviso is not null then
    p_avviso := null;
  end if;
  if p_codice = 'checkin' then
    if p_bacaro_id is null then raise exception 'Scegli il bacaro'; end if;
    if exists (select 1 from punti where profilo_id = chi and codice = 'checkin' and bacaro_id = p_bacaro_id and not annullato) then
      raise exception 'Check-in già fatto in questo bacaro';
    end if;
  end if;
  if adm and p_punti is not null then base := p_punti; end if;
  if p_codice not like 'badge%' and p_codice <> 'correzione'
     and exists (select 1 from avvisi where tipo = 'doppi' and now() between inizio and coalesce(fine, 'infinity')) then
    m := 2;
  end if;

  insert into punti (profilo_id, codice, punti, molt, qta, nota, bacaro_id, bacaro_nome, sestiere, foto_id, avviso_id, creato_da)
    values (chi, p_codice, base * p_qta * m, m, p_qta, left(coalesce(p_nota, ''), 140), p_bacaro_id, left(p_bacaro_nome, 80), p_sestiere, p_foto, p_avviso, me)
    returning id into nuovo;

  if p_codice = 'checkin' then
    if not exists (select 1 from punti where codice = 'checkin' and bacaro_id = p_bacaro_id and profilo_id <> chi and not annullato) then
      insert into punti (profilo_id, codice, punti, molt, bacaro_id, bacaro_nome, creato_da)
        values (chi, 'primo', 1 * m, m, p_bacaro_id, left(p_bacaro_nome, 80), me);
    end if;
    if (select count(distinct bacaro_id) from punti where profilo_id = chi and codice = 'checkin' and not annullato) >= 10
       and not exists (select 1 from punti where profilo_id = chi and codice = 'badge_bacari' and not annullato) then
      insert into punti (profilo_id, codice, punti, creato_da) values (chi, 'badge_bacari', 5, me);
    end if;
  end if;
  if p_codice like 'cicchetto%'
     and (select sum(qta) from punti where profilo_id = chi and codice like 'cicchetto%' and not annullato) >= 10
     and not exists (select 1 from punti where profilo_id = chi and codice = 'badge_cicchetto' and not annullato) then
    insert into punti (profilo_id, codice, punti, creato_da) values (chi, 'badge_cicchetto', 5, me);
  end if;
  return nuovo;
end $$;

-- ------------------------------------------------------------ gestione profili (solo admin)
-- PIN: l'admin lo mette, lo cambia o lo toglie (vuoto = niente PIN); il profilo admin deve tenerlo
create or replace function public.admin_pin(p_profilo uuid, p_pin text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not sono_admin() then raise exception 'Solo admin'; end if;
  if coalesce(p_pin, '') = '' then
    if exists (select 1 from profili where id = p_profilo and ruolo = 'admin') then
      raise exception 'Il profilo admin deve avere un PIN';
    end if;
    delete from pin where profilo_id = p_profilo;
    return;
  end if;
  if p_pin !~ '^\d{4}$' then raise exception 'Il PIN deve avere 4 cifre'; end if;
  insert into pin (profilo_id, hash) values (p_profilo, crypt(p_pin, gen_salt('bf')))
    on conflict (profilo_id) do update set hash = excluded.hash, errori = 0, bloccato_fino = null;
end $$;

-- profilo creato dall'admin: non è legato a nessun telefono, l'amico entra con Accedi e il nome
create or replace function public.admin_crea_profilo(p_nome text, p_bio text default '', p_pin text default null) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare v uuid;
begin
  if not sono_admin() then raise exception 'Solo admin'; end if;
  if exists (select 1 from profili where lower(trim(nome)) = lower(trim(p_nome))) then raise exception 'Nome già preso'; end if;
  insert into profili (nome, bio) values (trim(p_nome), coalesce(p_bio, '')) returning id into v;
  if coalesce(p_pin, '') <> '' then perform admin_pin(v, p_pin); end if;
  return v;
end $$;

-- elimina il profilo con i suoi punti, foto, reazioni e commenti
create or replace function public.admin_elimina_profilo(p_profilo uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not sono_admin() then raise exception 'Solo admin'; end if;
  if p_profilo = mio_profilo() then raise exception 'Non puoi eliminare il tuo profilo'; end if;
  delete from profili where id = p_profilo;
end $$;

-- quali profili hanno un PIN (i PIN restano illeggibili)
create or replace function public.admin_con_pin() returns setof uuid
language plpgsql stable security definer set search_path = public as $$
begin
  if not sono_admin() then raise exception 'Solo admin'; end if;
  return query select profilo_id from pin;
end $$;

-- ------------------------------------------------------------ permessi
alter table public.profili enable row level security;
alter table public.pin enable row level security;
alter table public.regole enable row level security;
alter table public.avvisi enable row level security;
alter table public.foto enable row level security;
alter table public.reazioni enable row level security;
alter table public.commenti enable row level security;
alter table public.punti enable row level security;
alter table public.impostazioni enable row level security;

-- niente per chi non ha una sessione; dentro l'app tutti vedono tutto (classifica e log sono pubblici)
revoke all on public.profili, public.pin, public.regole, public.avvisi, public.foto, public.reazioni, public.commenti, public.punti, public.classifica, public.impostazioni from anon;
revoke all on public.pin from authenticated;
revoke insert, update, delete on public.profili, public.punti, public.regole, public.impostazioni from authenticated;
grant update (nome, bio, foto) on public.profili to authenticated;
grant update (punti, nota, annullato) on public.punti to authenticated;
revoke execute on function public.crea_profilo, public.entra_profilo, public.segna, public.admin_pin,
  public.admin_crea_profilo, public.admin_elimina_profilo, public.admin_con_pin from anon, public;
grant execute on function public.crea_profilo, public.entra_profilo, public.segna, public.admin_pin,
  public.admin_crea_profilo, public.admin_elimina_profilo, public.admin_con_pin to authenticated;

drop policy if exists "leggi" on public.profili;
create policy "leggi" on public.profili for select to authenticated using (true);
drop policy if exists "modifica il mio" on public.profili;
create policy "modifica il mio" on public.profili for update to authenticated using (user_id = auth.uid() or sono_admin());
drop policy if exists "leggi" on public.regole;
create policy "leggi" on public.regole for select to authenticated using (true);
drop policy if exists "leggi" on public.punti;
create policy "leggi" on public.punti for select to authenticated using (true);
drop policy if exists "admin corregge" on public.punti;
create policy "admin corregge" on public.punti for update to authenticated using (sono_admin());
drop policy if exists "leggi" on public.avvisi;
create policy "leggi" on public.avvisi for select to authenticated using (true);
drop policy if exists "admin scrive" on public.avvisi;
create policy "admin scrive" on public.avvisi for all to authenticated using (sono_admin()) with check (sono_admin());
drop policy if exists "leggi" on public.foto;
create policy "leggi" on public.foto for select to authenticated using (not nascosta or profilo_id = mio_profilo() or sono_admin());
drop policy if exists "carica le mie" on public.foto;
create policy "carica le mie" on public.foto for insert to authenticated with check (profilo_id = mio_profilo());
drop policy if exists "admin modera" on public.foto;
create policy "admin modera" on public.foto for update to authenticated using (sono_admin());
drop policy if exists "cancella" on public.foto;
create policy "cancella" on public.foto for delete to authenticated using (profilo_id = mio_profilo() or sono_admin());
drop policy if exists "leggi" on public.reazioni;
create policy "leggi" on public.reazioni for select to authenticated using (true);
drop policy if exists "metti la mia" on public.reazioni;
create policy "metti la mia" on public.reazioni for insert to authenticated with check (profilo_id = mio_profilo());
drop policy if exists "togli la mia" on public.reazioni;
create policy "togli la mia" on public.reazioni for delete to authenticated using (profilo_id = mio_profilo());
drop policy if exists "leggi" on public.commenti;
create policy "leggi" on public.commenti for select to authenticated using (true);
drop policy if exists "scrivi il mio" on public.commenti;
create policy "scrivi il mio" on public.commenti for insert to authenticated with check (profilo_id = mio_profilo());
drop policy if exists "cancella" on public.commenti;
create policy "cancella" on public.commenti for delete to authenticated using (profilo_id = mio_profilo() or sono_admin());
drop policy if exists "leggi" on public.impostazioni;
create policy "leggi" on public.impostazioni for select to authenticated using (true);
drop policy if exists "admin cambia" on public.impostazioni;
create policy "admin cambia" on public.impostazioni for update to authenticated using (sono_admin()) with check (sono_admin());

-- permessi espliciti: i progetti Supabase nuovi non li danno in automatico alle tabelle create via SQL
grant usage on schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
grant execute on function public.mio_profilo(), public.sono_admin() to authenticated;

grant select on public.profili, public.regole, public.avvisi, public.foto, public.reazioni,
  public.commenti, public.punti, public.classifica, public.impostazioni to authenticated;
grant update (valore) on public.impostazioni to authenticated;
grant update (nome, bio, foto) on public.profili to authenticated;
grant update (punti, nota, annullato) on public.punti to authenticated;
grant insert, update, delete on public.avvisi to authenticated;
grant insert, update, delete on public.foto to authenticated;
grant insert, delete on public.reazioni to authenticated;
grant insert, delete on public.commenti to authenticated;

-- ------------------------------------------------------------ archivio foto (solo immagini, max 2 MB)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('foto', 'foto', true, 2097152, array['image/jpeg', 'image/webp', 'image/png'])
  on conflict (id) do nothing;
-- ognuno scrive solo nella sua cartella: foto/<id profilo>/...
drop policy if exists "carica nella mia cartella" on storage.objects;
create policy "carica nella mia cartella" on storage.objects for insert to authenticated
  with check (bucket_id = 'foto' and (storage.foldername(name))[1] = public.mio_profilo()::text);
drop policy if exists "cancella le mie o admin" on storage.objects;
create policy "cancella le mie o admin" on storage.objects for delete to authenticated
  using (bucket_id = 'foto' and ((storage.foldername(name))[1] = public.mio_profilo()::text or public.sono_admin()));

-- ------------------------------------------------------------ tempo reale (banner e log che si aggiornano da soli)
do $$
declare t text;
begin
  foreach t in array array['avvisi', 'punti', 'foto', 'commenti', 'reazioni', 'impostazioni'] loop
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- Ultimo passo, DOPO aver creato il tuo profilo nell'app: diventa admin (cambia il nome se serve)
-- update public.profili set ruolo = 'admin' where lower(trim(nome)) = 'paolo';

-- fa vedere subito le funzioni nuove all'app (altrimenti: "could not find the function ... in the schema cache")
notify pgrst, 'reload schema';
