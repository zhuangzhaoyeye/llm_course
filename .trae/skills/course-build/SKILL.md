---
name: course-build
description: 构建课程产物 dist_course.html 并校验产物与源一致，处理课程映射表、侧边栏与 shell 模板改动。当用户要求构建、打包、重新生成产物、新增课程入口、改侧边栏或导航时使用。不用于写卡片内容或质量评审。
---

# 课程构建

## 描述

把 `src/` 组装成单文件自包含产物 `dist_course.html`。产物是**给人用的交付物**，源是**给人和 Agent 改的工作面**。

## 使用场景

触发：构建 / 打包 / 重新生成产物、新增课程入口、改侧边栏导航、改共享 CSS 或 JS。

不触发：写卡片内容（`course-content`）、评审（`card-review`）、验证（`course-verify`）。

## 目录契约

```
src/shell.html             除课程正文以外的全部内容（head / style / 骨架 / 侧边栏 / JS）
src/lessons/lesson-<id>.html   每课正文（纯文本 HTML，不含转义）
src/lessons/manifest.json     课程映射表 —— 唯一事实源（2026-10-04 起 id ≡ display ≡ 课号）
scripts/build.py           组装脚本
tools/                     验证脚本
dist_course.html           产物（构建生成，不要手改）
```

## 指令

### 构建

```
python3 scripts/build.py           # 生成产物
python3 scripts/build.py --check   # 只校验产物与源是否一致，不写文件
```

### 铁律

1. **禁止手改 `dist_course.html`**。它是产物，下一次构建会被覆盖，改了等于白改。
2. **新增课程必须同时改四处**，缺一处就会出问题：
   - `src/lessons/lesson-<id>.html`（正文）
   - `src/lessons/manifest.json`（映射表，id 与 display 都要对）
   - `src/shell.html` 侧边栏 `.nav-item`（`data-lesson` + `onclick="switchLesson(id)"`）
   - `src/shell.html` 的 `LESSON_TITLES`、`LESSON_DISPLAY`、`cardTopics` / `allCardTopics`
   另需补 **覆盖地图（docs 侧，非交付物）**：`docs/coverage-maps.md` 加一节（四段齐备）+ `tools/coverage_check.js` 的 `ANCHORS` 登记该课锚点，否则 `coverage_check` FAIL → gate BLOCKED。
3. **id 与课号恒等**（2026-10-04 起统一，历史曾分叉成两套编号，导致取错数据）。`switchLesson(n)` 的 n 就是学员看到的课号，`data-card="<id>-<卡号>"`、`lesson-<id>.html`、`reports/<id>-*.md` 全部同号。改课前先核对 `manifest.json`。
4. **`shell.html` 里的 `/*__LESSONS__*/` 占位符必须恰好出现 1 次**，否则构建直接失败（这是有意的护栏）。
5. 正文里的 `"` 和换行由 `build.py` 自动做 JSON 转义，**不要手写转义**——历史上手工转义导致过页面 JS 崩溃。

### 构建后

必跑 `node tools/content_verify.js`（查产物层）+ `node tools/coverage_check.js`（覆盖地图归档与锚点，gate 第 3 把锁），并按 `.trae/rules/30-dev-rules.md` 判断是否需要跑渲染层验证。

## 排错

| 现象 | 原因 | 处理 |
|---|---|---|
| `占位符必须恰好出现 1 次` | shell.html 被误改 | 恢复为一行 `/*__LESSONS__*/` |
| `缺少课程正文文件` | manifest 引用了不存在的 file | 修 manifest 或补文件 |
| `课程正文为空` | 正文文件被清空 | 补内容，空卡片无法通过验证 |
| 构建后页面白屏 | 正文里有未转义引号或未闭合标签 | 跑 `node tools/content_verify.js --quiet` 定位 |
