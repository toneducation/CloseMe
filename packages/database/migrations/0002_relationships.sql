begin;
alter table users add column language_selected boolean not null default false, add column flow jsonb not null default '{}', add column messaging_enabled boolean not null default true;
alter table admin_users add column email text, add column created_at timestamptz not null default now(), add column last_active_at timestamptz;
create table settings(key text primary key,value jsonb not null);
insert into settings values ('registrations','true'),('photos','true'),('requests','true'),('messages','true'),('transfers','true'),('request_daily_limit','5');
create function enabled(p_key text) returns boolean language sql stable set search_path=public,pg_temp as $$ select coalesce((select value='true'::jsonb from settings where key=p_key),false) $$;
create function registration_gate() returns trigger language plpgsql set search_path=public,pg_temp as $$ begin if not enabled('registrations') and not exists(select 1 from users where telegram_id=new.telegram_id) then raise exception 'PAUSED'; end if;return new;end $$;
create trigger registration_gate before insert on users for each row execute function registration_gate();
create table profiles(user_id uuid primary key references users(id),display_name text not null check(length(display_name) between 1 and 50),gender text not null check(gender in ('woman','man','other')),interested_in text[] not null check(cardinality(interested_in) between 1 and 3 and interested_in <@ array['woman','man','other']),city text not null check(length(city) between 2 and 80),intent text not null check(intent in ('serious_relationship','long_term_relationship','friendship_first','open_to_relationship','getting_to_know_someone','unsure')),bio text not null default '' check(length(bio)<=500),hidden boolean not null default false,user_paused boolean not null default false,completed boolean not null default false,updated_at timestamptz not null default now());
create index profiles_city on profiles(lower(city));
create index profiles_name on profiles(lower(display_name));
create table interests(id text primary key,label_en text not null,label_uz text not null,label_ru text not null,active boolean not null default true);
insert into interests values
('travel','Travel','Sayohat','Путешествия',true),('music','Music','Musiqa','Музыка',true),('movies','Movies','Kino','Кино',true),('coffee','Coffee','Qahva','Кофе',true),('architecture','Architecture','Arxitektura','Архитектура',true),('gaming','Gaming','O‘yinlar','Игры',true),('fitness','Fitness','Fitnes','Фитнес',true),('photography','Photography','Fotografiya','Фотография',true),('books','Books','Kitoblar','Книги',true),('technology','Technology','Texnologiya','Технологии',true),('art','Art','San’at','Искусство',true),('food','Food','Taomlar','Еда',true),('nature','Nature','Tabiat','Природа',true),('business','Business','Biznes','Бизнес',true),('design','Design','Dizayn','Дизайн',true),('sports','Sports','Sport','Спорт',true);
create table profile_interests(user_id uuid references users(id),interest_id text references interests(id),primary key(user_id,interest_id));
create table location_preferences(user_id uuid primary key references users(id),lat_cell numeric check(lat_cell between -90 and 90),lon_cell numeric check(lon_cell between -180 and 180),radius integer not null default 50 check(radius between 5 and 500),min_age integer not null default 18 check(min_age>=18),max_age integer not null default 70 check(max_age between min_age and 120));
create table notification_preferences(user_id uuid primary key references users(id),enabled boolean not null default true);
create table photos(id uuid primary key default gen_random_uuid(),user_id uuid not null references users(id),status text not null default 'PROCESSING' check(status in ('PROCESSING','APPROVED','REJECTED','ERROR','REMOVED','HIDDEN')),storage_path text unique,primary_photo boolean not null default false,replaces uuid references photos(id),created_at timestamptz not null default now(),check(not primary_photo or status='APPROVED'));
create unique index photos_one_primary on photos(user_id) where primary_photo;
create index photos_user on photos(user_id,status);
create table usage_quotas(month date primary key,used integer not null default 0 check(used>=0));
create table quota_reservations(photo_id uuid primary key references photos(id),month date not null references usage_quotas(month),created_at timestamptz not null default now());
create table blocks(blocker uuid references users(id),blocked uuid references users(id),created_at timestamptz not null default now(),primary key(blocker,blocked),check(blocker<>blocked));
create index blocks_reverse on blocks(blocked,blocker);
create table likes(sender uuid references users(id),recipient uuid references users(id),super boolean not null default false,created_at timestamptz not null default now(),primary key(sender,recipient),check(sender<>recipient));
create index likes_recipient on likes(recipient,created_at);
create table passes(sender uuid references users(id),recipient uuid references users(id),created_at timestamptz not null default now(),primary key(sender,recipient));
create table matches(id uuid primary key default gen_random_uuid(),user_a uuid not null references users(id),user_b uuid not null references users(id),active boolean not null default true,created_at timestamptz not null default now(),unique(user_a,user_b),check(user_a<user_b));
create table conversations(id uuid primary key default gen_random_uuid(),user_a uuid not null references users(id),user_b uuid not null references users(id),active boolean not null default true,created_at timestamptz not null default now(),unique(user_a,user_b),check(user_a<user_b));
create table message_requests(id uuid primary key default gen_random_uuid(),sender uuid not null references users(id),recipient uuid not null references users(id),body text not null check(length(body) between 1 and 1000),state text not null default 'PENDING' check(state in ('PENDING','ACCEPTED','DECLINED','BLOCKED')),created_at timestamptz not null default now(),unique(sender,recipient),check(sender<>recipient));
create table messages(id uuid primary key default gen_random_uuid(),conversation_id uuid not null references conversations(id),sender uuid not null references users(id),body text not null check(length(body) between 1 and 2000),event_key text not null unique,created_at timestamptz not null default now());
create index messages_conversation on messages(conversation_id,created_at);
create table reports(id uuid primary key default gen_random_uuid(),reporter uuid not null references users(id),subject uuid not null references users(id),photo_id uuid references photos(id),conversation_id uuid references conversations(id),category text not null check(category in ('fake','spam','scam','harassment','sexual','photo','underage','impersonation','violence','other')),detail text not null default '' check(length(detail)<=1000),state text not null default 'NEW' check(state in ('NEW','UNDER_REVIEW','ESCALATED','RESOLVED','DISMISSED')),priority text not null default 'NORMAL' check(priority in ('LOW','NORMAL','HIGH','CRITICAL')),assigned_to uuid references admin_users(id),created_at timestamptz not null default now());
create index reports_queue on reports(state,priority,created_at);
create table risk_flags(id bigint generated always as identity primary key,user_id uuid not null references users(id),kind text not null,created_at timestamptz not null default now());
create table moderation_actions(id bigint generated always as identity primary key,user_id uuid references users(id),admin_id uuid references admin_users(id),action text not null,reason text not null,created_at timestamptz not null default now());
create table notifications(id uuid primary key default gen_random_uuid(),recipient uuid not null references users(id),actor uuid references users(id),kind text not null,payload jsonb not null default '{}',state text not null default 'PENDING' check(state in ('PENDING','SENDING','SENT','CANCELLED')),attempts integer not null default 0,lease_until timestamptz,created_at timestamptz not null default now());
create index notifications_pending on notifications(state,created_at);
create table action_receipts(event_key text primary key,result jsonb not null,created_at timestamptz not null default now());
create table update_leases(update_id bigint primary key,token uuid not null,expires_at timestamptz not null);
create function claim_update(p_id bigint,p_token uuid) returns boolean language plpgsql security definer set search_path=public,pg_temp as $$ begin
 if exists(select 1 from webhook_receipts where update_id=p_id) then return false;end if;
 insert into update_leases values(p_id,p_token,now()+interval '60 seconds') on conflict(update_id) do update set token=p_token,expires_at=now()+interval '60 seconds' where update_leases.expires_at<now();return found;
