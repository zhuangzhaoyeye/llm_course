# LLM Course 项目指令

本文件是程小帮及其他兼容工具的项目规则入口。项目原有 Harness 仍以 `.trae/rules/` 为源，不复制或重写课程质量标准。

## 每轮规则加载

每轮开展本项目任务前，完整读取以下 `alwaysApply: true` 规则，再匹配技能并执行任务；不能把下面的文件名索引当作已经读过正文：

1. `.trae/rules/00-preflight.md`：开工门禁、每轮联网搜索、技能路由、输出契约及收尾闸门。
2. `.trae/rules/project_rules.md`：项目总纲、Agent 工作循环、全局铁律。
3. `.trae/rules/10-course-design.md`：课程设计与因果链。
4. `.trae/rules/15-naming.md`：名词与 DOM 标识对齐。
5. `.trae/rules/20-content-rules.md`：内容质量与逐条核验标准。
6. `.trae/rules/30-dev-rules.md`：工程约束、验证触发条件与规则卫生。
7. `.trae/rules/40-ai-tutor.md`：AI 助教约束。

给课程添加或修改分步动画时，另读 `.trae/rules/50-animation-spec.md`。前置检查与输出位置有重复描述时，以 `00-preflight.md` 的明确要求为准。

程小帮不依赖 `.trae/rules` 的 `alwaysApply` 字段自动加载，以上显式读取是本项目的规则加载步骤。缺少规则文件或技能时，说明缺口，不凭记忆臆造规则或静默跳过。

## 技能发现与工作循环

- 程小帮项目技能入口 `.chengxiaobang/skills/` 是指向 `.trae/skills/` 的相对符号链接；所有技能正文、references、scripts、assets 及登记表共用源文件，已有 `.trae/skills/...` 脚本命令继续有效。
- 对本轮任务匹配技能描述，命中即先调用对应 skill；只对命中的技能加载正文与所需参考文件。`preflight-search` 按原规则每轮执行，不用全局按需搜索技能代替。
- 课程内容：`course-content` → `card-review` → 按原规则执行验证与独立盲审；构建走 `course-build`，交付验证走 `course-verify`。
- 发布一课到三平台走 `course-publish`；单平台走 `juejin-publish` / `csdn-publish` / `zhihu-publish`，保持只存草稿和回读校验的边界。课程统计走 `stats-report`，热点候选走 `hotspot-radar`，交接走 `session-handoff`。
- 项目级同名技能优先于全局技能，规则和技能只作用于本项目，不安装到全局污染其他项目。
- 改动规则、技能或本兼容入口后，按 `30-dev-rules.md` 第八节检查规则卫生，并调用程小帮扩展 check 检查项目技能 active / modelActive 与 diagnostics；不要把文件存在等同于技能可用。

内容、脚本、草稿登记表和质量门禁保持原有唯一事实源；迁移或技能注册本身不代表课程内容验证、联网核验、外部服务连接或定时任务已执行。
