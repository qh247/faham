#!/usr/bin/env node
// bot/collect.mjs
//
// ============================================================================
// 中文说明（为什么这个 bot 永远不发布数据）
// ============================================================================
//
// faham 的前提是：规则先于数据，且没有任何内容会在未经人工审核的情况下发布
// （见 docs/governance.md）。这个脚本因此被设计为「线索收集器」，而不是
// 「发布器」：
//
//   1. 本脚本【绝不】写入 data/events.json —— 那是唯一的、经审核后的公开数据。
//      本脚本只写入 data/candidates/YYYY-MM-DD.json，一个「待审核队列」。
//   2. 抓取到的仅仅是新闻标题（headline），标题本身【不是事实】，更不是
//      「声明」（claim）。所以每条候选记录都带有 headline_is_not_a_claim: true
//      这个字段，提醒任何读这份 JSON 的人：这只是「某家媒体用了这个标题」，
//      不代表标题描述的内容已被核实。
//   3. 中文小报（星洲日报、中国报、东方日报等）在本项目里被owner明确认定为
//      「标题党」——标题经常夸张、煽情，不能当作事实来源。因此这些媒体在
//      bot/feeds.json 中被标记 tier: 3、headline_only: true，它们的标题只用
//      来交叉印证「是否有其他独立来源也在报道同一件事」，而不能单独作为
//      候选事件被采信。
//   4. 「多家独立媒体同时报道同一件事」恰好对应 docs/governance.md 里
//      「至少 2 个独立来源」的验证门槛——所以本脚本会把同一事件的多个
//      sightings（不同媒体的报道）聚合成一个候选（cluster），并统计
//      independent_outlets（独立媒体数）。这个数字越高，排在待审队列越前面，
//      但仍然只是「值得人工核实的线索」，不是「已核实的事件」。
//   5. 一切候选记录的 status 都固定为 "unreviewed"。要把候选变成正式的
//      data/events.json 条目，必须经过人工审核流程（见 docs/governance.md
//      第 4 节），本脚本没有、也不应该有绕过这个流程的能力。
//
// ============================================================================
// Zero-dependency Node.js 20+ ESM script. Uses only built-in fetch, node:fs,
// node:crypto, node:path. No npm packages.
// ============================================================================

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.join(__dirname, '..');
const CANDIDATES_DIR = path.join(REPO_ROOT, 'data', 'candidates');

const USER_AGENT = 'faham-collector/1.0 (+https://github.com/qh247/faham)';
const FETCH_TIMEOUT_MS = 15000;

// ----------------------------------------------------------------------------
// CLI args
// ----------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { dryRun: false, days: 3 };
  for (const raw of argv) {
    if (raw === '--dry-run') {
      args.dryRun = true;
    } else if (raw.startsWith('--days=')) {
      const n = Number(raw.slice('--days='.length));
      if (Number.isFinite(n) && n > 0) args.days = n;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

// ----------------------------------------------------------------------------
// Small helpers
// ----------------------------------------------------------------------------

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
  hellip: '…', mdash: '—', ndash: '–',
};

function decodeEntities(str) {
  if (!str) return '';
  return str.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, ent) => {
    if (ent[0] === '#') {
      const code = ent[1] === 'x' || ent[1] === 'X'
        ? parseInt(ent.slice(2), 16)
        : parseInt(ent.slice(1), 10);
      if (Number.isFinite(code)) {
        try { return String.fromCodePoint(code); } catch { return whole; }
      }
      return whole;
    }
    return NAMED_ENTITIES[ent] ?? whole;
  });
}

function stripCdata(str) {
  const m = str.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  return m ? m[1] : str;
}

function stripTags(str) {
  return str.replace(/<[^>]*>/g, '');
}

function cleanText(raw) {
  if (raw == null) return '';
  return decodeEntities(stripTags(stripCdata(raw))).replace(/\s+/g, ' ').trim();
}

// ----------------------------------------------------------------------------
// Tolerant RSS / Atom parser
//
// Feeds in the wild are messy. We do NOT assume well-formed XML; we scan with
// regex for <item>...</item> (RSS) and <entry>...</entry> (Atom) blocks, then
// pull fields out of each block independently and tolerate CDATA, missing
// namespaces, self-closing Atom <link href="..."/> tags as well as RSS-style
// <link>text</link> tags.
// ----------------------------------------------------------------------------

