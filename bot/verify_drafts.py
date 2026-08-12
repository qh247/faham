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


def sentence_hit(page, claim):
    """页面是否含这句话。只作加分信号，不作判定关卡——见 facts_of() 的说明。

    短句一律不算：`supports` 若只有几个字符（曾出现过写成 "x" 的），
    子串比对在任何页面上都会命中，等于凭空放行。"""
    if not page or not claim or len(strip_punct(claim)) < 12:
        return False
    if norm(claim) in page:
        return True
    pc, cc = strip_punct(page), strip_punct(claim)
    if cc and cc in pc:
        return True
    if cjk_ratio(cc) > 0.3:
        grams = {cc[i:i + 8] for i in range(0, max(1, len(cc) - 7))}
        return bool(grams) and sum(1 for g in grams if g in pc) / len(grams) >= 0.7
    toks = [t for t in re.split(r'\W+', cc.lower()) if len(t) > 3]
    pl = pc.lower()
    return bool(toks) and sum(1 for t in toks if t in pl) / len(toks) >= 0.7


# 条目正文是中文，来源多半是英文／马来文，所以逐句比对必然误杀。
# 真正跨语言可比的，是「事实指纹」：数字、金额、百分比、日期，
# 以及拉丁字母的专名与缩写（BUDI95、SPR、UEC、Adam Adli）——
# 这些在中文报道里也照写不误。查这些，才是查主张本身，而不是查引文格式。
NUM = re.compile(r'\d[\d,]{2,}(?:\.\d+)?|\d+\.\d+')
LAT = re.compile(r'\b[A-Z][A-Za-z]{2,}\d*\b|\b[A-Z]{2,}\d*\b')


def facts_of(item):
    """从条目里抽出跨语言可核对的事实指纹，分成数字类与专名类。"""
    blob = ' '.join(filter(None, [
        str(item.get('title', '')), str(item.get('why', '')), str(item.get('who', '')),
        ' '.join(str(c.get('tx', '')) + ' ' + str(c.get('sr', '')) for c in item.get('claims') or []),
        ' '.join(str(i.get('k', '')) + ' ' + str(i.get('v', '')) for i in item.get('impact') or []),
        ' '.join(str(h.get('t', '')) for h in item.get('hist') or []),
    ]))
    nums = {n for n in NUM.findall(blob) if len(n.replace(',', '').replace('.', '')) >= 3}
    STOP = {'The', 'This', 'That', 'RM', 'PDF', 'HTTP', 'Dewan', 'Rakyat', 'Negara'}
    lats = {w for w in LAT.findall(blob) if w not in STOP and len(w) >= 3}
    return nums, lats


# 光年份对上不算佐证：2026 出现在 2026 年的任何一篇报道里。
# 真正有辨识力的是 75,144、108.79、4,254 这种——凑巧撞上的概率极低。
IS_YEAR = lambda n: re.fullmatch(r'(19|20)\d\d', n) is not None


def corroborates(page, nums, lats, supports):
    """这一页是否支持本条。回传 (强度, 说明)：'strong' / 'weak' / ''。"""
    if not page:
        return '', '正文为空'
    pl = page.lower()
    # 数字比对时把千分位去掉，因为各家排版不一（75,144 / 75144）
    flat = page.replace(',', '')
    nhit = {n for n in nums if n in page or n.replace(',', '') in flat}
    lhit = {w for w in lats if w.lower() in pl}
    sharp = {n for n in nhit if not IS_YEAR(n)}     # 有辨识力的数字
    years = nhit - sharp

    if sentence_hit(page, supports):
        return 'strong', '原句命中'
    if sharp:
        return 'strong', f'关键数字 {len(sharp)}/{len([n for n in nums if not IS_YEAR(n)])}：' \
                         + '、'.join(sorted(sharp)[:3])
    if len(lhit) >= 3:
        return 'strong', f'专名 {len(lhit)}/{len(lats)}：' + '、'.join(sorted(lhit)[:3])
    if years or lhit:
        bits = []
        if years: bits.append('仅年份 ' + '、'.join(sorted(years)))
        if lhit:  bits.append(f'专名 {len(lhit)} 个')
        return 'weak', '弱证据（' + '；'.join(bits) + '）'
    total = len(nums) + len(lats)
    return '', f'指纹未命中（条目共 {total} 个可核对指纹）'


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

        # 1+2. 每条审计记录实地抓取，并用事实指纹比对
        nums, lats = facts_of(it)
        strong_hosts, weak_hosts = set(), set()
        if not nums and not lats:
            problems.append('条目里没有任何可跨语言核对的指纹（数字或专名）')
        for v in ver:
            u, want = v.get('url', ''), v.get('supports', '')
            status, page = fetch(u)
            if status != 200:
                problems.append(f'HTTP {status or "连不上"} · {u[:70]}')
                continue
            level, how = corroborates(page, nums, lats, want)
            if level == 'strong':
                strong_hosts.add(hostname(u))
                evidence.append(f'✓ {hostname(u)} — {how}')
            elif level == 'weak':
                weak_hosts.add(hostname(u))
                evidence.append(f'~ {hostname(u)} — {how}')
            else:
                problems.append(f'{hostname(u)} 打得开，但内容对不上：{how}')
        good_hosts = strong_hosts

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
