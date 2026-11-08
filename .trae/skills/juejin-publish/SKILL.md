---
name: juejin-publish
description: 用无头浏览器把本地 Markdown 存成掘金草稿(不发布),未登录时弹出可见窗口让用户登录,存完回读校验。当用户要把文章发到掘金、存掘金草稿、更新掘金草稿时使用。不用于正式发布(需用户明确同意并自行点发布),不用于 CSDN(走 csdn-publish)。
---

# 掘金草稿发布

## 描述

掘金没有官方的发文章 MCP(官方 `@juejin-team/mcp-server` 只能部署 HTML/CSS/JS 静态页)。本 skill 用 Playwright 驱动网页编辑器,**只存草稿**,由用户到草稿箱确认后自己点发布。

## 使用场景

触发:把文章发到掘金、存/更新掘金草稿。
不触发:CSDN(`csdn-publish`);写文章内容本身(先把稿子写成 `docs/*.md`)。

## 铁律

1. **只存草稿,不点"发布"。** 正式发布要选分类、标签、摘要,这条路径**没有验证过**。用户明确要求时才做,且做之前先给他看草稿。
2. **不碰用户的日常浏览器 cookie。** 登录态保存在独立目录 `~/.llm_course_publish_profile`(可用环境变量 `PUBLISH_PROFILE` 覆盖),仓库之外,不会被提交。凭证不写进任何文件,日志里不打印 cookie 值。
3. **以回读为准。** 编辑器的"保存成功"提示不可靠:内容没变时不会出现。脚本会新开页面读服务器上的草稿,校验标题和行数。
4. **每次批准只做一次明确的操作。** 稿子要先给用户看过,再存。
5. **每次新建或更新草稿后,回复里必须给出可点击的草稿链接**:`https://juejin.cn/editor/drafts/<ID>`,方便用户直接跳转。脚本输出的"草稿链接"一行就是它;拿不到 ID 就明说,不得省略。
6. **需要用户在网页上操作时(登录、点发布、查看草稿箱),先代填,再给网址。** 见 `project_rules.md` 第 19 条与第六节地址登记。

## 指令

脚本:`scripts/juejin.js`(依赖仓库根的 `playwright`,已在 `package.json` 里)。

```bash
node .trae/skills/juejin-publish/scripts/juejin.js check                      # 查登录态
node .trae/skills/juejin-publish/scripts/juejin.js login                      # 未登录则弹窗,登录后自动退出
node .trae/skills/juejin-publish/scripts/juejin.js draft docs/文章.md          # 新建草稿
node .trae/skills/juejin-publish/scripts/juejin.js draft docs/文章.md <草稿ID>  # 覆盖已有草稿
```

约定:md 第一行 `# 标题` 是标题,其余是正文。

流程:
1. `check`。未登录就跑 `login`(后台运行,告诉用户去弹出的窗口里登录,验证码和扫码由用户完成)。
2. `draft`。**已有草稿就带上草稿 ID 覆盖**,否则每跑一次会在草稿箱里多一篇。
3. 看输出的"回读"一行是否"通过",并读截图确认预览(表格、链接)渲染正常。
4. 把草稿链接 `https://juejin.cn/editor/drafts/<ID>` 给用户。用户自己登录的浏览器才能打开。

## 平台细节(踩过的坑)

| 项 | 做法 |
|---|---|
| 登录判断 | cookie 里有 `sessionid`。访客只有 `s_v_web_id` 等,登录后才多出 `sessionid`、`uid_tt` 等 |
| 标题 | `.title-input`,`fill` 即可 |
| 正文 | CodeMirror 5,`document.querySelector('.CodeMirror').CodeMirror.setValue(text)`,换行保留 |
| 保存 | 自动保存,等约 10 秒;新建后 URL 变成 `/editor/drafts/<ID>` |
| 草稿箱 | `https://juejin.cn/creator/content/article/draft`。**页面默认停在"文章"标签**,看顶部"草稿箱(N)"计数,不要用页面文字匹配标题来判断 |

## 同一个登录目录不能并发

`login` 和 `draft` 用同一个 Chromium 配置目录,同一时间只能跑一个。需要和 `csdn-publish` 一起用时**串行执行**。
