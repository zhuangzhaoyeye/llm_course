---
description: "项目总纲（每轮对话必读）：项目定位、技术架构、Agent 工作循环 Harness、全局铁律。只记「做什么 / 为什么」，不记「怎么做」。"
alwaysApply: true
---

# 项目总纲

> 规则文件索引：`00-preflight.md`（**强制前置检查**）· `project_rules.md`（总纲 / Harness）· `10-course-design.md`（课程设计理念）· `15-naming.md`（**名词对齐表**：口语说法 ↔ HTML 类名）· `20-content-rules.md`（内容铁律 / 卡片质量清单 / 三大验证维度）· `30-dev-rules.md`（开发工程 / 验证 / 防御）· `40-ai-tutor.md`（AI 助教规范）
>
> 技能索引（按需加载，路由表见第三节）：`.trae/skills/preflight-search`（每轮必调）· `.trae/skills/course-content` · `.trae/skills/card-review` · `.trae/skills/course-build` · `.trae/skills/course-verify` · `.trae/skills/juejin-publish` · `.trae/skills/csdn-publish` · `.trae/skills/session-handoff`

# 第一铁律（覆盖其余一切细则）

> **逐条核验 = 交付的前置条件。** 任何内容改动（含补 1 条追问、改 1 句话）都会让该课台账**立即过期**，
> 必须当轮重新逐条核验：**逐条联网核验事实、python 复算算术、不抽样、不省 token、不省联网次数、不降级**。
> 机械锁：`node tools/provenance_check.js` + `node tools/review_check.js --all` **必须全绿**；
> 未全绿时**禁止进入下一任务、禁止声称完成**。详见 `00-preflight.md` 的 IRON-RULE。

## 一、项目定位

为**算法工程师**构建学习**大模型**的高质量、可交互课程工具，主线为大模型全链路：架构 → Tokenization → 训练范式 → 对齐 → 应用。

**要解决的真问题**：痛点不是信息不够——教程遍地、ArXiv 每天 50 篇。痛点是**记住了但推不出来**。目标是**认知效率**：不是"学得多"，是"学完就能用"。

> 唯一判据：学完 Self-Attention，能不能在白板上拿一句话、几个向量**从头手算一遍**？能不能告诉同事"如果没有 Q/K/V 你会用什么替代、效果差在哪"？

### 三条底色（不可动摇）

| # | 底色 | 含义 | 反例 |
|---|------|------|------|
| 1 | **深入简出** | 入口极简（一句话问题 + 最小数字例子），底盘极深（每个结论能一路推到工程细节）。简是入口，深是底线 | 一上来讲"设 d=128、频率=10000" |
| 2 | **第一性原理** | 不从"业界怎么做"讲起，从"为什么必须这样"讲起；每个设计还原到它要解决的原始矛盾，**禁止把结论当公理** | "除以 √d_k 可以稳定训练"（只给结论不给后果） |
| 3 | **因果链替代知识树** | 分类是专家回顾时的视角，不是学习路径。先让问题出现，再让解法被逼出来 | "今天我们来学 Self-Attention，它是 RNN 的优化" |

> 底色的来源与完整论证见 `10-course-design.md`；与国际教学法的对应关系（First Principles Thinking → 计算走查 等）同样在该文件。

## 二、技术形态

| 项 | 值 |
|---|---|
| 交付物 | 单文件**自包含** HTML（`dist_course.html`），拿到即用 |
| 渲染 | 原生 HTML / CSS / JS，无前端框架 |
| 公式 | KaTeX（CDN 引入 + auto-render） |
| 状态 | localStorage 保存卡片勾选（`card_checks`）与问答勾选（`qna_checks`） |
| AI 助教 | 每张卡片内嵌对话，前端直连 LLM API |
| 课程组织 | 侧边栏 = 「部分」→ 课 → 卡片；一课包含若干张 `.card` |
| 卡片结构 | `.card[data-card]` = 问题区 `.card-q` + 内容区 `.card-a` + 问答区（tab + AI + 追问） |

**源工程与产物的分工（改代码前必须清楚）**：

