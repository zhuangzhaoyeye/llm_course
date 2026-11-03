---
description: "AI 助教（卡片内嵌对话）的角色定位、上下文注入规则、系统提示必含约束、交互与数据规范。改 AI 助教相关代码或 prompt 时必读。"
alwaysApply: true
---

# AI 助教规范

## 一、角色定位

每张卡片内的 AI 助教上下文是**整张卡片的完整教学内容**——它就是这张卡的专属讲解老师。

| 职责 | 具体表现 |
|---|---|
| 不重复讲 | 学生已读完卡片，禁止复述卡片原文 |
| 深入回答 | 基于卡片内容回答学生的追问，往前推一步 |
| 用数字 | 优先具体数字计算例子，不堆砌花哨比喻 |
| 纠误解 | 学生理解偏了要温和但明确地纠正 |
| 不编造 | 涉及未掌握的最新信息，诚实说明，不编造 |

## 二、上下文注入规则

| # | 规则 | 反例 |
|---|------|------|
| 1 | 注入**本卡**完整内容：问题 + 正文 + 计算块 | 把整节课塞给 AI |
| 2 | 注入内容取自 `.card-a` 的 textContent（`getCardContent(cardId)`） | 手写摘要，与卡片正文脱节 |
| 3 | 主题取自 `cardTopics` / `allCardTopics[lesson][card]` | AI 不知道这张卡在讲什么 |
| 4 | 上下文在**首条消息时注入一次**，之后只追加对话 | 每轮重复注入，浪费 token 且污染对话 |
| 5 | 通过 `.qna-ask-btn` 进入的对话，上下文为**该条问答**（q + a） | 传整卡内容给单条问答 |

## 三、系统提示必含三段

系统提示（`getSystemPrompt(cardId)`）必须明确表达：

1. **你是 AI 课程助教**，当前学生正在学习：`{本卡主题}`
2. **以下为本卡完整教学内容，学生已读过，不要重复讲**，而是基于内容深入回答追问：`{卡片正文}`
3. **三条约束**：①优先用具体数字计算例子 ②纠正学生可能的误解 ③不确定的信息诚实说明，不编造

> 修改系统提示文案 → 属 prompt 变更，须遵循项目的 prompt 变更流程；改完必须验证 AI 回复未复述卡片原文。

## 四、交互与数据规范

| 项 | 规范 |
|---|---|
| 入口 | 卡片内 `.tab-bar` 的「AI 助教」tab；单条问答下另有「💡 咨询 AI」按钮 |
| 工具栏 | 复制 / 清空 / 停止 / 重新生成 四个按钮齐备 |
| 快捷键 | Enter 发送、Shift+Enter 换行 |
| 状态 | 对话状态保存在内存对象（按 `chatId` 索引），勾选状态保存在 localStorage |
| chatId 规则 | 卡片内 AI 用 `cardId`；单条问答用 `${cardId}-${index}` |
| 渲染时机 | 首次展开卡片 / 首次切到该 tab 时才渲染问答列表（懒加载） |
| 安全 | 用户输入、提问文本渲染前必须 `escapeHtml`；答案字段 `a` 是**设计上允许的 HTML 片段**，写数据时不得引入未闭合标签或 ASCII 引号 |

## 五、接口配置（2026-09-28 切换；2026-11-03 改为代理）

