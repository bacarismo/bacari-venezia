-- Permessi espliciti per il ruolo "authenticated" (chi usa l'app).
-- I progetti Supabase nuovi non li danno più in automatico alle tabelle create con SQL.
-- Si può rilanciare senza problemi. Le regole di dettaglio (chi vede/modifica cosa) restano le policy RLS di schema.sql.
grant usage on schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
grant execute on function public.mio_profilo(), public.sono_admin() to authenticated;

grant select on public.profili, public.regole, public.avvisi, public.foto, public.reazioni,
  public.commenti, public.punti, public.classifica to authenticated;
grant update (nome, bio, foto) on public.profili to authenticated;
grant update (punti, nota, annullato) on public.punti to authenticated;
grant insert, update, delete on public.avvisi to authenticated;
grant insert, update, delete on public.foto to authenticated;
grant insert, delete on public.reazioni to authenticated;
grant insert, delete on public.commenti to authenticated;
