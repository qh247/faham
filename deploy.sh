#!/usr/bin/env bash
# faham 部署脚本
#
# 为什么存在：wrangler pages deploy 上传目录内的「所有实际文件」，
# 与 .gitignore 无关。曾因此把 .env 传上公网。
# 因此本脚本采用白名单：只把该公开的文件复制进 public/ 再部署，
# 并在部署后自动验证敏感路径确实不可访问。
#
# 用法：  ./deploy.sh dev     （预览，带样例数据）
#         ./deploy.sh main    （正式，空架构）
set -euo pipefail

BRANCH="${1:-dev}"
PROJECT="${PAGES_PROJECT:-faham}"
ROOT="$(cd "$(dirname "$0")" && pwd)"
OUT="$ROOT/public"

echo "▸ 重建 public/（白名单）"
rm -rf "$OUT"
mkdir -p "$OUT/data" "$OUT/db" "$OUT/docs" "$OUT/assets"

cp "$ROOT/index.html"                "$OUT/"
cp "$ROOT/data/events.json"          "$OUT/data/"
cp "$ROOT/db/schema.sql"             "$OUT/db/"
cp "$ROOT"/docs/*.md                 "$OUT/docs/"
cp "$ROOT/assets/og.png"             "$OUT/assets/"        # 社交分享预览图
cp "$ROOT"/README*.md                "$OUT/" 2>/dev/null || true
cp "$ROOT/LICENSE" "$ROOT/LICENSE-CONTENT" "$OUT/" 2>/dev/null || true

echo "▸ 部署前安全检查"
if find "$OUT" \( -name '.env*' -o -name '*.local.*' -o -name '.git*' -o -name 'skills-lock*' \) | grep -q .; then
  echo "  ✗ public/ 内发现敏感文件，已中止"; exit 1
fi
echo "  ✓ public/ 干净（$(find "$OUT" -type f | wc -l | tr -d ' ') 个文件）"

echo "▸ 部署到分支 $BRANCH"
npx wrangler pages deploy "$OUT" --project-name="$PROJECT" --branch="$BRANCH" --commit-dirty=true

echo "▸ 部署后验证敏感路径不可访问"
sleep 6
URL="https://${BRANCH}.${PAGES_HOST:-$PROJECT}.pages.dev"
fail=0
for p in .env .gitignore skills-lock.json .git/config data/events.local.json; do
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 12 "$URL/$p" || echo 000)
  body=$(curl -s --max-time 12 "$URL/$p" 2>/dev/null | head -c 200 || true)
  # Pages 对未知路径回退到 index.html，故以「是否为 HTML 页面」判定，忽略大小写
  if [ "$code" = "200" ] && ! printf '%s' "$body" | grep -qi '<!doctype html\|<html'; then
    echo "  ✗ 泄露：$URL/$p"; fail=1
  else
    echo "  ✓ $p 不可访问"
  fi
done
[ "$fail" = "0" ] && echo "▸ 完成：$URL" || { echo "▸ 发现泄露，请立即删除该部署"; exit 1; }
