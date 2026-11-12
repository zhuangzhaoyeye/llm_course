---
name: csdn-publish
description: 用无头浏览器把本地 Markdown 存成 CSDN 草稿(不发布),未登录时弹出可见窗口让用户登录,存完回读校验。当用户要把文章发到 CSDN、存 CSDN 草稿、更新 CSDN 草稿时使用。不用于正式发布(需用户明确同意并自行点发布),不用于掘金(走 juejin-publish)。
---

# CSDN 草稿发布

## 描述

CSDN 没有找到官方的发文章 MCP 或开放发文 API(检索未命中,不是已证实不存在)。本 skill 用 Playwright 驱动网页 Markdown 编辑器,**只存草稿**,由用户到草稿箱确认后自己点发布。

## 使用场景

触发:把文章发到 CSDN、存/更新 CSDN 草稿。
不触发:掘金(`juejin-publish`);写文章内容本身(先把稿子写成 `docs/*.md`)。

## 铁律

1. **只存草稿,不点"发布文章"(`.btn-publish`)。** 新版编辑器靠标题自动保存（不点任何保存按钮）；旧版才点 `button.btn-save`。CSDN 每天有发文额度(实测"今日还有 2 篇"),误点发布会消耗额度且文章公开。**唯一例外**：`update` 子命令——它**只对已发布文章做「标题 + 摘要 + 标签 + 尾链」点更新**（用户已明确授权）时才点发布按钮；**新稿首发仍走 `draft`，禁止点发布**。
2. **不碰用户的日常浏览器 cookie。** 登录态保存在独立目录 `~/.llm_course_publish_profile`(可用环境变量 `PUBLISH_PROFILE` 覆盖),仓库之外,不会被提交。凭证不写进任何文件,日志里不打印 cookie 值。
3. **以回读为准。** 脚本存完会新开页面读服务器上的草稿,校验标题和行数,不凭"点了保存"就报成功。
4. **每次批准只做一次明确的操作。** 稿子要先给用户看过,再存。
5. **每次新建或更新草稿后,回复里必须给出可点击的草稿链接**:`https://editor.csdn.net/md?articleId=<ID>`,方便用户直接跳转。脚本输出的"草稿链接"一行就是它;拿不到 ID 就明说,不得省略。
6. **需要用户在网页上操作时(登录、点发布、查看草稿箱),先代填,再给网址。** 见 `project_rules.md` 第 19 条与第六节地址登记。

## 指令

脚本:`scripts/csdn.js`(依赖仓库根的 `playwright`,已在 `package.json` 里)。

```bash
node .trae/skills/csdn-publish/scripts/csdn.js check                          # 查登录态
node .trae/skills/csdn-publish/scripts/csdn.js login                          # 未登录则弹窗,登录后自动退出
node .trae/skills/csdn-publish/scripts/csdn.js draft docs/文章.md              # 新建草稿
node .trae/skills/csdn-publish/scripts/csdn.js draft docs/文章.md <articleId>  # 覆盖已有草稿
node .trae/skills/csdn-publish/scripts/csdn.js update docs/文章.md <articleId> # 更新已发布文章的 标题+摘要+标签+尾链(数据源 docs/csdn-优化方案.md)
```

约定:md 第一行 `# 标题` 是标题,其余是正文。

流程:
1. `check`。未登录就跑 `login`(后台运行,告诉用户去弹出的窗口里登录,验证码和扫码由用户完成)。
2. `draft`。**已有草稿就带上 articleId 覆盖**,否则每跑一次会在草稿箱里多一篇。
3. 看输出的"回读"一行是否"通过",并读截图确认预览渲染正常。
4. 把草稿链接 `https://editor.csdn.net/md?articleId=<ID>` 给用户。用户自己登录的浏览器才能打开。
5. 要确认没有公开:创作中心 `https://mp.csdn.net/mp_blog/manage/article` 顶部有"已发布(N) / 草稿箱(N)"计数,新稿只会让草稿箱 +1。

## 平台细节(踩过的坑)

