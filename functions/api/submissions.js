import { sql, json, bad, identity, humanOk, readJson, glyphs, isSlug, friendly, APP_ENV } from '../_lib.js';

const KINDS = ['new_event', 'correction', 'source'];

// POST /api/submissions
// { kind, title, occurred_on?, body, sources:[url,...], target_slug?, contact?, token? }
export async function onRequestPost({ request, env }) {
  let d;
  try { d = await readJson(request, 16384); }
  catch (e) { return bad(e.message === 'TOO_LARGE' ? '内容过长' : '格式错误'); }

  if (!KINDS.includes(d.kind)) return bad('投稿类型无效');
  if (glyphs(d.title) < 4 || glyphs(d.title) > 120) return bad('标题需要 4–120 字。');
  if (glyphs(d.body) < 20 || glyphs(d.body) > 1200) return bad('说明需要 20–1200 字。');

  const sources = (Array.isArray(d.sources) ? d.sources : [])
    .map(s => String(s || '').trim()).filter(Boolean).slice(0, 10);
  const need = d.kind === 'new_event' ? 2 : 1;
  if (sources.length < need) {
    return bad(d.kind === 'new_event'
      ? '新事件需要至少 2 个独立来源链接——这是收录准则，不是客套。'
      : '至少需要 1 个来源链接。');
  }
  if (!sources.every(s => /^https?:\/\/[^\s]{6,}$/.test(s))) {
    return bad('来源必须是完整的 http(s) 链接。');
  }

  const date = d.occurred_on && /^\d{4}-\d{2}-\d{2}$/.test(d.occurred_on) ? d.occurred_on : null;
  const target = isSlug(d.target_slug) ? d.target_slug : null;
  const contact = String(d.contact || '').trim().slice(0, 120) || null;

  const human = await humanOk(env, d.token, request.headers.get('cf-connecting-ip'));
  if (!human.ok) return bad('人机验证未通过', 403);

  const id = await identity(request, env);

  try {
    // sources 以 jsonb 传入再展开成 text[]，避免依赖 HTTP 端点的数组序列化行为
    const rows = await sql(env,
      `insert into app_submissions
         (env, kind, title, occurred_on, body, sources, target_slug, contact, net_hash)
       values ($1, $2, btrim($3), $4::date, btrim($5),
               array(select jsonb_array_elements_text($6::jsonb)),
               $7, $8, decode($9,'hex'))
       returning id, kind, state, created_at`,
      [APP_ENV, d.kind, d.title, date, d.body, JSON.stringify(sources), target, contact, id.net]);

    return json({ ok: true, submission: rows[0] }, 201,
      id.setCookie ? { 'set-cookie': id.setCookie } : {});
  } catch (err) {
    const [msg, status] = friendly(err);
    return json({ ok: false, error: msg }, status);
  }
}

// GET /api/submissions        → 公开统计（只有数字，没有内容）
// GET /api/submissions?queue=1 + Authorization: Bearer <REVIEW_TOKEN> → 复核队列
export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);

  if (url.searchParams.get('queue')) {
    const auth = request.headers.get('authorization') || '';
    const tok = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!env.REVIEW_TOKEN || tok !== env.REVIEW_TOKEN) return bad('未授权', 401);
    const rows = await sql(env,
      `select id, kind, title, occurred_on, body, sources, target_slug, contact,
              state, created_at
         from app_submissions
        where env = $1 and state = 'pending'
        order by created_at asc limit 200`, [APP_ENV]);
    return json({ ok: true, pending: rows });
  }

  try {
    const rows = await sql(env,
      `select state, n, latest from public_submission_stats where env = $1`, [APP_ENV]);
    return json({ ok: true, env: APP_ENV, stats: rows });
  } catch {
    return json({ ok: false, stats: [], offline: true }, 200);
  }
}
