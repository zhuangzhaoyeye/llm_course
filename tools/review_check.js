#!/usr/bin/env node
/**
 * review_check.js — 逐条核验覆盖度 + 类型路由门禁（零依赖，纯 Node）
 *
 * 存在意义：把两件事从口头要求变成**可核查的产出物要求**——
 *   1) 必须逐条过（主问题 + 每条下挂追问），一份缺失或覆盖不全的报告 = 等于没做；
 *   2) 每条断言必须**按类型路由到有资格裁决它的裁判**，不许什么都塞给 python。
 *
 * 能力边界（必须向使用者说清）：
 *   - 本脚本只负责「暴露候选错误」与「不许偷懒」，**不负责证明「对」**。
 *   - 正确性仍需人工金标：算术靠复算一致、事实靠一手来源、经验数字只能标「估算」。
 *   - 语义问题（是否预设结论、提示是否泄题、类比是否恰当）永远需要人判。
 *
 * 报告列定义（9 列，固定顺序）：
 *   | # | 定位 | 待核验断言 | 类型 | 核验方式 | 来源/算式 | 置信度 | 判定 | 处置 |
 *
 * 类型路由表：
 *   算术 → 核验方式须含 python/重算/复算     ｜ 来源须给出算式
 *   事实 → 核验方式须含 web/搜索/一手/论文   ｜ 来源须给链接或写明「未找到/无来源/待人工」
 *   推导 → 核验方式须含 推导/反例/边界       ｜ 来源须写出边界条件或反例
 *   经验 → 核验方式须含 来源/web/估算        ｜ 来源须给链接或显式标注「估算/示意」
 *   语义 → 核验方式须含 语义/人判/对照       ｜ 来源须引用所依据的规则条款
 *
 * 三条硬约束：
 *   H1 类型必须来自路由表，核验方式必须与类型匹配，来源必须满足该类型的举证要求
 *   H2 「经验」类判 PASS 时必须有一手来源链接（无来源经验数字不得判过）
 *   H3 「推导」类必须写出边界/反例（缺反例只是「讲得通」，不是「对」）
 *
 * 断言覆盖（H4，治「漏列断言」；2026-09-28 由「结构单元锚点」升级为「可核验断言」）：
 *   报告里以「Card N」定位的行数，必须 ≥ 该卡的可核验断言数。
 *   断言判定：取卡片内容区（`.card-a` 起，砍掉 `.tab-bar` 之后的问答区与课程级 `.footer-nav`），
 *   按块级边界切句，凡含「数字」或「归属/时间/版本声明」（提出/发表/首次/出自/原论文/论文/版本/这就是）
 *   的句子各算 1 条；步骤标签编号（`Step 1：`/`第1步：`）先剥掉再判；激活区固定算 2 条（主问题 + 提示）。
 *   为什么升级：旧粒度是「结构单元」（每个 .content-section / .calc-block 各 1），一个正文段含
 *   3 条事实断言时 1 行即可满足 —— 粒度不足会让绿色的通过指标把缺口藏起来（RTM 领域共识）。
 *   边界：只解决「列不列」，**不解决「列得对不对」**；后者仍靠 H1~H3 + 人工金标。
 *
 * 问题闭环（B1~B3，治「记下来就不管」）：
 *   第 9 列「处置」必填枚举：已修 / 待修 / 不改（不改须带理由）。
 *   B1 判定为 WARN 或 ERROR 的行，处置必填且以三枚举之一开头
 *   B2 处置为「不改」时必须给出理由（去掉「不改」后 ≥4 字）
 *   B3 「待修」条数被显式统计并报警（不 FAIL）——债务必须可见，不许静默累积
 *   设计依据：ERROR 有「清零」门禁，但 P1/P2 若无归宿就会攒成技术债；本机制让
 *   每条问题都有明确归宿，而不是"先记下来后面再说"。
 *
 * 用法：
 *   node tools/review_check.js --lesson 1     # 校验第 1 课的核验报告
 *   node tools/review_check.js --all          # 校验所有课程
 *   node tools/review_check.js --lesson 1 --quiet
 *
 * 退出码：0 = 全部通过；1 = 存在 FAIL
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST = path.join(ROOT, 'src', 'lessons', 'manifest.json');
const REPORT_DIR = path.join(ROOT, 'reports');

const QUIET = process.argv.includes('--quiet');
const ALL = process.argv.includes('--all');
const lessonArg = (process.argv.find((a) => a.startsWith('--lesson=')) || '').split('=')[1]
  || (process.argv.includes('--lesson') ? process.argv[process.argv.indexOf('--lesson') + 1] : null);

// ── 列契约 ────────────────────────────────────────────────────────────────
const COLS = 9;
const COL_NAMES = '定位/断言/类型/核验方式/来源/置信度/判定/处置';

// ── 类型路由表 ────────────────────────────────────────────────────────────
const ROUTE = {
  算术: {
    method: /python|重算|复算/i,
    need: (c) => c[5].length > 0,
    needDesc: '来源须给出可复算的算式',
  },
  事实: {
    method: /web|搜索|search|一手|论文|检索/i,
    need: (c) => /https?:\/\//.test(c[5]) || /未找到|无来源|待人工/.test(c[5]),
    needDesc: '来源须给一手链接，或写明「未找到/无来源/待人工」',
  },
  推导: {
    method: /推导|反例|边界|量纲|语义|极限/i,
    need: (c) => /边界|反例|退化|若不|假设|极限|量纲/.test(c[5]),
    needDesc: '来源须写出边界条件或反例',
  },
  经验: {
    method: /web|搜索|来源|估算|标注/i,
    need: (c) => /https?:\/\//.test(c[5]) || /估算|示意|未找到|无来源|待人工/.test(c[5]),
    needDesc: '来源须给一手链接，或显式标注「估算/示意」',
  },
  语义: {
    method: /语义|人判|对照/i,
    need: (c) => c[5].length > 0,
    needDesc: '来源须引用所依据的规则条款',
  },
};
const TYPES = Object.keys(ROUTE);
const CONFIDENCE = ['可保证', '需标注', '估算'];
const VERDICTS = ['PASS', 'WARN', 'ERROR'];
const DISPOSITIONS = ['已修', '待修', '不改'];

let rows = [];
let fail = 0, warn = 0, pass = 0;
function record(lesson, name, status, detail) {
  if (status === 'PASS') pass++;
  if (status === 'WARN') warn++;
  if (status === 'FAIL') fail++;
  rows.push({ lesson, name, status, detail: detail || '' });
}

/** 从 shell.html 取 allHardcodedQnA（花括号配平） */
function loadQnA() {
  const shell = fs.readFileSync(path.join(ROOT, 'src', 'shell.html'), 'utf8');
  const at = shell.indexOf('const allHardcodedQnA');
  if (at < 0) return null;
  const braceAt = shell.indexOf('{', at);
  let depth = 0, i = braceAt, quote = null;
  for (; i < shell.length; i++) {
    const c = shell[i];
    if (quote) { if (c === '\\') { i++; continue; } if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) break;
  }
  try {
    // eslint-disable-next-line no-new-func
    return new Function('return ' + shell.slice(braceAt, i + 1) + ';')();
  } catch {
    return null;
  }
}