end $$;
create function finish_update(p_id bigint,p_token uuid,p_ok boolean) returns void language plpgsql security definer set search_path=public,pg_temp as $$ begin
 delete from update_leases where update_id=p_id and token=p_token;if found and p_ok then insert into webhook_receipts(update_id) values(p_id) on conflict do nothing;end if;
end $$;
create function blocked_pair(a uuid,b uuid) returns boolean language sql stable set search_path=public,pg_temp as $$ select exists(select 1 from blocks where (blocker=a and blocked=b) or (blocker=b and blocked=a)) $$;
create function active_user(p_user uuid) returns boolean language sql stable set search_path=public,pg_temp as $$ select exists(select 1 from users where id=p_user and status='ACTIVE' and state<>'DENIED' and birth_date<=current_date-interval '18 years' and phone_verified_at is not null) $$;
create function visible_user(p_user uuid) returns boolean language sql stable set search_path=public,pg_temp as $$ select active_user(p_user) and exists(select 1 from profiles where user_id=p_user and completed and not hidden and not user_paused) and exists(select 1 from usernames where owner_id=p_user and status='ASSIGNED') and exists(select 1 from photos where user_id=p_user and primary_photo and status='APPROVED') $$;
create function require_limit(p_user uuid,p_action text,p_limit int,p_seconds int) returns void language plpgsql set search_path=public,pg_temp as $$ begin if not consume_limit(p_user::text,p_action,p_limit,p_seconds) then raise exception 'LIMIT';end if;end $$;
create function card(p_viewer uuid,p_target uuid) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare result jsonb;begin
 if p_viewer<>p_target and (not visible_user(p_viewer) or not visible_user(p_target) or blocked_pair(p_viewer,p_target)) then return null;end if;
 select jsonb_build_object('id',u.id,'username',n.canonical,'premium',n.premium,'display_name',p.display_name,'age',extract(year from age(current_date,u.birth_date))::int,'city',p.city,'intent',p.intent,'bio',p.bio,'photo',ph.storage_path,'photo_id',ph.id,'interests',coalesce((select jsonb_agg(i.interest_id order by i.interest_id) from profile_interests i where i.user_id=u.id),'[]')) into result from users u join profiles p on p.user_id=u.id join usernames n on n.owner_id=u.id left join photos ph on ph.user_id=u.id and ph.primary_photo and ph.status='APPROVED' where u.id=p_target;
 return result;