```
src/shell.html               除课程正文外的全部内容（head / style / 骨架 / 侧边栏 / JS）
src/lessons/lesson-<id>.html 每课正文（纯文本 HTML）
src/lessons/manifest.json    课程映射表 —— 唯一事实源（2026-10-04 起 **id ≡ display ≡ 学员看到的课号**）
scripts/build.py             组装脚本
tools/content_verify.js      内容层验证（零依赖）
tools/verify.js              渲染层验证（Playwright）
dist_course.html             产物：构建生成，禁止手改
```

> `dist_course.html` 是产物。手工修改会被下一次构建覆盖，且会绕过全部验证。

**HTML 交付双份（2026-11-01 用户规定，长期有效）**：任何生成的 HTML（`dist_course.html`、美化预览、报告等），除工作区路径外，**必须再复制一份到 `~/Downloads/`**，文件名带日期（`<原名>_YYYYMMDD.html`，重名追加 `_2`、`_3`），并在回复中给出该文件链接。工作区文件仍是唯一事实源，Downloads 副本只用于本地双击打开。

**每次课程更新后必须重发最新版（2026-11-01 用户追加，长期有效）**：凡改动了 `src/` 下的课程内容或 shell 并重新构建，收尾时必须 ① 先跑 `python3 scripts/build.py --check` 确认 `dist_course.html` 与源一致；② 把最新 `dist_course.html` 复制到 `~/Downloads/`（命名同上）；③ 在回复里**明确告诉用户**：文件链接、本次更新了什么、与上一份 Downloads 副本的区别。复制前不得跳过 ①，避免把过期产物当最新版发出。

当前进度：**第一部分「认知衔接」5 课 30 张卡片已完成**（Transformer 回顾 / 模型结构全景 / 七大改造 / Tokenization / 逐层解剖），已知有未清项（见 `30-dev-rules.md` 门禁结果）；第二部分「训练范式」待开发。

## 三、Agent 工作循环（Harness）

### 第 0 步 先做前置检查（每轮必做，详见 `00-preflight.md`）

**① 联网搜索（必做，无条件）** → 读 `.trae/skills/preflight-search/SKILL.md`，先提炼本轮核心目的再构造 query；即使判断"没必要"也要搜兜底 query。

**② Skill 路由** → 逐个读 `.trae/skills/*/SKILL.md` 的 `description` 做语义匹配。**`preflight-search` 无条件命中**（每轮都读其正文并执行）；其余 skill 命中才读正文（省 token，注意：省的是"读正文"，不是"是否调用"）。命中不调 = 违规。

| 触发信号 | 调用 skill |
|---|---|
| 任意一轮对话（无条件） | `preflight-search` |
| 新增课程、写卡片、改正文、补追问、加计算走查 | `course-content` |
| **用户说「检查」「自检」「质检」「体检」「评审」**、判断卡片是否达标 | `card-review` |
| 构建、打包、重新生成产物、改侧边栏或课程映射表 | `course-build` |
| 跑验证脚本、交付前把关、刚修完一个缺陷 | `course-verify` |
| 把文章发到**掘金** / 存或更新掘金草稿 | `juejin-publish` |
| 把文章发到 **CSDN** / 存或更新 CSDN 草稿 | `csdn-publish` |
| 用户说「交接」「开新窗口」「新开对话」「保存上下文」「handoff」等 | `session-handoff` |

**串联与逐条铁律**：生成（`course-content`）完成后**必须串联质检（`card-review`）**；两者都必须**逐条过**「每张主问题 + 该主问题下挂的每一条追问」，一条不漏、不抽样、不省 token，且**每条逐条联网核验**，产出 `reports/<id>-逐条核验.md`，由 `tools/review_check.js` 校验覆盖度——报告缺失或覆盖不全 = 等于没做。

**③ 输出契约** → 每轮回复**开头**附 `[联网自检]` 与 `[来源]`（格式见 `00-preflight.md`；2026-09-28 起由"末尾"改为"开头"），自检必须诚实。正文之后不再重复。

没命中任务类 skill 时按下面的通用循环走，**不得臆造流程**。

### 通用循环（不可跳步）

