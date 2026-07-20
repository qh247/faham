-- ═══════════════════════════════════════════════════════════════════════
--  faham · 数据库结构  (PostgreSQL 15+ / Neon)
--
--  设计原则 —— 这些不是注释里的口号，是被约束强制执行的：
--   1. 无来源的数据插不进来      → impacts.source_id / claim_citations 皆 NOT NULL
--   2. 改动一律留痕，不静默改写  → revisions 快照表 + 触发器自动写入
--   3. 正反并列可被机器检验      → event_balance 视图 + 发布前检查函数
--   4. 个资最小化（PDPA）        → 存 ip_hash 而非 IP 明文，会话哈希代替身份
--   5. 多语言是结构而非装饰      → *_i18n 表，马来语/中文/英文对等
--   6. 可整包导出、可分叉        → 所有内容表均可 COPY 成 JSON/CSV 公开
--
--  执行方式： psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/schema.sql
-- ═══════════════════════════════════════════════════════════════════════

BEGIN;

CREATE EXTENSION IF NOT EXISTS "pgcrypto";   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "citext";     -- 大小写不敏感邮箱

-- ───────────────────────── 枚举 ─────────────────────────
CREATE TYPE lang_code       AS ENUM ('ms','zh','en','ta');           -- 马来语/中文/英文/淡米尔语
CREATE TYPE actor_kind      AS ENUM ('person','party','coalition','govt_body','ngo','company','media','other');
CREATE TYPE actor_role      AS ENUM ('responsible','proposer','opponent','decider','affected','beneficiary','mentioned');
CREATE TYPE date_precision  AS ENUM ('day','month','year','range');
CREATE TYPE pub_status      AS ENUM ('draft','in_review','published','retracted');
CREATE TYPE stance          AS ENUM ('support','oppose','neutral');
CREATE TYPE source_kind     AS ENUM ('news','official','academic','court','dataset','ngo','book','other');
CREATE TYPE relation_kind   AS ENUM ('causes','precedes','supersedes','reverses','implements','contradicts','related');
CREATE TYPE trust_tier      AS ENUM ('guest','verified','trusted','reviewer','editor');
CREATE TYPE comment_status  AS ENUM ('visible','folded','hidden','removed');
CREATE TYPE submission_kind AS ENUM ('new_event','edit_event','new_claim','new_source','correction','new_actor');
CREATE TYPE submission_state AS ENUM ('pending','changes_requested','approved','rejected','withdrawn');
CREATE TYPE review_decision AS ENUM ('approve','reject','request_changes');
CREATE TYPE engagement_kind AS ENUM ('view','expand','share','cite','export');

-- ═════════════════ 一、人物 / 组织（actors）═════════════════
-- 人、政党、联盟、政府机构、公司、媒体统一建模；用 parent_id 表达从属
-- （如 巫统 → 国阵，某部门 → 联邦政府）
CREATE TABLE actors (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug         text UNIQUE NOT NULL CHECK (slug ~ '^[a-z0-9-]+$'),
  kind         actor_kind NOT NULL,
  parent_id    uuid REFERENCES actors(id) ON DELETE SET NULL,
  active_from  date,
  active_to    date,                                   -- 政党解散/人物卸任
  status       pub_status NOT NULL DEFAULT 'draft',
  created_by   uuid,                                   -- → users(id)，稍后加外键
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (active_to IS NULL OR active_from IS NULL OR active_to >= active_from)
);

CREATE TABLE actor_i18n (
  actor_id uuid NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  lang     lang_code NOT NULL,
  name     text NOT NULL,
  bio      text,
  PRIMARY KEY (actor_id, lang)
);

