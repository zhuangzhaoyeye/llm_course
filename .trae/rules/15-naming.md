---
name: 15-naming
description: "【名词对齐表】用户口语说法 ↔ HTML 类名/数据标识的唯一对照。AI 与人沟通课程内容前必读——确保双方说的是同一个东西，禁止用近义词指代不同结构。"
alwaysApply: true
---

# 名词对齐表（唯一口径）

## 为什么有这份文件

课程结构里有多个层级都长得像"卡片"、都有"问题"。若人与 AI 各用一套词（"主卡片""追问卡片""那张小卡片"），会出现**说了半天其实在说不同东西**的情况。

**规则**：涉及课程结构的沟通，一律使用下表的「标准名」。听到左侧口语说法时，按下表映射到唯一的代码标识，**不得自行解释**。

## 一、一句话速查（最高频的 6 个）

| 你说的 | 标准名 | 代码标识 | 一课内数量（第 1 课） |
|---|---|---|---|
| 主卡片 / 大卡片 / 卡片 | **主卡片** | `.card[data-card]` | 6 |
| 主问题 / 卡片问题 / 标题问题 | **主问题** | `.card-q-text` | 6（每卡 1 条） |
| 追问卡片 / 小卡片 / 下面的问题 | **追问卡片** | `.qna-item` | 30（每卡 5 条） |
| 追问的问题 | **追问问句** | `.qna-item-q .q-text` | 30 |
| 追问的答案 | **追问答案** | `.qna-item-a` | 30 |
| 提示 / 小提示 | **提示** | `.card-q-hint` | 6 |

> ⚠️ 最高危的两个混淆：
> 1. **「主卡片」≠「主问题」**——前者是整张卡（`div.card`），后者是卡里的那行问句（`.card-q-text`）。
> 2. **「追问卡片」≠「主卡片」**——追问卡片是 `.qna-item`，它是主卡片**内部**的一个子项，两者不是同级。

## 二、完整层级对照

### 课程级（一课的容器）

| 标准名 | 代码标识 | 说明 |
|---|---|---|
| 课程 / 一课 | `lesson-<id>.html` + `manifest.json` 的 `lessons[]` | **id ≡ 学员看到的课号**（2026-10-04 起统一；manifest 仍是唯一事实源） |
| 侧边栏 | `.sidebar` | 左侧导航容器 |
| 侧边栏分组 | `.sidebar` 内的分组标题 | 「第一部分 / 第二部分」 |
| 侧边栏导航项 | `.nav-item[data-lesson]` | 点击即 `switchLesson(id)`；高亮态 `.nav-item.active` |
| 顶部栏 | `.header` / `#headerTitle` / `.lesson-badge` / `.progress-bar` / `.progress-fill` | 标题 + 进度 |
| 课程头部 | `.lesson-intro` | 标题 + `.subtitle` + `.lesson-goal` + `.roadmap` + `.meta-tags` |
| 学习目标 | `.lesson-goal` / `.goal-label` / `.goal-text` | |
| **推理链** | `.roadmap` / `.roadmap-flow` / `.roadmap-node` / `.rn-num` / `.rn-text` / `.roadmap-arrow` | 课前那 6 步逻辑递进图 |
| 知识点标签 | `.meta-tag` | |
| 课程页脚导航 | `.footer-nav` | 上一课/下一课；**绝不能在 `.card` 内部** |

### 主卡片级（`.card`）