function countCards(lessonFile) {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'lessons', lessonFile), 'utf8');
  return (html.match(/<div class="card" data-card="[^"]+"/g) || []).length;
}

// ── 断言单元锚点（H4 粒度升级版）───────────────────────────────────────────
// 旧定义是「结构性单元」：每个 .content-section / .calc-block 各算 1 个锚点。
// 问题：粒度太粗——一个正文段里含 3 条事实断言，1 行就能满足门禁，等于用一个
// 绿色的通过指标把缺口藏起来（需求追溯 RTM 领域的既有结论）。
// 新定义是「可核验断言」：一句话若含数字、或归属/时间/版本声明，就必须在台账里
// 单独占一行。表格按行切分（每个数据行 = 一条断言）。
const CLAIM_SIGNAL = /[0-9０-９]|提出|发表|首次|出自|原论文|论文|版本|这就是/;

/** 把 HTML 切成「句子」，数其中含可核验信号、且不重复的句子数 */
function claimCount(html) {
  const sentences = html
    .replace(/<\/(tr|div|p|li|h[1-6])>/gi, '。')   // 块级边界当句号；表格按行计
    .replace(/<br\s*\/?>/gi, '。')
    .replace(/<[^>]+>/g, ' ')
    .split(/[。！？；;]/)
    // 步骤标签里的编号（"Step 1：" / "第1步："）不是断言本身，去掉前缀再判断
    .map((s) => s.replace(/^(?:Step|第)\s*[0-9０-９]+\s*(?:步|：|:)?\s*/i, '').replace(/\s+/g, ' ').trim());
  const seen = new Set();
  let n = 0;
  for (const s of sentences) {
    if (s.length < 4 || !CLAIM_SIGNAL.test(s) || seen.has(s)) continue;
    seen.add(s);
    n++;
  }
  return n;
}

