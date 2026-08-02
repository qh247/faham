-- faham · 阶段一运行表 (phase-1 runtime tables)
--
-- 与 schema.sql 的关系：
--   schema.sql  = 完整目标结构（26 表，事件／主张／来源／复核的全图）
--   live.sql    = 现在真的在跑的那一小块：评论、投稿、举报
--
-- 为什么先跑这一小块：事件数据目前仍以 data/events.json 静态发布，
-- 每个分支各自一份（dev 有样品、main 为空），不需要数据库参与读取。
-- 需要数据库的只有「写入」——用户产生的内容。
--
-- 设计原则（与 docs/governance.zh.md 一致）：
--   1. 规则写成约束，不写成自觉。字数、来源数量、频率限制全部由数据库拒绝，
--      前端即使被绕过（curl 直接打 API）也一样拒绝。
--   2. 不存 IP。只存每日轮换盐的 HMAC 摘要，且分两层：
--      actor_hash = 单一访客桶（cookie 派生），net_hash = 粗网络桶。
--      隔日盐轮换后，昨天的摘要无法与今天的关联，也无法还原成 IP。
--   3. dev 与 prod 共用一个数据库，用 env 列隔离，样品数据不会污染正式站。

create extension if not exists pgcrypto;

do $$ begin
  create type app_env as enum ('dev','prod');
exception when duplicate_object then null; end $$;

-- 所有来源必须是 http(s) 链接。数组逐元素校验需要函数，CHECK 无法直接做。
create or replace function faham_all_urls(t text[]) returns boolean
  language sql immutable as $$
  select coalesce(bool_and(x ~ '^https?://[^\s]{6,}$'), false) from unnest(t) x
$$;


-- ── 评论 ─────────────────────────────────────────────────────────────────
create table if not exists app_comments (
  id          uuid primary key default gen_random_uuid(),
  env         app_env not null,
  event_slug  text    not null,
  body        text    not null,
  actor_hash  bytea   not null,
  net_hash    bytea   not null,
  status      text    not null default 'visible',
  reports     int     not null default 0,
  created_at  timestamptz not null default now(),

  -- 30–50 字：从产品层面排除长篇情绪宣泄，比事后审核便宜得多
  constraint comment_len   check (char_length(btrim(body)) between 30 and 50),
  constraint comment_state check (status in ('visible','folded','hidden','removed'))
);

create index if not exists app_comments_feed
  on app_comments (env, event_slug, created_at desc) where status = 'visible';
create index if not exists app_comments_rate
  on app_comments (env, actor_hash, created_at desc);
create index if not exists app_comments_net
  on app_comments (env, net_hash, created_at desc);

-- 频率限制：每人每帖每 24 小时 2 条。
-- 第二层 net_hash 上限放得很宽（24 小时 20 条），因为马来西亚电信普遍使用 CGNAT，
-- 同一个出口 IP 后面可能是整栋组屋——把这层收紧等于误伤一大片无辜的人。
create or replace function faham_comment_rate() returns trigger
  language plpgsql as $$
declare n int;
begin
  select count(*) into n from app_comments
   where env = new.env and event_slug = new.event_slug
     and actor_hash = new.actor_hash
     and created_at > now() - interval '24 hours';
  if n >= 2 then
    raise exception 'RATE_POST' using errcode = 'P0001';
  end if;

  select count(*) into n from app_comments
   where env = new.env and net_hash = new.net_hash
     and created_at > now() - interval '24 hours';
  if n >= 20 then
    raise exception 'RATE_NET' using errcode = 'P0001';
  end if;

  return new;
end $$;

drop trigger if exists trg_comment_rate on app_comments;
create trigger trg_comment_rate before insert on app_comments
  for each row execute function faham_comment_rate();


-- ── 举报 ─────────────────────────────────────────────────────────────────
create table if not exists app_reports (
  id          uuid primary key default gen_random_uuid(),
  comment_id  uuid not null references app_comments(id) on delete cascade,
  reason      text not null,
  net_hash    bytea not null,
  created_at  timestamptz not null default now(),
  resolved_at timestamptz,
  action_taken text,
  constraint report_reason check (char_length(btrim(reason)) between 2 and 200)
);

