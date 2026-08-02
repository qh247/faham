import { json, bad } from '../_lib.js';

// GET /api/peek?url=…
//
// 为什么存在：投稿最烦的部分是抄标题、抄日期、抄出处——这些机器抄得比人准。
// 人该写的是「发生了什么、改变了什么」，那是机器抄不来的部分。
//
// 只回传元数据（标题／日期／站点），永不回传正文。
// 一是别把这个端点变成开放代理，二是照抄新闻正文本身就侵权：
// 事实不受著作权保护，表达受保护。档案要记事实、附链接，不要搬段落。

// 报馆分层。tier 1 是原始文件（宪报、国会、选委会、统计局……），不是新闻报道。
const TIERS = [
  [/(^|\.)parlimen\.gov\.my$/,        1, '国会记录'],
  [/(^|\.)(lom\.)?agc\.gov\.my$/,     1, '联邦宪报／总检察署'],
  [/(^|\.)spr\.gov\.my$/,             1, '选举委员会'],
  [/(^|\.)bnm\.gov\.my$/,             1, '国家银行'],
  [/(^|\.)dosm\.gov\.my$/,            1, '统计局'],
  [/(^|\.)mof\.gov\.my$/,             1, '财政部'],
  [/(^|\.)hasil\.gov\.my$/,           1, 'LHDN'],
  [/(^|\.)kehakiman\.gov\.my$/,       1, '司法机构'],
  [/(^|\.)sprm\.gov\.my$/,            1, '反贪会'],
  [/\.gov\.my$/,                      1, '政府机构'],
  [/(^|\.)bernama\.com$/,             2, '国家通讯社'],
  [/(^|\.)malaysiakini\.com$/,        2, ''],
  [/(^|\.)theedgemalaysia\.com$/,     2, ''],
  [/(^|\.)freemalaysiatoday\.com$/,   2, ''],
  [/(^|\.)malaymail\.com$/,           2, ''],
  [/(^|\.)thestar\.com\.my$/,         2, ''],
  [/(^|\.)nst\.com\.my$/,             2, ''],
  [/(^|\.)thevibes\.com$/,            2, ''],
  [/(^|\.)galencentre\.org$/,         2, '医卫政策'],
  [/(^|\.)macaranga\.org$/,           2, '环境政策'],
  [/(^|\.)sinchew\.com\.my$/,         3, ''],
  [/(^|\.)chinapress\.com\.my$/,      3, ''],
  [/(^|\.)orientaldaily\.com\.my$/,   3, ''],
  [/(^|\.)enanyang\.my$/,             3, ''],
  [/(^|\.)guangming\.com\.my$/,       3, ''],
  [/(^|\.)kwongwah\.com\.my$/,        3, ''],
];

function classify(host){
  for (const [re, tier, note] of TIERS) if (re.test(host)) return { tier, note };
  return { tier: 0, note: '' };   // 0 = 未登记，不代表不可用，只代表本站没给它定过位
}

const pick = (html, res) => { const m = res.exec(html); return m ? m[1].trim() : ''; };

// &amp; 必须最后解，否则 &amp;lt; 会被两次解码成 <
const decode = s => s
  .replace(/&lt;/g,'<').replace(/&gt;/g,'>')
  .replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&nbsp;/g,' ')
  .replace(/&#x([0-9a-f]+);/gi, (_,h)=>String.fromCodePoint(parseInt(h,16)))
  .replace(/&#(\d+);/g, (_,d)=>String.fromCodePoint(+d))
  .replace(/&amp;/g,'&')
  .replace(/\s+/g,' ').trim();

function meta(html, prop){
  const esc = prop.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  return pick(html, new RegExp(
    `<meta[^>]+(?:property|name)=["']${esc}["'][^>]*content=["']([^"']*)["']`, 'i'))
    || pick(html, new RegExp(
    `<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${esc}["']`, 'i'));
}

export async function onRequestGet({ request }) {
  const raw = new URL(request.url).searchParams.get('url') || '';
  let u;
  try { u = new URL(raw); } catch { return bad('链接格式不对'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return bad('只支持 http(s) 链接');
  if (/^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|\[?::1)/i.test(u.hostname))
    return bad('不支持内网地址');

  let html = '';
  try {
    const ctl = new AbortController();
    const timer = setTimeout(()=>ctl.abort(), 8000);
    const res = await fetch(u.href, {
      signal: ctl.signal, redirect: 'follow',
      headers: { 'user-agent': 'faham/1.0 (+https://github.com/qh247/faham)',
                 'accept': 'text/html,application/xhtml+xml' }
    });
    clearTimeout(timer);
    if (!res.ok) return json({ ok:false, error:`来源返回 ${res.status}`, tier: classify(u.hostname).tier }, 200);

    // 只读前 256KB：<head> 早就读完了，正文没必要下载
    const reader = res.body.getReader();
    const dec = new TextDecoder('utf-8', { fatal:false });
    let n = 0;
    while (n < 262144) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.length;
      html += dec.decode(value, { stream:true });
      if (/<\/head>/i.test(html)) break;
    }
    try { await reader.cancel(); } catch(_){}
  } catch (e) {
    return json({ ok:false, error: e.name === 'AbortError' ? '来源超时' : '抓取失败',
                  tier: classify(u.hostname).tier }, 200);
  }

  const title = decode(meta(html,'og:title') || meta(html,'twitter:title')
                    || pick(html, /<title[^>]*>([\s\S]{0,300}?)<\/title>/i));
  const pub   = meta(html,'article:published_time') || meta(html,'og:article:published_time')
             || meta(html,'datePublished') || meta(html,'date') || meta(html,'pubdate')
             || pick(html, /<time[^>]+datetime=["']([^"']+)["']/i);
  const site  = decode(meta(html,'og:site_name'));
  const canon = pick(html, /<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)["']/i);

  const { tier, note } = classify(u.hostname);
  const dm = /(\d{4})-(\d{2})-(\d{2})/.exec(pub || '');

  return json({
    ok: true,
    url: canon || u.href,
    host: u.hostname,
    title: title.slice(0, 200),
    published: dm ? dm[0] : '',
    site: site || u.hostname,
    tier, tier_note: note,
    // 中文报与未登记来源：标题只是标题。这条提示出现在投稿当下，不是事后审核时。
    headline_only: tier === 3 || tier === 0,
  });
}