end $$;
create function save_profile(p_user uuid,p_profile jsonb,p_interests text[]) returns void language plpgsql security definer set search_path=public,pg_temp as $$ begin
 perform 1 from users where id=p_user for update;if not active_user(p_user) then raise exception 'ACCOUNT_UNAVAILABLE';end if;
 if cardinality(p_interests) not between 5 and 10 or (select count(*) from interests where id=any(p_interests) and active)<>cardinality(p_interests) then raise exception 'INVALID_INTERESTS';end if;
 insert into profiles(user_id,display_name,gender,interested_in,city,intent,bio) values(p_user,p_profile->>'display_name',p_profile->>'gender',array(select jsonb_array_elements_text(p_profile->'interested_in')),p_profile->>'city',p_profile->>'intent',coalesce(p_profile->>'bio','')) on conflict(user_id) do update set display_name=excluded.display_name,gender=excluded.gender,interested_in=excluded.interested_in,city=excluded.city,intent=excluded.intent,bio=excluded.bio,updated_at=now();
 delete from profile_interests where user_id=p_user;insert into profile_interests select p_user,unnest(p_interests);
 update profiles set completed=exists(select 1 from photos where user_id=p_user and status='APPROVED' and primary_photo) where user_id=p_user;
 update users set flow='{}',state=case when exists(select 1 from profiles where user_id=p_user and completed) then 'READY' else 'PROFILE' end where id=p_user;