1. **判定任务类型**：内容创作 / 结构开发 / 纯讨论。纯讨论不跑验证。
2. **内容任务先查证**：涉及「某篇论文 / 某模型做了什么」→ 先 WebSearch 再动笔，禁止凭记忆。
3. **先设计后实现**：新增或修改卡片，先对齐《课程设计理念》与《卡片质量清单》，再写 HTML。
4. **改完必验证**：动了 `src/` 下任何内容 → 构建 + 跑验证，达标才交付。
5. **修完必防御**：修掉一个问题 → 追问「下次怎么自动拦住它？」能自动化的立刻写进验证脚本。
6. **亮点必记录**：出现方法论进步 → 先与用户确认，再追加到迭代日志（格式见下）。
7. **改完规则必做卫生检查**：动了 `.trae/rules/**` 或 `.trae/skills/**` → 跑 `30-dev-rules.md` 第八节「规则卫生」5 条清单；**harness 也要减肥，增删改一律由读数驱动**。

## 四、全局铁律

| # | 铁律 | 反例 |
|---|------|------|
| 1 | 用**具体数字计算例子**解释，不讲抽象概念 | 「梯度消失就是梯度变小了」 |
| 2 | 每张卡片**以问题开头**，不预设结论 | 「Causal Mask 导致了分道扬镳，它们各自怎么选？」 |
| 3 | 涉及论文 / 事实，**WebSearch 验证**后再写 | Sinusoidal 说成「标签表」 |
| 4 | HTML 变更后**必须跑验证脚本**且达标才能交付 | 改完说「应该没问题」 |
| 5 | 修完问题**必须追问怎么自动拦住它**，可自动化的一律落脚本 | 同一个 Bug 修两次 |
| 6 | 新课堂必须与其他课堂**结构一致**（必备模块不遗漏） | 第 5 课少了问答面板 |
| 7 | 只做被要求的事，不过度工程化、不做无关重构 | 顺手「优化」别的卡片 |
| 8 | **每轮对话先联网搜索再作答**，结尾附「联网自检 + 来源」（见 `00-preflight.md`） | 跳过搜索，凭预训练记忆直接下结论 |
| 9 | 采纳来源前确认**来源真的包含**该论断，不把「引用」当「支持」 | 引一篇主题相近的博客就当依据 |
| 10 | 无 A/B 级来源的数字、论文归属、版本、政策结论，必须标「需人工核实」 | 把搜索结果里的经验数字当成已证实事实 |
| 11 | **生成内容后必须串联质检**，生成者不得用自己标准验收自己的产出 | 写完卡片直接说"完成了" |
| 12 | 生成与质检都**逐条过「主问题 + 每条下挂追问」**，不抽样、不省 token，逐条联网核验 | 抽几张看看就说"整体没问题" |
| 13 | **harness 也要减肥**：规则/skill 的增删改必须由「规则卫生」清单的读数驱动；**误报的诊断项应下线，而不是留着** | 一味往 rules 里加条目、从不删；硬门禁套软标准 |
| **14** | **逐条核验不可跳过**（第一铁律）：改动内容 → 当轮逐条过「主问题 + 每条追问」，逐条联网核验，不抽样、不省 token/联网次数 | "先做别的回头再补"；只抽几张看看就说过关了 |
| **15** | **内容改过 ≠ 台账还有效**：内容任何改动都使该课台账过期，必须重核验并 `--stamp`；未全绿禁止进入下一任务 | 补完追问直接宣布"第 2 课 FAIL 0" |
| **16** | **任何内容都必须逐条联网核验**（含算术、推导、语义）——即使很有把握；台账每行须留联网证据（http 或 `query=`），由 `review_check.js` H1f 强制 | 「这个我确定，不用搜」；只给事实类联网 |
| **17** | **交付标准 = 0 FAIL 且 0 WARN**（IRON-RULE-0，2026-09-29 用户要求，永久生效）：`gate.js` 必须 `GATE = OPEN`，且 `provenance_check` / `review_check --all` / `content_verify --src` 三条**全部 FAIL 0 且 WARN 0**，`build.py --check` PASS。WARN 必须当轮处置（改内容或改误报检查器），**禁止"记录在案、下轮再说"**；任一 WARN 未清时**不得声称"已完成"** | 说"FAIL 清零了"但留着 8 条 WARN；把 FAIL 降级成 WARN 来"清零" |
| **18** | **对外发帖只存草稿，不替用户点"发布"**（掘金 / CSDN 走 `juejin-publish` / `csdn-publish`）：登录态只放独立配置目录，**禁止读取用户日常浏览器的 cookie、禁止把凭证写进文件或回复**；存完必须**回读服务器上的草稿**校验，不凭"点了保存"报成功；**每次新建或更新草稿后，回复里必须给出可点击的草稿链接**（掘金 `https://juejin.cn/editor/drafts/<ID>`、CSDN `https://editor.csdn.net/md?articleId=<ID>`），拿不到 ID 就明说，不得省略；正式发布需用户明确同意 | 替用户点发布；把 cookie 贴进对话；只看"保存成功"提示就报成功 |
| **19** | **凡需要用户在网页上亲自操作的事，必须同时做到两点**（2026-11-02 用户要求，长期有效）：① **能代填的一律先填好**——能用链接参数预填就给预填链接（如 GitHub 新建 issue 的 `?title=…&body=…`），能用 MCP / 脚本写入的先写入，用户只剩点按钮；② **回复里必须给出该操作的可点击网址**，并写清点哪里、做什么。新出现的网页操作地址登记到本文件第六节 | 只说"去设置里上传"却不给网址；表单能预填却让用户自己复制粘贴 |

