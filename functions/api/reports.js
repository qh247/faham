import { sql, json, bad, identity, readJson, glyphs, friendly } from '../_lib.js';

// POST /api/reports  { id, reason }
// 举报只折叠、不删除：累计 3 个不同网络才折叠，且折叠后仍可展开查看。
// 让举报直接删内容，等于把审查权交给举报最积极的那群人。
export async function onRequestPost({ request, env }) {
  let d;
  try { d = await readJson(request); } catch { return bad('格式错误'); }

  if (!/^[0-9a-f-]{36}$/i.test(String(d.id || ''))) return bad('评论 id 无效');
  if (glyphs(d.reason) < 2 || glyphs(d.reason) > 200) return bad('请写明举报理由（2–200 字）。');

  const id = await identity(request, env);
  try {
    await sql(env,
      `insert into app_reports (comment_id, reason, net_hash)
       values ($1::uuid, btrim($2), decode($3,'hex'))`,
      [d.id, d.reason, id.net]);
    return json({ ok: true });
  } catch (err) {
    const [msg, status] = friendly(err);
    return json({ ok: false, error: msg }, status);
  }
}
