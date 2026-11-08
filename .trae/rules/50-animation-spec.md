# 分步动画生产规范（课程可视化层）

> 用途：给某课 calc-block（计算走查）补「交互式分步动画」（Canvas，可播放 / 上一步 / 下一步）。
> 定位：动画是**新增交互组件**，是计算走查的「可视化呈现」——**绝不改卡片正文 / 表格 / 追问的数字与文字**。数字必须与 calc-block 严格一致。与 `10-course-design.md`（因果链）、`20-content-rules.md`（计算走查）并列。

## 一、每课一个动画
- 每课挑 1 张「calc-block 计算走查最有分步感」的卡片（数字有清晰逐级变换，如衰减 / softmax / 参数账 / 归一化），给它配一个动画。
- 动画步骤数 3~5 个 step，一一对应 calc-block 的关键步骤。

## 二、两个产出（禁止碰 shell.html）
1. `src/lessons/lesson-N.html`：在选中 calc-block 的闭合 `</div>` **之后**插入 `.anim-panel` 容器（highlight-box / tab-bar 之前）。
2. `tmp/anim/lesson-N.js`：`if(!ANIM_STEPS[N]) ANIM_STEPS[N] = [ ... ];` —— 主 agent 统一合并进 shell.html。

## 三、anim-panel HTML 模板（id 原样，不要改）
```html
      <!-- 交互式分步动画：<主题>（可播放） -->
      <div class="anim-panel" id="animPanel">
        <div class="anim-head">
          <div class="anim-title">🎬 分步动画 · <主题></div>
          <div class="anim-controls">
            <button class="anim-btn" id="animPrev" title="回退到上一步">⏮ 上一步</button>
            <button class="anim-btn primary" id="animPlay" title="播放/暂停">▶ 播放</button>
            <button class="anim-btn" id="animNext" title="推进到下一步">下一步 ⏭</button>
          </div>
        </div>
        <div class="anim-stepbar" id="animStepbar"></div>
        <div class="anim-stage"><canvas id="animCanvas"></canvas></div>
        <div class="anim-caption" id="animCaption"></div>
      </div>
```
- id 固定：`animPanel / animPrev / animPlay / animNext / animStepbar / animCanvas / animCaption`（引擎靠这些 id 找元素）。

## 四、ANIM_STEPS 数据格式（JS 对象字面量，颜色用 hex 字符串）
```js
if(!ANIM_STEPS[N]) ANIM_STEPS[N] = [
  {
    caption: '<b>Step 1 · 标题</b>：一句话描述，关键数字用 <b>加粗</b>。',
    nodes: [
      {x:50,y:80,w:110,h:52,label:'标签',value:'数值',color:'#1F2430',fill:'#FBF6EE'},
    ],
    flows: [
      {v:'数值',x1:105,y1:106,x2:280,y2:106,delay:0.0,dur:0.6,color:'#1F2430'},
    ],
    end: 4.8
  },
];
```
- `caption`：本步标题 + 描述，关键数字 `<b>` 加粗。
- **`.anim-title` 与 HTML 注释里禁止出现阿拉伯数字**（如 `7B`/`405B`/`70%`），否则会被 review_check 的 H4 断言扫描误计为「可核验断言」，导致该卡台账行数不足而 FAIL。标题只写定性主题（如「参数账」「显存账」「多评审一致性」），数字全部放 calc-block 与 caption（JS 内，不参与断言扫描）。
- `nodes`：方框数组。x/y=左上角、w=宽、h=高、label=左上小标签、value=框内大字、color=文字色、fill=可选浅背景。
- `flows`：小球动画。v=球上文字、x1/y1=起点、x2/y2=终点、delay=本步内延迟(秒)、dur=飞行时长(秒)、color=球色。
- `end`：本步总时长(秒)，> 最后一个 flow 的 delay+dur，并留约 0.5 秒余量。

## 五、画布与坐标硬约束
- 画布逻辑尺寸固定 **880×470**。
- 每个 node 满足 `x+w ≤ 880` 且 `y+h ≤ 470`；flow 的 x1/x2 在 0~880、y1/y2 在 0~470。
- 同一 step 内多个 flow 的 delay 要错开（0.0 / 0.7 / 1.4 / 2.1 …），避免重叠。
- 每步 node ≤ 14 个、flow ≤ 8 个，保持画面清晰。

## 六、配色（hex）
深色文字 `#1F2430`｜蓝 `#2563EB`｜琥珀 `#B45309`｜绿 `#0E9F6E`｜红(突出结果) `#DC2626`｜靛蓝 `#4F46E5`。浅背景可用 `#FBF6EE` / `#FDF6EC` / `#F0FDF4`。

## 七、数字正确性
- 用 `python3 -c "..."` 独立复算 calc-block 关键数字，动画数字与之严格一致（不复算不写）。
- 若发现 calc-block 数字有错：**不改卡片正文**，只在 `tmp/anim/lesson-N.js` 顶部加 `// NOTE:` 注释标注。
- 动画不引入新的外部事实，故不需要额外联网；它只复现已核验的 calc-block 数字。

## 八、自检（提交前必跑）
```bash
mkdir -p tmp/anim
node -e "var ANIM_STEPS={}; var fs=require('fs'); eval(fs.readFileSync('tmp/anim/lesson-N.js','utf8')); var a=ANIM_STEPS[N]; console.log('steps:', a.length); a.forEach(function(s){ s.nodes.forEach(function(n){ if(n.x+n.w>880||n.y+n.h>470) throw new Error('node越界'); }); }); console.log('OK')"
```
期望输出 `steps: 3~5` 且最后一行 `OK`（无越界）。

## 九、合并与门禁（主 agent 负责，串行收口）
1. 合并 `tmp/anim/lesson-*.js` → 插入 shell.html 的 `var STEPS = ANIM_STEPS[activeLesson];` 之前（按课号排序）。
2. `python3 scripts/build.py` → `node tools/content_verify.js --src` → `python3 scripts/build.py --check`。
3. 逐课 `node tools/provenance_check.js --lesson=N --stamp`（3~35）。
4. `node tools/gate.js`（四把锁全绿）→ `python3 scripts/build_site.py` + `--check` → 部署 Pages。
