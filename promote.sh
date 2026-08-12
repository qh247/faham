#!/usr/bin/env bash
# 把 dev 上验证过的改动推上生产，同时保证 main 永远不带数据。
#
# 为什么要有这个脚本：main 的设计是「空档案 + 规则 + 投稿入口」，
# dev 带 44 条样品。两者共用一个仓库，所以每次 dev → main 都要做同一套动作：
#   合并 → 把数据文件清回空 → 提交 → 部署 → 切回 dev
# 手工做过两次，两次都出错：一次忘了切分支就部署（把 dev 上线成空的），
# 一次 checkout 被未提交改动挡下、清空的命令却已经跑完（把 dev 的数据清了）。
# 顺序固定、失败即停，就不会再错。
#
# 用法：  ./promote.sh            正常提升并部署
#         ./promote.sh --dry-run  只做合并与清空，不部署
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
DRY="${1:-}"

# 前置条件：工作区必须干净。上面那次事故就是脏工作区挡下 checkout 造成的。
if [ -n "$(git status --porcelain)" ]; then
  echo "✗ 工作区不干净，先提交或 stash："; git status --short; exit 1
fi
START="$(git rev-parse --abbrev-ref HEAD)"
if [ "$START" != "dev" ]; then
  echo "✗ 请在 dev 分支上运行（当前：$START）"; exit 1
fi

echo "▸ dev 的数据（用于事后核对）"
python3 - <<'PY'
import json
for f, k in (('data/events.json', None), ('data/threads.json','threads'), ('data/actors.json','actors')):
    d = json.load(open(f)); n = len(d if k is None else d[k])
    print(f"    {f:<20}{n} 条")
PY

echo "▸ 切到 main 并合并 dev"
git checkout -q main
# 从这里开始，任何失败都要把分支切回去，别把人留在 main 上
trap 'echo "✗ 中断，切回 $START"; git merge --abort 2>/dev/null || true; git checkout -q "$START"' ERR INT TERM
git merge --no-edit -q dev

echo "▸ 清空 main 的数据（规则先于数据：上线时档案是空的）"
printf '[]'              > data/events.json
printf '{"threads":[]}'  > data/threads.json
printf '{"actors":[]}'   > data/actors.json
rm -rf data/candidates data/enrich.report.md
git add -A data/
if git diff --cached --quiet; then
  echo "  · 数据已是空的，无需提交"
else
  git commit -q -m "Keep main empty: architecture and rules ship before any data"
  echo "  ✓ 已提交"
fi

# 兜底：main 上线前再确认一次数据真的是空的
python3 - <<'PY'
import json, sys
bad = []
if json.load(open('data/events.json')):            bad.append('events.json')
if json.load(open('data/threads.json'))['threads']: bad.append('threads.json')
if json.load(open('data/actors.json'))['actors']:   bad.append('actors.json')
if bad:
    print('✗ main 上仍有数据：' + ', '.join(bad)); sys.exit(1)
print('  ✓ 核对通过：main 的三个数据文件都是空的')
PY

if [ "$DRY" = "--dry-run" ]; then
  echo "▸ --dry-run：跳过部署"
else
  # 不再写死 faham-2t2：那个 Pages 项目已删除。重新上线时用
  #   PAGES_HOST=<新的子域前缀> ./promote.sh
  # 未设置时由 deploy.sh 回退到项目名。
  ./deploy.sh main
fi

trap - ERR INT TERM
git checkout -q "$START"
echo "▸ 已切回 $START"
git log --oneline -1
echo
echo "记得推送： git push origin main && git push origin dev"
