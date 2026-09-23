-- CloseMe social profile polish: Instagram links and inbox access independent of discovery pause.
begin;

alter table public.profiles
  add column if not exists instagram_username text;

alter table public.profiles
  drop constraint if exists profiles_instagram_username_check;

alter table public.profiles
  add constraint profiles_instagram_username_check
  check (
    instagram_username is null
    or (
      instagram_username ~ '^[a-z0-9._]{1,30}$'
      and instagram_username not like '.%'
      and instagram_username not like '%.'
      and position('..' in instagram_username)=0
    )
  );

create or replace function public.set_instagram(p_user uuid,p_username text) returns text
language plpgsql security definer set search_path=public,pg_temp as $$
declare v text:=lower(trim(leading '@' from trim(coalesce(p_username,''))));
begin
 if not active_user(p_user) then raise exception 'ACCOUNT_UNAVAILABLE'; end if;
 if not exists(select 1 from profiles where user_id=p_user) then raise exception 'PROFILE_REQUIRED'; end if;
 if v='' then
   update profiles set instagram_username=null,updated_at=now() where user_id=p_user;
   return null;
 end if;
 if v !~ '^[a-z0-9._]{1,30}
   raise exception 'INVALID_INSTAGRAM';
 end if;
 update profiles set instagram_username=v,updated_at=now() where user_id=p_user;
 return v;
end $$;

create or replace function public.card(p_viewer uuid,p_target uuid) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare result jsonb;
begin
 if p_viewer<>p_target and (
   not visible_user(p_viewer)
   or not visible_user(p_target)
   or blocked_pair(p_viewer,p_target)
 ) then return null; end if;

 select jsonb_build_object(
   'id',u.id,
   'username',n.canonical,
   'premium',n.premium,
   'display_name',p.display_name,
   'age',extract(year from age(current_date,u.birth_date))::int,
   'city',p.city,
   'intent',p.intent,
   'bio',p.bio,
   'instagram_username',p.instagram_username,
   'photo',ph.storage_path,
   'photo_id',ph.id,
   'interests',coalesce(
     (select jsonb_agg(i.interest_id order by i.interest_id)
      from profile_interests i where i.user_id=u.id),
     '[]'
   )
 ) into result
 from users u
 join profiles p on p.user_id=u.id
 join usernames n on n.owner_id=u.id
 left join photos ph
   on ph.user_id=u.id and ph.primary_photo and ph.status='APPROVED'
 where u.id=p_target;

 return result;
end $$;

-- A paused profile is hidden from discovery, but the owner must still be able to
-- open Likes / Matches / Messages and manage existing connections.
create or replace function public.inbox(p_user uuid,p_kind text) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare result jsonb;
begin
 if not active_user(p_user)
    or not exists(select 1 from profiles where user_id=p_user and completed)
    or not exists(select 1 from usernames where owner_id=p_user and status='ASSIGNED')
 then raise exception 'PROFILE_REQUIRED'; end if;

 if p_kind='likes' then
   select jsonb_agg(card(p_user,sender)) into result
   from (
     select sender
     from likes
     where recipient=p_user
       and visible_user(sender)
       and not blocked_pair(p_user,sender)
     order by created_at desc
     limit 20
   ) s;
 elsif p_kind='matches' then
   select jsonb_agg(card(p_user,other)) into result
   from (
     select case when user_a=p_user then user_b else user_a end other
     from matches
     where active and p_user in (user_a,user_b)
     order by created_at desc
     limit 20
   ) s;
 elsif p_kind='requests' then
   select jsonb_agg(
     jsonb_build_object('id',id,'body',body,'profile',card(p_user,sender))
   ) into result
   from (
     select *
     from message_requests
     where recipient=p_user
       and state='PENDING'
       and not blocked_pair(p_user,sender)
     order by created_at desc
     limit 20
   ) s;
 elsif p_kind='messages' then
   select jsonb_agg(card(p_user,other)) into result
   from (
     select case when user_a=p_user then user_b else user_a end other
     from conversations
     where active and p_user in (user_a,user_b)
     order by created_at desc
     limit 20
   ) s;
 else
   raise exception 'INVALID_ACTION';
 end if;

 return coalesce(result,'[]'::jsonb);
end $$;

revoke execute on function public.set_instagram(uuid,text) from public,anon,authenticated;
grant execute on function public.set_instagram(uuid,text) to service_role;

commit;
 or v like '.%' or v like '%.' or position('..' in v)>0 then
   raise exception 'INVALID_INSTAGRAM';
 end if;
 update profiles set instagram_username=v,updated_at=now() where user_id=p_user;
 return v;
end $$;

create or replace function public.card(p_viewer uuid,p_target uuid) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare result jsonb;
begin
 if p_viewer<>p_target and (
   not visible_user(p_viewer)
   or not visible_user(p_target)
   or blocked_pair(p_viewer,p_target)
 ) then return null; end if;

 select jsonb_build_object(
   'id',u.id,
   'username',n.canonical,
   'premium',n.premium,
   'display_name',p.display_name,
   'age',extract(year from age(current_date,u.birth_date))::int,
   'city',p.city,
   'intent',p.intent,
   'bio',p.bio,
   'instagram_username',p.instagram_username,
   'photo',ph.storage_path,
   'photo_id',ph.id,
   'interests',coalesce(
     (select jsonb_agg(i.interest_id order by i.interest_id)
      from profile_interests i where i.user_id=u.id),
     '[]'
   )
 ) into result
 from users u
 join profiles p on p.user_id=u.id
 join usernames n on n.owner_id=u.id
 left join photos ph
   on ph.user_id=u.id and ph.primary_photo and ph.status='APPROVED'
 where u.id=p_target;

 return result;
end $$;

-- A paused profile is hidden from discovery, but the owner must still be able to
-- open Likes / Matches / Messages and manage existing connections.
create or replace function public.inbox(p_user uuid,p_kind text) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare result jsonb;
begin
 if not active_user(p_user)
    or not exists(select 1 from profiles where user_id=p_user and completed)
    or not exists(select 1 from usernames where owner_id=p_user and status='ASSIGNED')
 then raise exception 'PROFILE_REQUIRED'; end if;

 if p_kind='likes' then
   select jsonb_agg(card(p_user,sender)) into result
   from (
     select sender
     from likes
     where recipient=p_user
       and visible_user(sender)
       and not blocked_pair(p_user,sender)
     order by created_at desc
     limit 20
   ) s;
 elsif p_kind='matches' then
   select jsonb_agg(card(p_user,other)) into result
   from (
     select case when user_a=p_user then user_b else user_a end other
     from matches
     where active and p_user in (user_a,user_b)
     order by created_at desc
     limit 20
   ) s;
 elsif p_kind='requests' then
   select jsonb_agg(
     jsonb_build_object('id',id,'body',body,'profile',card(p_user,sender))
   ) into result
   from (
     select *
     from message_requests
     where recipient=p_user
       and state='PENDING'
       and not blocked_pair(p_user,sender)
     order by created_at desc
     limit 20
   ) s;
 elsif p_kind='messages' then
   select jsonb_agg(card(p_user,other)) into result
   from (
     select case when user_a=p_user then user_b else user_a end other
     from conversations
     where active and p_user in (user_a,user_b)
     order by created_at desc
     limit 20
   ) s;
 else
   raise exception 'INVALID_ACTION';
 end if;

 return coalesce(result,'[]'::jsonb);
end $$;

revoke execute on function public.set_instagram(uuid,text) from public,anon,authenticated;
grant execute on function public.set_instagram(uuid,text) to service_role;

commit;