/**
 * 取出卡片里"应被核验的教学内容"部分。
 * 必须砍掉三处非断言内容，否则检测器误报：
 *   - `.tab-bar` 之后（tab 标题「学生最可能追问的 5 个问题」含数字、AI 面板文案）
 *   - `.footer-nav`（课程级页脚；最后一张卡的切片会一直延伸到文件末尾而把它吞进来）
 */
function cardContentForClaims(block) {
  let s = block;
  const at = s.indexOf('class="card-a"');
  if (at >= 0) s = s.slice(at);
  for (const marker of ['tab-bar', 'footer-nav']) {
    const i = s.indexOf(marker);
    if (i >= 0) s = s.slice(0, i);
  }
  return s;
}

/** 逐卡统计可核验断言数，返回 { cardId: 断言数 } */
function countAnchors(lessonFile) {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'lessons', lessonFile), 'utf8');
  const marks = [...html.matchAll(/<div class="card" data-card="([^"]+)"/g)];
  const out = {};
  marks.forEach((m, i) => {
    const start = m.index;
    const end = i + 1 < marks.length ? marks[i + 1].index : html.length;
    const content = cardContentForClaims(html.slice(start, end));
    // 激活区固定算 2 条：主问题 1 + 提示 1
    out[m[1]] = 2 + claimCount(content);
  });
  return out;
}

/** 报告里「以 Card <id> 定位」的行（按 id 边界精确匹配，避免 Card 1 命中 Card 1-2 / Card 10） */
function rowsForCard(rows, cardId) {
  const id = String(cardId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`Card\\s*${id}(?![-\\d])`);
  return rows.filter((c) => re.test(c[1]));
}

/**
 * 解析报告里的**核心台账表**（以 `| # | …` 表头开始的那一张）。
 *
 * 为什么锚定表头而不是"抓所有 | 行"：报告里后面还会有别的表格（"让机制持续生效"
 * 的对照表、盲审的"无法判定"表等）。历史上这个函数抓所有表格行，导致非 9 列表格
 * 被当成台账数据、整份报告假报「列数不对」——已经踩过 3 次坑。
 * 现在只认第一张 `| # |` 表，遇到第一行非表格内容即结束。
 */
const crypto0 = require('crypto');
const HASH_RE = /<!--\s*content-hash:\s*lesson=([0-9a-f]{8,})\s+shell=([0-9a-f]{8,})\s*-->/;

function sha(str) { return crypto0.createHash('sha1').update(str).digest('hex').slice(0, 16); }
function collapse(s) { return s.replace(/\s+/g, ' ').trim(); }
function contentHashes(lessonId, lessonFile) {
  const lp = path.join(ROOT, 'src/lessons', lessonFile);
  const sp = path.join(ROOT, 'src/shell.html');
  return {
    lesson: sha(collapse(fs.readFileSync(lp, 'utf8'))),
    shell: sha(collapse(fs.readFileSync(sp, 'utf8'))),
  };
}
function stampReport(mdPath, h) {
  let md = fs.readFileSync(mdPath, 'utf8');
  const line = `<!-- content-hash: lesson=${h.lesson} shell=${h.shell} -->`;
  md = HASH_RE.test(md) ? md.replace(HASH_RE, line) : line + '\n' + md;
  fs.writeFileSync(mdPath, md);
  return line;
}

