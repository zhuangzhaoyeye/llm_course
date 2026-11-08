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
