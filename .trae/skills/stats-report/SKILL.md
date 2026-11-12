---
name: stats-report
description: 查询课程站 Cloudflare D1 匿名事件并输出聚合统计。当用户问课程访问量、访客数、多少人看了、哪节课火、搜索命中率或 AI 助教使用情况时使用；数字必须来自实跑，不用于修改埋点或识别个人访客。
---

# 课程统计报表

## 描述

从 Cloudflare D1（库 `llm-course-stats`）读匿名事件，按北京时间聚合成人可读的报表。
**只要用户问“多少人看了 / 访问量 / 统计 / 数据怎么样 / 哪节课火 / 有没有人用”，必须调用本 skill，不得凭印象回答。**

## 使用场景

触发:用户问课程站的统计数据、访问量、访客数、打开率、搜索命中、AI 助教使用情况，或说“给我看下数据”。
不触发:修改统计埋点(`src/shell.html` 的 `window.Stats`);查询 D1 之外的业务数据。

## 铁律

1. **必须实跑，不许估算。** 报表里的每个数字都来自本次 D1 查询；查不到就明说“没有数据”，不猜。
2. **区分“没有数据”和“数据为 0”。** 没有数据 = 没人访问过或统计未启用；数据为 0 = 有访问但没有触达该行为。
3. **数据起点是 2026-11-06 07:26 UTC。** 更早的事件在服务端开通 D1 之前被丢弃，任何时候都不要声称能补。
4. **只能给聚合量，不能还原个人。** 表里存的是随机访客 ID（`cid`），不含 IP、不含任何用户输入文本、不含搜索词。用户若问“谁看了”，明确说做不到。
5. **默认 7 天**，用户说“这周 / 最近一个月”时用 `--days 7` / `--days 30` 并写明区间。

## 指令

```bash
node .trae/skills/stats-report/scripts/stats.js              # 最近 7 天
node .trae/skills/stats-report/scripts/stats.js --days 30    # 最近 30 天
node .trae/skills/stats-report/scripts/stats.js --json       # 原始聚合 JSON
```

脚本内部执行 `npx wrangler d1 execute llm-course-stats --remote --json --command "<SQL>"`（工作目录 `proxy/`），需要本机已 `wrangler` 登录且账号在 `zhuangzhaoyeye` 的 Cloudflare 下。

## 指标口径

| 指标 | 定义 |
|---|---|
| 批次 | 一次 `sendBeacon` 上报 = D1 一行（最多 50 个事件压一行） |
| 事件 | 批次内 `ev` 数组的元素总数 |
| 访客 (UV) | 去重后的 `cid`（浏览器 localStorage 随机生成，清缓存会变成新访客） |
| 会话 | 去重后的 `sid`（每个标签页会话一个） |
| PV | `open` 事件数，一次页面加载记 1 次 |
| 展开/人 | 卡片 `open` 次数 ÷ 当日访客数 |
| 停留 | `dwell` 事件的 `ms`，服务端已把单次上限截到 30 分钟、不足 1 秒的不记 |
| 搜索命中率 | `search` 事件 `k=hit` ÷ (hit + miss) |

## 事件白名单（与 `proxy/events.js` 一致）

`open`、`lesson`、`card`(open/close)、`dwell`、`check`、`tab`、`qna`、`ai_open`、`ai_ask`、`link`、`search`、`resume`。
出现表外事件说明前端与服务端版本不一致，先查 `src/shell.html` 的 `Stats.track` 调用。

## 常见异常

| 现象 | 判断 |
|---|---|
| `D1 里没有任何数据` | 确实没人访问，或 Worker 未绑定 D1。先看 `/e` 响应有没有 `x-stats: disabled` |
| `无法解析 wrangler 输出` | 未登录 / 网络问题 / 库名改了。手动跑一次 SQL 看报错 |
| 只有 `open` 没有 `lesson` | 学员没进入任何课就离开了，正常 |
| 访客数远大于 PV | 不可能，说明 `cid` 生成逻辑异常，查 `src/shell.html` 的 `ensureIds()` |