| 标准名 | 代码标识 | 说明 |
|---|---|---|
| **主卡片** | `div.card[data-card="<cardId>"]` | 一整张卡；`.card.active` = 已展开 |
| 问题区（卡片头） | `.card-q` | 点击 `toggleCard(this)` 展开 |
| 卡片序号 | `.card-num` | 左上角数字 |
| 问题容器 | `.card-q-content` | |
| **主问题** | `.card-q-text` | 每卡 1 条 |
| **提示** | `.card-q-hint` | 给方向不给答案 |
| 展开箭头 | `.card-arrow` | |
| 已学完勾选 | `.card-check` | 存 `card_checks` |
| 内容区 | `.card-a` | 展开后才可见 |
| 知识背景 | `.card-bg` / `.bg-label` | 提出者 + 年份 + 痛点 |
| 正文段 | `.content-section` | |
| **计算走查** | `.calc-block` | 内部：`.step` / `.step-title` / `.step-desc` / `<table>` / `.math` |
| 冲突展示 | `.highlight-box`（`.label`） | 有 X→A，没有 X→B |
| 类比块 | `.analogy-block`（`.label`） | |
| 对比表 | `.compare-table`（`.winner`） | |

### 问答区（每张主卡片内部的 tab）

| 标准名 | 代码标识 | 说明 |
|---|---|---|
| 标签条 | `.tab-bar` / `.tab-btn` | 两个 tab，文案固定为 `💡 自定义问答` / `🤔 你可能还想问` |
| **AI 助教面板** | `#tab-ai-<cardId>`，class `.llm-section` / `.llm-chat` / `.chat-messages` / `.chat-input-row` | 「点我开始对话」按钮 = `.llm-btn` |
| **追问面板** | `#tab-qna-<cardId>`，class `.qna-section` / `.qna-header` / `.qna-title` / `.qna-refresh-btn` | 「换一批」= `.qna-refresh-btn` |
| **追问列表** | `.qna-list[data-qna="<cardId>"]` | 容器，**不是**单条 |
| **追问卡片** | `.qna-item` | 单条追问（= 问句 + 答案） |
| 追问问句 | `.qna-item-q` / `.q-num` / `.q-text` / `.q-check` / `.q-arrow` | 点击展开答案 |
| 追问答案 | `.qna-item-a` | **答案为设计上允许的 HTML 片段**，可用 `.step` / `.step-title` / `.calc-block` / `<table>` |
| 单条「咨询 AI」按钮 | `.qna-ask-btn` | 上下文 = 该条问答（q+a） |
| 单条内联对话 | `.qna-inline-chat` / `.qna-chat-msgs` | |

### 数据标识（JS 侧）

| 标准名 | 代码标识 | 说明 |
|---|---|---|
| 追问数据 | `allHardcodedQnA[lessonId][cardId]` → `[{q, a}, …]` | 写在 `src/shell.html` |
| 追问数据（旧） | `qnaData` | |
| 主卡片主题 | `cardTopics` / `allCardTopics[lessonId][cardId]` | 注入 AI 上下文用 |
| 课程标题表 | `LESSON_TITLES` | |
| 课号映射 | `LESSON_DISPLAY` | 以 `manifest.json` 为准 |
| 卡片勾选 | `localStorage.card_checks` | |
| 追问勾选 | `localStorage.qna_checks` | |

## 三、id 命名约定（注意：现状不统一）

| 课 | cardId 形态 | 例 |
|---|---|---|
| 第 1 课（id=1） | **纯数字** | `data-card="3"`、`switchTab(this,'ai',3)` |
| 第 2~5 课 | **字符串 `课id-卡号`** | `data-card="4-3"`、`switchTab(this,'ai','3-3')` |

> 这是**历史遗留的不一致**（能用是因为 JS 会自动转字符串）。改课或新增课一律沿用**所在课的既有形态**，不要在同一课里混用；新写的代码判定 id 时按字符串处理即可。

## 四、数量口径（说"几天/几条"时必须带单位）

| 说法 | 含义 | 第一部分现状 |
|---|---|---|
| "6 张卡" | 6 张**主卡片** | 每课 6 张 |
| "36 条" | 6 主问题 + 30 追问 | 第 1 课 |
| "175 条" | 30 主问题 + 145 追问 | 全部 5 课 |
| "逐条过" | **主问题 + 每条追问**，即 175 条 | 见 `30-dev-rules.md` |

> 说"逐条核验"时，**必须说明是「主问题」还是「主问题 + 追问」**——这是本项目最容易产生歧义的地方。
