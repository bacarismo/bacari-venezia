-- PIN solo per l'admin: gli altri si iscrivono e rientrano col solo nome.
-- Un profilo che ha un PIN (il tuo) lo chiede sempre per entrare. Si può rilanciare.
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

-- l'admin può mettere (o cambiare) il PIN a chiunque
create or replace function public.admin_pin(p_profilo uuid, p_pin text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not sono_admin() then raise exception 'Solo admin'; end if;
  if p_pin !~ '^\d{4}$' then raise exception 'Il PIN deve avere 4 cifre'; end if;
  insert into pin (profilo_id, hash) values (p_profilo, crypt(p_pin, gen_salt('bf')))
    on conflict (profilo_id) do update set hash = excluded.hash, errori = 0, bloccato_fino = null;
end $$;
