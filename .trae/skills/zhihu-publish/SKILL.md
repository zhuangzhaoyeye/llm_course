---
name: zhihu-publish
description: 使用独立浏览器配置将本地文章存为知乎草稿并回读校验。当用户要把文章发到知乎、存知乎草稿或更新已有知乎草稿时使用；只存草稿，不代为公开发布，不用于掘金、CSDN 或文章内容创作。
---

# 知乎草稿发布

## 描述

知乎没有官方发文 API/发文章 MCP。本 skill 用 Playwright 驱动知乎写文章页,**只存草稿**,由用户到草稿箱确认后自己点"发布"。

## 使用场景

触发:把文章发到知乎、存/更新知乎草稿。
不触发:掘金(`juejin-publish`);CSDN(`csdn-publish`);写文章内容本身(先把稿子写成 `docs/*.md`)。

## 铁律

1. **只存草稿,不点"发布"。** 脚本不碰页面右下角的「发布」按钮。
2. **不碰用户的日常浏览器 cookie。** 登录态保存在独立目录 `~/.llm_course_publish_profile`(可用环境变量 `PUBLISH_PROFILE` 覆盖),仓库之外,不会被提交。日志只打印 cookie 名字,不打印值。
3. **以回读为准。** 存完新开页面读服务器上的草稿,校验标题和正文字符数,不凭"点了保存"就报成功。
4. **已有草稿就带 id 覆盖**,否则每跑一次会多一篇。
5. **每次新建或更新草稿后,回复里必须给出可点击的草稿链接**:`https://zhuanlan.zhihu.com/p/<ID>/edit`,拿不到 ID 就明说。

## 指令

脚本:`.trae/skills/zhihu-publish/scripts/zhihu.js`(依赖仓库根的 `playwright`)。

```bash
node .trae/skills/zhihu-publish/scripts/zhihu.js check                      # 查登录态
node .trae/skills/zhihu-publish/scripts/zhihu.js login                      # 未登录则弹窗,登录后自动退出
node .trae/skills/zhihu-publish/scripts/zhihu.js draft docs/文章.md          # 新建草稿
node .trae/skills/zhihu-publish/scripts/zhihu.js draft docs/文章.md <草稿ID>  # 覆盖已有草稿
```

约定:md 第一行 `# 标题` 是标题,其余是正文。脚本内置最小 Markdown→HTML 转换(标题/表格/列表/段落/加粗/斜体/行内码/链接),**不支持图片**,正文里有图片会丢。

## 平台细节(踩过的坑)

| 项 | 做法 |
|---|---|
| 登录判断 | cookie 里有 `z_c0` 即已登录(访客只有 `d_c0`、`_zap` 等) |
| 写文章页 | `https://zhuanlan.zhihu.com/write`;已有草稿走 `https://zhuanlan.zhihu.com/p/<ID>/edit` |
| 标题 | `textarea[placeholder*="请输入标题"]`,直接 `fill` |
| 正文 | Draft.js 的 `.public-DraftEditor-content`。**必须派发带 `text/html` 的 `paste` 事件**,html 里的 table/h2/ul 才会保留结构;纯文本会把 Markdown 管道符号原样贴进去 |
| 覆盖 | 先点编辑器,`Cmd/Ctrl+A` + `Backspace` 清空再粘贴,否则会追加到旧文后面 |
| 保存 | 全自动,无保存按钮。URL 从 `/write` 变成 `/p/<ID>/edit` 即已落库,轮询最多 40s |
| 草稿箱 | `https://www.zhihu.com/creator/manage/creation/all` |

## 同一个登录目录不能并发

`login` / `draft` 与 `juejin-publish`、`csdn-publish` 共用同一个 Chromium 配置目录,**必须串行执行**;并发会因目录锁失败。