function extractTag(block, tagNames) {
  for (const tag of tagNames) {
    const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i');
    const m = block.match(re);
    if (m) return m[1];
  }
  return null;
}

function extractLink(block) {
  // Atom-style self-closing <link ... href="..." .../> tags, possibly several
  // (rel="alternate", rel="self", etc). Prefer rel="alternate" or no rel.
  const linkTagRe = /<link\b([^>]*)\/?>/gi;
  let match;
  let fallbackHref = null;
  while ((match = linkTagRe.exec(block)) !== null) {
    const attrs = match[1];
    const hrefMatch = attrs.match(/href\s*=\s*"([^"]*)"|href\s*=\s*'([^']*)'/i);
    if (!hrefMatch) continue; // could be an RSS <link>text</link> opening tag with no href
    const href = hrefMatch[1] ?? hrefMatch[2];
    const relMatch = attrs.match(/rel\s*=\s*"([^"]*)"|rel\s*=\s*'([^']*)'/i);
    const rel = relMatch ? (relMatch[1] ?? relMatch[2]) : null;
    if (!rel || rel === 'alternate') {
      return href;
    }
    if (!fallbackHref) fallbackHref = href;
  }
  if (fallbackHref) return fallbackHref;

  // RSS-style <link>https://example.com/x</link>
  const rssLink = extractTag(block, ['link']);
  if (rssLink) {
    const cleaned = cleanText(rssLink);
    if (cleaned) return cleaned;
  }
  // Atom sometimes uses <id> as the canonical permalink when it's a URL.
  const idTag = extractTag(block, ['id']);
  if (idTag) {
    const cleaned = cleanText(idTag);
    if (/^https?:\/\//i.test(cleaned)) return cleaned;
  }
  return null;
}

function extractBlocks(xml, tag) {
  const blocks = [];
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  let m;
  while ((m = re.exec(xml)) !== null) {
    blocks.push(m[0]);
  }
  return blocks;
}

function parseFeed(xmlText) {
  const items = [];
  const rawBlocks = [
    ...extractBlocks(xmlText, 'item'),
    ...extractBlocks(xmlText, 'entry'),
  ];

  for (const block of rawBlocks) {
    const rawTitle = extractTag(block, ['title']);
    const title = cleanText(rawTitle);
    if (!title) continue;

    const link = extractLink(block);
    if (!link) continue;

    const rawDate = extractTag(block, ['pubDate', 'published', 'updated', 'dc:date']);
    const dateText = rawDate ? cleanText(rawDate) : null;
    const publishedDate = dateText ? new Date(dateText) : null;
    const publishedIso = publishedDate && !Number.isNaN(publishedDate.getTime())
      ? publishedDate.toISOString()
      : null;

    const rawDesc = extractTag(block, ['description', 'summary', 'content:encoded', 'content']);
    const description = rawDesc ? cleanText(rawDesc) : '';

    items.push({ title, link, publishedIso, description });
  }

  return items;
}

// ----------------------------------------------------------------------------
// URL canonicalisation
// ----------------------------------------------------------------------------

const TRACKING_PARAM_RE = /^utm_/i;
const DROP_PARAMS = new Set(['fbclid', 'gclid']);