| 项 | 值 | 为什么 |
|---|---|---|
| 前端端点 | `https://tutor.taleverse.cn`（Cloudflare Worker 绑自有域名，源码 `proxy/`；`workers.dev` 入口保留但前端不用——它在部分国内网络被 DNS 污染） | 前端**不直连 DeepSeek**；代理转发到 `https://api.deepseek.com/anthropic/v1/messages`。**只有 Anthropic 格式支持原生联网搜索**，OpenAI 格式 `tools` 只接受 `function` |
| 模型 | `deepseek-flash` | `deepseek-v4-flash` 是**已退役旧名**，服务端会映射到 `deepseek-flash`（DeepSeek-V4.1-Flash）；直接写新名 |
| 鉴权（2026-11-03 起） | **前端不带任何 key**。DeepSeek key 只存在 Worker 的 secret（`DEEPSEEK_API_KEY`），由代理加到上游请求头 | GitHub Pages 的 JS 对每个访问者可见，仓库与产物中**不得**出现任何密钥；此前的「访问者自填 key、工具栏 🔑 按钮」方案已删除 |
| `system` | 顶层参数，**不在 messages 里** | Anthropic 协议不接受 `role:'system'` 的消息；调用前从 history 抽出 |
| `thinking` | `{ type: 'disabled' }`（**代理写死**，客户端传什么都被忽略） | 默认开启思考，reasoning 会吃光 `max_tokens` 导致 `content` 返回空 → 学员看到空白 |
| `max_tokens` | 2048（代理环境变量 `MAX_TOKENS`，写死在服务端） | 控制单次费用。2026-11-03 由 1024 提到 2048：实测让助教分 4 节详细讲，两次都因 `stop_reason: max_tokens` 在约 1800 字处被截断 |
| `tools` | 由**代理注入** `[{ type: 'web_search_20250305', name: 'web_search', max_uses: 2 }]`；客户端传的 `tools` 一律丢弃；环境变量 `WEB_SEARCH`：**2026-11-03 起线上为 `false`（关闭）**，开启时才注入 | 合法类型只有 `web_search_20250305` / `web_search_20260209`。搜索按成功次数计费（官方价 5 元/千次），`max_uses` 控制单次上限 |
| CORS / 来源 | 代理只放行 `ALLOWED_ORIGINS` 里的来源（默认 `https://zhuangzhaoyeye.github.io`） | Origin 可被伪造，只能挡普通滥用；真正的保护是下面的限额 |
| 限额 | 全站每天 100、每 IP 每天 20、每 IP 每分钟 5；UTC 零点（北京时间 8 点）重置 | 由 Durable Object 原子计数。DeepSeek 官方只限账号并发（flash 2500，与 key 无关），所以**新建专用 key 不能单独限流**，限额靠代理 |
| 响应取值 | 前端只取 `content` 里**最后一个** `type:text` 块 | 联网时 content 形如 `[text开场白, server_tool_use, web_search_tool_result, text正式回答]`，全拼会把「我先联网核实一下」混进答案 |

**联网搜索是模型自主决定的**，不是每次都触发——同一问题要求"必须联网核实"时会搜，不要求时可能 0 次搜索。因此系统提示里必须写清分支（涉及事实/数字才搜，纯概念推导不搜），落在 `# SKILLS` 的 `web-verify` 与 `# CONSTRAINTS` 的"不编造"两条上，见下节。

> ✅ **prompt 已按 8 段标准改造（2026-09-28）**：`getSystemPrompt` 现为「必选 8 段 + 首尾铁律对」结构。

## 六、系统提示结构（必选 8 段 + 首尾铁律对）

```
# IRON-RULE            ← 首因位：唯一一条最高优先级红线
# ROLE                 ← 单卡专属助教，只教这一张卡
# CONTEXT              ← 当前卡片主题 + 卡片完整正文
# SKILLS               ← number-walkthrough / misconception-correction / web-verify
# TASK                 ← 基于卡片内容把回答往前推一步
# CONSTRAINTS          ← 不重复原文、不堆砌比喻、不编造、超范围要声明、不学术腔
# OUTPUT               ← 分段/小标题/公式/表格/来源链接
# EXAMPLES             ← 3 对（含"超范围""需核实"两个边界 case）
# SELF-CHECK           ← 6 条交付前自检
# IRON-RULE-RESTATE    ← 近因位：同一铁律同义复述
```

**唯一铁律**（首尾同义）：*绝不重复学生已经读过的卡片原文；每个回答都必须用具体数字或计算例子往前推一步。*

设计依据：注意力在长上下文首尾最强、中间最弱（U 型曲线），所以"绝对不能丢"的红线首尾双置；其余红线一律下沉 `# CONSTRAINTS`。

**分支完整性**（`prompt变更` skill 的硬要求）：写"禁止/必须"时必须给出合法分支，否则误伤。本 prompt 的两处分支：
- 涉及事实/数字/版本 → 必须联网核实；纯概念推导 → 直接回答不必搜
- 超出卡片范围 → 先声明"这超出本张卡片的范围"，再给最小必要解释（而不是硬答或拒答）

**改动 prompt 前必须走 `prompt变更` skill**（`~/.trae-cn/skills/prompt变更/`），保持标签与顺序不动、只改该动的段。

**验收记录（2026-09-28）**：段序正确 ✅ ｜ 铁律对首尾同义 100% ✅ ｜ 旧 prompt 的 12 个语义点无丢失 ✅ ｜ 分支完整 ✅ ｜ 端到端冒烟：复述率 1.0%、超范围分支实际触发、概念题正确未触发搜索 ✅
