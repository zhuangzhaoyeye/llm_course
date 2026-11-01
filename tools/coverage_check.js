#!/usr/bin/env node
/**
 * coverage_check.js —— 覆盖地图归档校验（零依赖，随时可跑）
 *
 * 解决的问题：覆盖地图曾是「每课正文里的一块」——对学生可见、且由 content_verify
 * 在交付物上强制。2026-10-04 用户要求：设计保留、但**不在 HTML 暴露、不在代码中
 * 对学生页面发挥作用**。于是内容归档到 `docs/coverage-maps.md`，而**保障机制不消失**，
 * 改为对归档文档校验（本脚本）。
 *
 * 为什么不能干脆删掉机制：覆盖地图护的是「课程质量与连贯性」——每个经典概念都要
 * 有一个家（本课讲 / 别处讲 / 有意不讲），以及领域锚点必须真的落到正文里。这两件事
 * 与「学生看不看得到」无关，删掉就等于把这项保障一起丢了。
 *
 * 用法：
 *   node tools/coverage_check.js          # 人读输出
 *   node tools/coverage_check.js --json   # 供程序读取
 *
 * 判据（任一 FAIL → 退出码 1）：
 *   ① 归档文件存在，且 manifest 里**每一课**都有一节（新课没写覆盖地图 = FAIL）
 *   ② 每节四段齐备：本领域标准知识块 / 本课覆盖 / 其余去向 / 有意不讲
 *   ③ 领域锚点落地：锚点表里每个锚点必须真的出现在该课 `src/lessons/lesson-<id>.html` 正文里
 *   ④ 回归护栏：学生页面（lesson-*.html）**不得**再出现 `class="coverage-map"`
 *
 * 能力边界（必须说清）：本脚本只保证「覆盖地图没缺、四段没缺、锚点真在正文里」，
 * **不保证覆盖地图本身写得对**（哪个概念该归到哪一课，是教学法判断，仍需人判）。
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const JSON_OUT = process.argv.includes('--json');

/** 每课四段标签（与 docs/coverage-maps.md 的书写约定一致） */
const CM_LABELS = ['本领域标准知识块', '本课覆盖', '其余去向', '有意不讲'];

/**
 * 领域锚点表：本领域「不能缺席」的概念 → 归属课。
 * 判据是「必须真的出现在该课正文里」，不是「出现在覆盖地图里」。
 * 新增课程时在此登记该课锚点（见 .trae/rules/30-dev-rules.md 第六节）。
 */
const ANCHORS = {
  1: ['Attention Is All You Need', 'Self-Attention', 'Causal Mask'],
  2: ['Encoder', 'Decoder', 'Cross-Attention', '位置编码'],
  3: ['RoPE', 'GQA', 'RMSNorm', 'SwiGLU'],
  4: ['BPE', '子词', '词表'],
  5: ['Llama 2', 'Embedding', 'LM Head', 'FFN'],
  6: ['MoE', 'Prefill', '开源'],
  7: ['Kaplan', 'Chinchilla', '过训练'],
  8: ['去重', '配比', '合成数据'],
  9: ['warmup', '梯度裁剪', '混合精度', 'MFU'],
  10: ['SFT', 'Loss Masking', '灾难性遗忘'],
  11: ['RLHF', 'Bradley-Terry', 'PPO', 'DPO', 'GRPO', 'RLAIF', 'Constitutional'],
  12: ['CoT', 'RLVR', 'DeepSeek-R1', '蒸馏'],
  13: ['ZeRO', 'FSDP', '张量并行', '流水线并行'],
  14: ['AdamW', '激活重计算', 'FP8'],
  15: ['KV Cache', 'PagedAttention', 'GQA', 'MLA'],
  16: ['GPTQ', 'AWQ', '困惑度', 'GGUF'],
  17: ['LoRA', 'QLoRA', 'PEFT'],
  18: ['vLLM', '连续批处理', '前缀缓存'],
  19: ['MMLU', 'GSM8K', 'HumanEval', '污染'],
  20: ['few-shot', 'Chain-of-Thought', 'Self-Consistency', 'JSON'],
  21: ['ReAct', '终止条件', '错误累积'],
  22: ['JSON Schema', 'strict', '幂等'],
  23: ['MCP', 'JSON-RPC', 'Resources', 'Prompts', 'Tools'],
  24: ['RAG', '重排', 'Lost in the Middle', 'RAGAS'],
  25: ['Reflexion', 'Tree of Thoughts', '分解'],
  26: ['A2A', 'AgentCard', '上下文工程'],
  27: ['Toolformer', '轨迹', 'ORM', 'PRM'],
  28: ['pass@k', '轨迹评测', '提示注入', '灰度'],
  29: ['MLE-bench', 'L1–L5', 'AI Scientist', 'held-out'],
  30: ['provenance', 'contamination', '新颖性', '去污染'],
  31: ['假设树', 'best-so-far', 'MLE-Bench Lite', 'worktree'],
  32: ['File-as-Bus', 'worktree', '长时程', 'best-so-far'],
  33: ['silent error', 'PaperBench', '复现', '五维'],
  34: ['L5', '免责', 'token', '可回滚'],
};

const rows = [];
const record = (检查, 判定, 说明) => rows.push({ 检查, 判定, 说明 });
const stripTags = (s) => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