| 项 | 做法 |
|---|---|
| 登录判断 | cookie 里有 `UserToken`。访客只有 `SESSION` 等,登录后才多出 `UserToken`、`UserInfo`、`UserName` |
| 标题 | DOM 里有一个 **0×0 的隐藏 `input`**,直接选它会点击超时。真正可见的是 `.article-bar__title-display`,**先点它**,才会出现可输入的 `input.article-bar__title--input` |
| 正文 | `.editor__inner` 是 contenteditable 的 `PRE`。**`keyboard.insertText` 会吞换行**,整篇挤成一段、`##` 和表格全坏。必须派发 `paste` 事件(`DataTransfer` 带 `text/plain`) |
| 保存 | **2026-11 起为新版编辑器：自动保存**，标题一填即开始存，页面右下只剩「发布文章」(`button.btn-publish`)，**绝不能点**。旧版才有 `button.btn-save` → 弹出菜单 →「保存草稿」，脚本已做兼容判断 |
| 草稿 ID | 新版编辑器自动保存后 URL **不带** `?articleId`（旧版才带）。脚本自动转草稿列表页 `mp.csdn.net/mp_blog/manage/article` 按标题匹配取最新 articleId（三级回退：URL 参数 → URL → 草稿列表）。之后覆盖要带这个 ID,否则会新建重复草稿 |

## 同一个登录目录不能并发

`login` 和 `draft` 用同一个 Chromium 配置目录,同一时间只能跑一个。需要和 `juejin-publish` 一起用时**串行执行**。

## 发布前优化（2026-11-12 起强制，为了 CSDN 搜索流量）

每篇存草稿前，标题/摘要/标签/尾链按以下规范先定好（内容方案放 `docs/csdn-优化方案.md`，写文章时同步生成）：

| 项 | 规范 |
|---|---|
| 标题 | 统一前缀「第一性原理大模型课程 · 第 N 课」，核心词 + 长尾词 + 场景，主体 ≤30 字。**不要只写一个词**（如《对齐》太泛、搜不到） |
| 摘要 | ≤60 字，关键词越靠前越好（前 38 字内含核心词），点出「讲什么 + 能学到什么 + 手算」 |
| 标签 | 3–5 个「中高搜索量 + 低竞争」长尾标签（如 `RLHF`、`PPO 算法`，**不用** `深度学习`/`Python` 这类大词） |
| 尾链 | 文末加「上一篇 / 下一篇」链接，利于系列识别 + 站内互导 |

**摘要与标签**：CSDN 的摘要/标签在「发布设置」里（草稿编辑器内不一定有），`csdn.js` 的 `draft` 只存标题+正文，不填摘要/标签。因此：写文章时把摘要/标签一并生成、写进 `docs/csdn-优化方案.md`，**存草稿后提示用户在发布时手动填摘要和标签**（或先确认新编辑器是否支持内联填写）。

**更新已发布文章（`update`，标题 + 摘要 + 标签 + 尾链）**：`update` 子命令用于**已发布文章**的「标题 + 摘要 + 标签 + 尾链」四项一并点更新（用户已授权），**新稿首发仍走 `draft`，禁止点发布**。四项数据源：
- **标题**：md 第一行 `# 标题`。
- **摘要 / 标签**：`docs/csdn-优化方案.md`（按文件名 `## <文件名>` 定位该节，取「摘要」「标签」）。
- **尾链**：md 末尾 `---` 之后追加的「上一篇 / 下一篇」。

执行流程：打开 `https://editor.csdn.net/md?articleId=<ID>` → 改标题 → **正文全选重贴 md 正文**（md 已把尾链追加在末尾；CSDN 编辑器 paste 不尊重光标位置，只有全选重贴可靠，重贴后回读校验字符数防丢失）→ 点「发布文章」→ 在发布设置弹窗里填摘要、替换标签（先删旧大词标签、再添加新长尾标签；因账号博客等级 <3 无法创建自定义标签，需伪造搜索命中组件 `handleSelect` 的「在库」分支来添加）→ 确认发布 → 回读校验标题/摘要/标签/尾链/正文字符数。用法示例见上文「指令」块。

## 冷启动 SOP（发完后 30 分钟内做，触发二次推荐）

1. 首发 30 分钟内自评一条置顶评论（补充一句「本文的关键数字/结论」）。
2. 回复前 10 条评论（哪怕只是表情/谢谢），拉高互动率。
3. 24 小时内争取点赞/收藏过 50，触发二次推荐。
4. 分享到 2–3 个相关技术群 / 朋友圈（不刷屏）。