end $$;
create function photo_begin(p_user uuid,p_replace uuid,p_event text) returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare pid uuid;begin
 perform 1 from users where id=p_user for update;
 if not active_user(p_user) or not enabled('photos') then raise exception 'PAUSED';end if;
 select (result->>'id')::uuid into pid from action_receipts where event_key=p_user::text||':photo:'||p_event;if found then return pid;end if;
 perform require_limit(p_user,'photos',10,3600);
 if p_replace is not null and not exists(select 1 from photos where id=p_replace and user_id=p_user and status='APPROVED') then raise exception 'NOT_FOUND';end if;
 if p_replace is null and (select count(*) from photos where user_id=p_user and status in ('APPROVED','PROCESSING'))>=6 then raise exception 'PHOTO_LIMIT';end if;
 if exists(select 1 from photos where user_id=p_user and status='PROCESSING' and created_at>now()-interval '2 minutes') then raise exception 'BUSY';end if;
 update photos set status='ERROR' where user_id=p_user and status='PROCESSING';
 insert into photos(user_id,replaces) values(p_user,p_replace) returning id into pid;
 insert into action_receipts values(p_user::text||':photo:'||p_event,jsonb_build_object('id',pid),now());return pid;
end $$;
create function reserve_photo_quota(p_photo uuid,p_limit int) returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare m date:=date_trunc('month',timezone('UTC',now()))::date;begin
 perform 1 from photos where id=p_photo and status='PROCESSING' for update;if not found then return false;end if;
 if p_limit<1 or p_limit>950 then return false;end if;
 -- A reservation is single-use: retries never produce another external call.
 if exists(select 1 from quota_reservations where photo_id=p_photo) then return false;end if;
 insert into usage_quotas(month) values(m) on conflict do nothing;
 update usage_quotas set used=used+1 where month=m and used<p_limit;if not found then return false;end if;
 insert into quota_reservations values(p_photo,m,now());return true;
end $$;
create function photo_finish(p_user uuid,p_photo uuid,p_decision text,p_path text default null) returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare ph photos; was_primary boolean:=false;begin
 perform 1 from users where id=p_user for update;select * into ph from photos where id=p_photo and user_id=p_user for update;
 if not found or ph.status<>'PROCESSING' then return false;end if;
 if p_decision<>'SAFE' then update photos set status=case when p_decision='UNSAFE' then 'REJECTED' else 'ERROR' end where id=p_photo;insert into risk_flags(user_id,kind) values(p_user,'PHOTO_'||p_decision);return false;end if;
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
create function photo_edit(p_user uuid,p_photo uuid,p_action text) returns void language plpgsql security definer set search_path=public,pg_temp as $$ begin
 perform 1 from users where id=p_user for update;
 if not active_user(p_user) or not exists(select 1 from photos where id=p_photo and user_id=p_user and status='APPROVED') then raise exception 'NOT_FOUND';end if;
 if p_action='primary' then update photos set primary_photo=false where user_id=p_user;update photos set primary_photo=true where id=p_photo;
 elsif p_action='delete' then
 if (select count(*) from photos where user_id=p_user and status='APPROVED')<=1 then raise exception 'PRIMARY_REQUIRED';end if;
 update photos set status='REMOVED',primary_photo=false where id=p_photo;
 if not exists(select 1 from photos where user_id=p_user and primary_photo) then update photos set primary_photo=true where id=(select id from photos where user_id=p_user and status='APPROVED' order by created_at limit 1);end if;
 else raise exception 'INVALID_ACTION';end if;
