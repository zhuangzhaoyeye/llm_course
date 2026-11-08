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

1. **只存草稿,不点"发布文章"(`.btn-publish`)。** 脚本只点 `button.btn-save`。CSDN 每天有发文额度(实测"今日还有 2 篇"),误点发布会消耗额度且文章公开。
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
| 草稿 ID | 首次保存后 URL 变成 `?articleId=<ID>`。之后覆盖要带这个 ID,否则会新建重复草稿 |

## 同一个登录目录不能并发

`login` 和 `draft` 用同一个 Chromium 配置目录,同一时间只能跑一个。需要和 `juejin-publish` 一起用时**串行执行**。