// ── H1f 全类型联网强制（用户 2026-09-29 要求）────────────────────────────
// 要求：**任何内容**都必须逐条联网核验——即使作者很确定。理由：预训练知识会过时/出错，
//       "有把握"不是证据。因此台账**每一行**都必须留下联网证据：
//         · 有外部来源 → 来源列写 http(s) 链接；或
//         · 确无对应来源 → 仍须执行检索，并写下 query 与结论（query=…）
//       query 兜底模板（不知道该搜什么时用这两条）：
//         1. 「<断言> 是否准确或过时」
//         2. 「<断言> 是否有错误」
// 判据可机械核对（有无 URL / query 标记）→ 属"有唯一答案"，故由脚本强制。
function checkWebPerRow(md) {
  const rows = parseRows(md);
  if (!rows.length) return { status: 'SKIP', detail: '无台账数据行' };
  const bad = [];
  rows.forEach((c) => {
    const cell = c.join(' ');
    if (!/https?:\/\//.test(cell) && !/query\s*[=:：]/i.test(cell)) bad.push(c[0]);
  });
  return {
    status: bad.length ? 'FAIL' : 'PASS',
    detail: bad.length
      ? `${bad.length}/${rows.length} 行无联网证据（既无 http 链接，也无 query= 标记）—— 行号：${bad.slice(0, 10).join(', ')}${bad.length > 10 ? ' …' : ''}`
      : `${rows.length} 行全部留下联网证据`,
  };
}

function parseRows(md) {
  const lines = md.split('\n').map((l) => l.trim());
  const start = lines.findIndex((l) => /^\|\s*#\s*\|/.test(l));
  if (start < 0) return [];
  const out = [];
  for (let i = start; i < lines.length; i++) {
    const l = lines[i];
    if (!l.startsWith('|') || !l.endsWith('|')) break;
    const cells = l.slice(1, -1).split('|').map((c) => c.trim());
    if (cells[0] === '#' || /^-{2,}$/.test(cells[0])) continue;
    out.push(cells);
  }
  return out;
}

/** 取判定列的首个关键字（PASS / WARN / ERROR），后接说明允许存在 */
function verdictOf(cell) {
  const m = /^(PASS|WARN|ERROR)\b/i.exec(cell || '');
  return m ? m[1].toUpperCase() : null;
}

/** 去重后取前 n 条示例，避免刷屏 */
function sample(arr, n, fmt) {
  const uniq = [];
  const seen = new Set();
  for (const x of arr) {
    const k = fmt(x);
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(k);
    if (uniq.length >= n) break;
  }
  return uniq.join(' ｜ ');
}

function checkLesson(item, qna) {
  const label = `第${item.display}课 id=${item.id}`;
  const report = path.join(REPORT_DIR, `${item.id}-逐条核验.md`);

  if (!fs.existsSync(report)) {
    record(label, '逐条核验报告存在', 'FAIL', `缺 reports/${item.id}-逐条核验.md → 视为未做逐条核验`);
    return;
  }
  record(label, '逐条核验报告存在', 'PASS');

  const cards = countCards(item.file);
  const anchors = countAnchors(item.file);
  const perLesson = (qna && qna[String(item.id)]) || {};
  let qnaCount = 0;
  for (const k of Object.keys(perLesson)) {
    if (Array.isArray(perLesson[k])) qnaCount += perLesson[k].length;
  }
  const expected = cards + qnaCount;

  const dataRows = parseRows(fs.readFileSync(report, 'utf8'));
  record(label, `覆盖度 ≥ ${expected} 条（${cards} 主问题 + ${qnaCount} 追问）`,
    dataRows.length >= expected ? 'PASS' : 'FAIL',
    `实际 ${dataRows.length} 条${dataRows.length < expected ? `，少 ${expected - dataRows.length} 条` : ''}`);

  const good = dataRows.filter((c) => c.length === COLS);
  record(label, `每行 ${COLS} 列（${COL_NAMES}）`,
    good.length === dataRows.length ? 'PASS' : 'FAIL',
    good.length === dataRows.length ? '' : `${dataRows.length - good.length} 行列数不对，例：${sample(dataRows.filter((c) => c.length !== COLS), 2, (c) => `[${c.length}列] ${c.slice(0, 3).join(' / ')}`)}`);

  // ── H4 锚点覆盖（治「漏列断言」）────────────────────────────────────────
  const cardIds = Object.keys(anchors);
  const shortBy = [];
  for (const id of cardIds) {
    const need = anchors[id];
    const got = rowsForCard(good, id).length;
    if (got < need) shortBy.push(`Card ${id} ${got}/${need}`);
  }
  const totalAnchors = cardIds.reduce((n, id) => n + anchors[id], 0);
  record(label, `H4 断言覆盖（每卡行数 ≥ 该卡可核验断言数，共 ${totalAnchors} 条断言）`,
    shortBy.length === 0 ? 'PASS' : 'FAIL',
    shortBy.length ? `${shortBy.length} 张卡行数不足（实测/要求）→ ${shortBy.join('，')}` : `${cardIds.length} 张卡全部达标`);

  // ── A 组 盲审持久化（防「流程只活在文档里」）─────────────────────────────
  //     机制只写进文档 = 不跑也没人知道。A 组把「必须做盲审」变成 FAIL 级门禁，
  //     这样"下次不做了"会在跑门禁时立刻暴露，而不是等到出问题才想起来。
  const blindReport = path.join(REPORT_DIR, `${item.id}-盲审.md`);
  if (!fs.existsSync(blindReport)) {
    record(label, 'A1 独立盲审报告存在', 'FAIL',
      `缺 reports/${item.id}-盲审.md → 未做盲审，本次质检不算完成`);
  } else {
    record(label, 'A1 独立盲审报告存在', 'PASS');
    const bRows = parseRows(fs.readFileSync(blindReport, 'utf8')).filter((c) => c.length >= 5);
    const bWithUrl = bRows.filter((c) => /https?:\/\//.test(c.join(' ')));
    record(label, 'A2 盲审报告含缺陷表（≥5 行）且附联网证据',
      bRows.length >= 5 && bWithUrl.length >= 1 ? 'PASS' : 'FAIL',
      `缺陷行 ${bRows.length}，其中带链接 ${bWithUrl.length}`);
  }

  const mdText = fs.readFileSync(report, 'utf8');
  // 收紧（2026-09-29）：原判据只要求全文出现任意「N%」，报告里其它位置的百分比会误判通过。
  // 实测：第 4 课台账写着「（待填 %）」时 A3 仍 PASS。现要求「漏检率」后 60 字内出现带 % 的数字。
  const hasDiff = /差集/.test(mdText) && /漏检率[^。\n]{0,60}\d+\s*[·.]?\d*\s*[%％]/.test(mdText);
  record(label, 'A3 核验报告含「差集」段与漏检率数字',
    hasDiff ? 'PASS' : 'FAIL',
    hasDiff ? '' : '缺「差集」或「漏检率」→ 质检质量无法量化，等于没做独立评审');

  // ── H1 类型路由 ────────────────────────────────────────────────────────
  const badType = good.filter((c) => !TYPES.includes(c[3]));
  record(label, `H1a 类型合法（${TYPES.join('/')}）`,
    badType.length === 0 ? 'PASS' : 'FAIL',
    badType.length ? `${badType.length} 行类型非法，例：${sample(badType, 3, (c) => `${c[1]}=「${c[3]}」`)}` : '');

  const typed = good.filter((c) => TYPES.includes(c[3]));
  const badMethod = typed.filter((c) => !ROUTE[c[3]].method.test(c[4]));
  record(label, 'H1b 核验方式与类型匹配（不许什么都塞给 python）',
    badMethod.length === 0 ? 'PASS' : 'FAIL',
    badMethod.length ? `${badMethod.length} 行方式与类型不匹配，例：${sample(badMethod, 3, (c) => `${c[1]} 类型=${c[3]} 方式=「${c[4]}」`)}` : '');

  const badEvidence = typed.filter((c) => !ROUTE[c[3]].need(c));
  record(label, 'H1c 来源满足该类型的举证要求',
    badEvidence.length === 0 ? 'PASS' : 'FAIL',
    badEvidence.length ? `${badEvidence.length} 行举证不足，例：${sample(badEvidence, 3, (c) => `${c[1]} 类型=${c[3]} 需 ${ROUTE[c[3]].needDesc}`)}` : '');

  // 收紧：事实类判 PASS 时不许用「未找到/无来源」放行，必须真给一手链接
  const factRows = typed.filter((c) => c[3] === '事实');
  const factPassNoUrl = factRows.filter((c) => verdictOf(c[7]) === 'PASS' && !/https?:\/\//.test(c[5]));
  record(label, 'H1d 事实类判 PASS 必须给一手链接',
    factPassNoUrl.length === 0 ? 'PASS' : 'FAIL',
    factPassNoUrl.length ? `${factPassNoUrl.length} 条事实类 PASS 无链接，例：${sample(factPassNoUrl, 3, (c) => c[1])}` : '');

  const factWithUrl = factRows.filter((c) => /https?:\/\//.test(c[5]));
  const factRate = factRows.length ? Math.round((factWithUrl.length / factRows.length) * 100) : 100;
  record(label, 'H1e 事实类联网覆盖率（逐条联网的可量化读数）',
    factRate === 100 ? 'PASS' : 'WARN',
    `事实类 ${factRows.length} 条，带一手链接 ${factWithUrl.length} 条（${factRate}%）`);

  // H1f 全类型联网强制：**任何**一行都必须留下联网证据（http 或 query=）
  {
    const w = checkWebPerRow(fs.readFileSync(report, 'utf8'));
    record(label, 'H1f 全类型联网强制（每行须有 http 或 query= 证据）',
      w.status === 'SKIP' ? 'FAIL' : w.status, w.detail);
  }

  // ── H2 经验数字不得无来源判过 ──────────────────────────────────────────
  const expNoSrc = typed.filter((c) => c[3] === '经验'
    && verdictOf(c[7]) === 'PASS'
    && !/https?:\/\//.test(c[5]));
  record(label, 'H2 经验类判 PASS 必须有一手来源链接',
    expNoSrc.length === 0 ? 'PASS' : 'FAIL',
    expNoSrc.length ? `${expNoSrc.length} 条无来源经验数字被判 PASS，例：${sample(expNoSrc, 3, (c) => c[1])}` : '');

  // ── H3 推导类必须有边界/反例（由 H1c 覆盖，此处单列出便于定位） ─────────
  const noBoundary = typed.filter((c) => c[3] === '推导' && !ROUTE.推导.need(c));
  record(label, 'H3 推导类必须写出边界条件或反例',
    noBoundary.length === 0 ? 'PASS' : 'FAIL',
    noBoundary.length ? `${noBoundary.length} 条推导缺边界，例：${sample(noBoundary, 3, (c) => c[1])}` : '');

  // ── 枚举与判定 ────────────────────────────────────────────────────────
  const badConf = good.filter((c) => !CONFIDENCE.includes(c[6]));
  record(label, `置信度合法（${CONFIDENCE.join('/')}）`,
    badConf.length === 0 ? 'PASS' : 'FAIL',
    badConf.length ? `${badConf.length} 行置信度非法，例：${sample(badConf, 3, (c) => `${c[1]}=「${c[6]}」`)}` : '');

  const noMethod = good.filter((c) => !c[4]);
  record(label, '每行都写了核验方式', noMethod.length === 0 ? 'PASS' : 'FAIL', `${noMethod.length} 行缺方式`);

  const badVerdict = good.filter((c) => !VERDICTS.includes(verdictOf(c[7])));
  record(label, '判定合法（PASS/WARN/ERROR）',
    badVerdict.length === 0 ? 'PASS' : 'FAIL',
    badVerdict.length ? `${badVerdict.length} 行判定非法，例：${sample(badVerdict, 3, (c) => `${c[1]}=「${c[7]}」`)}` : '');

  // ── 联网核验行须有链接 ────────────────────────────────────────────────
  // 只看「核验方式」的首个标签词（切掉 query=… 与括注）——
  // 否则 query 文案里的「参与搜索」「re-search」会被误判成联网行（2026-10-05 实测：第 32 课虚报 2 行）
  const methodLabel = (c) => String(c[4] || '').split(/[\s（(]|query=/i)[0];
  const searched = good.filter((c) => /web|搜索|search/i.test(methodLabel(c)));
  const noSource = searched.filter((c) => !/https?:\/\//.test(c[5]) && !/未找到|无来源|待人工/.test(c[5]));
  record(label, '联网核验行必须给出链接或说明「未找到」',
    noSource.length === 0 ? 'PASS' : 'WARN',
    noSource.length ? `${noSource.length}/${searched.length} 行没有来源链接` : `共 ${searched.length} 行联网核验`);

  // ── B 问题闭环（治「记下来就不管」）────────────────────────────────────
  const dispositionOf = (cell) => {
    const t = (cell || '').trim();
    const hit = DISPOSITIONS.find((d) => t.startsWith(d));
    return hit ? { kind: hit, rest: t.slice(hit.length).trim() } : null;
  };
  const needDispo = good.filter((c) => {
    const v = verdictOf(c[7]);
    return (v === 'WARN' || v === 'ERROR') && !dispositionOf(c[8]);
  });
  record(label, 'B1 WARN/ERROR 行必须填处置（已修/待修/不改）',
    needDispo.length === 0 ? 'PASS' : 'FAIL',
    needDispo.length ? `${needDispo.length} 行缺处置或处置非法，例：${sample(needDispo, 3, (c) => `${c[1]}=「${c[8]}」`)}` : '');

  // 注意：只剥括号字符本身，不剥括号里的内容——「不改（理由）」里的括号内容正是理由。
  // （首版误把括号内容一并剥掉，导致带括号的合法理由被判「未给理由」，已修正。）
  const noReason = good.filter((c) => {
    const d = dispositionOf(c[8]);
    return d && d.kind === '不改' && d.rest.replace(/[（）()【】\[\]]/g, '').trim().length < 4;
  });
  record(label, 'B2 处置为「不改」必须给出理由（≥4 字）',
    noReason.length === 0 ? 'PASS' : 'FAIL',
    noReason.length ? `${noReason.length} 行「不改」未给理由，例：${sample(noReason, 3, (c) => c[1])}` : '');

  const pending = good.filter((c) => {
    const d = dispositionOf(c[8]);
    return d && d.kind === '待修';
  });
  record(label, 'B3 待修债务计数（不 FAIL，但必须可见）',
    pending.length === 0 ? 'PASS' : 'WARN',
    pending.length ? `待修 ${pending.length} 条（其中 ERROR ${pending.filter((c) => verdictOf(c[7]) === 'ERROR').length} 条）` : '无待修');

  const err = good.filter((c) => verdictOf(c[7]) === 'ERROR');
  record(label, '判定为 ERROR 的已清零', err.length === 0 ? 'PASS' : 'FAIL',
    err.length ? `${err.length} 条仍为 ERROR` : '');

  // ── A4 复核持久化（防「改完就跑绿、不复核」）──────────────────────────
  // 实测依据：第 1 课修复轮自己引入 3 条新错（丢问号 / 归属改错 / 口径只改主卡），
  // 只有独立复核能抓。不做复核 = 本次质检不算完成。
  const recheckReport = path.join(REPORT_DIR, `${item.id}-盲审复核.md`);
  if (!fs.existsSync(recheckReport)) {
    record(label, 'A4 独立盲审复核报告存在', 'FAIL',
      `缺 reports/${item.id}-盲审复核.md → 修复后未复核，本次质检不算完成`);
  } else {
    const rcRows = parseRows(fs.readFileSync(recheckReport, 'utf8')).filter((c) => c.length >= 5);
    const noHome = rcRows.filter((c) => !/已修|不改|不修|保留|已删除|撤回/.test(c.join(' ')));
    record(label, 'A4 独立盲审复核报告存在且每条缺陷有归宿',
      rcRows.length >= 1 && noHome.length === 0 ? 'PASS' : 'FAIL',
      `缺陷 ${rcRows.length} 行，缺归宿 ${noHome.length} 行`);
  }

  // ── C 组 同源索引表（防「改了 A 漏了 B」）────────────────────────────
  // 实测依据：Card 5 的 d_model 口径只改了主卡、漏了追问里的 768。
  // 分工：关键词由人抽（脚本自动抽会误报，误报会让门禁失去信任），
  //       "抽了就必须同步"由门禁负责。
  // 索引表格式（首列必须是 #，parseRows 只认以「| # |」开头的那张表）：
  //   | # | 关键词 | 课程中出现位置 | 对应台账行 |
  const idxSection = mdText.split('同源索引表')[1] || '';
  if (!idxSection) {
    record(label, 'C1 每个 ERROR 行被同源索引表覆盖', 'FAIL', '报告缺「同源索引表」一节');
    record(label, 'C2 同源索引表引用的台账行真实存在', 'FAIL', '报告缺「同源索引表」一节');
  } else {
    const idxRows = parseRows(idxSection).filter((c) => c.length >= 4);
    const rowNums = new Set(good.map((c) => Number(c[0])));
    const covered = new Set();
    idxRows.forEach((r) => (r[3].match(/\d+/g) || []).forEach((n) => covered.add(Number(n))));
    const uncovered = err.filter((c) => !covered.has(Number(c[0])));
    record(label, 'C1 每个 ERROR 行被同源索引表覆盖',
      uncovered.length === 0 ? 'PASS' : 'FAIL',
      uncovered.length
        ? `${uncovered.length} 条 ERROR 未进索引表，例：第 ${uncovered[0][0]} 行`
        : (err.length ? `覆盖 ${err.length} 条 ERROR` : '当前无 ERROR，规则保持生效'));

    const badRef = [];
    idxRows.forEach((r) => (r[3].match(/\d+/g) || []).forEach((n) => {
      if (!rowNums.has(Number(n))) badRef.push(`第 ${n} 行不存在`);
    }));
    record(label, 'C2 同源索引表引用的台账行真实存在',
      badRef.length === 0 ? 'PASS' : 'FAIL',
      badRef.length ? badRef.slice(0, 3).join('，') : `索引表 ${idxRows.length} 行`);
  }
}


function main() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const qna = loadQnA();
  if (!qna) { console.error('无法解析 src/shell.html 的 allHardcodedQnA'); return 1; }

  let targets = manifest.lessons;
  if (!ALL) {
    if (!lessonArg) {
      console.error('用法：node tools/review_check.js --lesson <id> | --all');
      return 1;
    }
    targets = manifest.lessons.filter((l) => String(l.id) === String(lessonArg));
    if (!targets.length) { console.error(`manifest 中没有 id=${lessonArg} 的课程`); return 1; }
  }

  console.log(`\n逐条核验覆盖度+类型路由 review_check.js   范围: ${ALL ? '全部课程' : `id=${lessonArg}`}\n`);
  for (const item of targets) checkLesson(item, qna);

  const shown = QUIET ? rows.filter((r) => r.status !== 'PASS') : rows;
  let last = null;
  for (const r of shown) {
    if (r.lesson !== last) { console.log(`\n${r.lesson}`); last = r.lesson; }
    console.log(`  [${r.status}] ${r.name}${r.detail ? `  — ${r.detail}` : ''}`);
  }
  console.log('\n' + '─'.repeat(56));
  console.log(`PASS ${pass}   WARN ${warn}   FAIL ${fail}`);
  if (fail > 0) console.log('FAIL：逐条核验未达标，本次生成/质检不算完成。');
  console.log('');
  return fail > 0 ? 1 : 0;
}

process.exit(main());