end $$;
create function discover(p_user uuid,p_near boolean default false,p_name text default null) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare target uuid; loc location_preferences; result jsonb; distance float;begin
 if not visible_user(p_user) then raise exception 'PROFILE_REQUIRED';end if;
 perform require_limit(p_user,'search',30,60);
 select * into loc from location_preferences where user_id=p_user;
 if p_near and loc.lat_cell is null then raise exception 'LOCATION_REQUIRED';end if;
 select u.id into target from users u join profiles p on p.user_id=u.id join profiles me on me.user_id=p_user join usernames n on n.owner_id=u.id left join location_preferences l on l.user_id=u.id
 where u.id<>p_user and visible_user(u.id) and not blocked_pair(p_user,u.id)
 and (p_name is null or n.canonical=lower(p_name))
 and (p_name is not null or (p.gender=any(me.interested_in) and me.gender=any(p.interested_in) and extract(year from age(current_date,u.birth_date)) between coalesce(loc.min_age,18) and coalesce(loc.max_age,70) and not exists(select 1 from passes where sender=p_user and recipient=u.id) and not exists(select 1 from likes where sender=p_user and recipient=u.id)))
 and (not p_near or (l.lat_cell is not null and 6371*2*asin(least(1,sqrt(power(sin(radians((l.lat_cell-loc.lat_cell)::float)/2),2)+cos(radians(loc.lat_cell::float))*cos(radians(l.lat_cell::float))*power(sin(radians((l.lon_cell-loc.lon_cell)::float)/2),2))))<=loc.radius))
 order by u.last_active_at desc,u.id limit 1;
 if target is null then return null;end if;result:=card(p_user,target);
 if p_near then select 6371*2*asin(least(1,sqrt(power(sin(radians((l.lat_cell-loc.lat_cell)::float)/2),2)+cos(radians(loc.lat_cell::float))*cos(radians(l.lat_cell::float))*power(sin(radians((l.lon_cell-loc.lon_cell)::float)/2),2)))) into distance from location_preferences l where user_id=target;result:=result||jsonb_build_object('distance',greatest(5,round(distance/5)*5));end if;
 return result;
