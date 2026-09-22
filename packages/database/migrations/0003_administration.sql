begin;
alter table username_transfers add column completed_at timestamptz;
create function protect_owner() returns trigger language plpgsql set search_path=public,pg_temp as $$ begin
 if old.role='OWNER' and (tg_op='DELETE' or new.role<>'OWNER' or not new.active) then raise exception 'OWNER_PROTECTED';end if;return new;
end $$;
create trigger owner_protected before update or delete on admin_users for each row execute function protect_owner();
create function admin_action(p_admin uuid,p_action text,p_target text,p_reason text,p_data jsonb default '{}') returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare staff admin_users; recipient uuid; old_owner uuid; old_handle text; v text; result jsonb:='{"ok":true}'; r reports;begin
 select * into staff from admin_users where id=p_admin and active for update;if not found then raise exception 'FORBIDDEN';end if;
 if p_reason is null or length(trim(p_reason))<5 or length(p_reason)>1000 then raise exception 'REASON_REQUIRED';end if;
 perform require_limit(p_admin,'admin_write',30,60);
 if p_action in ('GIFT_USERNAME','TRANSFER_USERNAME','REASSIGN_USERNAME','RESERVE_USERNAME','FREEZE_USERNAME','RELEASE_USERNAME') then
 if staff.role not in ('OWNER','SUPER_ADMIN') then raise exception 'FORBIDDEN';end if;
 perform pg_advisory_xact_lock(810021);v:=lower(p_target);
 if v !~ '^[a-z0-9]{1,25}$' then raise exception 'NOT_ALLOWED';end if;
 recipient:=(p_data->>'recipient')::uuid;
 -- Lock involved users before handles, consistently with existing identity functions.
 perform 1 from users where id=recipient or id=(select owner_id from usernames where canonical=v) order by id for update;
 perform pg_advisory_xact_lock(hashtextextended(v,0));
 insert into usernames(canonical) values(v) on conflict do nothing;
 select owner_id into old_owner from usernames where canonical=v for update;
 if p_action in ('GIFT_USERNAME','TRANSFER_USERNAME','REASSIGN_USERNAME') then
 if length(v)<>1 then raise exception 'NOT_PREMIUM';end if;
 if p_action='GIFT_USERNAME' and exists(select 1 from usernames where canonical=v and status<>'AVAILABLE') then raise exception 'NOT_AVAILABLE';end if;
 if p_action='TRANSFER_USERNAME' and old_owner is null then raise exception 'NO_OWNER';end if;
 if not active_user(recipient) then raise exception 'ACCOUNT_UNAVAILABLE';end if;
 select canonical into old_handle from usernames where owner_id=recipient and canonical<>v for update;
 if old_handle is not null then update usernames set owner_id=null,status='AVAILABLE' where canonical=old_handle;insert into username_history(canonical,from_user,action,actor,reason) values(old_handle,recipient,'RELEASE_ON_ADMIN_ASSIGN',p_admin,p_reason);end if;
 update usernames set owner_id=recipient,status='ASSIGNED' where canonical=v;
 update users set state=case when id=old_owner and old_owner<>recipient then 'USERNAME' when id=recipient then case when exists(select 1 from profiles where user_id=recipient and completed) then 'READY' else 'PROFILE' end else state end,username_changed_at=now() where id in (old_owner,recipient);
 elsif p_action='FREEZE_USERNAME' then update usernames set status='FROZEN' where canonical=v;
 elsif p_action='RESERVE_USERNAME' then
 if old_owner is not null then raise exception 'RELEASE_FIRST';end if;
 update usernames set status='RESERVED' where canonical=v;
 if length(v)>1 then insert into reserved_usernames values(v,p_reason) on conflict(canonical) do update set reason=excluded.reason;end if;
 elsif p_action='RELEASE_USERNAME' then
 update usernames set owner_id=null,status='AVAILABLE' where canonical=v;
 delete from reserved_usernames where canonical=v;
 update users set state='USERNAME',username_changed_at=now() where id=old_owner;
 end if;
 update username_transfers set state='CANCELLED' where state in ('DRAFT','PENDING') and (canonical=v or sender_id=recipient);
 insert into username_history(canonical,from_user,to_user,action,actor,reason) values(v,old_owner,case when p_action in ('GIFT_USERNAME','TRANSFER_USERNAME','REASSIGN_USERNAME') then recipient when p_action='FREEZE_USERNAME' then old_owner else null end,p_action,p_admin,p_reason);
 elsif p_action in ('CHANGE_STAFF_ROLE','DISABLE_STAFF','ENABLE_STAFF') then
 if staff.role<>'OWNER' then raise exception 'FORBIDDEN';end if;
 if p_action='CHANGE_STAFF_ROLE' then
 if p_data->>'role' not in ('SUPER_ADMIN','MODERATOR','SUPPORT') then raise exception 'INVALID_ROLE';end if;
 insert into admin_users(id,role,email) values(p_target::uuid,p_data->>'role',p_data->>'email') on conflict(id) do update set role=excluded.role;
 else update admin_users set active=p_action='ENABLE_STAFF' where id=p_target::uuid;end if;
 elsif p_action='SECURITY_SETTING_CHANGE' then
 if staff.role<>'OWNER' then raise exception 'FORBIDDEN';end if;
 if p_target='request_daily_limit' then if (p_data->>'value')::int not between 1 and 20 then raise exception 'INVALID_VALUE';end if;
 elsif p_target not in ('registrations','photos','requests','messages','transfers') or jsonb_typeof(p_data->'value')<>'boolean' then raise exception 'INVALID_SETTING';end if;
 update settings set value=p_data->'value' where key=p_target;
 elsif p_action='REVIEW_REPORT' then
 if staff.role='SUPPORT' then raise exception 'FORBIDDEN';end if;
 update reports set state=coalesce(p_data->>'state',state),priority=coalesce(p_data->>'priority',priority),assigned_to=coalesce((p_data->>'assigned_to')::uuid,assigned_to) where id=p_target::uuid;
 elsif p_action='VIEW_REPORTED_CONVERSATION' then
 if staff.role='SUPPORT' then raise exception 'FORBIDDEN';end if;
 select * into r from reports where id=p_target::uuid and state in ('NEW','UNDER_REVIEW','ESCALATED');
 if not found or r.conversation_id is null then raise exception 'CASE_REQUIRED';end if;
 select coalesce(jsonb_agg(to_jsonb(m)),'[]') into result from (select id,sender,body,created_at from messages where conversation_id=r.conversation_id order by created_at desc limit 100) m;
 elsif p_action in ('HIDE_PHOTO','RESTORE_PHOTO') then
 if staff.role='SUPPORT' then raise exception 'FORBIDDEN';end if;
 select user_id into recipient from photos where id=p_target::uuid;perform 1 from users where id=recipient for update;
 if p_action='HIDE_PHOTO' then update photos set status='HIDDEN',primary_photo=false where id=p_target::uuid;update profiles set hidden=true where user_id=recipient;
 else
 -- Only previously approved, stored images can be restored following a safety case.
 update photos set status='APPROVED' where id=p_target::uuid and status='HIDDEN' and storage_path is not null;
 if not exists(select 1 from photos where user_id=recipient and primary_photo) then update photos set primary_photo=true where id=p_target::uuid and status='APPROVED';end if;
 end if;
 elsif p_action in ('WARN_USER','SUSPEND_USER','UNSUSPEND_USER','BAN_USER','UNBAN_USER','HIDE_PROFILE','RESTORE_PROFILE','DISABLE_MESSAGING','ENABLE_MESSAGING','REQUIRE_REVIEW') then
 if staff.role='SUPPORT' and p_action<>'WARN_USER' then raise exception 'FORBIDDEN';end if;
 if p_action in ('BAN_USER','UNBAN_USER') and staff.role not in ('OWNER','SUPER_ADMIN') then raise exception 'FORBIDDEN';end if;
 perform pg_advisory_xact_lock(810022);
 recipient:=p_target::uuid;perform 1 from users where id=recipient for update;if not found then raise exception 'NOT_FOUND';end if;
 if p_action='SUSPEND_USER' then update users set status='SUSPENDED' where id=recipient;
 elsif p_action='BAN_USER' then update users set status='BANNED' where id=recipient;
 elsif p_action in ('UNBAN_USER','UNSUSPEND_USER') then update users set status='ACTIVE' where id=recipient;
 elsif p_action='REQUIRE_REVIEW' then update users set status='NEEDS_REVIEW',risk_state='REVIEW' where id=recipient;
 elsif p_action in ('HIDE_PROFILE','RESTORE_PROFILE') then update profiles set hidden=p_action='HIDE_PROFILE' where user_id=recipient;
 elsif p_action in ('DISABLE_MESSAGING','ENABLE_MESSAGING') then update users set messaging_enabled=p_action='ENABLE_MESSAGING' where id=recipient;end if;
 insert into moderation_actions(user_id,admin_id,action,reason) values(recipient,p_admin,p_action,p_reason);
 insert into notifications(recipient,kind,payload) values(recipient,'notice',jsonb_build_object('reason',p_reason));
 else raise exception 'INVALID_ACTION';end if;
 insert into audit_logs(admin_id,action,target,reason,metadata) values(p_admin,p_action,p_target,p_reason,p_data);
 return result;
