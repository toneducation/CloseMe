-- Safe, additive repair for CloseMe username search/change and transfer cooldown.
begin;
create or replace function public.identity_begin_transfer(p_sender uuid,p_recipient uuid,p_hash text) returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare h public.usernames; result uuid;
begin
 if p_sender=p_recipient then raise exception 'SAME_USER'; end if;
 -- Global identity-operation lock keeps two-way transfers/gifts deadlock-free.
 perform pg_advisory_xact_lock(810021);
 perform 1 from users where id in (p_sender,p_recipient) order by id for update;
 if (select count(*) from users where id in (p_sender,p_recipient) and status='ACTIVE' and phone_verified_at is not null and birth_date is not null)<>2 then raise exception 'ACCOUNT_UNAVAILABLE'; end if;
 if exists(select 1 from username_history h where h.action in ('CHANGE','TRANSFER') and h.created_at>now()-interval '7 days' and (h.from_user in (p_sender,p_recipient) or h.to_user in (p_sender,p_recipient))) then raise exception 'COOLDOWN'; end if;
 select * into h from usernames where owner_id=p_sender and status='ASSIGNED' for update;
 if not found then raise exception 'NO_USERNAME'; end if;
 if h.premium then raise exception 'PREMIUM_ADMIN_ONLY'; end if;
 update username_transfers set state='EXPIRED' where canonical=h.canonical and state in ('DRAFT','PENDING') and expires_at<=now();
 insert into username_transfers(canonical,sender_id,recipient_id,token_hash) values(h.canonical,p_sender,p_recipient,p_hash) returning id into result;
 return result;
end $$;

create or replace function public.confirm_transfer(p_id uuid,p_actor uuid,p_hash text) returns text language plpgsql security definer set search_path=public,pg_temp as $$
declare tr public.username_transfers; old_name text;
begin
 perform pg_advisory_xact_lock(810021);
 select * into tr from username_transfers where id=p_id for update;
 if not found or tr.token_hash <> p_hash then raise exception 'INVALID_TRANSFER'; end if;
 if tr.state not in ('DRAFT','PENDING') then raise exception 'TRANSFER_USED'; end if;
 if tr.expires_at<=now() then raise exception 'TRANSFER_EXPIRED'; end if;
 if p_actor not in (tr.sender_id,tr.recipient_id) then raise exception 'NOT_PARTICIPANT'; end if;
 perform 1 from users where id in (tr.sender_id,tr.recipient_id) order by id for update;
 if (select count(*) from users where id in (tr.sender_id,tr.recipient_id) and status='ACTIVE' and phone_verified_at is not null)<>2 then raise exception 'ACCOUNT_UNAVAILABLE'; end if;
 if exists(select 1 from username_history h where h.action in ('CHANGE','TRANSFER') and h.created_at>now()-interval '7 days' and (h.from_user in (tr.sender_id,tr.recipient_id) or h.to_user in (tr.sender_id,tr.recipient_id))) then raise exception 'COOLDOWN'; end if;
 perform pg_advisory_xact_lock(hashtextextended(tr.canonical,0));
 if not exists(select 1 from usernames where canonical=tr.canonical and owner_id=tr.sender_id and status='ASSIGNED' and not premium) then raise exception 'OWNER_CHANGED'; end if;
 if p_actor=tr.sender_id and tr.state='DRAFT' then
 update username_transfers set state='PENDING',sender_confirmed_at=now() where id=tr.id; return 'PENDING';
 end if;
 if p_actor<>tr.recipient_id or tr.state<>'PENDING' or tr.sender_confirmed_at is null then raise exception 'CONFIRMATION_REQUIRED'; end if;
 select canonical into old_name from usernames where owner_id=tr.recipient_id for update;
 if old_name is not null then
 if exists(select 1 from usernames where canonical=old_name and (premium or status='FROZEN')) then raise exception 'PREMIUM_ADMIN_ONLY'; end if;
 update usernames set owner_id=null,status='AVAILABLE' where canonical=old_name;
 insert into username_history(canonical,from_user,action) values(old_name,tr.recipient_id,'RELEASE_ON_TRANSFER');
 end if;
 update usernames set owner_id=tr.recipient_id where canonical=tr.canonical;
 update users set username_changed_at=now(),state=case when id=tr.sender_id then 'USERNAME' else state end where id in (tr.sender_id,tr.recipient_id);
 update username_transfers set state='COMPLETED',recipient_confirmed_at=now() where id=tr.id;
 update username_transfers set state='CANCELLED' where id<>tr.id and state in ('DRAFT','PENDING') and (sender_id in (tr.sender_id,tr.recipient_id) or recipient_id in (tr.sender_id,tr.recipient_id));
 insert into username_history(canonical,from_user,to_user,action) values(tr.canonical,tr.sender_id,tr.recipient_id,'TRANSFER');
 return 'COMPLETED';
