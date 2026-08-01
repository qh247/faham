import { sql, json, bad, identity, humanOk, readJson, glyphs, isSlug, friendly, APP_ENV } from '../_lib.js';

// GET /api/comments?event=<slug>
export async function onRequestGet({ request, env }) {
  const ev = new URL(request.url).searchParams.get('event');
  if (!isSlug(ev)) return bad('event 参数无效');
  try {
    const rows = await sql(env,
      `select id, body, status, reports, created_at
         from public_comments
        where env = $1 and event_slug = $2
        order by created_at desc limit 60`,
      [APP_ENV, ev]);
    return json({ ok: true, env: APP_ENV, comments: rows });
  } catch {
    // 后端不可用时前端要能优雅降级，而不是整张卡片崩掉
    return json({ ok: false, comments: [], offline: true }, 200);
  }
}

// POST /api/comments  { event, body, token? }
export async function onRequestPost({ request, env }) {
  let d;
  try { d = await readJson(request); }
  catch (e) { return bad(e.message === 'TOO_LARGE' ? '内容过长' : '格式错误'); }

  if (!isSlug(d.event)) return bad('event 参数无效');

  const n = glyphs(d.body);
  if (n < 30 || n > 50) return bad(`评论需要 30–50 字，现在是 ${n} 字。`);

  const ip = request.headers.get('cf-connecting-ip');
  const human = await humanOk(env, d.token, ip);
  if (!human.ok) return bad('人机验证未通过', 403);

  const id = await identity(request, env);

  try {
    const rows = await sql(env,
      `insert into app_comments (env, event_slug, body, actor_hash, net_hash)
       values ($1, $2, btrim($3), decode($4,'hex'), decode($5,'hex'))
       returning id, body, status, reports, created_at`,
      [APP_ENV, d.event, d.body, id.actor, id.net]);

    const headers = id.setCookie ? { 'set-cookie': id.setCookie } : {};
    return json({ ok: true, comment: rows[0] }, 201, headers);
  } catch (err) {
    const [msg, status] = friendly(err);
    return json({ ok: false, error: msg }, status,
      id.setCookie ? { 'set-cookie': id.setCookie } : {});
  }
}
