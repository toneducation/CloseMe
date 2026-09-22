begin;
create table public.users (
 id uuid primary key default gen_random_uuid(),
 telegram_id bigint not null unique check(telegram_id > 0),
 locale text not null default 'en' check(locale in ('en','uz','ru')),
 state text not null default 'AGE' check(state in ('AGE','DOB','CONTACT','USERNAME','PROFILE','READY','DENIED')),
 status text not null default 'ACTIVE' check(status in ('ACTIVE','SUSPENDED','BANNED','NEEDS_REVIEW')),
 risk_state text not null default 'NORMAL' check(risk_state in ('NORMAL','REVIEW','HIGH_RISK')),
 birth_date date,
 adult_confirmed_at timestamptz,
 phone_hmac text unique check(phone_hmac ~ '^[a-f0-9]{64}$'),
 phone_verified_at timestamptz,
 username_changed_at timestamptz,
 created_at timestamptz not null default now(),
 last_active_at timestamptz not null default now()
);
create table public.reserved_usernames (canonical text primary key check(canonical ~ '^[a-z0-9]{2,25}$'), reason text not null);
insert into public.reserved_usernames select v,'System reserved' from unnest(array['admin','administrator','closeme','official','support','moderator','security','help','telegram']) v;
create table public.usernames (
 canonical text primary key check(canonical ~ '^[a-z0-9]{1,25}$'),
 owner_id uuid unique references public.users(id),
 status text not null default 'AVAILABLE' check(status in ('AVAILABLE','ASSIGNED','RESERVED','FROZEN')),
 premium boolean generated always as (length(canonical)=1) stored,
 created_at timestamptz not null default now(),
 check((status='ASSIGNED' and owner_id is not null) or (status in ('AVAILABLE','RESERVED') and owner_id is null) or status='FROZEN')
);
insert into public.usernames(canonical) select substr('abcdefghijklmnopqrstuvwxyz0123456789',n,1) from generate_series(1,36) n;
create table public.username_history (
 id bigint generated always as identity primary key,
 canonical text not null references public.usernames(canonical),
 from_user uuid references public.users(id), to_user uuid references public.users(id),
 action text not null, actor uuid, reason text,
 created_at timestamptz not null default now()
);
create table public.username_transfers (
 id uuid primary key default gen_random_uuid(),
 canonical text not null references public.usernames(canonical),
 sender_id uuid not null references public.users(id), recipient_id uuid not null references public.users(id),
 token_hash text not null unique check(token_hash ~ '^[a-f0-9]{64}$'),
 state text not null default 'DRAFT' check(state in ('DRAFT','PENDING','COMPLETED','CANCELLED','EXPIRED')),
 expires_at timestamptz not null default now()+interval '24 hours',
 sender_confirmed_at timestamptz, recipient_confirmed_at timestamptz,
 created_at timestamptz not null default now(), check(sender_id <> recipient_id)
);
create unique index one_active_transfer_per_username on public.username_transfers(canonical) where state in ('DRAFT','PENDING');
create index transfers_recipient on public.username_transfers(recipient_id,state);
create table public.admin_users (id uuid primary key, role text not null check(role in ('OWNER','SUPER_ADMIN','MODERATOR','SUPPORT')), active boolean not null default true);
create unique index one_owner on public.admin_users(role) where role='OWNER';
create table public.audit_logs (id bigint generated always as identity primary key,admin_id uuid not null references public.admin_users(id),action text not null,target text not null,reason text not null,metadata jsonb not null default '{}',created_at timestamptz not null default now());
create table public.rate_limits (actor text not null, action text not null, window_start timestamptz not null, count integer not null default 1, primary key(actor,action,window_start));
create table public.webhook_receipts(update_id bigint primary key,completed_at timestamptz not null default now());
create function public.immutable_record() returns trigger language plpgsql set search_path=public,pg_temp as $$ begin raise exception 'IMMUTABLE_RECORD'; end $$;
create trigger audit_immutable before update or delete on public.audit_logs for each row execute function public.immutable_record();
create trigger history_immutable before update or delete on public.username_history for each row execute function public.immutable_record();
create function public.check_adult_date() returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
 if new.birth_date is not null and (new.birth_date > (current_date - interval '18 years')::date or new.birth_date < (current_date - interval '120 years')::date) then raise exception 'UNDERAGE_OR_INVALID_DOB'; end if;
 return new;
