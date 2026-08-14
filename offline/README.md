# 下线用的占位页

Cloudflare Pages **不允许删除当前生产部署**（`code: 8000034`），所以「关站」做不到让
URL 完全不响应——除非删掉整个项目，而那会释放子域名。

折中做法：把这一页部署上去，站点就只剩一句话，没有数据、没有 Functions、没有密钥。

## 关站

```bash
cd offline && npx wrangler pages deploy . --project-name=faham --branch=main
cd offline && npx wrangler pages deploy . --project-name=faham --branch=dev
```

**必须 `cd` 进这个目录再部署。**wrangler 是从当前工作目录找 `functions/` 的，
在仓库根目录跑会把整套 API 一起打包进「下线」的部署里。踩过一次。

顺手清掉密钥：

```bash
yes y | npx wrangler pages secret delete DATABASE_URL --project-name=faham
yes y | npx wrangler pages secret delete DATABASE_URL --project-name=faham --env preview
```

## 开站

回仓库根目录跑 `./promote.sh` 与 `./deploy.sh dev`，再把密钥重新 put 回去
（Pages 的密钥在部署时绑定，改完必须重新部署才生效）。