## 五、迭代日志格式

路径：`技术分享/05-迭代日志.md`，**最新记录追加在顶部**，单条 8–15 行。

```markdown
## [日期] 标题
**类型**：新方法 / Bug修复 / 工具引入 / 规则升级
**触发**：什么事件触发了这个改进
**做法**：具体做了什么
**效果**：可量化的结果
**启示**：对未来的指导意义
```

触发条件（满足任一即记录，但**必须先与用户确认**）：新增自动化检查项 / 验证分数任一维度提升 >5% / 修复系统性 Bug / 规则文件升级 / 引入新工具链 / 内容质量方法论有可总结进步 / 克服了阻碍多轮的难题。

## 六、需要用户网页操作的地址登记

规则见第四节第 19 条：**每次需要你操作时，回复里都要附网址，并尽量先代填**。已核实可用的地址：

| 场景 | 网址 | 我先做的 / 你要做的 |
|---|---|---|
| 上传仓库社交预览图 | https://github.com/zhuangzhaoyeye/llm_course/settings | 图已备好 `assets/social-preview.png`；你在 Settings → Social preview → Edit → Upload an image 上传（GitHub 无 API） |
| 向 GitHubDaily 提交自荐 | https://github.com/GitHubDaily/GitHubDaily/issues/new | 我生成带 `title`、`body` 参数的预填链接；你登录后点 Submit new issue |
| 看掘金草稿箱 | https://juejin.cn/creator/content/article/draft | 页面默认停在"文章"标签，看"草稿箱(N)" |
| 看 CSDN 草稿箱 | https://mp.csdn.net/mp_blog/manage/article | 顶部有"已发布(N) / 草稿箱(N)"计数 |
| 草稿本身 | 掘金 `https://juejin.cn/editor/drafts/<ID>`；CSDN `https://editor.csdn.net/md?articleId=<ID>` | 每次更新草稿后都发（第 18 条） |
| 开启 GitHub Discussions | https://github.com/zhuangzhaoyeye/llm_course/settings | 本机无 `gh`、无 token，无法代开。你在 Settings → General → Features 勾选 **Discussions**，再点 Set up discussions 发一条欢迎帖。开启前 `/discussions` 返回 404（2026-11-05 实测），站点页脚和 README 里的讨论区链接此时是死链 |
| 创建 D1 统计库并部署 Worker | 无网页入口，命令行：`cd proxy && npx wrangler d1 create llm-course-stats` | 见 `proxy/wrangler.toml` 的 D1 注释；统计上线前线上收不到数据 |

没有核实过的地址（Google Search Console、百度站长平台、V2EX 发帖页等）不写进表里，首次用到并核实后再登记。

