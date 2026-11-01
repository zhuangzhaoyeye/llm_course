---
name: course-verify
description: 执行课程质量门禁并在修完缺陷后补自动化拦截，形成 Bug 到 Check 的闭环。当用户要求验证、跑检查、交付前把关，或刚修完一个缺陷需要防止复发时使用。不用于首次写内容或纯讨论。
---

# 课程验证与缺陷防御

## 描述

两条验证命令 + 一套"修完必须追问怎么自动拦住"的闭环。核心理念：**Agent 反复犯同一个错，答案不是改 prompt，而是加一条让它无法再犯的检查**。

## 使用场景

触发：验证 / 跑检查 / 交付前把关 / 刚修完一个问题。

不触发：写卡片内容（`course-content`）、构建（`course-build`）。

## 指令

### 第 1 步 跑两条命令，分工不同

```
node tools/content_verify.js     # 内容层「写得对不对」：零依赖，静态解析
node tools/coverage_check.js     # 覆盖地图归档层「设计有没有丢」：零依赖，gate 第 3 把锁
node tools/verify.js             # 渲染层「渲染对不对」：Playwright，需先装依赖
```

`verify.js` 首次使用需装依赖（只需一次）：

```
npm install && npx playwright install chromium
```

渲染层未安装时**明确声明"未跑渲染层验证"**，不要假装全绿。

### 第 2 步 判断该跑哪条

| 变更类型 | 动作 |
|---|---|
| 改了 `src/lessons/*.html` 或 `src/shell.html` 的问答数据 | 构建 → `content_verify.js` → `verify.js` |
| 改了 CSS / 侧边栏 / 交互 JS | 构建 → `verify.js` |
| 改了 `src/lessons/manifest.json` | `python3 scripts/build.py --check` + `content_verify.js` |
| 改了 `docs/coverage-maps.md`、或新增一门课 | `node tools/coverage_check.js`（归档齐备 / 四段齐备 / 锚点落地 / 学生页面无残留） |
| 只改 `tools/*.js` 或 `scripts/build.py` | 跑该脚本自身验证自洽性 |
| 纯 `.md` 变更、纯讨论 | 不跑 |

### 第 3 步 交付线（IRON-RULE-0 · 2026-09-29 用户要求 · 永久生效）

- 任一层出现 **FAIL → 禁止交付**（脚本退出码 1）
- **任一层出现 WARN → 同样禁止交付**：WARN 必须当轮处置（改内容消除，或改误报检查器并附负向自测），**不允许"接受并说明理由"后放行**
- 交付必须同时满足：
  ```
  node tools/gate.js                   → GATE = OPEN
  node tools/provenance_check.js       → FAIL 0 / WARN 0
  node tools/review_check.js --all     → FAIL 0 / WARN 0
  node tools/content_verify.js --src   → FAIL 0 / WARN 0（内容分 100）
  node tools/coverage_check.js         → FAIL 0 / WARN 0（覆盖地图归档 / 锚点 / 无残留）
  python3 scripts/build.py --check     → PASS
  ```
- 任一 WARN 未清时**不得声称"已完成 / 已交付"**，只能说"未完成，剩余 N 条 WARN"

### 第 4 步 缺陷防御闭环（修完必做）

```
发现问题 → 修复 → 追问：这个错误下次能自动拦住吗？
                   ├─ 能 → 立刻加进 content_verify.js / verify.js
                   └─ 不能 → 在 30-dev-rules.md 记一条，明确标注"需人工"
```

必须触发本流程的事件：UI / DOM 结构 bug、内容缺失、用户指出"和其他课堂不一致"、用户要求做一项改进、脚本报出新类别问题。

### 已积累的防御记录

| 问题 | 根因 | 拦截 |
|---|---|---|
| Card 与 footer 合并成一张卡片 | 漏写 `</div>` | 内容层 div 配对 + 渲染层 `.card .footer-nav` |
| 新课堂忘加问答面板 | 没照模板创建 | 内容层 7 大组件 + 渲染层 tab-bar/qna-list |
| QnA 引号破坏 JS 语法 | 中文用 ASCII `"` 包裹 | 内容层"QnA 数据可解析（花括号配平）" |
| 验证脚本误报"最后一卡 footer 被吞" | 用"下一卡位置"当切分边界，最后一卡切到文件尾 | 改为按 div 配平切分（`sliceBalancedDiv`）——**修脚本本身也要按本流程补测试思路** |
| QnA 贴错卡片 | 卡片 id 与 tab/qna 绑定不一致 | 内容层"id 与 tab-qna/qna-list 绑定一致" |

## 记分口径（须知晓的历史不一致）

规则文档里写的是「满分 126 / DOM 31pt」，但按各检查项实际权重相加是 **18 + 82 + 36 = 136**。脚本以**实际权重和 136** 为准并把总分归一化到 100 分制。改权重时只改脚本里的 `weight`，不要同时维护两套数字。

## 铁律

1. 数字正确性**工具无法自证**，必须人工金标；工具只能说"格式合规"。
2. 验证失败先分辨是**代码 bug** 还是**检测逻辑过时**，不许直接放宽检查条件蒙混。
3. 有成本的验证只在必要时跑（见第 2 步），但"不确定影响面"时宁可多跑。

## 参考

- 完整评分维度与防御案例：`.trae/rules/30-dev-rules.md`