// ── 读输入 ────────────────────────────────────────────────────────────────
const manifestPath = path.join(root, 'src/lessons/manifest.json');
const docPath = path.join(root, 'docs/coverage-maps.md');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const lessons = manifest.lessons;

const docExists = fs.existsSync(docPath);
const doc = docExists ? fs.readFileSync(docPath, 'utf8') : '';
record('归档文件 docs/coverage-maps.md 存在', docExists ? 'PASS' : 'FAIL',
  docExists ? `${doc.length} 字符` : '缺失');

// ── ① 每课一节 ────────────────────────────────────────────────────────────
const sections = {};   // id -> 该节正文
const sectionOrder = [];
if (docExists) {
  const lines = doc.split('\n');
  let curId = null;
  let buf = [];
  const flush = () => { if (curId !== null) sections[curId] = buf.join('\n'); };
  for (const line of lines) {
    const m = line.match(/^##\s+第(\d+)课.*（id=(\d+)）/);
    if (m) { flush(); curId = Number(m[2]); sectionOrder.push(curId); buf = []; continue; }
    if (curId !== null) buf.push(line);
  }
  flush();
}

const docIds = Object.keys(sections).map(Number);
const missingSection = lessons.filter((l) => !(l.id in sections)).map((l) => `id${l.id}(第${l.display}课)`);
record('每课都有覆盖地图小节（新课漏写即 FAIL）', missingSection.length === 0 ? 'PASS' : 'FAIL',
  missingSection.length === 0 ? `${lessons.length} 课全覆盖` : '缺：' + missingSection.join('；'));

const extraSection = docIds.filter((id) => !lessons.some((l) => l.id === id));
record('归档里没有 manifest 之外的小节', extraSection.length === 0 ? 'PASS' : 'WARN',
  extraSection.length === 0 ? '一致' : '多出：' + extraSection.map((i) => `id${i}`).join('；'));

// ── ② 四段齐备 ────────────────────────────────────────────────────────────
const lackSeg = [];
for (const id of docIds) {
  const seg = sections[id];
  const lack = CM_LABELS.filter((l) => !seg.includes(l));
  if (lack.length) lackSeg.push(`id${id}(缺 ${lack.join('/')})`);
}
record('覆盖地图四段齐备（标准知识块/本课覆盖/其余去向/有意不讲）',
  lackSeg.length === 0 ? 'PASS' : 'FAIL', lackSeg.length === 0 ? '全部齐备' : lackSeg.join('；'));

// ── ③ 领域锚点落地 + ④ 学生页面无残留 ──────────────────────────────────────
const anchorMissing = [];
const leftovers = [];
let anchorTotal = 0;
for (const item of lessons) {
  const p = path.join(root, 'src/lessons', `lesson-${item.id}.html`);
  if (!fs.existsSync(p)) { anchorMissing.push(`id${item.id}(正文缺失)`); continue; }
  const raw = fs.readFileSync(p, 'utf8');
  if (/class="coverage-map"/.test(raw)) leftovers.push(`id${item.id}`);
  // 只看正文（去掉课间导航页脚），避免"在页脚里提到就算落地"
  const body = stripTags(raw.replace(/<div class="footer-nav">[\s\S]*?<\/div>/g, ' '));
  for (const a of (ANCHORS[item.id] || [])) {
    anchorTotal++;
    if (!body.includes(a)) anchorMissing.push(`id${item.id}(${a})`);
  }
}
record('领域锚点落地（锚点必须真的出现在该课正文里）',
  anchorMissing.length === 0 ? 'PASS' : 'FAIL',
  anchorMissing.length === 0 ? `${anchorTotal} 个锚点全部落地`
    : `${anchorMissing.length}/${anchorTotal} 未落地 → ` + anchorMissing.slice(0, 8).join('；'));

record('学生页面不含覆盖地图（回归护栏）',
  leftovers.length === 0 ? 'PASS' : 'FAIL',
  leftovers.length === 0 ? 'lesson-*.html 均无 .coverage-map' : '残留：' + leftovers.join('；'));

// ── 输出 ──────────────────────────────────────────────────────────────────
const nP = rows.filter((r) => r.判定 === 'PASS').length;
const nW = rows.filter((r) => r.判定 === 'WARN').length;
const nF = rows.filter((r) => r.判定 === 'FAIL').length;

if (JSON_OUT) {
  console.log(JSON.stringify({ pass: nP, warn: nW, fail: nF, rows }, null, 2));
} else {
  console.log('========================================');
  console.log('  覆盖地图归档校验 coverage_check');
  console.log('========================================');
  for (const r of rows) {
    const icon = r.判定 === 'PASS' ? 'PASS' : r.判定 === 'WARN' ? 'WARN' : 'FAIL';
    console.log(`[${icon}] ${r.检查} — ${r.说明}`);
  }
  console.log('────────────────────────────────────────');
  console.log(`PASS ${nP}   WARN ${nW}   FAIL ${nF}`);
  if (nF) console.log('存在 FAIL：新课缺覆盖地图 / 四段不齐 / 锚点未落地 → 请补 docs/coverage-maps.md 并让锚点落进正文。');
}

process.exit(nF ? 1 : 0);