end $$;
create trigger adult_date before insert or update on public.users for each row execute function public.check_adult_date();

-- Only the trusted backend may call these RPCs. Telegram IDs come from secret-verified updates.
create function public.onboard(p_telegram bigint,p_locale text,p_action text default 'read',p_value text default null) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare u public.users;
begin
 insert into users(telegram_id,locale) values(p_telegram,p_locale) on conflict(telegram_id) do nothing;
 select * into u from users where telegram_id=p_telegram for update;
 if u.status <> 'ACTIVE' then raise exception 'ACCOUNT_UNAVAILABLE'; end if;
 if p_action='deny' and u.state in ('AGE','DOB') then update users set state='DENIED' where id=u.id;
 elsif p_action='adult' and u.state='AGE' then update users set state='DOB',adult_confirmed_at=now() where id=u.id;
 elsif p_action='dob' and u.state='DOB' then update users set birth_date=p_value::date,state='CONTACT' where id=u.id;
 elsif p_action='contact' and u.state='CONTACT' and u.birth_date is not null and u.adult_confirmed_at is not null then
   update users set phone_hmac=p_value,phone_verified_at=now(),state='USERNAME' where id=u.id;
 elsif p_action not in ('read','deny','adult','dob','contact') then raise exception 'INVALID_ACTION';
 end if;
 update users set last_active_at=now() where id=u.id returning * into u;
 return to_jsonb(u);
end $$;
create function public.username_status(p_name text) returns text language plpgsql security definer set search_path=public,pg_temp as $$
declare v text:=lower(p_name); s text;
begin
 if v !~ '^[a-z0-9]{1,25}$' then return 'NOT_ALLOWED'; end if;
 select status into s from usernames where canonical=v;
 if s='FROZEN' then return 'FROZEN'; end if;
 if exists(select 1 from reserved_usernames where canonical=v) or s='RESERVED' then return 'RESERVED'; end if;
 if length(v)=1 then return 'PREMIUM'; end if;
 if s='ASSIGNED' then return 'TAKEN'; end if;
 return 'AVAILABLE';
end $$;
create function public.claim_username(p_user uuid,p_name text) returns text language plpgsql security definer set search_path=public,pg_temp as $$
declare v text:=lower(p_name); u public.users; s text;
begin
 select * into u from users where id=p_user for update;
 if not found or u.status <> 'ACTIVE' or u.phone_verified_at is null or u.birth_date is null or u.adult_confirmed_at is null or u.state not in ('USERNAME','PROFILE','READY') then raise exception 'ACCOUNT_NOT_VERIFIED'; end if;
 if exists(select 1 from usernames where owner_id=u.id and canonical=v and status='ASSIGNED') then return v; end if;
 if exists(select 1 from usernames where owner_id=u.id) then raise exception 'ALREADY_OWNS_USERNAME'; end if;
 -- Serialize claims, reservations and administrative ownership changes per handle.
 perform pg_advisory_xact_lock(hashtextextended(v,0));
 s:=username_status(v);
 if s <> 'AVAILABLE' then raise exception '%',s; end if;
 insert into usernames(canonical,owner_id,status) values(v,u.id,'ASSIGNED')
 on conflict(canonical) do update set owner_id=u.id,status='ASSIGNED' where usernames.status='AVAILABLE' and usernames.owner_id is null;
 if not found then raise exception 'TAKEN'; end if;
 update users set state='PROFILE',username_changed_at=now() where id=u.id;
 insert into username_history(canonical,to_user,action) values(v,u.id,'CLAIM');
 return v;
end $$;
create function public.consume_limit(p_actor text,p_action text,p_limit integer,p_seconds integer) returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare w timestamptz; n integer;
begin
 if p_limit<1 or p_seconds<1 then raise exception 'INVALID_LIMIT'; end if;
 w:=to_timestamp(floor(extract(epoch from now())/p_seconds)*p_seconds);
 insert into rate_limits(actor,action,window_start) values(p_actor,p_action,w)
 on conflict(actor,action,window_start) do update set count=rate_limits.count+1 returning count into n;
 return n<=p_limit;