end $$;
create function admin_metrics(p_admin uuid) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$ begin
 if not exists(select 1 from admin_users where id=p_admin and active) then raise exception 'FORBIDDEN';end if;
 return jsonb_build_object('Total users',(select count(*) from users),'New today',(select count(*) from users where created_at>=date_trunc('day',now())),'Active users',(select count(*) from users where last_active_at>now()-interval '7 days'),'Verified accounts',(select count(*) from users where phone_verified_at is not null),'Completed profiles',(select count(*) from profiles where completed),'Matches',(select count(*) from matches where active),'Message requests',(select count(*) from message_requests),'Open reports',(select count(*) from reports where state in ('NEW','UNDER_REVIEW','ESCALATED')),'Reported photos',(select count(distinct photo_id) from reports where photo_id is not null and state in ('NEW','UNDER_REVIEW','ESCALATED')),'Suspended users',(select count(*) from users where status='SUSPENDED'),'Banned users',(select count(*) from users where status='BANNED'),'Premium assigned',(select count(*) from usernames where premium and owner_id is not null),'Rejected photos',(select count(*) from photos where status='REJECTED'),'Moderation units',(select coalesce(sum(used),0) from usage_quotas where month=date_trunc('month',timezone('UTC',now()))::date));
end $$;
create function admin_users_search(p_admin uuid,p_query text,p_offset int default 0) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$ begin
 if not exists(select 1 from admin_users where id=p_admin and active) then raise exception 'FORBIDDEN';end if;
 return coalesce((select jsonb_agg(to_jsonb(s)) from (select u.id,u.telegram_id,u.status,u.risk_state,u.created_at,u.last_active_at,(u.phone_verified_at is not null) phone_verified,n.canonical username,p.display_name,p.city,p.intent,extract(year from age(current_date,u.birth_date))::int age from users u left join usernames n on n.owner_id=u.id left join profiles p on p.user_id=u.id where p_query='' or n.canonical ilike '%'||p_query||'%' or p.display_name ilike '%'||p_query||'%' or p.city ilike '%'||p_query||'%' or u.id::text=p_query or u.telegram_id::text=p_query order by u.created_at desc limit 50 offset greatest(0,least(p_offset,100000))) s),'[]');
