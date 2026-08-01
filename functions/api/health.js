import { sql, json, APP_ENV } from '../_lib.js';

// GET /api/health —— 公开。故意把「什么已接通、什么没接通」摊开，
// 而不是让访客猜。人机验证未配置这件事也照实报。
export async function onRequestGet({ env }) {
  const out = {
    ok: true,
    env: APP_ENV,
    db: 'unknown',
    turnstile: env.TURNSTILE_SECRET ? 'on' : 'off',
    salt: env.HASH_SALT ? 'set' : 'fallback',
  };
  try {
    const r = await sql(env,
      `select (select count(*) from app_comments    where env = $1) as comments,
              (select count(*) from app_submissions where env = $1) as submissions`,
      [APP_ENV]);
    out.db = 'up';
    out.counts = r[0];
  } catch (e) {
    out.ok = false;
    out.db = 'down';
  }
  return json(out, out.ok ? 200 : 503);
}