end $$;
create function social_action(p_user uuid,p_action text,p_target uuid,p_body text,p_event text,p_extra jsonb default '{}') returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare result jsonb; a uuid; b uuid; conv uuid; mid uuid; req message_requests; lim int;begin
 -- Consistent lock orders serialize block/send/match races. No external I/O inside this transaction.
 perform pg_advisory_xact_lock(810022);
 select r.result into result from action_receipts r where event_key=p_user::text||':'||p_action||':'||p_event;if found then return result;end if;
 if not active_user(p_user) then raise exception 'ACCOUNT_UNAVAILABLE';end if;
 if p_user=p_target then raise exception 'SAME_USER';end if;
 if not exists(select 1 from users where id=p_target) then raise exception 'NOT_FOUND';end if;
 a:=least(p_user,p_target);b:=greatest(p_user,p_target);
 if p_action='block' then
 insert into blocks values(p_user,p_target,now()) on conflict do nothing;
 update matches set active=false where user_a=a and user_b=b;update conversations set active=false where user_a=a and user_b=b;
 update message_requests set state='BLOCKED' where (sender=a and recipient=b) or (sender=b and recipient=a);
 update notifications set state='CANCELLED' where state in ('PENDING','SENDING') and ((recipient=a and actor=b) or (recipient=b and actor=a));result:='{"ok":true}';
 elsif p_action='report' then
 perform require_limit(p_user,'reports',5,3600);
 if p_extra->>'photo_id' is not null and not exists(select 1 from photos where id=(p_extra->>'photo_id')::uuid and user_id=p_target and status in ('APPROVED','HIDDEN')) then raise exception 'NOT_FOUND';end if;
 select id into conv from conversations where user_a=a and user_b=b;
 insert into reports(reporter,subject,photo_id,conversation_id,category,detail,priority) values(p_user,p_target,(p_extra->>'photo_id')::uuid,conv,p_extra->>'category',coalesce(p_body,''),case when p_extra->>'category' in ('underage','violence','sexual') then 'HIGH' else 'NORMAL' end) returning id into mid;
 insert into risk_flags(user_id,kind) values(p_target,'REPORT_'||(p_extra->>'category'));
 if (select count(distinct reporter) from reports where subject=p_target and state in ('NEW','UNDER_REVIEW','ESCALATED') and priority in ('HIGH','CRITICAL'))>=3 then update users set risk_state='REVIEW',status='NEEDS_REVIEW' where id=p_target and status='ACTIVE';end if;
 result:=jsonb_build_object('id',mid);
 else
 if not visible_user(p_user) or not visible_user(p_target) or blocked_pair(p_user,p_target) then raise exception 'NOT_FOUND';end if;
 if p_action in ('like','super','skip') then
 perform require_limit(p_user,p_action,case when p_action='super' then 3 else 100 end,86400);
 if p_action='skip' then insert into passes values(p_user,p_target,now()) on conflict do nothing;result:='{"ok":true}';
 else
 insert into likes(sender,recipient,super) values(p_user,p_target,p_action='super') on conflict do nothing;
 if found then insert into notifications(recipient,actor,kind) values(p_target,p_user,'like');end if;
 if exists(select 1 from likes where sender=p_target and recipient=p_user) then
 insert into matches(user_a,user_b) values(a,b) on conflict(user_a,user_b) do nothing returning id into mid;
 if mid is not null then insert into notifications(recipient,actor,kind) values(p_user,p_target,'match'),(p_target,p_user,'match');end if;
 insert into conversations(user_a,user_b) values(a,b) on conflict(user_a,user_b) do nothing;
 select id into mid from matches where user_a=a and user_b=b and active;
 end if;
 result:=jsonb_build_object('match',mid is not null);
 end if;
 elsif p_action='request' then
 if not enabled('requests') or not (select messaging_enabled from users where id=p_user) or not (select messaging_enabled from users where id=p_target) then raise exception 'PAUSED';end if;
 if exists(select 1 from message_requests where sender=p_user and recipient=p_target) then raise exception 'REQUEST_EXISTS';end if;
 if exists(select 1 from conversations where user_a=a and user_b=b and active) then raise exception 'USE_CONVERSATION';end if;
 select least(20,greatest(1,value::text::int)) into lim from settings where key='request_daily_limit';perform require_limit(p_user,'requests',coalesce(lim,5),86400);
 insert into message_requests(sender,recipient,body) values(p_user,p_target,p_body) returning id into mid;
 insert into notifications(recipient,actor,kind,payload) values(p_target,p_user,'request',jsonb_build_object('request_id',mid));result:=jsonb_build_object('id',mid);
 elsif p_action in ('accept','decline') then
 select * into req from message_requests where id=(p_extra->>'id')::uuid and recipient=p_user and sender=p_target and state='PENDING' for update;if not found then raise exception 'NOT_FOUND';end if;
 update message_requests set state=case when p_action='accept' then 'ACCEPTED' else 'DECLINED' end where id=req.id;
 if p_action='accept' then
 insert into conversations(user_a,user_b) values(a,b) on conflict(user_a,user_b) do update set active=true returning id into conv;
 insert into messages(conversation_id,sender,body,event_key) values(conv,req.sender,req.body,'request:'||req.id) on conflict do nothing;
 insert into notifications(recipient,actor,kind) values(p_target,p_user,'accepted');end if;result:=jsonb_build_object('conversation_id',conv);
 elsif p_action='message' then
 if not enabled('messages') or not (select messaging_enabled from users where id=p_user) or not (select messaging_enabled from users where id=p_target) then raise exception 'PAUSED';end if;
 select id into conv from conversations where user_a=a and user_b=b and active;if conv is null then raise exception 'REQUEST_REQUIRED';end if;
 perform require_limit(p_user,'messages',30,60);
 insert into messages(conversation_id,sender,body,event_key) values(conv,p_user,p_body,p_user::text||':'||p_event) returning id into mid;
 insert into notifications(recipient,actor,kind,payload) values(p_target,p_user,'message',jsonb_build_object('message_id',mid));result:=jsonb_build_object('id',mid);
 elsif p_action='unmatch' then update matches set active=false where user_a=a and user_b=b;update conversations set active=false where user_a=a and user_b=b;result:='{"ok":true}';
 else raise exception 'INVALID_ACTION';end if;
 end if;
 insert into action_receipts values(p_user::text||':'||p_action||':'||p_event,result,now());return result;
