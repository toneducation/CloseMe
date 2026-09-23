-- Provider outages are not evidence of member abuse.
begin;
create or replace function photo_finish(p_user uuid,p_photo uuid,p_decision text,p_path text default null) returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare ph photos; was_primary boolean:=false;begin
 perform 1 from users where id=p_user for update;select * into ph from photos where id=p_photo and user_id=p_user for update;
 if not found or ph.status<>'PROCESSING' then return false;end if;
 if p_decision<>'SAFE' then update photos set status=case when p_decision='UNSAFE' then 'REJECTED' else 'ERROR' end where id=p_photo;if p_decision='UNSAFE' then insert into risk_flags(user_id,kind) values(p_user,'PHOTO_UNSAFE');end if;return false;end if;
 if not active_user(p_user) or not enabled('photos') or p_path<>p_user::text||'/'||p_photo::text||'.jpg' or p_path is null or not exists(select 1 from quota_reservations where photo_id=p_photo) then raise exception 'INVALID_PHOTO';end if;
 if ph.replaces is not null then
 select primary_photo into was_primary from photos where id=ph.replaces and user_id=p_user and status='APPROVED' for update;if not found then raise exception 'PHOTO_CHANGED';end if;
 update photos set status='REMOVED',primary_photo=false where id=ph.replaces;
 end if;
 update photos set status='APPROVED',storage_path=p_path,primary_photo=was_primary or not exists(select 1 from photos where user_id=p_user and primary_photo) where id=p_photo;
 update profiles set completed=true where user_id=p_user;
 update users set state=case when exists(select 1 from profiles where user_id=p_user and completed) then 'READY' else state end where id=p_user;
 return true;
end $$;
commit;
