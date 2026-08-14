// faham · Pages Functions 公共库
//
// 没有依赖，没有构建步骤。Neon 提供 HTTP SQL 端点，用内置 fetch 就能查，
// 不需要 pg 驱动、不需要 node_modules、不需要打包器。
//
// 隐私：本文件不写 IP。IP 与 User-Agent 只在内存里参与一次 HMAC，
// 盐每天轮换，落库的只有摘要。隔天盐一换，昨天与今天的摘要无法关联，
// 也无法反推回 IP。这是 PDPA 的最小化原则，也是这个站点承诺匿名的实际做法。

import { APP_ENV } from './_env.js';

export { APP_ENV };

const enc = new TextEncoder();

/* ── Neon HTTP ──────────────────────────────────────────────────────────── */

export async function sql(env, query, params = []) {
  const url = new URL(env.DATABASE_URL);
  // 本地开发时 DATABASE_URL 指向 docker-compose 里的 sqlgate（见 docker-compose.yml），
  // 它只监听本机、没有证书，所以走 http；其余一律 https。
  // 这是本地与线上唯一的差别，除此之外跑的是同一段代码。
  const scheme = /^(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(url.host) ? 'http' : 'https';
  const res = await fetch(`${scheme}://${url.host}/sql`, {
    method: 'POST',
    headers: {
      'Neon-Connection-String': env.DATABASE_URL,
      'Neon-Raw-Text-Output': 'true',
      'Neon-Array-Mode': 'false',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, params }),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(out.message || `db ${res.status}`);
    e.pgCode = out.code;
    e.constraint = out.constraint;
    throw e;
  }
  return out.rows || [];
}

/* ── 响应 ───────────────────────────────────────────────────────────────── */

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...headers,
    },
  });
}

export const bad = (msg, status = 400) => json({ ok: false, error: msg }, status);

/* ── 身份摘要 ───────────────────────────────────────────────────────────── */

async function hmacHex(key, msg) {
  const k = await crypto.subtle.importKey(
    'raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', k, enc.encode(msg));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function cookie(request, name) {
  const raw = request.headers.get('cookie') || '';
  const hit = raw.split(';').map(s => s.trim()).find(s => s.startsWith(name + '='));
  return hit ? decodeURIComponent(hit.slice(name.length + 1)) : null;
}

/**
 * 返回 { actor, net, setCookie }
 *   actor —— 单一访客桶，来自 cookie 里的随机 id。清 cookie 就能绕过，所以还有第二层。
 *   net   —— 粗网络桶，来自 IP+UA。上限放得很宽：马来西亚电信普遍 CGNAT，
 *            同一出口 IP 后面可能是一整栋楼，收紧这层等于误伤一大片人。
 * 盐每天轮换 → 限制窗口实际是「每个日历日」，略宽于严格的滚动 24 小时，
 * 这是为隐私付出的代价，且是有意的：能精确滚动 24 小时的前提是长期可关联的标识符。
 */
export async function identity(request, env) {
  const day = new Date().toISOString().slice(0, 10);
  const salt = `${env.HASH_SALT || 'faham-unsalted-fallback'}:${day}`;

  let fid = cookie(request, 'fid');
  let setCookie = null;
  if (!fid || fid.length < 20 || fid.length > 60) {
    fid = crypto.randomUUID();
    setCookie = `fid=${fid}; Path=/; Max-Age=34560000; HttpOnly; Secure; SameSite=Lax`;
  }

  const ip = request.headers.get('cf-connecting-ip') || '0.0.0.0';
  const ua = (request.headers.get('user-agent') || '').slice(0, 200);

  return {
    actor: await hmacHex(salt, 'a:' + fid),
    net: await hmacHex(salt, 'n:' + ip + '|' + ua),
    setCookie,
  };
}

/* ── 人机验证（可选）────────────────────────────────────────────────────── */

// 未配置 TURNSTILE_SECRET 时直接放行，站点仍可运行。
// 这样做的代价写在 docs 里：上线初期没有人机验证，遇到脚本灌水就必须补上。
export async function humanOk(env, token, ip) {
  if (!env.TURNSTILE_SECRET) return { ok: true, skipped: true };
  if (!token) return { ok: false };
  const form = new FormData();
  form.append('secret', env.TURNSTILE_SECRET);
  form.append('response', token);
  if (ip) form.append('remoteip', ip);
  const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify',
    { method: 'POST', body: form });
  const d = await r.json().catch(() => ({}));
  return { ok: !!d.success };
}

/* ── 输入处理 ───────────────────────────────────────────────────────────── */

export async function readJson(request, limit = 8192) {
  const text = await request.text();
  if (text.length > limit) throw new Error('TOO_LARGE');
  try { return JSON.parse(text || '{}'); } catch { throw new Error('BAD_JSON'); }
}

// 与 Postgres char_length 对齐：按码位计数，不按 UTF-16 单元。
export const glyphs = s => [...String(s ?? '').trim()].length;

export const isSlug = s => typeof s === 'string' && /^[a-z0-9][a-z0-9._-]{0,80}$/i.test(s);

// 数据库约束是最终防线，但把已知错误翻译成人话，用户才知道怎么改。
export function friendly(err) {
  const m = String(err.message || '');
  if (m.includes('RATE_POST')) return ['你在这条事件下今天已经发过 2 条了，明天再来。', 429];
  if (m.includes('RATE_NET'))  return ['当前网络今天的发言次数已达上限。', 429];
  if (m.includes('RATE_SUB'))  return ['今天的投稿次数已达上限（5 条）。', 429];
  if (m.includes('comment_len'))  return ['评论需要 30–50 字。', 400];
  if (m.includes('sub_sources')) return ['新事件需要至少 2 个独立来源链接。', 400];
  if (m.includes('sub_urls'))    return ['来源必须是完整的 http(s) 链接。', 400];
  if (m.includes('sub_title'))   return ['标题需要 4–120 字。', 400];
  if (m.includes('sub_body'))    return ['说明需要 20–1200 字。', 400];
  if (m.includes('app_reports_once')) return ['你已经举报过这条评论了。', 409];
  return ['提交失败，请稍后再试。', 500];
}
