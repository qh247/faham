# faham 新闻收集机器人

*English: A daily bot that reads public RSS/Atom feeds and writes candidate leads to `data/candidates/YYYY-MM-DD.json` for human review — it never writes to `data/events.json` and never publishes anything.*

---

## 这个 bot 做什么

每天（见 `.github/workflows/collect.yml` 的排程），`bot/collect.mjs`：

1. 读取 `bot/feeds.json` 里登记的媒体 RSS/Atom 订阅源，逐个抓取；
2. 用 `bot/keywords.json` 里的关键词表做「是否与公共政策相关」的粗筛；
3. 把同一件事在不同媒体的报道聚成一组（`cluster`），记录有几家「独立媒体」
   都报道了同一件事（`independent_outlets`）；
4. 按「来源等级（tier）由高到低、独立媒体数由多到少」排序，写入
   `data/candidates/YYYY-MM-DD.json`。

这份文件是一份**待审队列**，不是网站会展示的数据。

## 这个 bot 绝对不做的事

- **绝不写入 `data/events.json`**。那是唯一会被网站读取、公开展示的数据文件，
  只能由人工审核后手动/另行流程更新。本脚本代码里没有、也不应该加上任何
  写入该文件的路径。
- **绝不「发布」任何东西**。它只生产候选线索，候选的初始 `status` 永远是
  `"unreviewed"`；要不要收录、怎么写摘要、双方各自的说法是什么，都是人的
  工作，见 [`docs/governance.md`](../docs/governance.md)。
- **不把标题当事实**。每条候选记录都带
  `"headline_is_not_a_claim": true`——意思是「这只是某家媒体用的标题」，
  不代表标题所说的内容已被核实，更不能直接抄进 `claims` 字段。
- **不采信小报的标题本身，只用它来做交叉印证**。本项目 owner 明确认为星洲
  日报等中文小报「标题党」——标题经常夸张、煽情，不能单独当作事实来源。
  这类媒体在 `bot/feeds.json` 里被标为 `tier: 3`、`headline_only: true`；
  它们的标题只在「是否也有别的独立媒体在报道同一件事」这个问题上有价值，
  不能单独支撑一条候选。

## tier（来源等级）是怎么设计的

这是编辑方针的编码，不是媒体大小或流量排名：

| tier | 含义 | 例子 |
|---|---|---|
| 1 | 一手/官方文件——国会 Hansard、联邦宪报、选委会（SPR）、国家银行（BNM）、
统计局（DOSM）、财政部、税收局（LHDN）、司法机构。这些是**文件**，不是新闻报道。 | `bot/feeds.json` 里目前都是 `feed: null`——都没有找到可用的 RSS，
只登记了 `listing`（列表页网址），留给未来的爬虫用。 |
| 2 | 通讯社与建制新闻——Bernama、Malaysiakini、The Edge、Free Malaysia Today、
Malay Mail、The Star、NST、The Vibes、CodeBlue、Macaranga。 | 实际验证能用的 RSS：Malaysiakini、FMT、Malay Mail、The Vibes、CodeBlue（Macaranga
的 RSS 是真的，但它会拦截本 bot 声明的 User-Agent，实际抓取时大概率会失败，
详情见 `bot/feeds.json` 里 macaranga 条目的 note）。 |
| 3 | 其它，包括中文小报（星洲、中国报、东方、南洋等）与聚合站。 | 全部标 `headline_only: true`。 |

`bot/collect.mjs` 输出时按 `tier` 升序、`independent_outlets` 降序排列——
官方文件和被多家独立媒体印证的story会排在审核队列最前面。

## 本地怎么跑

```bash
# 只看结果，不写任何文件（推荐先跑这个）
node bot/collect.mjs --dry-run

# 真正写入 data/candidates/<今天日期>.json
node bot/collect.mjs

# 只保留最近 N 天发布的内容（默认 3 天）
node bot/collect.mjs --dry-run --days=7
```

零依赖：只用 Node 20+ 内建的 `fetch`、`node:fs`、`node:crypto`、`node:path`，
不需要 `npm install`。

同一天内重复跑（比如手动触发 `workflow_dispatch` 两次）是安全的：脚本会先
读回当天已经写过的 `data/candidates/YYYY-MM-DD.json`，把里面已有的候选合并
进这一次抓到的结果，而不是覆盖掉；如果两次结果完全一样，连文件内容
（包括时间戳）都会保持不变，GitHub Actions 那边的「没变化就不 commit」
逻辑才会真正生效。

## 怎么新增一个媒体源

1. 找到该媒体的 RSS/Atom 网址，**必须自己实际 `curl` 验证过**：返回
   200、内容是合法的 XML、`<item>`/`<entry>` 数量大于 0、日期是最近的。
   不要凭猜测/凭记忆填网址——本项目里好几家大媒体（Bernama、The Star、
   NST、The Edge）看起来"应该"有 RSS，实测全部失效或已下线，只能退而
   记录 `listing`（页面网址）供未来写专门的爬虫。
2. 在 `bot/feeds.json` 的 `outlets` 数组里加一条，字段：`key`（唯一英文
   短标识）、`name`、`lang`（en/ms/zh/ta）、`tier`（按上表判断）、
   `feed`（验证过的 RSS 网址，没有就填 `null`）、`site`、
   `status`（`ok` / `no_feed` / 其它说明）、`note`（写清楚你验证时看到
   了什么，方便以后的人不用重新踩一遍坑）。
   如果没有 RSS，加 `listing` 字段指向一个真实存在、内容看起来是新闻列表
   的网址。
   如果这是一家中文小报或类似「标题党」媒体，加 `"headline_only": true`。
3. 如果关心的是新主题（比如新的政策关键词），去改 `bot/keywords.json`，
   不用碰 `bot/collect.mjs` 的代码。
4. 跑 `node bot/collect.mjs --dry-run` 确认新源真的被抓到、条目数量合理，
   再提交。