end $$;
-- Wrap existing identity operations: retain all original confirmation/replay/cooldown logic.
alter function begin_transfer(uuid,uuid,text) rename to identity_begin_transfer;
create function begin_transfer(p_sender uuid,p_recipient uuid,p_hash text) returns uuid language plpgsql security definer set search_path=public,pg_temp as $$ begin
 if not enabled('transfers') or blocked_pair(p_sender,p_recipient) then raise exception 'PAUSED';end if;
 perform require_limit(p_sender,'transfers',3,86400);return identity_begin_transfer(p_sender,p_recipient,p_hash);
end $$;
create function transfer_confirm(p_id uuid,p_actor uuid,p_hash text,p_token text) returns text language plpgsql security definer set search_path=public,pg_temp as $$ declare result text;tr username_transfers;begin
 if not enabled('transfers') then raise exception 'PAUSED';end if;
 select * into tr from username_transfers where id=p_id;
 if blocked_pair(tr.sender_id,tr.recipient_id) then raise exception 'NOT_FOUND';end if;
 result:=confirm_transfer(p_id,p_actor,p_hash);
 if result='PENDING' then insert into notifications(recipient,actor,kind,payload) values(tr.recipient_id,tr.sender_id,'transfer',jsonb_build_object('id',p_id,'token',p_token,'username',tr.canonical));
 elsif result='COMPLETED' then update username_transfers set completed_at=now() where id=p_id;insert into notifications(recipient,kind,payload) values(tr.sender_id,'transfer_done',jsonb_build_object('username',tr.canonical)),(tr.recipient_id,'transfer_done',jsonb_build_object('username',tr.canonical));end if;return result;
end $$;
do $$ declare r record;begin for r in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('protect_owner','admin_action','admin_metrics','admin_users_search','identity_begin_transfer','begin_transfer','transfer_confirm') loop execute format('revoke execute on function %s from public,anon,authenticated',r.signature);execute format('grant execute on function %s to service_role',r.signature);end loop;end $$;
commit;
