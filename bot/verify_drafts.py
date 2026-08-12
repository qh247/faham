#!/usr/bin/env python3
"""faham · 草稿溯源核查

为什么存在：研究出来的条目，光看内容判断不了真假——编造的条目读起来比真的还顺。
唯一能机械判定的，是「这个链接真的存在，而且页面上真的有那句话」。
所以这个脚本不看文笔，只做三件事：

  1. 每个链接实地抓一次，记录 HTTP 状态
  2. 检查草稿声称的支持句，是否真的出现在页面正文里
  3. 检查条目里出现的每个链接，都在 _verified 审计清单中登记过

任何一项不过，该条目标为 FAIL。宁可少收，不可收假。

用法：  python3 bot/verify_drafts.py                 核查 data/drafts/ 下全部草稿
        python3 bot/verify_drafts.py <file.json>     只核查一个文件
退出码：有 FAIL 则为 1，全过为 0。
"""
import json, re, sys, glob, html, subprocess
from pathlib import Path

UA = 'faham-verify/1.0 (+https://github.com/qh247/faham)'
TIMEOUT = 25

# ── 取页面 ────────────────────────────────────────────────────────────────
# 用 curl 而不是 urllib：本机上 urllib 会被目标站的机器人防护挡掉，
# 同一个 URL curl 拿得到、urllib 拿不到。核查工具误报「连不上」
# 比没有核查工具更糟——它会把真条目判成造假。
_cache = {}

def fetch(url):
    """回传 (status, 正文纯文本)。失败时 status 为 0 或 HTTP 码，正文为空。"""
    if url in _cache:
        return _cache[url]
    try:
        p = subprocess.run(
            ['curl', '-sL', '--compressed', '--max-time', str(TIMEOUT),
             '--max-filesize', '3000000', '-A', UA,
             '-H', 'Accept: text/html,application/xhtml+xml',
             '-H', 'Accept-Language: en,ms,zh',
             '-w', '\n__HTTP__%{http_code}', url],
            capture_output=True, timeout=TIMEOUT + 10)
        body = p.stdout.decode('utf-8', 'replace')
        m = re.search(r'\n__HTTP__(\d{3})\s*$', body)
        status = int(m.group(1)) if m else 0
        body = body[:m.start()] if m else body
        out = (status, strip_html(body) if status == 200 else '')
    except Exception:
        out = (0, '')
    _cache[url] = out
    return out


def strip_html(s):
    s = re.sub(r'(?is)<(script|style|noscript)[^>]*>.*?</\1>', ' ', s)
    s = re.sub(r'(?s)<[^>]+>', ' ', s)
    return norm(html.unescape(s))


def norm(s):
    """归一化：压空白、全角标点转半角、去掉标点。用于比对句子。"""
    s = s.replace('　', ' ')
    return re.sub(r'\s+', ' ', s).strip()


PUNCT = re.compile(r'[\s，。、；：？！「」『』（）()《》〈〉—–\-·"\'“”‘’,.;:?!/\\|\[\]]+')
strip_punct = lambda s: PUNCT.sub('', s)

# CJK 无词边界，按字比对；拉丁文按词比对
cjk_ratio = lambda s: (sum(1 for c in s if '一' <= c <= '鿿') / max(1, len(s)))


def contains(page, claim):
    """页面是否支持这句话。三级放宽：原句 → 去标点 → 片段重叠。"""
    if not page or not claim:
        return False, 'no-text'
    if norm(claim) in page:
        return True, 'exact'
    pc, cc = strip_punct(page), strip_punct(claim)
    if cc and cc in pc:
        return True, 'depunct'
    # 片段重叠：长句被排版切断时，仍应算命中
    if cjk_ratio(cc) > 0.3:
        grams = {cc[i:i + 8] for i in range(0, max(1, len(cc) - 7))}
        if grams:
            hit = sum(1 for g in grams if g in pc) / len(grams)
            if hit >= 0.7:
                return True, f'overlap {hit:.0%}'
            return False, f'overlap {hit:.0%}'
    else:
        toks = [t for t in re.split(r'\W+', cc.lower()) if len(t) > 3]
        if toks:
            pl = pc.lower()
            hit = sum(1 for t in toks if t in pl) / len(toks)
            if hit >= 0.7:
                return True, f'overlap {hit:.0%}'
            return False, f'overlap {hit:.0%}'
    return False, 'miss'


def urls_in(item):
    out = []
    for c in item.get('claims') or []:
        if c.get('url'):
            out.append(c['url'])
    for s in item.get('srcs') or []:
        if s.get('u'):
            out.append(s['u'])
    return out


def hostname(u):
    m = re.match(r'https?://([^/]+)', u or '')
    return re.sub(r'^www\.', '', m.group(1).lower()) if m else ''


# ── 主流程 ────────────────────────────────────────────────────────────────
def check_file(path):
    try:
        doc = json.load(open(path, encoding='utf-8'))
    except Exception as e:
        print(f'✗ {path} 无法解析：{e}')
        return 0, 1
    items = doc.get('items') or []
    print(f'\n══ {Path(path).name} · {len(items)} 条 ══')
    ok_n = fail_n = 0

    for i, it in enumerate(items):
        problems, evidence = [], []
        ver = it.get('_verified') or []

        if not ver:
            problems.append('没有 _verified 审计清单')

        # 1+2. 每条审计记录实地抓取并比对支持句
        good_hosts = set()
        for v in ver:
            u, want = v.get('url', ''), v.get('supports', '')
            status, page = fetch(u)
            if status != 200:
                problems.append(f'HTTP {status or "连不上"} · {u[:70]}')
                continue
            hit, how = contains(page, want)
            if hit:
                good_hosts.add(hostname(u))
                evidence.append(f'✓ {hostname(u)} ({how})')
            else:
                problems.append(f'页面无此句 [{how}] · {hostname(u)} · 「{want[:38]}…」')

        # 3. 条目里用到的链接必须都登记过
        registered = {v.get('url') for v in ver}
        for u in urls_in(it):
            if u not in registered:
                problems.append(f'链接未登记进 _verified · {u[:70]}')

        verdict = 'FAIL' if problems else ('PASS' if len(good_hosts) >= 2 else 'THIN')
        if verdict == 'FAIL':
            fail_n += 1
        else:
            ok_n += 1

        tag = {'PASS': '✅', 'THIN': '🟨', 'FAIL': '❌'}[verdict]
        print(f'{tag} [{i}] {it.get("date","?")} {str(it.get("title",""))[:44]}'
              f'  ({len(good_hosts)} 家独立来源)')
        for e in evidence:
            print(f'      {e}')
        for p in problems:
            print(f'      ✗ {p}')

    if doc.get('searched_but_found_nothing'):
        print(f'  · 搜过没结果：{len(doc["searched_but_found_nothing"])} 组查询词')
    return ok_n, fail_n


def main():
    args = sys.argv[1:]
    files = args or sorted(
        f for f in glob.glob('data/drafts/*.json') if not f.endswith('.gaps.md'))
    if not files:
        print('data/drafts/ 下没有草稿文件。')
        return 0
    tot_ok = tot_fail = 0
    for f in files:
        a, b = check_file(f)
        tot_ok += a
        tot_fail += b
    print(f'\n══ 合计 ══  可用 {tot_ok} 条 · 不合格 {tot_fail} 条')
    print('✅ 两家以上独立来源已核实　🟨 只有一家（够收录但要标注）　❌ 有链接打不开或页面无此句')
    return 1 if tot_fail else 0


if __name__ == '__main__':
    sys.exit(main())