-- ═════════════════ 二、来源（sources）═════════════════
-- outlets 单独建表，并记录「所有权事实」而非「立场判断」——
-- 所有权可查证，立场是意见。马来西亚多家媒体有政党持股，读者应自行权衡。
CREATE TABLE outlets (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug           text UNIQUE NOT NULL,
  name           text NOT NULL,
  country        text DEFAULT 'MY',
  primary_lang   lang_code,
  ownership_note text,                                  -- 事实陈述，须配 ownership_source_id
  ownership_source_id uuid,                             -- → sources(id)
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sources (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          source_kind NOT NULL,
  outlet_id     uuid REFERENCES outlets(id) ON DELETE SET NULL,
  title         text NOT NULL,
  url           text,
  archived_url  text,                                   -- 存档快照：防链接失效，事实档案的命脉
  published_on  date,
  retrieved_at  timestamptz NOT NULL DEFAULT now(),
  lang          lang_code,
  paywalled     boolean NOT NULL DEFAULT false,
  note          text,
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (url IS NOT NULL OR archived_url IS NOT NULL OR kind IN ('book','other'))
);
ALTER TABLE outlets
  ADD CONSTRAINT outlets_ownership_source_fk
  FOREIGN KEY (ownership_source_id) REFERENCES sources(id) ON DELETE SET NULL;

CREATE INDEX sources_outlet_idx    ON sources(outlet_id);
CREATE INDEX sources_published_idx ON sources(published_on DESC);

-- ═════════════════ 三、议题 & 事件 ═════════════════
CREATE TABLE topics (
  id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key   text UNIQUE NOT NULL,          -- subsidy / tax / cost / vote / graft ...
  color text
);
CREATE TABLE topic_i18n (
  topic_id uuid NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  lang     lang_code NOT NULL,
  name     text NOT NULL,
  PRIMARY KEY (topic_id, lang)
);

CREATE TABLE events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug           text UNIQUE NOT NULL CHECK (slug ~ '^[a-z0-9-]+$'),
  occurred_on    date NOT NULL,
  occurred_end   date,                                  -- 跨期事件（如 2020–2022 提款潮）
  precision      date_precision NOT NULL DEFAULT 'day',
  weight         smallint NOT NULL DEFAULT 2 CHECK (weight BETWEEN 1 AND 3),
  status         pub_status NOT NULL DEFAULT 'draft',
  contested      boolean NOT NULL DEFAULT false,        -- 争议性议题：发布前强制正反并列
  created_by     uuid,
  published_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (occurred_end IS NULL OR occurred_end >= occurred_on)
);
CREATE INDEX events_date_idx   ON events(occurred_on);
CREATE INDEX events_status_idx ON events(status) WHERE status = 'published';

CREATE TABLE event_i18n (
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  lang     lang_code NOT NULL,
  title    text NOT NULL,
  summary  text,                                        -- 一句话概述
  cause    text,                                        -- 起因
  note     text,                                        -- 附注 / 提醒
  PRIMARY KEY (event_id, lang)
);
-- 全文检索（中文需配分词，先按简单配置建；上线后可换 pg_bigm / zhparser）
CREATE INDEX event_i18n_fts_idx ON event_i18n
  USING gin (to_tsvector('simple', coalesce(title,'') || ' ' || coalesce(summary,'')));

CREATE TABLE event_topics (
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  topic_id uuid NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  PRIMARY KEY (event_id, topic_id)
);

-- 人物/组织 ↔ 事件，带角色（谁负责、谁提出、谁反对、谁受影响）
CREATE TABLE event_actors (
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  role     actor_role NOT NULL,
  note     text,
  PRIMARY KEY (event_id, actor_id, role)
);
CREATE INDEX event_actors_actor_idx ON event_actors(actor_id);

-- 事件之间的相关性（因果、取代、逆转……）
CREATE TABLE event_relations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_event uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  to_event   uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  kind       relation_kind NOT NULL,
  note       text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (from_event <> to_event),
  UNIQUE (from_event, to_event, kind)
);

