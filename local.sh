#!/usr/bin/env bash
# faham · 一条命令起本地全栈
#
#   docker (postgres + sqlgate)  →  打包 public/  →  wrangler pages dev
#
# 跑起来后：
#   站点      http://localhost:8788
#   复核台    http://localhost:8788/review   （token 见 .env 的 REVIEW_TOKEN）
#   接口自检  http://localhost:8788/api/health
#
# 用法：  ./local.sh          起服务
#         ./local.sh --reset  清空数据库重来（连表一起重建）
#         ./local.sh --stop   停掉全部
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

case "${1:-}" in
  --stop)
    pkill -f "wrangler pages dev" 2>/dev/null || true
    docker compose down
    echo "▸ 已停止"; exit 0 ;;
  --reset)
    pkill -f "wrangler pages dev" 2>/dev/null || true
    echo "▸ 清空数据库并重建"
    docker compose down -v ;;
esac

if [ ! -f .dev.vars ]; then
  echo "✗ 缺 .dev.vars。需要 DATABASE_URL / HASH_SALT / REVIEW_TOKEN 三行。"; exit 1
fi

echo "▸ 起 Postgres 与 sqlgate"
docker compose up -d

printf "▸ 等待网关就绪"
for _ in $(seq 1 40); do
  if [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://localhost:5433/health || echo 000)" = "200" ]; then
    echo " ✓"; break
  fi
  printf "."; sleep 3
done
if [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://localhost:5433/health || echo 000)" != "200" ]; then
  echo " ✗"; echo "  网关没起来，看日志： docker logs faham-sqlgate"; exit 1
fi

echo "▸ 建表情况：$(docker exec faham-db psql -U faham -d faham -tAc \
  "select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE'" | tr -d ' ') 张表"

echo "▸ 打包 public/"
./deploy.sh dev --build-only >/dev/null

pkill -f "wrangler pages dev" 2>/dev/null || true
sleep 1
echo "▸ 起 wrangler pages dev"
npx wrangler pages dev public --port 8788 --compatibility-date=2024-11-01 > /tmp/faham-local.log 2>&1 &

printf "▸ 等待站点"
for _ in $(seq 1 30); do
  if [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://localhost:8788/api/health || echo 000)" = "200" ]; then
    echo " ✓"; break
  fi
  printf "."; sleep 2
done

echo
echo "  站点      http://localhost:8788"
echo "  复核台    http://localhost:8788/review"
echo "  自检      $(curl -s --max-time 5 http://localhost:8788/api/health)"
echo "  日志      tail -f /tmp/faham-local.log"
echo "  停止      ./local.sh --stop"