end $$;
create function inbox(p_user uuid,p_kind text) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$ declare result jsonb;begin
 if not visible_user(p_user) then raise exception 'PROFILE_REQUIRED';end if;
 if p_kind='likes' then select jsonb_agg(card(p_user,sender)) into result from (select sender from likes where recipient=p_user and visible_user(sender) and not blocked_pair(p_user,sender) order by created_at desc limit 20) s;
 elsif p_kind='matches' then select jsonb_agg(card(p_user,other)) into result from (select case when user_a=p_user then user_b else user_a end other from matches where active and p_user in (user_a,user_b) order by created_at desc limit 20) s;
 elsif p_kind='requests' then select jsonb_agg(jsonb_build_object('id',id,'body',body,'profile',card(p_user,sender))) into result from (select * from message_requests where recipient=p_user and state='PENDING' and not blocked_pair(p_user,sender) and visible_user(sender) order by created_at desc limit 20) s;
 elsif p_kind='messages' then select jsonb_agg(card(p_user,other)) into result from (select case when user_a=p_user then user_b else user_a end other from conversations where active and p_user in (user_a,user_b) order by created_at desc limit 20) s;
 else raise exception 'INVALID_ACTION';end if;return coalesce(result,'[]');end $$;
create function notification_claim() returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$ declare n notifications; u users; a text; content text; result jsonb:='[]';begin
 perform pg_advisory_xact_lock(810022);
 for n in select * from notifications where (state='PENDING' or (state='SENDING' and lease_until<now())) and attempts<5 order by created_at limit 5 for update skip locked loop
 select * into u from users where id=n.recipient;
 if u.status<>'ACTIVE' or (n.actor is not null and (blocked_pair(n.recipient,n.actor) or not active_user(n.actor))) or exists(select 1 from notification_preferences where user_id=n.recipient and not enabled) then update notifications set state='CANCELLED' where id=n.id;continue;end if;
 select canonical into a from usernames where owner_id=n.actor;
 content:=null;
 if n.kind='message' then select body into content from messages where id=(n.payload->>'message_id')::uuid;
 elsif n.kind='request' then select body into content from message_requests where id=(n.payload->>'request_id')::uuid and state='PENDING';end if;
 update notifications set state='SENDING',attempts=attempts+1,lease_until=now()+interval '1 minute' where id=n.id;
 result:=result||jsonb_build_array(jsonb_build_object('id',n.id,'recipient',n.recipient,'telegram_id',u.telegram_id,'locale',u.locale,'kind',n.kind,'actor',n.actor,'username',a,'body',content,'payload',n.payload));
 end loop;return result;end $$;
-- RLS defaults to no browser access. Explicitly cover only objects introduced by this migration.
do $$ declare r text;begin foreach r in array array['settings','profiles','interests','profile_interests','location_preferences','notification_preferences','photos','usage_quotas','quota_reservations','blocks','likes','passes','matches','conversations','message_requests','messages','reports','risk_flags','moderation_actions','notifications','action_receipts','update_leases'] loop execute format('alter table %I enable row level security',r);execute format('revoke all on %I from anon,authenticated',r);execute format('grant all on %I to service_role',r);end loop;end $$;
do $$ declare r record;begin for r in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('enabled','registration_gate','claim_update','finish_update','blocked_pair','active_user','visible_user','require_limit','card','save_profile','photo_begin','reserve_photo_quota','photo_finish','photo_edit','discover','social_action','inbox','notification_claim') loop execute format('revoke execute on function %s from public,anon,authenticated',r.signature);execute format('grant execute on function %s to service_role',r.signature);end loop;end $$;
grant usage,select on sequence risk_flags_id_seq,moderation_actions_id_seq to service_role;
commit;