end $$;
create function public.begin_transfer(p_sender uuid,p_recipient uuid,p_hash text) returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare h public.usernames; result uuid;
begin
 if p_sender=p_recipient then raise exception 'SAME_USER'; end if;
 -- Global identity-operation lock keeps two-way transfers/gifts deadlock-free.
 perform pg_advisory_xact_lock(810021);
 perform 1 from users where id in (p_sender,p_recipient) order by id for update;
 if (select count(*) from users where id in (p_sender,p_recipient) and status='ACTIVE' and phone_verified_at is not null and birth_date is not null)<>2 then raise exception 'ACCOUNT_UNAVAILABLE'; end if;
 if exists(select 1 from users where id in (p_sender,p_recipient) and username_changed_at>now()-interval '7 days') then raise exception 'COOLDOWN'; end if;
 select * into h from usernames where owner_id=p_sender and status='ASSIGNED' for update;
 if not found then raise exception 'NO_USERNAME'; end if;
 if h.premium then raise exception 'PREMIUM_ADMIN_ONLY'; end if;
 update username_transfers set state='EXPIRED' where canonical=h.canonical and state in ('DRAFT','PENDING') and expires_at<=now();
 insert into username_transfers(canonical,sender_id,recipient_id,token_hash) values(h.canonical,p_sender,p_recipient,p_hash) returning id into result;
 return result;
end $$;
create function public.confirm_transfer(p_id uuid,p_actor uuid,p_hash text) returns text language plpgsql security definer set search_path=public,pg_temp as $$
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
 if exists(select 1 from users where id in (tr.sender_id,tr.recipient_id) and username_changed_at>now()-interval '7 days') then raise exception 'COOLDOWN'; end if;
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
create function public.gift_premium(p_admin uuid,p_name text,p_recipient uuid,p_reason text) returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare v text:=lower(p_name); prev uuid; old_name text;
begin
 if not exists(select 1 from admin_users where id=p_admin and active and role in ('OWNER','SUPER_ADMIN')) then raise exception 'FORBIDDEN'; end if;
 if length(trim(p_reason))<5 or p_reason is null then raise exception 'REASON_REQUIRED'; end if;
 if v !~ '^[a-z0-9]$' then raise exception 'NOT_PREMIUM'; end if;
 perform pg_advisory_xact_lock(810021);
 perform 1 from users where id=p_recipient and status='ACTIVE' and phone_verified_at is not null and birth_date is not null for update;
 if not found then raise exception 'ACCOUNT_UNAVAILABLE'; end if;
 perform pg_advisory_xact_lock(hashtextextended(v,0));
 select owner_id into prev from usernames where canonical=v and status='AVAILABLE' for update;
 if not found then raise exception 'NOT_AVAILABLE'; end if;
 select canonical into old_name from usernames where owner_id=p_recipient for update;
 if old_name is not null then
 if exists(select 1 from usernames where canonical=old_name and status='FROZEN') then raise exception 'FROZEN'; end if;
 update usernames set owner_id=null,status='AVAILABLE' where canonical=old_name;
 insert into username_history(canonical,from_user,action,actor,reason) values(old_name,p_recipient,'RELEASE_ON_GIFT',p_admin,p_reason);
 end if;
 update usernames set owner_id=p_recipient,status='ASSIGNED' where canonical=v;
 update users set username_changed_at=now() where id=p_recipient;
 insert into username_history(canonical,from_user,to_user,action,actor,reason) values(v,prev,p_recipient,'GIFT',p_admin,p_reason);
 insert into audit_logs(admin_id,action,target,reason,metadata) values(p_admin,'GIFT_USERNAME',v,p_reason,jsonb_build_object('recipient',p_recipient));
end $$;
-- No browser role can access application identity, phone HMACs or privileged RPCs.
do $$ declare r record; begin
 for r in select tablename from pg_tables where schemaname='public' and tablename in ('users','reserved_usernames','usernames','username_history','username_transfers','admin_users','audit_logs','rate_limits','webhook_receipts') loop
 execute format('alter table public.%I enable row level security',r.tablename);
 execute format('revoke all on table public.%I from anon, authenticated',r.tablename);
 execute format('grant all on table public.%I to service_role',r.tablename);
 end loop;
end $$;
do $$ declare r record; begin
 for r in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('immutable_record','check_adult_date','onboard','username_status','claim_username','consume_limit','begin_transfer','confirm_transfer','gift_premium') loop
 execute format('revoke execute on function %s from public, anon, authenticated',r.signature);
 execute format('grant execute on function %s to service_role',r.signature);
 end loop;
end $$;
grant usage, select on sequence public.username_history_id_seq,public.audit_logs_id_seq to service_role;
commit;