end $$;


-- A person's initial registration and admin premium gift do not consume their
-- self-service rename; subsequent changes and transfers require seven days.
create function public.username_self_status(p_user uuid) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare u public.users; h public.usernames; last_change timestamptz; last_transfer timestamptz;
begin
 select * into u from users where id=p_user;
 if not found or u.status<>'ACTIVE' or u.phone_verified_at is null then raise exception 'ACCOUNT_UNAVAILABLE'; end if;
 select * into h from usernames where owner_id=p_user and status='ASSIGNED';
 if not found then raise exception 'NO_USERNAME'; end if;
 select max(created_at) into last_change from username_history where action='CHANGE' and to_user=p_user;
 select max(created_at) into last_transfer from username_history
 where action='TRANSFER' and (from_user=p_user or to_user=p_user);
 return jsonb_build_object('username',h.canonical,'premium',h.premium,
   'can_change',last_change is null or last_change<=now()-interval '7 days',
   'next_change_at',case when last_change>now()-interval '7 days' then last_change+interval '7 days' else null end,
   'can_transfer',not h.premium and greatest(coalesce(last_change,'-infinity'::timestamptz),coalesce(last_transfer,'-infinity'::timestamptz))<=now()-interval '7 days');
end $$;

create function public.change_username(p_user uuid,p_name text) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare v text:=lower(trim(leading '@' from trim(coalesce(p_name,'')))); u public.users; old_handle public.usernames; last_change timestamptz; availability text;
begin
 if v !~ '^[a-z0-9]{2,25}$' then raise exception 'NOT_ALLOWED';end if;
 perform pg_advisory_xact_lock(810021);
 select * into u from users where id=p_user for update;
 if not found or u.status<>'ACTIVE' or u.phone_verified_at is null or u.birth_date is null or u.adult_confirmed_at is null
    or u.state not in ('PROFILE','READY') then raise exception 'ACCOUNT_NOT_VERIFIED';end if;
 select * into old_handle from usernames where owner_id=p_user for update;
 if not found or old_handle.status<>'ASSIGNED' then raise exception 'NO_USERNAME';end if;
 if old_handle.canonical=v then return jsonb_build_object('username',v,'changed',false);end if;
 select max(created_at) into last_change from username_history where to_user=p_user and action='CHANGE';
 if last_change>now()-interval '7 days' then raise exception 'COOLDOWN';end if;
 perform pg_advisory_xact_lock(hashtextextended(v,0));
 availability:=username_status(v);
 if availability<>'AVAILABLE' then raise exception '%',availability;end if;
 -- First reserve the target, then atomically release the old handle.
 insert into usernames(canonical,owner_id,status) values(v,null,'RESERVED')
 on conflict(canonical) do update set status='RESERVED'
 where usernames.status='AVAILABLE' and usernames.owner_id is null;
 if not found then raise exception 'TAKEN';end if;
 update username_transfers set state='CANCELLED'
 where state in ('DRAFT','PENDING') and (sender_id=p_user or recipient_id=p_user);
 update usernames set owner_id=null,status=case when premium then 'RESERVED' else 'AVAILABLE' end
 where canonical=old_handle.canonical;
 update usernames set owner_id=p_user,status='ASSIGNED' where canonical=v;
 update users set username_changed_at=now() where id=p_user;
 insert into username_history(canonical,from_user,action) values(old_handle.canonical,p_user,'RELEASE_ON_CHANGE');
 insert into username_history(canonical,to_user,action) values(v,p_user,'CHANGE');
 return jsonb_build_object('username',v,'changed',true,'previous',old_handle.canonical);
end $$;

revoke execute on function public.username_self_status(uuid),public.change_username(uuid,text) from public,anon,authenticated;
grant execute on function public.username_self_status(uuid),public.change_username(uuid,text) to service_role;
commit;
