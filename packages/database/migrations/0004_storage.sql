-- Supabase-only migration, after 0001–0003. This bucket never permits public URLs.
begin;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('profile-photos','profile-photos',false,5242880,array['image/jpeg'])
on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;
-- No anon/authenticated object policies: only the trusted Worker service key accesses bytes.
commit;