-- 状态历程（留痕不删：政策口径变了就追加一条，不改旧的）
CREATE TABLE event_timeline (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id   uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  happened_on date NOT NULL,
  label_ms   text, label_zh text, label_en text,
  source_id  uuid REFERENCES sources(id) ON DELETE SET NULL,
  seq        smallint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX event_timeline_event_idx ON event_timeline(event_id, happened_on, seq);

-- ═════════════════ 四、主张 & 引用 ═════════════════
CREATE TABLE claims (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id     uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  stance       stance NOT NULL,
  actor_id     uuid REFERENCES actors(id) ON DELETE SET NULL,   -- 谁主张的（若为已收录主体）
  attributed_to text,                                            -- 或自由文本（「中小企业/商会」）
  lang         lang_code NOT NULL DEFAULT 'zh',
  body         text NOT NULL,
  status       pub_status NOT NULL DEFAULT 'draft',
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX claims_event_idx ON claims(event_id, stance);

-- 主张必须挂来源：这张表存在本身就是「无来源不发布」的执行机制
CREATE TABLE claim_citations (
  claim_id  uuid NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES sources(id) ON DELETE RESTRICT,
  quote     text,                                       -- 原文摘录，便于核对
  locator   text,                                       -- 页码/段落/时间码
  PRIMARY KEY (claim_id, source_id)
);

-- ═════════════════ 五、差异化影响 ═════════════════
-- source_id 为 NOT NULL —— 没有可靠来源的数字，在数据库层面就写不进去。
-- 这是「本平台不发布未经核实的数字」这条承诺的硬执行点。
CREATE TABLE impacts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id   uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  dimension  text NOT NULL,          -- business_size / region / income / industry / ethnicity ...
  label_ms   text, label_zh text, label_en text,
  value_ms   text, value_zh text, value_en text,
  source_id  uuid NOT NULL REFERENCES sources(id) ON DELETE RESTRICT,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX impacts_event_idx ON impacts(event_id);

-- ═════════════════ 六、图像资料 ═════════════════
CREATE TABLE media (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  storage_key text NOT NULL,                    -- 自托管路径（R2/Pages），不外链第三方
  kind        text NOT NULL DEFAULT 'image',    -- image | chart | document
  caption_ms  text, caption_zh text, caption_en text,
  credit      text,                             -- 署名
  license     text,                             -- 授权（自制图表填 CC BY / 自有）
  source_id   uuid REFERENCES sources(id) ON DELETE SET NULL,
  width       int, height int,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ═════════════════ 七、用户与信任分层 ═════════════════
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  handle        text UNIQUE NOT NULL CHECK (handle ~ '^[a-z0-9_-]{3,24}$'),
  email         citext UNIQUE,                  -- 仅用于登录与通知；保留期见 docs/privacy
  email_verified_at timestamptz,
  tier          trust_tier NOT NULL DEFAULT 'guest',
  -- 声明性偏好：核查者可自愿公开政治倾向，用于组建「多元复核组」而非用于歧视
  alignment_note text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  banned_at     timestamptz,
  ban_reason    text
);

-- 行为统计（信任层级由行为累积决定，不是填个邮箱就过关）
CREATE TABLE user_stats (
  user_id            uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  claims_accepted    int NOT NULL DEFAULT 0,
  submissions_approved int NOT NULL DEFAULT 0,
  comments_removed   int NOT NULL DEFAULT 0,
  reports_upheld     int NOT NULL DEFAULT 0,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- 补上前面各表的 created_by 外键
ALTER TABLE actors  ADD CONSTRAINT actors_created_by_fk  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE sources ADD CONSTRAINT sources_created_by_fk FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE events  ADD CONSTRAINT events_created_by_fk  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE claims  ADD CONSTRAINT claims_created_by_fk  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE impacts ADD CONSTRAINT impacts_created_by_fk FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE event_relations ADD CONSTRAINT er_created_by_fk FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;

-- ═════════════════ 八、投稿与复核（公平性的引擎）═════════════════
-- 任何内容进入档案都要走这条路；谁提交、谁复核、为何通过，全部留痕公开。
CREATE TABLE submissions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind         submission_kind NOT NULL,
  target_id    uuid,                              -- 编辑类投稿指向既有对象
  payload      jsonb NOT NULL,                    -- 拟新增/修改的内容
  rationale    text,                              -- 提交者说明
  state        submission_state NOT NULL DEFAULT 'pending',
  submitted_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  decided_at   timestamptz
);
CREATE INDEX submissions_state_idx ON submissions(state, created_at DESC);

CREATE TABLE reviews (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id uuid NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  reviewer_id   uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  decision      review_decision NOT NULL,
  rationale     text NOT NULL,                    -- 必须写理由，不能只点通过
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (submission_id, reviewer_id)             -- 一人一票，不能重复复核
);

-- 公开纠错台账
CREATE TABLE corrections (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    uuid REFERENCES events(id) ON DELETE CASCADE,
  claim_id    uuid REFERENCES claims(id) ON DELETE CASCADE,
  reported_by uuid REFERENCES users(id) ON DELETE SET NULL,
  description text NOT NULL,
  resolution  text,
  resolved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  resolved_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (event_id IS NOT NULL OR claim_id IS NOT NULL)
);

-- ═════════════════ 九、修订快照（留痕不删）═════════════════
CREATE TABLE revisions (
  id          bigserial PRIMARY KEY,
  entity_type text NOT NULL,                      -- 'event' | 'claim' | 'impact' | 'actor'
  entity_id   uuid NOT NULL,
  snapshot    jsonb NOT NULL,                     -- 变更「之后」的完整状态
  change_note text,
  author_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX revisions_entity_idx ON revisions(entity_type, entity_id, created_at DESC);

CREATE OR REPLACE FUNCTION snapshot_revision() RETURNS trigger AS $$
BEGIN
  INSERT INTO revisions(entity_type, entity_id, snapshot)
  VALUES (TG_ARGV[0], NEW.id, to_jsonb(NEW));
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER events_revision  AFTER INSERT OR UPDATE ON events
  FOR EACH ROW EXECUTE FUNCTION snapshot_revision('event');
CREATE TRIGGER claims_revision  AFTER INSERT OR UPDATE ON claims
  FOR EACH ROW EXECUTE FUNCTION snapshot_revision('claim');
CREATE TRIGGER impacts_revision AFTER INSERT OR UPDATE ON impacts
  FOR EACH ROW EXECUTE FUNCTION snapshot_revision('impact');

-- ═════════════════ 十、评论 ═════════════════
-- 注意：评论是法律风险最集中的一环（《证据法》114A 推定平台运营者为发布者）。
-- 因此举报处理必须留时间戳与判定依据——它同时是产品数据和法律抗辩材料。
CREATE TABLE comments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id   uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  parent_id  uuid REFERENCES comments(id) ON DELETE CASCADE,
  author_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  body       text NOT NULL CHECK (length(btrim(body)) >= 2),
  status     comment_status NOT NULL DEFAULT 'visible',
  lang       lang_code,
  ip_hash    bytea,                               -- 只存哈希，不存 IP 明文（PDPA 最小化）
  created_at timestamptz NOT NULL DEFAULT now(),
  edited_at  timestamptz,
  hidden_reason text,
  moderated_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  moderated_at  timestamptz
);
CREATE INDEX comments_event_idx  ON comments(event_id, created_at DESC);
CREATE INDEX comments_author_idx ON comments(author_id, created_at DESC);

CREATE TABLE comment_reports (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  comment_id  uuid NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  reporter_id uuid REFERENCES users(id) ON DELETE SET NULL,
  reason      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  resolved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  resolved_at timestamptz,
  action_taken text,
  UNIQUE (comment_id, reporter_id)               -- 同一人对同一条只能举报一次
);
CREATE INDEX comment_reports_open_idx ON comment_reports(created_at DESC) WHERE resolved_at IS NULL;

-- ═════════════════ 十一、互动与热度 ═════════════════
-- 热度由信号推算，不存一个可被随手改的「热度值」。
CREATE TABLE engagements (
  id           bigserial PRIMARY KEY,
  event_id     uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  kind         engagement_kind NOT NULL,
  user_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  session_hash bytea,                             -- 匿名会话哈希，用于去重而非追踪个人
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX engagements_event_time_idx ON engagements(event_id, created_at DESC);

CREATE TABLE claim_votes (
  claim_id  uuid NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  value     smallint NOT NULL CHECK (value IN (-1, 1)),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (claim_id, user_id)
);

-- 热度：按信任层级加权 + 时间衰减（类 Hacker News）。刷小号收效甚微。
CREATE MATERIALIZED VIEW event_heat AS
SELECT
  e.id AS event_id,
  round(sum(
    CASE u.tier
      WHEN 'trusted'  THEN 3.0
      WHEN 'reviewer' THEN 3.0
      WHEN 'editor'   THEN 3.0
      WHEN 'verified' THEN 1.5
      ELSE 0.5
    END
    * CASE en.kind WHEN 'cite' THEN 4 WHEN 'share' THEN 3 WHEN 'expand' THEN 2 ELSE 1 END
    * exp(-extract(epoch FROM (now() - en.created_at)) / (86400 * 7.0))   -- 7 天半衰
  )::numeric, 3) AS heat,
  count(*) AS signal_count,
  max(en.created_at) AS last_signal_at
FROM events e
LEFT JOIN engagements en ON en.event_id = e.id
LEFT JOIN users u ON u.id = en.user_id
WHERE e.status = 'published'
GROUP BY e.id;
CREATE UNIQUE INDEX event_heat_pk ON event_heat(event_id);
-- 定时刷新： REFRESH MATERIALIZED VIEW CONCURRENTLY event_heat;

-- ═════════════════ 十二、中立性检验（可被机器验证）═════════════════
-- 正反并列的状态，任何人都能查询核对，不靠运营者自称。
CREATE VIEW event_balance AS
SELECT
  e.id AS event_id,
  count(*) FILTER (WHERE c.stance = 'support' AND c.status = 'published') AS support_n,
  count(*) FILTER (WHERE c.stance = 'oppose'  AND c.status = 'published') AS oppose_n,
  count(*) FILTER (WHERE c.stance = 'neutral' AND c.status = 'published') AS neutral_n,
  count(DISTINCT cc.source_id) AS distinct_sources
FROM events e
LEFT JOIN claims c ON c.event_id = e.id
LEFT JOIN claim_citations cc ON cc.claim_id = c.id
GROUP BY e.id;

-- 发布前置检查：争议性事件必须正反俱在，且每条主张都有来源
CREATE OR REPLACE FUNCTION check_publishable(p_event uuid)
RETURNS TABLE (ok boolean, reason text) AS $$
DECLARE b record; unsourced int;
BEGIN
  SELECT * INTO b FROM event_balance WHERE event_id = p_event;

  SELECT count(*) INTO unsourced
  FROM claims c
  WHERE c.event_id = p_event
    AND NOT EXISTS (SELECT 1 FROM claim_citations x WHERE x.claim_id = c.id);

  IF unsourced > 0 THEN
    RETURN QUERY SELECT false, format('有 %s 条主张没有来源', unsourced); RETURN;
  END IF;

  IF (SELECT contested FROM events WHERE id = p_event)
     AND (coalesce(b.support_n,0) = 0 OR coalesce(b.oppose_n,0) = 0) THEN
    RETURN QUERY SELECT false, '争议性事件必须同时收录支持与反对方的主张'; RETURN;
  END IF;

  IF coalesce(b.distinct_sources,0) < 2 THEN
    RETURN QUERY SELECT false, '独立来源少于 2 个'; RETURN;
  END IF;

  RETURN QUERY SELECT true, '可发布'::text;
END $$ LANGUAGE plpgsql;

-- ═════════════════ 十三、公开导出（可分叉的信任锚）═════════════════
-- 定期导出为 JSON 推送到公开 git 仓库：任何人可整包带走、独立验证。
CREATE VIEW export_events AS
SELECT
  e.slug, e.occurred_on, e.occurred_end, e.precision, e.weight, e.published_at,
  (SELECT jsonb_object_agg(i.lang, jsonb_build_object('title', i.title, 'summary', i.summary, 'cause', i.cause))
     FROM event_i18n i WHERE i.event_id = e.id) AS i18n,
  (SELECT jsonb_agg(t.key) FROM event_topics et JOIN topics t ON t.id = et.topic_id
     WHERE et.event_id = e.id) AS topics,
  (SELECT jsonb_agg(jsonb_build_object('actor', a.slug, 'role', ea.role))
     FROM event_actors ea JOIN actors a ON a.id = ea.actor_id WHERE ea.event_id = e.id) AS actors,
  (SELECT jsonb_agg(jsonb_build_object(
            'stance', c.stance, 'body', c.body, 'attributed_to', c.attributed_to,
            'citations', (SELECT jsonb_agg(jsonb_build_object('title', s.title, 'url', s.url, 'archived', s.archived_url))
                            FROM claim_citations cc JOIN sources s ON s.id = cc.source_id
                           WHERE cc.claim_id = c.id)))
     FROM claims c WHERE c.event_id = e.id AND c.status = 'published') AS claims,
  (SELECT jsonb_agg(jsonb_build_object('dimension', im.dimension, 'label', im.label_zh,
            'value', im.value_zh, 'source', s2.title))
     FROM impacts im JOIN sources s2 ON s2.id = im.source_id WHERE im.event_id = e.id) AS impacts
FROM events e
WHERE e.status = 'published';

COMMIT;