function canonicaliseUrl(rawUrl, baseUrl) {
  let u;
  try {
    u = new URL(rawUrl, baseUrl);
  } catch {
    return rawUrl.trim();
  }
  const toDelete = [];
  for (const key of u.searchParams.keys()) {
    if (TRACKING_PARAM_RE.test(key) || DROP_PARAMS.has(key.toLowerCase())) {
      toDelete.push(key);
    }
  }
  toDelete.forEach((k) => u.searchParams.delete(k));
  u.hash = '';
  let out = u.toString();
  out = out.replace(/\?$/, '').replace(/#$/, '');
  return out;
}

// ----------------------------------------------------------------------------
// Relevance filter (bot/keywords.json)
// ----------------------------------------------------------------------------

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Short, all-ASCII-alphanumeric abbreviations (EC, SPR, SST, GST, UEC, ...)
// are prone to matching as a substring inside unrelated words once everything
// is lowercased (e.g. "EC" inside "sELECt", "aspECt", "rEConstruct"). For
// those we require a word boundary. Longer terms and any non-ASCII (Malay
// diacritics, Chinese, Tamil) terms keep plain substring matching, since
// \b is meaningless for scripts without a Latin notion of "word character"
// and longer terms are unlikely to collide by accident.
function isShortAsciiAbbrev(term) {
  return /^[a-z0-9]+$/i.test(term) && term.length <= 4;
}

function loadKeywords() {
  const file = path.join(__dirname, 'keywords.json');
  const data = JSON.parse(readFileSync(file, 'utf8'));
  const themes = data.themes || {};
  const flat = [];
  for (const [theme, terms] of Object.entries(themes)) {
    for (const term of terms) {
      if (!term) continue;
      if (isShortAsciiAbbrev(term)) {
        flat.push({ theme, re: new RegExp(`\\b${escapeRegex(term)}\\b`, 'i') });
      } else {
        flat.push({ theme, term: term.toLowerCase() });
      }
    }
  }
  return flat;
}

function matchThemes(text, flatKeywords) {
  const hay = text.toLowerCase();
  const matched = new Set();
  for (const k of flatKeywords) {
    if (k.re) {
      if (k.re.test(text)) matched.add(k.theme);
    } else if (k.term && hay.includes(k.term)) {
      matched.add(k.theme);
    }
  }
  return [...matched];
}

// ----------------------------------------------------------------------------
// Title normalisation + soft clustering (token-overlap Jaccard >= 0.6)
// ----------------------------------------------------------------------------

const STOPWORDS = new Set([
  // English
  'the', 'a', 'an', 'of', 'in', 'on', 'for', 'to', 'and', 'or', 'is', 'are',
  'was', 'were', 'by', 'with', 'at', 'as', 'that', 'this', 'it', 'its',
  'after', 'before', 'from', 'into', 'says', 'said', 'over', 'amid', 'has',
  'have', 'had', 'be', 'will', 'not', 'no', 'new', 'about', 'up', 'out',
  // Bahasa Malaysia
  'yang', 'dan', 'di', 'ke', 'untuk', 'dari', 'akan', 'adalah', 'itu', 'ini',
  'dengan', 'atau', 'tidak', 'pada', 'kata', 'dalam', 'oleh', 'juga', 'ada',
]);

function normaliseTitleTokens(title) {
  const lower = title.toLowerCase();
  // Strip punctuation (keep CJK/Latin word characters and spaces).
  const stripped = lower.replace(/[!"#$%&'()*+,\-./:;<=>?@[\]^_`{|}~“”‘’—–、。，！？「」『』]/g, ' ');
  const tokens = stripped.split(/\s+/).filter(Boolean).filter((t) => !STOPWORDS.has(t));
  return tokens;
}

function jaccard(setA, setB) {
  if (setA.size === 0 && setB.size === 0) return 0;
  let intersection = 0;
  for (const t of setA) if (setB.has(t)) intersection += 1;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ----------------------------------------------------------------------------
// Existing candidate history (for cross-run dedupe)
// ----------------------------------------------------------------------------

function loadExistingUrlHashes(excludeFile) {
  const seen = new Set();
  if (!existsSync(CANDIDATES_DIR)) return seen;
  let files = [];
  try {
    files = readdirSync(CANDIDATES_DIR).filter((f) => f.endsWith('.json') && f !== excludeFile);
  } catch {
    return seen;
  }
  for (const file of files) {
    try {
      const data = JSON.parse(readFileSync(path.join(CANDIDATES_DIR, file), 'utf8'));
      const candidates = Array.isArray(data.candidates) ? data.candidates : [];
      for (const c of candidates) {
        if (c.url) seen.add(sha256(c.url));
        for (const s of c.sightings || []) {
          if (s.url) seen.add(sha256(s.url));
        }
      }
    } catch {
      // Ignore unreadable/corrupt history files; do not let them kill the run.
    }
  }
  return seen;
}

// ----------------------------------------------------------------------------
// Fetching
// ----------------------------------------------------------------------------

async function fetchFeed(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' },
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------

async function main() {
  const feedsFile = path.join(__dirname, 'feeds.json');
  const feedsData = JSON.parse(readFileSync(feedsFile, 'utf8'));
  const outlets = feedsData.outlets || [];
  const outletByKey = new Map(outlets.map((o) => [o.key, o]));
  const flatKeywords = loadKeywords();

  const today = new Date().toISOString().slice(0, 10);
  const todayFileName = `${today}.json`;
  const todayFilePath = path.join(CANDIDATES_DIR, todayFileName);

  const cutoffMs = Date.now() - args.days * 24 * 60 * 60 * 1000;

  const feedsFailed = [];
  let feedsOk = 0;
  let feedsSkipped = 0;

  /** @type {Array<{title:string, canonicalUrl:string, outletKey:string, tier:number, lang:string, publishedIso:string|null, matched:string[]}>} */
  const rawItems = [];

  for (const outlet of outlets) {
    if (!outlet.feed) {
      feedsSkipped += 1;
      continue;
    }
    try {
      const xml = await fetchFeed(outlet.feed);
      const items = parseFeed(xml);
      feedsOk += 1;

      for (const item of items) {
        const canonicalUrl = canonicaliseUrl(item.link, outlet.feed);

        // Age filter.
        if (item.publishedIso) {
          const ms = new Date(item.publishedIso).getTime();
          if (Number.isFinite(ms) && ms < cutoffMs) continue;
        }

        // Relevance filter.
        const haystack = `${item.title} ${item.description}`;
        const matched = matchThemes(haystack, flatKeywords);
        if (matched.length === 0) continue;

        rawItems.push({
          title: item.title,
          canonicalUrl,
          outletKey: outlet.key,
          tier: outlet.tier,
          lang: outlet.lang,
          publishedIso: item.publishedIso,
          matched,
        });
      }
    } catch (err) {
      feedsFailed.push({ outlet: outlet.key, error: err && err.message ? err.message : String(err) });
    }
  }

  // Dedupe against everything already collected on OTHER days (by canonical
  // URL hash). Today's own file (if this is a rerun, e.g. via
  // workflow_dispatch) is deliberately excluded from this set and instead
  // merged back in below — otherwise a same-day rerun would see its own
  // previously-written candidates as "already collected", filter them all
  // out, and overwrite today's file with a near-empty result. That would
  // silently destroy already-collected leads and defeat the "no-op when
  // nothing changed" goal of the GitHub Action.
  const existingHashes = loadExistingUrlHashes(todayFileName);
  const seenThisRun = new Set();
  const freshItems = [];
  for (const item of rawItems) {
    const hash = sha256(item.canonicalUrl);
    if (existingHashes.has(hash) || seenThisRun.has(hash)) continue;
    seenThisRun.add(hash);
    freshItems.push({ ...item, hash });
  }

  // Reconstruct pseudo-items from today's own already-written file (if a
  // previous run already produced one today) so this run's clustering merges
  // with it instead of replacing it. Per-sighting published dates aren't
  // stored in the output schema, so we approximate with the cluster's
  // primary `published` value — good enough for sort order, not load-bearing.
  const carriedOverItems = [];
  if (existsSync(todayFilePath)) {
    try {
      const prev = JSON.parse(readFileSync(todayFilePath, 'utf8'));
      for (const c of prev.candidates || []) {
        for (const s of c.sightings || []) {
          const outletMeta = outletByKey.get(s.outlet);
          const hash = sha256(s.url);
          if (seenThisRun.has(hash)) continue; // this run already re-fetched it fresh
          seenThisRun.add(hash);
          carriedOverItems.push({
            title: s.title,
            canonicalUrl: s.url,
            outletKey: s.outlet,
            tier: typeof s.tier === 'number' ? s.tier : (outletMeta ? outletMeta.tier : 9),
            lang: outletMeta ? outletMeta.lang : c.lang,
            publishedIso: c.published || null,
            matched: c.matched || [],
            hash,
          });
        }
      }
    } catch {
      // Corrupt/unreadable today-file: proceed as if this is a fresh run
      // rather than crashing the whole collector over one bad file.
    }
  }

  const clusterInput = [...carriedOverItems, ...freshItems];

  // Soft title-similarity clustering (token-overlap Jaccard >= 0.6).
  /** @type {Array<{tokenSet:Set<string>, items:Array<any>}>} */
  const clusters = [];
  for (const item of clusterInput) {
    const tokens = new Set(normaliseTitleTokens(item.title));
    let placed = false;
    for (const cluster of clusters) {
      if (jaccard(tokens, cluster.tokenSet) >= 0.6) {
        cluster.items.push(item);
        // Grow the cluster's token set slightly (union) so later, differently
        // worded headlines about the same story can still match.
        for (const t of tokens) cluster.tokenSet.add(t);
        placed = true;
        break;
      }
    }
    if (!placed) {
      clusters.push({ tokenSet: tokens, items: [item] });
    }
  }

  const candidates = clusters.map((cluster) => {
    const items = cluster.items;
    const sorted = [...items].sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier;
      const aMs = a.publishedIso ? new Date(a.publishedIso).getTime() : Infinity;
      const bMs = b.publishedIso ? new Date(b.publishedIso).getTime() : Infinity;
      return aMs - bMs;
    });
    const primary = sorted[0];
    const sightings = items.map((i) => ({
      outlet: i.outletKey,
      tier: i.tier,
      url: i.canonicalUrl,
      title: i.title,
    }));
    const independentOutlets = new Set(items.map((i) => i.outletKey)).size;
    const matchedThemes = [...new Set(items.flatMap((i) => i.matched))];

    return {
      id: primary.hash.slice(0, 16),
      cluster: normaliseTitleTokens(primary.title).join(' '),
      headline: primary.title,
      headline_is_not_a_claim: true,
      url: primary.canonicalUrl,
      outlet: primary.outletKey,
      tier: primary.tier,
      lang: primary.lang,
      published: primary.publishedIso,
      matched: matchedThemes,
      sightings,
      independent_outlets: independentOutlets,
      status: 'unreviewed',
    };
  });

  candidates.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    return b.independent_outlets - a.independent_outlets;
  });

  const output = {
    collected_at: new Date().toISOString(),
    feeds_ok: feedsOk,
    feeds_failed: feedsFailed,
    feeds_skipped: feedsSkipped,
    candidates,
  };

  // True idempotency for same-day reruns: if nothing but the timestamp would
  // differ from what's already on disk, keep the old timestamp too, so the
  // file is byte-identical and the GitHub Actions workflow's `git diff`
  // no-op check has nothing to commit.
  if (existsSync(todayFilePath)) {
    try {
      const prev = JSON.parse(readFileSync(todayFilePath, 'utf8'));
      const { collected_at: _prevTs, ...prevRest } = prev;
      const { collected_at: _newTs, ...newRest } = output;
      if (JSON.stringify(prevRest) === JSON.stringify(newRest)) {
        output.collected_at = prev.collected_at;
      }
    } catch {
      // Ignore — fall through and write with a fresh timestamp.
    }
  }

  // ---- Human summary to stdout ----
  console.log(`faham collector — ${today}${args.dryRun ? ' (dry run)' : ''}`);
  console.log(`feeds: ${feedsOk} ok, ${feedsFailed.length} failed, ${feedsSkipped} skipped (no feed registered)`);
  if (feedsFailed.length) {
    for (const f of feedsFailed) console.log(`  ! ${f.outlet}: ${f.error}`);
  }
  const byTier = {};
  for (const c of candidates) byTier[c.tier] = (byTier[c.tier] || 0) + 1;
  console.log(`candidates: ${candidates.length} clusters (${freshItems.length} newly fetched + ${carriedOverItems.length} carried over from an earlier run today)`);
  console.log(`  by tier: ${Object.entries(byTier).sort().map(([t, n]) => `tier ${t}: ${n}`).join(', ') || '(none)'}`);
  console.log('top clusters:');
  for (const c of candidates.slice(0, 10)) {
    console.log(`  [T${c.tier}, ${c.independent_outlets} outlet(s)] ${c.headline} — ${c.matched.join(',')}`);
  }

  if (args.dryRun) {
    console.log('\n--dry-run: no files written.');
    return;
  }

  mkdirSync(CANDIDATES_DIR, { recursive: true });
  writeFileSync(todayFilePath, JSON.stringify(output, null, 2) + '\n', 'utf8');
  console.log(`\nwrote ${path.relative(REPO_ROOT, todayFilePath)}`);
}

main().catch((err) => {
  console.error('faham collector: fatal error (this should not happen — per-feed errors are caught individually):', err);
  process.exitCode = 1;
});
