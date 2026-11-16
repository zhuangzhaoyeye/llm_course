---
name: course-publish
description: 将同一课程文章串行存为掘金、CSDN、知乎草稿并回读校验、登记草稿 ID。当用户说发布第 X 课、把这课发三个平台或补跑失败平台时使用；只存草稿，不代为公开发布，不用于单平台发布或课程内容编写。
---

# 课程发布（一课三平台）

## 描述

用户说「发布第 X 课」时的**唯一入口**：把 `docs/第X课文章.md` 串行存成三个平台（掘金 / CSDN / 知乎）的草稿，回读校验，更新草稿 ID 登记表，最后把三条链接给用户。
**只存草稿，不点"发布"。** 公开上线由用户自己点。

## 使用场景

触发:
- 「发布第 5 课」「把第 4 课发一下」「这课发到三个平台」
- 「文章写好了，发出去」
- 单个平台失败后要重试

不触发:只写文章(`course-content`);只发某一个平台且用户点名了平台 → 可直接用对应的单平台 skill。

## 铁律

1. **草稿优先。** 三个平台脚本都不点发布按钮;用户明确说「公开 / 上线 / 点发布」时才碰,且要先给用户看草稿。
2. **同一课只覆盖、不重复。** 草稿 ID 存在 `registry.json` 里,重跑必须带 ID,否则草稿箱会堆重复稿。
3. **串行执行。** 三个脚本共用 `~/.llm_course_publish_profile`,并发会抢目录锁。
4. **以回读为准。** 只看脚本输出的「回读: … 通过」,不看"点了保存"就报成功。
5. **必须给链接。** 每次跑完在回复里列出三条可点击的草稿链接;哪个平台失败就明说失败原因,不省略。

## 指令

```bash
node .trae/skills/course-publish/scripts/publish.js 4              # 第 4 课发三平台
node .trae/skills/course-publish/scripts/publish.js 4 --only csdn  # 只补一个平台
node .trae/skills/course-publish/scripts/publish.js --list         # 看已登记的草稿 ID
```

脚本会：读 `docs/第<中文数字>课文章.md` → 查 `registry.json` 里该课已有的平台 ID → 依次调三个单平台脚本（带 ID 则覆盖）→ 从输出里解析草稿链接 → 写回 `registry.json` → 打印三行结果。

## 用户明确授权「直接发布」时

默认只存草稿。只有用户明确说「直接发布 / 直接公开」时，才用各平台脚本的 `publish` 模式（或 CSDN 的 `update`）：

```bash
# 掘金：填分类/标签/摘要后点「确定并发布」
PUBLISH_SUMMARY="50–100 字摘要" PUBLISH_TAGS="LLM,NLP" \
  node .trae/skills/juejin-publish/scripts/juejin.js publish docs/第N课文章.md [draftId]

# CSDN：新稿首发也走 update（打开草稿 → 重贴正文 → 点发布文章 → 弹窗填摘要/标签 → 确认）
node .trae/skills/csdn-publish/scripts/csdn.js update docs/第N课文章.md <articleId>

# 知乎：填话题后点「发布」
node .trae/skills/zhihu-publish/scripts/zhihu.js publish docs/第N课文章.md <draftId>
```

发布前脚本会核对标题与正文行数；发布后回读。掘金实测约束（2026-11-13）：

- **标签不可自建**：只能选平台已有标签；`大模型课程`、`大模型入门` 不存在，本账号上限 2 个，用 `LLM`、`NLP` 等已有标签。
- **摘要必须 50–100 字**：低于 50 字会被前端静默拦截（控制台报「摘要不满足最低50字的要求」），页面无提示。
- **发布后 URL 跳 `/published`**：文章 ID 从草稿详情接口 `article_data.article_id` 补取。
- **新稿先进入审核中**：公开页短暂 404 属正常，不代表失败；以创作中心「审核中」列表为准。

CSDN 实测约束（2026-11-13）：

- 新稿首发用 `update`：摘要/标签在点「发布文章」之后的弹窗里填。
- 首发后可能直接进「已发布」，也可能进「审核中/未通过 → 待审核」；**不能凭脚本回读通过判定已公开**，必须看管理页状态。

知乎实测约束（2026-11-13）：

- 话题（＝标签）只能精确匹配已有话题，匹配不到就跳过；
- 发布后 ID 一般不变，若另建新篇以公开页实际 `/p/<id>` 为准回写；
- 匿名 curl 回读会 403，要用浏览器看 status 200。


## 文章不存在时

脚本会以退出码 3 结束。此时按 `course-content` 的标准写文章：从 `src/lessons/lesson-<N>.html` 提取 6 张卡片的问题、正文和计算块，改写成「问题 → 表格 → 一句话结论」的连载格式，数字用 `python3` 独立复算，事实类逐条联网核验，经验数字标「估算」。写完再跑本脚本。

## 平台差异（必须知道）

| 项 | 掘金 | CSDN | 知乎 |
|---|---|---|---|
| 登录判断 | cookie `sessionid` | cookie `UserToken` | cookie `z_c0` |
| 保存方式 | 自动保存，URL 变 `/editor/drafts/<ID>` | 点「保存草稿」菜单项 | 自动保存，URL 变 `/p/<ID>/edit` |
| 正文格式 | CodeMirror `setValue`，保留 Markdown 原文 | contenteditable，`paste` 纯文本 | Draft.js，必须 `paste` **text/html**（脚本内置 Markdown→HTML，不支持图片） |
| 覆盖入口 | `draft <file> <ID>` | `draft <file> <articleId>` | `draft <file> <ID>` |
| 草稿箱 | `https://juejin.cn/creator/content/article/draft` | `https://mp.csdn.net/mp_blog/manage/article` | `https://www.zhihu.com/creator/manage/creation/all` |
| 平台限制 | — | 每天有发文额度，误发布会消耗 | — |

## 发布后回复里必须包含

1. 三个平台的草稿链接（可点击）。
2. 每个平台的回读结果（标题一致 / 行数）。
3. 一句「草稿已就绪，发布需你手动点」。
4. 若某个平台失败：失败原因 + 补跑命令，例如 `node .trae/skills/course-publish/scripts/publish.js 4 --only csdn`。
