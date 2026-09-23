-- Photos are optional. Public cards still select only APPROVED photos.
begin;
create or replace function save_profile(p_user uuid,p_profile jsonb,p_interests text[]) returns void language plpgsql security definer set search_path=public,pg_temp as $$ begin
 perform 1 from users where id=p_user for update;if not active_user(p_user) then raise exception 'ACCOUNT_UNAVAILABLE';end if;
 if cardinality(p_interests) not between 5 and 10 or (select count(*) from interests where id=any(p_interests) and active)<>cardinality(p_interests) then raise exception 'INVALID_INTERESTS';end if;
 insert into profiles(user_id,display_name,gender,interested_in,city,intent,bio) values(p_user,p_profile->>'display_name',p_profile->>'gender',array(select jsonb_array_elements_text(p_profile->'interested_in')),p_profile->>'city',p_profile->>'intent',coalesce(p_profile->>'bio','')) on conflict(user_id) do update set display_name=excluded.display_name,gender=excluded.gender,interested_in=excluded.interested_in,city=excluded.city,intent=excluded.intent,bio=excluded.bio,updated_at=now();
 delete from profile_interests where user_id=p_user;insert into profile_interests select p_user,unnest(p_interests);
 update profiles set completed=true where user_id=p_user;
 update users set flow='{}',state=case when exists(select 1 from profiles where user_id=p_user and completed) then 'READY' else 'PROFILE' end where id=p_user;
end $$;
create or replace function visible_user(p_user uuid) returns boolean language sql stable set search_path=public,pg_temp as $$ select active_user(p_user) and exists(select 1 from profiles where user_id=p_user and completed and not hidden and not user_paused) and exists(select 1 from usernames where owner_id=p_user and status='ASSIGNED') $$;
create or replace function photo_edit(p_user uuid,p_photo uuid,p_action text) returns void language plpgsql security definer set search_path=public,pg_temp as $$ begin
 perform 1 from users where id=p_user for update;
 if not active_user(p_user) or not exists(select 1 from photos where id=p_photo and user_id=p_user and status='APPROVED') then raise exception 'NOT_FOUND';end if;
 if p_action='primary' then update photos set primary_photo=false where user_id=p_user;update photos set primary_photo=true where id=p_photo;
 elsif p_action='delete' then
 update photos set status='REMOVED',primary_photo=false where id=p_photo;
 if not exists(select 1 from photos where user_id=p_user and primary_photo) then update photos set primary_photo=true where id=(select id from photos where user_id=p_user and status='APPROVED' order by created_at limit 1);end if;
 else raise exception 'INVALID_ACTION';end if;
end $$;

-- Recover profiles saved under the previous photo-required flow.
update profiles p set completed=true where not completed and
 (select count(*) from profile_interests i where i.user_id=p.user_id) between 5 and 10;
update users u set state='READY' where state='PROFILE' and exists
 (select 1 from profiles p where p.user_id=u.id and p.completed);
commit;