-- 同一网络对同一条评论只能举报一次，防止刷举报把人压下去
create unique index if not exists app_reports_once
  on app_reports (comment_id, net_hash);

-- 累计 3 个不同网络举报 → 自动折叠（折叠不是删除，内容仍可展开查看）。
-- 自动折叠只是降低可见度并排进人工队列，不做自动删除：
-- 让机器直接删内容，等于把审查权交给举报最积极的人。
create or replace function faham_report_fold() returns trigger
  language plpgsql as $$
begin
  update app_comments
     set reports = reports + 1,
         status  = case when reports + 1 >= 3 and status = 'visible'
                        then 'folded' else status end
   where id = new.comment_id;
  return new;
end $$;

drop trigger if exists trg_report_fold on app_reports;
create trigger trg_report_fold after insert on app_reports
  for each row execute function faham_report_fold();


-- ── 投稿 ─────────────────────────────────────────────────────────────────
create table if not exists app_submissions (
  id          uuid primary key default gen_random_uuid(),
  env         app_env not null,
  kind        text not null,
  title       text not null,
  occurred_on date,
  body        text not null,
  sources     text[] not null,
  target_slug text,
  contact     text,
  net_hash    bytea not null,
  state       text not null default 'pending',
  reviewer_note text,
  created_at  timestamptz not null default now(),
  resolved_at timestamptz,

  -- lead（线索）是最低门槛的一档：一个链接就够，说明可以完全不写。
  -- 分档的理由：贡献的成本必须与贡献的分量相称。
  -- 让「我看到一条新闻，你们看看」和「我要新增一条档案条目」填一样多的字，
  -- 结果是两种人都不填。
  constraint sub_kind  check (kind in ('lead','new_event','correction','source')),
  constraint sub_state check (state in ('pending','approved','rejected','needs_more')),
  constraint sub_title check (char_length(btrim(title)) between 4 and 200),
  constraint sub_urls  check (faham_all_urls(sources)),

  constraint sub_body check (
    case kind when 'lead' then char_length(btrim(body)) <= 1200
              else char_length(btrim(body)) between 20 and 1200 end
  ),

  -- 收录准则第一节第 2 条写成约束：新事件必须 ≥2 个独立来源；
  -- 其余至少 1 个。没有任何来源的投稿，数据库直接拒绝，不进人工队列。
  constraint sub_sources check (
    case kind when 'new_event' then coalesce(array_length(sources, 1), 0) >= 2
              else coalesce(array_length(sources, 1), 0) >= 1 end
  )
);

create index if not exists app_submissions_queue
  on app_submissions (env, state, created_at desc);
create index if not exists app_submissions_rate
  on app_submissions (net_hash, created_at desc);

create or replace function faham_submission_rate() returns trigger
  language plpgsql as $$
declare n int;
begin
  select count(*) into n from app_submissions
   where net_hash = new.net_hash and created_at > now() - interval '24 hours';
  if n >= 5 then
    raise exception 'RATE_SUB' using errcode = 'P0001';
  end if;
  return new;
end $$;

drop trigger if exists trg_submission_rate on app_submissions;
create trigger trg_submission_rate before insert on app_submissions
  for each row execute function faham_submission_rate();


-- ── 公开视图 ─────────────────────────────────────────────────────────────
-- 对外只暴露这些列：没有 hash、没有时间以外的任何可用于关联的字段。
create or replace view public_comments as
  select id, env, event_slug, body, status, reports, created_at
    from app_comments
   where status in ('visible','folded');

-- 投稿队列的公开面：只统计，不暴露内容。
-- 「有多少投稿在等、多少被拒」本身就是一个应该公开的数字。
create or replace view public_submission_stats as
  select env, state, count(*) as n, max(created_at) as latest
    from app_submissions group by env, state;
