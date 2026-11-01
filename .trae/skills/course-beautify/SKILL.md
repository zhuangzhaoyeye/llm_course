---
name: course-beautify
description: 课程内容美化（视觉微调）标准流程。只调颜色、字体、字号、行高、间距，不改文字、数字、DOM 结构和组件形态。当用户说美化、视觉精修、排版/配色不好看、截图对比、让某张卡像另一张卡一样好看时使用。不用于写新内容（course-content）、内容质检（card-review）、构建发布（course-build）。
---

# 课程内容美化（视觉微调）

## 定位

`course-content` 负责讲得对，`card-review` 负责逐条核验。本 skill 只做**微调**：在现有版式上调色、调字、调间距，让同样的内容更易读。

## 允许与禁止（2026-11-01 用户反馈「改太多、不好看」后收紧）

| 允许 | 禁止 |
|---|---|
| 文字颜色、背景色、边框颜色 | 改 DOM、包裹元素、加 class |
| 字号、字重、行高 | 注入任何装饰脚本 |
| padding / margin / 段距 | 换组件形态：卡片化步骤、徽章标签、渐变、圆点装饰、左侧色条 |
| 表格单元格留白、表头底色 | 改圆角形状、阴影层级、整体布局 |
| | 改文字、数字、标题、结构 |

**判断一条改动是否越界**：把改前改后截图并排，用户应该觉得"还是原来那张卡，只是更清楚"。如果看起来像换了一套皮肤，就是改多了。

## 流程

### 第 1 步 诊断

1. 截图：`node .trae/skills/course-beautify/references/shot.js dist_course.html --out tmp/shots-before`
2. 只列可微调解决的问题（字太淡、行太挤、表格太密），**最多 5 条**，每条带定位。
3. 看到内容问题（错位、措辞别扭）时**只报告、不顺手改**，交给 `course-content`。

### 第 2 步 实施

| 方式 | 做法 | 适用 |
|---|---|---|
| **A 预览（默认）** | 改 `references/beautify.css` → `python3 .trae/skills/course-beautify/references/make_preview.py` | 用户还没确认效果 |
| **B 落源** | 把确认过的 CSS 规则并入 `src/shell.html` 的 `<style>` | 用户确认预览后 |

方式 B 只动 `shell.html` 的 CSS，课程正文与追问数据不变，台账指纹不受影响。

### 第 3 步 验收

1. 截图对比：`node .trae/skills/course-beautify/references/shot.js tmp/preview_course_beautify.html --out tmp/shots-after`
2. 文本指纹：34 课 `textContent` 改前改后逐字一致。
3. 复制一份到 `~/Downloads/<原名>_YYYYMMDD.html` 并给用户链接（2026-11-01 用户规定）。
4. 落源后跑 `python3 scripts/build.py` 与 `node tools/content_verify.js --src`。

## 微调检查表

| # | 检查点 | 合格标准 |
|---|---|---|
| 1 | 字色对比 | 提示、表格描述等辅助文字在背景上清晰可读 |
| 2 | 行高 | 正文约 1.8，计算描述约 1.7 |
| 3 | 段距 | 段落之间有可见间隔，块与块之间不贴死 |
| 4 | 表格留白 | 单元格上下 ≥ 6px，数字不挤 |
| 5 | 克制 | 改前改后并排看，版式和组件形态不变 |

## 参考件

- `references/beautify.css`：微调规则（只含颜色、字号、行高、间距、边框颜色）
- `references/make_preview.py`：把 CSS 注入 `dist_course.html` 的副本，生成预览
- `references/shot.js`：逐卡截图
