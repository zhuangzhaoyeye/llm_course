#!/usr/bin/env node
/**
 * content_verify.js — 内容层质量门（零依赖，纯 Node，不需要 Playwright）
 *
 * 分工（见 .trae/rules/30-dev-rules.md）：
 *   content_verify.js  管「写得对不对」——组件齐不齐、绑定对不对、门禁数字够不够
 *   verify.js          管「渲染对不对」——布局、对比度、响应式、运行时 Console 错误
 *
 * 用法：
 *   node tools/content_verify.js              # 校验构建产物 dist_course.html
 *   node tools/content_verify.js --src        # 校验源文件（构建前自检，定位更准）
 *   node tools/content_verify.js --quiet      # 只输出汇总与失败项
 *
 * 退出码：0 = 无 FAIL；1 = 存在 FAIL（致命，禁止交付）
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST_PATH = path.join(ROOT, 'src', 'lessons', 'manifest.json');

// ── 门禁阈值（改这里就改了标准，别散落在各处）──
const GATE = {
  qnaPerCard: 5,        // 每卡追问答数下限
  distinctNumbers: 3,   // 每卡正文不同数字个数下限
  equations: 1,         // 每卡计算等式下限
  calcSteps: 2,         // 计算块 step-title 下限
  hintWarnChars: 100,   // 提示长度超此值只报警（偏长，是否泄题需人工判）
};

// 每卡必须具备的组件（= 7 大核心组件）
const REQUIRED_PER_CARD = [
  ['.card-q-text',   '<div class="card-q-text">',    '问题'],
  ['.card-q-hint',   '<div class="card-q-hint">',    '提示'],
  ['.card-bg',       '<div class="card-bg">',        '知识背景（锚定）'],
  ['.content-section', '<div class="content-section">', '正文段落'],
  ['.calc-block',    'class="calc-block"',           '计算走查'],
  ['.tab-bar',       'class="tab-bar"',              '问答标签条'],
  ['.qna-list',      'class="qna-list"',             '追问列表'],
];

const results = [];
let stats = { earned: 0, total: 0, fail: 0, warn: 0, pass: 0 };

function record(lesson, card, name, status, weight, detail) {
  stats.total += weight;
  if (status === 'PASS') { stats.earned += weight; stats.pass++; }
  if (status === 'FAIL') stats.fail++;
  if (status === 'WARN') stats.warn++;
  results.push({ lesson, card, name, status, weight, detail });
}

/** 从 JS 源码里按花括号配平抠出一个对象字面量（正确处理字符串/模板串/转义） */
function extractObjectLiteral(src, declStart) {
  const braceAt = src.indexOf('{', declStart);
  if (braceAt < 0) return null;
  let depth = 0, i = braceAt, quote = null;
  for (; i < src.length; i++) {
    const c = src[i], prev = src[i - 1];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(braceAt, i + 1); }
  }
  return null;
}

function stripTags(html) {
  return html.replace(/<[^>]*>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/**
 * 按 div 配平切出一张卡片的边界。
 * 不能用「下一张卡片的位置」当边界——最后一卡会一路切到文件尾，
 * 把课程级 .footer-nav 和收尾 </div> 也算进来，误报「footer 被吞入卡片」。
 */
function sliceBalancedDiv(html, start) {
  const re = /<div\b|<\/div>/g;
  re.lastIndex = start;
  let depth = 0, m;
  while ((m = re.exec(html))) {
    if (m[0] === '<div') depth++;
    else if (--depth === 0) return html.slice(start, re.lastIndex);
  }
  return html.slice(start);
}

function splitCards(html) {
  const re = /<div class="card" data-card="([^"]+)"/g;
  const marks = [];
  let m;
  while ((m = re.exec(html))) marks.push({ id: m[1], start: m.index });
  return marks.map((mk) => ({ id: mk.id, html: sliceBalancedDiv(html, mk.start) }));
}

function loadSource(useSrc) {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  if (useSrc) {
    const shell = fs.readFileSync(path.join(ROOT, 'src', 'shell.html'), 'utf8');
    const lessons = new Map();
    for (const item of manifest.lessons) {
      lessons.set(item.id, {
        id: item.id,
        display: item.display,
        title: item.title,
        html: fs.readFileSync(path.join(ROOT, 'src', 'lessons', item.file), 'utf8'),
        origin: item.file,
      });
    }
    return { shell, lessons, manifest, origin: 'src/ (+ src/shell.html)' };
  }
  const dist = fs.readFileSync(path.join(ROOT, 'dist_course.html'), 'utf8');
  const blockStart = dist.indexOf('const INLINE_LESSONS');
  if (blockStart < 0) throw new Error('dist_course.html 中找不到 const INLINE_LESSONS');
  const blockEnd = dist.indexOf('\n};', blockStart);
  const block = dist.slice(blockStart, blockEnd);
  const lessons = new Map();
  for (const line of block.split('\n')) {
    const m = /^\s*(\d+): (".*"),$/.exec(line);
    if (!m) continue;
    const id = Number(m[1]);
    const meta = manifest.lessons.find((x) => x.id === id) || { display: id, title: `(id ${id})`, file: '-' };
    lessons.set(id, {
      id, display: meta.display, title: meta.title,
      html: JSON.parse(m[2]), origin: meta.file,
    });
  }
  return { shell: dist, lessons, manifest, origin: 'dist_course.html' };
}

function loadQnA(shell) {
  const at = shell.indexOf('const allHardcodedQnA');
  if (at < 0) return { data: null, error: '找不到 const allHardcodedQnA' };
  const literal = extractObjectLiteral(shell, at);
  if (!literal) return { data: null, error: 'allHardcodedQnA 花括号不配平（JS 语法已损坏）' };
  try {
    // eslint-disable-next-line no-new-func
    return { data: new Function('return ' + literal + ';')(), error: null };
  } catch (e) {
    return { data: null, error: 'allHardcodedQnA 无法解析：' + e.message };
  }
}

// 与 loadQnA 同构：allCardTopics 也必须配平且可解析。
// 新增这条的原因（2026-10-04，Bug→Check 闭环）：注册第 18 课时把 `18: {…}` 误插进
// 第 17 课的数据块（漏了 `},`），导致 allCardTopics 整体缺一个收尾 `}`——
// allHardcodedQnA 照常解析、内容层 2617 全 PASS，只有 provenance_check 的
// 逐课切片把第 17 课的 shellHash 判成"变了"（WARN）才间接暴露。
// 负向自测：删掉 allCardTopics 末尾一个 `}` → 本项 FAIL 并报"花括号不配平"。
function loadCardTopics(shell) {
  const at = shell.indexOf('const allCardTopics');
  if (at < 0) return { data: null, error: '找不到 const allCardTopics' };
  const literal = extractObjectLiteral(shell, at);
  if (!literal) return { data: null, error: 'allCardTopics 花括号不配平（JS 语法已损坏）' };
  try {
    // eslint-disable-next-line no-new-func
    return { data: new Function('return ' + literal + ';')(), error: null };
  } catch (e) {
    return { data: null, error: 'allCardTopics 无法解析：' + e.message };
  }
}

// ── 推理链三查：起点 / 连接词 / 回指（WARN 级）─────────────────────────────
// 依据 10-course-design「维度1 推理链」四条判据里可机械化的三条。
// 第 4 条「空白纸重建」仍需人判，不在此处硬造脚本。
//
// 关键实现约束：rn-key 一律写作 <b class="rn-key">…</b>，不能用 <span>——
// 因为 rn-text 的内容抽取用非贪婪 </span>，内层 span 会把匹配提前截断。
const RM_START_OK  = /任务|要求|约束|必须|需要/;
const RM_START_BAD = /缺点|不足|问题|不行|缺陷|做不到|无法|不满足/;
const RM_CONN      = /这就要求|因此|于是|否则|所以|这就/;

// 技术术语表（模块级：B-1/B-3 在卡片级用、B-4 在课级用）
const TERM_RE = /\b(self-attention|cross-attention|attention|query|keys?|values?|softmax|argmax|embedding|tokens?|heads?|mask|logits?|temperature|gradients?|cache|encoders?|decoders?|multi-head|causal|normaliz\w*|layer\s*norm|ffn|position\w*\s*encod\w*|projection|hidden state|dot product|representations?|context|residual|rope|rotary|gqa|mqa|rmsnorm|swiglu|pre-?norm|post-?norm|bpe|wordpiece|sentencepiece|tokeniz\w*|vocab\w*|perplexity|ppl|flops?|weight\s*tying|residual\s*stream|mle-bench|held-out|provenance|contamination|file-as-bus|worktree|best-so-far|silent error|hypothesis tree|paperbench|novelty|l1–l5|recomputation|activation\s*recomputation)\b/gi;

function checkRoadmapChain(html, label) {
  const texts = [...html.matchAll(/class="rn-text"[^>]*>([\s\S]*?)<\/span>/g)]
    .map((m) => stripTags(m[1]).replace(/\s+/g, ' ').trim());
  const keys = [...html.matchAll(/class="rn-key"[^>]*>([\s\S]*?)<\/b>/g)]
    .map((m) => stripTags(m[1]).trim());
  const title = stripTags((html.match(/class="roadmap-title"[^>]*>([\s\S]*?)<\/div>/) || ['', ''])[1]);
  if (!texts.length) return;

  // A-1 起点：必须以任务约束收束，不能以"旧方案怎么不行"收束
  // 起点有两种合法形态（2026-09-28 按用户反馈补全，不是放宽）：
  //   ① 从任务约束出发：「要满足 X，就必须…」
  //   ② 从"一个具体例子上暴露的失效"出发：「用这句话走一遍，读到第 12 个词时还留得住吗？」
  // ② 是被 10-course-design 认可的（"先让问题出现"），但**必须有具体所指**——
  // 靠引号内容或数字判定；抽象的结论式判断（"RNN 有三大问题"）仍不算合格起点。
  // 是否声明为「逻辑递进」型（20-content-rules 维度1：声明了就必须可检验）
  // 注意：否定式表述（"不是单向递进"）也含"递进"二字，必须先排除，否则导览型链被判成线性链
  const isLinear = /逻辑递进/.test(title)
    || (/递进/.test(title) && !/不[是再]?[^。；]{0,6}递进|非递进|并列/.test(title));
  const hasTask = RM_START_OK.test(texts[0]);
  const hasBad = RM_START_BAD.test(texts[0]);
  const hasExample = /[「『"“].+?[」』"”]/.test(texts[0]) || /\d/.test(texts[0]);
  const okStart = (hasTask || hasExample) && !hasBad;
  // 理由必须区分两种失败形态：① 起点没写成任务约束（只描述话题或机制）
  //                          ② 起点虽提到任务，却以"旧方案怎么不行"收束
  // 首版把两者混为一谈，对第 2~5 课报出"疑似以旧方案缺点收束"，理由与实情不符 —— 已修正。
  const a1Detail = (!hasTask && !hasExample)
    ? `起点既未表述为任务约束（缺 任务/要求/约束/必须/需要），也没有具体例子（引号或数字）：${texts[0].slice(0, 30)}`
    : (hasBad ? `起点以对旧方案的抽象判断收束：…${texts[0].slice(-26)}` : '');
  record(label, '-', 'A-1 推理链起点为任务约束（非旧方案缺点）', okStart ? 'PASS' : 'WARN', 2, a1Detail);

  // A-2 连接词：第 2 步起每步都要有可检验的推进词
  const noConn = texts.slice(1).filter((t) => !RM_CONN.test(t));
  record(label, '-', 'A-2 推理链连接词可检验（每步含 这就要求/因此/于是/否则/所以/这就）',
    noConn.length === 0 ? 'PASS' : 'WARN', 2,
    noConn.length ? `${noConn.length}/${texts.length - 1} 步缺推进词，例：${noConn[0].slice(0, 30)}` : '');

  // B-4 呼应：每个 roadmap 节点讲的东西，对应卡片必须真的在讲
  //     为什么需要它：A-1/A-2/A-3 都是 roadmap 内部自洽检查，H4 是台账自洽检查——
  //     没有任何一条管「节点 ↔ 卡片」的对应关系，于是 roadmap 讲语言建模、卡片讲 RNN 三大问题，
  //     两边各说各话而门禁全绿。这是这套机制里最大的一个洞（用户 2026-09-28 指出）。
  {
    const cards = splitCards(html);
    const miss = [];
    for (let i = 0; i < Math.min(texts.length, cards.length); i++) {
      const nodeTerms = new Set((texts[i].match(TERM_RE) || []).map((x) => x.toLowerCase()));
      if (nodeTerms.size === 0) { miss.push(`节点${i + 1} 未含技术术语`); continue; }
      const cardText = stripTags(cards[i].html).toLowerCase();
      if (![...nodeTerms].some((t) => cardText.includes(t))) {
        miss.push(`节点${i + 1}（${[...nodeTerms].join('/')}）在 Card ${cards[i].id} 里找不到`);
      }
    }
    record(label, '-', 'B-4 推理链节点与卡片呼应（节点讲的，卡片真的在讲）',
      miss.length === 0 ? 'PASS' : 'WARN', 3,
      miss.length ? miss.join('；') : `${Math.min(texts.length, cards.length)} 对节点/卡片全部呼应`);
  }

  // B-5 命题同源（形式部分）：B-4 只数"节点术语有没有出现在卡片里"——
  //     但**名词重合 ≠ 命题同源**。实测：节点讲"为什么必须分两塔"（推导型），
  //     对应卡主问题却是"结构是什么、各干什么"（描述型），B-4 判 PASS 而实际不相关。
  //     形式判据：节点含因果/约束词时，该卡主问题必须是推导型问法。
  //     注意：这只判"问法类型"，判不了"命题是否真同源"——后者无唯一答案，仍需人判/盲审。
  {
    const cards = splitCards(html); // B-5 独立作用域，需自行取卡片（B-4 的 cards 在其块内）
    const WHY_Q = /为什么|为何|凭什么|怎么保证|需要满足|不.{0,6}会怎样|代价是什么|到底解决/;
    // 「目标/条件型」问法也算同源：把节点的前提嵌进问句、再问"怎么做到"
    // （如节点讲"要求直连"、卡片问"要让两位直接比对该怎么算" —— 这是同源，不是描述型）
    const GOAL_Q = /要让|要满足|要想|为了|在.{0,12}前提下|给定|既要|能不能/;
    const WHAT_Q = /是什么|有什么|哪几|各是|怎么连|包括哪些|长什么样|发生了什么|怎么算|是怎么/;
    // 只对**约束型**节点要求（排除"拼起来/走一遍"这类汇总节点，它们不需要"为什么"式提问）
    const RM_CONSTRAINT = /约束|要求|必须|需要|不能/;
    const bad = [];
    for (let i = 0; i < Math.min(texts.length, cards.length); i++) {
      if (!RM_CONSTRAINT.test(texts[i])) continue;
      // 汇总节点（"拼起来/走一遍/小结"）结尾常回指"上面哪一条约束"——那是回指，不是约束型节点
      if (/拼起来|走完|走一遍|小结|总结|回顾/.test(texts[i])) continue;
      const qt = stripTags((cards[i].html.match(/class="card-q-text"[^>]*>([\s\S]*?)<\/div>/) || [, ''])[1]);
      if (!WHY_Q.test(qt) && !GOAL_Q.test(qt) && WHAT_Q.test(qt)) {
        bad.push(`节点${i + 1} 是推导型（何以致此），但 Card ${cards[i].id} 主问题是描述型：「${qt.slice(0, 24)}」`);
      }
    }
  // B-10 表格容器：<table> 必须落在有表格样式的容器内。
  //     仅 .calc-block（L220）与 .qna-item-a（L462）定义了表格样式；
  //     放进 .highlight-box / .content-section / .analogy-block / .card-bg 会渲染成
  //     无样式松散文本（实测 2026-09-28：用户指出 Card 5-1 参数表"没人能看清"）。
  {
    const cards = splitCards(html);
    const BLOCK = /class="(calc-block|highlight-box|content-section|analogy-block|compare-table|card-bg)"/g;
    // 2026-09-28：CSS 已为 .highlight-box / .content-section 的 table 补样式（shell.html L220-226），
    //     故这两个容器同步纳入合法集（检测逻辑更新，非放宽条件）。
    const OKBLOCK = new Set(['calc-block', 'compare-table', 'highlight-box', 'content-section']);
    const bad = [];
    for (const c of cards) {
      const area = (c.html.match(/class="card-a"[\s\S]*?(?=<div class="tab-bar")/) || [''])[0];
      let m;
      const tabs = [];
      while ((m = area.match(/<table/g))) { tabs.push(area.indexOf('<table', tabs.length ? tabs[tabs.length - 1] + 1 : 0)); if (tabs.length > 20) break; m = null; }
      for (const pos of tabs) {
        const head = area.slice(0, pos);
        let last = null, mm;
        BLOCK.lastIndex = 0;
        while ((mm = BLOCK.exec(head))) last = mm[1];
        if (last && !OKBLOCK.has(last)) bad.push(`Card ${c.id} 的 <table> 落在 .${last} 内（无表格样式）`);
      }
    }
    const uniq = [...new Set(bad)];
    record(label, '-', 'B-10 表格容器（<table> 必须在 .calc-block 等有样式的容器内）',
      uniq.length === 0 ? 'PASS' : 'WARN', 2,
      uniq.length ? uniq.join('；') : '所有表格都在有样式的容器内');
  }

  // B-8 主问题↔正文 一致：主问题承诺的推导，正文必须真的做。
  //     实测教训（2026-09-28，用户指出）：把 Card 5-1 主问题改成"为什么必须分两塔"，
  //     正文却仍是"结构是什么 + 参数表"——B-5 判 PASS，但主问题与正文脱节，
  //     门禁全绿而内容更不一致。根因：B-5 只查「节点↔主问题」两端，漏了正文这一中间环。
  {
    const cards = splitCards(html);
    const DERIVE = /因为|由于|这就要求|因此|为了|所以|必须|否则|才需要|导致|凭什么/;
    const dry = [];
    for (let i = 0; i < Math.min(texts.length, cards.length); i++) {
      const qt = stripTags((cards[i].html.match(/class="card-q-text"[^>]*>([\s\S]*?)<\/div>/) || [, ''])[1]);
      if (!/为什么|为何|怎么保证|凭什么/.test(qt)) continue; // 只对推导型主问题要求
      // 从**第一个 .content-section 起**取正文——跳过 .card-bg（知识背景），
      // 否则背景占满前 320 字窗口，真正的推导句会被挤出窗外（首版即因此误报）
      const body = stripTags((cards[i].html.match(/class="content-section"[\s\S]*/) || [''])[0]).slice(0, 320);
      if (!DERIVE.test(body)) {
        dry.push(`Card ${cards[i].id} 主问题问"为什么"，但正文前 320 字无推导词（因为/因此/这就要求…）`);
      }
    }
    record(label, '-', 'B-8 主问题↔正文 一致（推导型主问题，正文必须真的推导）',
      dry.length === 0 ? 'PASS' : 'WARN', 3,
      dry.length ? dry.join('；') : '推导型主问题都配了真实推导');
  }

    record(label, '-', 'B-5 节点↔卡片 命题同源（约束型节点 ↔ 推导型主问题）',
      bad.length === 0 ? 'PASS' : 'WARN', 3,
      bad.length ? bad.join('；') : '全部约束型节点都对应着推导型主问题');
  }

  // A-3 回指：**仅对声明为「逻辑递进」的链生效**。
  // 依据 20-content-rules 维度1：「出现正交插入即判 P1，必须重排链 **或**明确标注为"支链"，
  // 并把 roadmap-title 改为与事实相符的表述」——声明了递进就必须可检验；声明为导览型则允许并列支链。
  const miss = [];
  if (isLinear) {
    for (let i = 1; i < texts.length; i++) {
      const k = keys[i - 1];
      if (k && !texts[i].includes(k)) miss.push(`节点${i + 1} 未回指「${k}」`);
    }
  }
  const noKey = keys.length < texts.length - 1
    ? `（rn-key 标注 ${keys.length} 个，少于所需 ${texts.length - 1}）` : '';
  record(label, '-', 'A-3 推理链回指（声明"递进"时：下一节点含上一节点 rn-key）',
    !isLinear || (miss.length === 0 && !noKey) ? 'PASS' : 'WARN', 3,
    !isLinear ? '导览型链（title 未声明"递进"），按维度1 规则允许并列支链'
      : (miss.length || noKey ? `${miss.join('，')}${noKey}` : ''));
}

function check() {
  const useSrc = process.argv.includes('--src');
  const quiet = process.argv.includes('--quiet');
  const { shell, lessons, manifest: manifest0, origin } = loadSource(useSrc);

  console.log(`\n内容验证 content_verify.js   源: ${origin}\n`);

  // 0. 全局：QnA 数据必须可解析（对应 8 类问题第 6 类 JS/JSON 语法错误）
  const qna = loadQnA(shell);
  record('全局', '-', 'QnA 数据可解析（引号/trailing comma）', qna.error ? 'FAIL' : 'PASS', 10, qna.error || '');
  if (qna.error) {
    printReport(quiet);
    return 1;
  }

  // 0a. 全局：allCardTopics 数据必须可解析（对应"新增一课把数据块插错位置"这类语法损坏）
  const topics = loadCardTopics(shell);
  record('全局', '-', 'cardTopics 数据可解析（花括号配平/trailing comma）', topics.error ? 'FAIL' : 'PASS', 10, topics.error || '');
  if (topics.error) {
    printReport(quiet);
    return 1;
  }
  const topicIds = Object.keys(topics.data).map(Number).sort((a, b) => a - b);
  const missingTopics = manifest0.lessons.map((x) => x.id).filter((id) => !topicIds.includes(id));
  record('全局', '-', '每课都有 cardTopics 数据块', missingTopics.length === 0 ? 'PASS' : 'FAIL', 5,
    missingTopics.length ? `缺课 id: ${missingTopics.join(', ')}` : `共 ${topicIds.length} 课`);

  // 0b. 课程映射表：manifest 与产物课程数一致，且每个源文件都在
  const ids = [...lessons.keys()].sort((a, b) => a - b);
  const missing = manifest0.lessons.filter((x) => !fs.existsSync(path.join(ROOT, 'src', 'lessons', x.file)));
  record('全局', '-', 'manifest 与产物课程数一致',
    manifest0.lessons.length === ids.length ? 'PASS' : 'FAIL', 5,
    `manifest=${manifest0.lessons.length} 产物=${ids.length}`);
  record('全局', '-', 'manifest 引用的源文件都存在',
    missing.length === 0 ? 'PASS' : 'FAIL', 5,
    missing.map((x) => x.file).join(', '));

  // 0e. 全文件 div 总数配平（防「切片器自证」盲区）
  //
  // 为什么必须有这条：`splitCards` 用 sliceBalancedDiv **按 div 配平**切卡片——
  // 若某卡多写了一个 </div>，切片会在"深度归零"处提前结束，而该卡仍可能包含
  // tab-qna/data-qna，于是「卡片内 div 配对」这项**按切片自证**的检查照样 PASS。
  // 实测（2026-10-04，第 16 课）：Card 16-5 漏写 `<div class="llm-chat" data-llm="16-5">`
  // 开标签，全文件 <div> 236 / </div> 237，内容层其余检查全部 PASS——是独立盲审的
  // 全局 <div>/< /div> 计数才抓到的。本条把它变成内容层的 FAIL 级检查。
  // 负向自测（当轮实测）：从 lesson-16 删掉任一 </div> → 该课 FAIL 并报 <div>=237 </div>=236；还原 → PASS。
  {
    const unbalanced = [];
    for (const item of manifest0.lessons) {
      const les = lessons.get(item.id);
      if (!les) continue;
      const o = (les.html.match(/<div\b/g) || []).length;
      const c = (les.html.match(/<\/div>/g) || []).length;
      if (o !== c) unbalanced.push(`id${item.id} <div>=${o} </div>=${c}`);
    }
    record('全局', '-', '全文件 div 总数配平（防切片器自证盲区）',
      unbalanced.length === 0 ? 'PASS' : 'FAIL', 8,
      unbalanced.length ? unbalanced.join('；') : `${manifest0.lessons.length} 课全部配平`);
  }

  // 0c. 多课节奏统一：各课卡片数应一致
  const counts = ids.map((id) => splitCards(lessons.get(id).html).length);
  const uniform = new Set(counts).size === 1;
  record('全局', '-', '各课卡片数一致', uniform ? 'PASS' : 'WARN', 5,
    counts.map((c, i) => `id${ids[i]}:${c}`).join(' '));

  // 0d. 标题四处一致（防副本漂移）
  //
  // 为什么要有这条：课名在 4 个可机械读取的位置各存一份 ——
  //   ① manifest.json 的 title；② 课内 `.lesson-intro > h2`；
  //   ③ shell.html 的 `LESSON_TITLES[id]`（顶部栏用）；④ 侧边栏 `.nav-title`。
  // 此前已实际出现三类不一致（都不是脚本能"算错"的那种，而是**同一事实多副本不同步**）：
  //   · 第 13 课页脚引用的第 14 课标题是旧稿「显存账本与混合精度——训一个 70B，…」；
  //   · 第 1 课 manifest 带副题、h2 不带；
  //   · 第 8/10/11 课侧边栏用短名、manifest/h2 用带副题的长名。
  // 负向自测（本轮实测）：① 只改 manifest 一个 title → 该课 FAIL；② 只改 h2 → 该课 FAIL；
  //   ③ 四处一致 → PASS（当前 14 课全 PASS）。
  //
  // 约定：标题一律是「领域短名」，统一格式为 `第 <display> 课：<title>`；
  //       本课主线问题写在课内 `.subtitle`，**不进标题**（侧边栏可用宽度仅 175px，见课表文档）。
  {
    const asideStart = shell.indexOf('<aside');
    const asideEnd = shell.indexOf('</aside>', asideStart);
    const aside = asideStart >= 0 ? shell.slice(asideStart, asideEnd) : '';
    const ltStart = shell.indexOf('const LESSON_TITLES');
    const ltEnd = ltStart >= 0 ? shell.indexOf('};', ltStart) : -1;
    const ltBlock = ltStart >= 0 ? shell.slice(ltStart, ltEnd) : '';
    const titleIssues = [];
    for (const item of manifest0.lessons) {
      const les = lessons.get(item.id);
      if (!les) continue;
      const expect = `第 ${item.display} 课：${item.title}`;
      const h2m = /<h2>([^<]*)<\/h2>/.exec(les.html);
      const h2Text = h2m ? h2m[1].trim() : '(课内无 h2)';
      const ltm = ltBlock ? new RegExp(`(?:^|[\\s{])${item.id}:\\s*'([^']*)'`).exec(ltBlock) : null;
      const ltText = ltm ? `第 ${item.display} 课：${ltm[1]}` : '(LESSON_TITLES 缺项)';
      const navm = aside
        ? new RegExp(`data-lesson="${item.id}"[\\s\\S]{0,300}?<span class="nav-title">([^<]*)</span>`).exec(aside)
        : null;
      const navText = navm ? navm[1].trim() : '(侧边栏缺项)';
      if (h2Text !== expect) titleIssues.push(`id${item.id} 课内h2="${h2Text}" 应为 "${expect}"`);
      if (ltText !== expect) titleIssues.push(`id${item.id} LESSON_TITLES="${ltText}" 应为 "${expect}"`);
      if (navText !== expect) titleIssues.push(`id${item.id} 侧边栏="${navText}" 应为 "${expect}"`);
    }
    record('全局', '-', '标题四处一致（manifest / 课内 h2 / LESSON_TITLES / 侧边栏）',
      titleIssues.length === 0 ? 'PASS' : 'FAIL', 8,
      titleIssues.length === 0 ? '14 课全部一致'
        : titleIssues.slice(0, 5).join(' ; ') + (titleIssues.length > 5 ? ` …共 ${titleIssues.length} 处` : ''));
  }

  // 0e-2. 课号自洽（manifest 的 id ≡ display ≡ 文件名）＋ 卡片 id 自洽
  //
  // 为什么要有这两条：2026-10-04 用户指出「id 和课程 number 不一致问题有些严重」。
  // 历史上 id 是引擎内部句柄、display 是学员看到的课号，两套编号分叉——前 5 课是 1,5,2,3,4，
  // 第 20 课之后整段错位（第20课 id=26、第26课 id=29…）。后果是真实存在的：allCardTopics
  // 按 id 取数取不到、报表/页码贴错课、脚本按 id 找文件找不着。已全量重编号为「id ≡ 课号」。
  //
  // 这两条防它再次分叉：
  //   ① manifest 自洽：id === display，file === lesson-<id>.html
  //   ② 课内自洽：data-card 前缀 === 本课课号；内联 JS（switchTab/startChat/refreshQnA…）
  //      里单引号引用的卡 id 必须真的在本课 DOM 里存在（重编号只改 DOM 不改内联 JS，
  //      就会点开 tab 找不到面板——这正是本轮真实踩过的坑）
  //
  // 负向自测（2026-10-04 实测）：把某课 display 改成 99 → FAIL 点名；
  //   把某课内联 switchTab(this,'qna','N-1') 的 N 写回旧号 → FAIL 点名「引用了不存在的卡 id」。
  //   注意：第 1 课历史上用「裸卡号」（data-card="1"），两条检查都对其放行（保持现状）。
  {
    const idIssues = [];
    for (const item of manifest0.lessons) {
      if (item.id !== item.display) idIssues.push(`id${item.id} display=${item.display} 不一致`);
      if (item.file !== `lesson-${item.id}.html`) idIssues.push(`id${item.id} file=${item.file} 应名 lesson-${item.id}.html`);
    }
    record('全局', '-', '课号自洽（manifest 的 id ≡ display ≡ lesson-<id>.html）',
      idIssues.length === 0 ? 'PASS' : 'FAIL', 6,
      idIssues.length === 0 ? `${manifest0.lessons.length} 课自洽` : idIssues.slice(0, 5).join(' ; '));

    const cardIssues = [];
    let refTotal = 0;
    for (const item of manifest0.lessons) {
      const les = lessons.get(item.id);
      if (!les) continue;
      const cards = [...les.html.matchAll(/data-card="([^"]+)"/g)].map((m) => m[1]);
      const bare = cards.length > 0 && cards.every((c) => /^\d+$/.test(c));   // 第 1 课：裸卡号
      if (!bare) {
        const wrong = [...new Set(cards.filter((c) => c.split('-')[0] !== String(item.id)))];
        if (wrong.length) cardIssues.push(`id${item.id} data-card 前缀应=${item.id}，实际 ${wrong.slice(0, 3).join('/')}`);
      }
      const refs = new Set([...les.html.matchAll(/(?<=')(\d{1,2}-\d)(?=')/g)].map((m) => m[1]));
      refTotal += refs.size;
      const ghost = [...refs].filter((r) => !cards.includes(r));
      if (ghost.length) cardIssues.push(`id${item.id} 内联 JS 引用了本课不存在的卡 id：${ghost.slice(0, 4).join('/')}`);
    }
    record('全局', '-', '卡片 id 自洽（DOM 前缀 ≡ 课号；内联引用不指向不存在的卡）',
      cardIssues.length === 0 ? 'PASS' : 'FAIL', 8,
      cardIssues.length === 0 ? `28 课自洽，内联卡 id 引用 ${refTotal} 处全部命中`
        : cardIssues.slice(0, 5).join(' ; '));
  }

  // 0f. 术语白话化（受众校准：本课面向"懂搜索/推荐、不懂大模型"的学员）
  //
  // 为什么要有这条：2026-10-04 用户评审——「从第二部分起不像在教初学者，名词概念不陈述」。
  // 审计见 reports/00-术语白话化审计.md：L7–L25 共 229 个术语首现点，174 个（76%）裸用；
  // 抽样 4/4 个术语的**首现位置在正文之前**（.goal-text / .meta-tags / .roadmap），
  // 即学员读到正文前就被英文专名拦住。
  //
  // 判定：**英文缩写/专名**首次出现后 30 字内须有白话标记（即/就是/指的是/（…）等）。
  // 中文常用术语（梯度、显存、采样…）不纳入硬检查——它们对目标读者并非完全不透明，
  // 硬套会制造误报，改由台账「语义」类行人工判（见 reports/00-术语白话化审计.md 第四节）。
  //
  // 负向自测（本轮实测）：给 lesson-13 的 ZeRO 补一句白话 → 全局裸用数由 **85/101 降为 84/101**；
  // 说明检测器确实随输入变化（而非恒真/恒假）。当前基线：84/101 裸用、涉及 21 课 → 本项 WARN。
  {
    const HARD_TERMS = [
      ['SFT', 'SFT'], ['RLHF', 'RLHF'], ['DPO', 'DPO'], ['GRPO', 'GRPO'], ['PPO', 'PPO'],
      ['LoRA', 'LoRA'], ['QLoRA', 'QLoRA'], ['ZeRO', 'ZeRO'], ['FSDP', 'FSDP'],
      ['FP16', 'FP16'], ['BF16', 'BF16'], ['KV Cache', 'KV Cache'], ['PagedAttention', 'PagedAttention'],
      ['ReAct', 'ReAct'], ['RAG', 'RAG'], ['MoE', 'MoE'], ['RoPE', 'RoPE'], ['logits', 'logits'],
      ['pass@k', 'pass@k'], ['PPL', 'PPL'], ['GQA', 'GQA'], ['MQA', 'MQA'], ['MLA', 'MLA'],
      ['RMSNorm', 'RMSNorm'], ['SwiGLU', 'SwiGLU'], ['FlashAttention', 'FlashAttention'],
      ['vLLM', 'vLLM'], ['SGLang', 'SGLang'], ['AdamW', 'AdamW'], ['RLVR', 'RLVR'],
    ];
    const GLOSS_MARKERS = ['即', '就是', '指的是', '意思是', '称为', '也就是', '换句话说', '相当于', '又叫', '叫做', '是指', '表示', '——'];
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const bareByLesson = [];
    let totalFound = 0, totalBare = 0;
    for (const item of manifest0.lessons) {
      const les = lessons.get(item.id);
      if (!les) continue;
      // 排除 .footer-nav：页脚里出现的是**下一课的课名**，而课名被「标题四处一致」锁死、
      // 不允许加白话括注（改了就会与 manifest/LESSON_TITLES/侧边栏不一致）。
      // 这是检查器误报（2026-10-04 实测：4 条裸用全部落在页脚）。导航文字不是教学内容。
      const text = stripTags(les.html.replace(/<div class="footer-nav">[\s\S]*?<\/div>/g, ' '));
      const bare = [];
      for (const [name, lit] of HARD_TERMS) {
        const re = new RegExp(`\\b${esc(lit)}\\b`);
        const m = re.exec(text);
        if (!m) continue;
        totalFound++;
        const after = text.slice(m.index + m[0].length, m.index + m[0].length + 30);
        const near = text.slice(m.index + m[0].length, m.index + m[0].length + 4);
        const ok = GLOSS_MARKERS.some((g) => after.includes(g)) || /[（(]/.test(near);
        if (!ok) { bare.push(name); totalBare++; }
      }
      if (bare.length) bareByLesson.push(`id${item.id}:${bare.length}(${bare.join('/')})`);
    }
    record('全局', '-', '术语白话化：英文专名首现须有白话解释',
      bareByLesson.length === 0 ? 'PASS' : 'WARN', 6,
      bareByLesson.length === 0
        ? `全部 ${totalFound} 个术语首现点均有白话解释`
        : `${totalBare}/${totalFound} 裸用 → ` + bareByLesson.slice(0, 6).join('；') +
          (bareByLesson.length > 6 ? ` …共 ${bareByLesson.length} 课` : ''));
  }

  // ── 覆盖地图 / 领域锚点：已于 2026-10-04 从「交付物」迁出 ──────────────────
  // 用户要求：覆盖地图设计保留，但**不在 HTML 中暴露给学生、不在代码中对学生页面
  // 发挥作用**。内容归档到 `docs/coverage-maps.md`，保障机制（每课一节 / 四段齐备 /
  // 锚点落地 / 学生页面不得残留）迁到 `tools/coverage_check.js`，由 gate.js 当第 3 把锁。
  // 故此处**不再**对学生 HTML 强制覆盖地图。

  for (const id of ids) {
    const lesson = lessons.get(id);
    const label = `第${lesson.display}课 id=${id} ${lesson.title}`;
    const cards = splitCards(lesson.html);

    record(label, '-', '课程含卡片', cards.length ? 'PASS' : 'FAIL', 5, `卡片数 ${cards.length}`);
    if (!cards.length) continue;

    // 课程级：推理链三查（.roadmap 属于课程级，不属于任何单卡）
    checkRoadmapChain(lesson.html, label);

    // 课程级：footer 必须在卡片之外（每卡切片已按 div 配平，见 sliceBalancedDiv）

    for (const card of cards) {
      const cardLabel = `Card ${card.id}`;
      const cardHtml = card.html;
      const text = stripTags(cardHtml);

      // 1) 7 大核心组件
      for (const [name, needle, human] of REQUIRED_PER_CARD) {
        record(label, cardLabel, `组件 ${name}（${human}）`, cardHtml.includes(needle) ? 'PASS' : 'FAIL', 1, '');
      }

      // 2) 卡片 id 与 tab/qna 绑定一致（8 类问题第 8 类）
      const bound = cardHtml.includes(`id="tab-qna-${card.id}"`) && cardHtml.includes(`data-qna="${card.id}"`);
      record(label, cardLabel, 'id 与 tab-qna/qna-list 绑定一致', bound ? 'PASS' : 'FAIL', 3,
        bound ? '' : `期望 tab-qna-${card.id} 与 data-qna="${card.id}"`);

      // 3) div 配对平衡（漏 </div> 会让卡片合并）
      const open = (cardHtml.match(/<div\b/g) || []).length;
      const close = (cardHtml.match(/<\/div>/g) || []).length;
      record(label, cardLabel, 'div 配对平衡', open === close ? 'PASS' : 'FAIL', 3, `<div>=${open} </div>=${close}`);

      // 4) 卡片不得嵌套
      const nested = (cardHtml.match(/<div class="card" data-card=/g) || []).length > 1;
      record(label, cardLabel, '卡片未嵌套', nested ? 'FAIL' : 'PASS', 3, nested ? '卡片内又出现 .card' : '');

      // 5) footer-nav 不得在卡片内
      const footerIn = cardHtml.includes('footer-nav');
      record(label, cardLabel, 'footer-nav 未吞入卡片', footerIn ? 'FAIL' : 'PASS', 3,
        footerIn ? '卡片内出现 footer-nav，多半漏写 </div>' : '');

      // 6) 问题以问号结尾
      const q = /<div class="card-q-text">([\s\S]*?)<\/div>/.exec(cardHtml);
      const qText = q ? stripTags(q[1]).trim() : '';
      record(label, cardLabel, '问题以问号结尾', /[？?]$/.test(qText) ? 'PASS' : 'WARN', 2,
        qText ? `实际结尾：…${qText.slice(-18)}` : '未取到问题文本');

      // 7) 提示必须存在；偏长只报警（是否泄题属语义，需人工判）
      const hint = /<div class="card-q-hint">([\s\S]*?)<\/div>/.exec(cardHtml);
      const hintText = hint ? stripTags(hint[1]).trim() : '';
      if (!hintText) {
        record(label, cardLabel, '提示存在', 'FAIL', 2, '缺 .card-q-hint');
      } else if (hintText.length > GATE.hintWarnChars) {
        record(label, cardLabel, '提示长度合理', 'WARN', 2, `${hintText.length} 字偏长，人工确认是否泄题：${hintText.slice(0, 40)}`);
      } else {
        record(label, cardLabel, '提示存在', 'PASS', 2, '');
      }

      // 8) 计算块 step 标题数（每步独立标题）
      const steps = (cardHtml.match(/class="step-title"/g) || []).length;
      record(label, cardLabel, `计算块 step-title ≥${GATE.calcSteps}`, steps >= GATE.calcSteps ? 'PASS' : 'WARN', 2, `实际 ${steps}`);

      // 9) 门禁：不同数字个数
      const nums = new Set((text.match(/\d+(?:\.\d+)?/g) || []));
      record(label, cardLabel, `不同数字 ≥${GATE.distinctNumbers}`, nums.size >= GATE.distinctNumbers ? 'PASS' : 'FAIL', 2, `实际 ${nums.size}`);

      // 10) 门禁：计算等式
      //     口径修复（2026-09-29）：原实现用 stripTags(cardHtml) 后数 `=` 的个数，但 stripTags 会把
      //     `<` `>` 转义成 `&lt;` `&gt;`，于是「≤」「≥」这类比较符在 HTML 里写作 `&le;`/`&ge;` 时
      //     不受影响，而**表格里用 `=` 表达的等式**（如「总参数 = 6.74B」）会被计入 —— 这本身没问题；
      //     真正的问题是**只统计 `=`，不统计「≈」「→」等推导符号**，导致「用 ≈ 表达的计算走查」被判 0。
      //     现改为：`=` / `≈` / `→`（推导箭头）任一出现即计入，与「计算走查」的语义一致。
      const eqs = (text.match(/[=＝≈→]/g) || []).length;
      record(label, cardLabel, `计算等式 ≥${GATE.equations}`, eqs >= GATE.equations ? 'PASS' : 'FAIL', 2, `实际 ${eqs}`);

      // 11) 门禁：追问条数
      const perLesson = qna.data[String(id)] || {};
      const list = perLesson[String(card.id)] || perLesson[card.id] || [];
      const n = Array.isArray(list) ? list.length : 0;
      record(label, cardLabel, `追问答数 ≥${GATE.qnaPerCard}`, n >= GATE.qnaPerCard ? 'PASS' : 'FAIL', 4, `实际 ${n}`);

      // 12) 每条追问必须带 table + 数字（PDF：每条带 table 和数字答案）
      if (Array.isArray(list) && list.length) {
        const bad = list.filter((it) => !/<table/i.test(it.a || '') || !/\d/.test(stripTags(it.a || '')));
        record(label, cardLabel, '每条追问答案含 table + 数字', bad.length === 0 ? 'PASS' : 'WARN', 2,
          bad.length ? `${bad.length}/${list.length} 条不达标，例：${String(bad[0].q).slice(0, 26)}` : '');
      } else {
        record(label, cardLabel, '每条追问答案含 table + 数字', 'WARN', 2, '无追问数据可查');
      }

      // 13) .qna-title 里声明的条数必须与实际条数一致
      //     Bug→Check：lesson-5.html 的标题写死「学生最可能追问的 5 个问题」，
      //     但该课每卡只有 4 条追问 → 学员看到的标题与内容不符。
      const titleM = cardHtml.match(/class="qna-title"[^>]*>([\s\S]*?)</);
      const declared = titleM ? (stripTags(titleM[1]).match(/\d+/) || [])[0] : null;
      if (declared !== null && Number(declared) !== n) {
        record(label, cardLabel, '.qna-title 条数与实际一致', 'FAIL', 2,
          `标题写「${declared} 个问题」，实际 ${n} 条`);
      } else if (declared !== null) {
        record(label, cardLabel, '.qna-title 条数与实际一致', 'PASS', 2, '');
      }

      // ── 质量维度（WARN 级，把「质量低」从纯人判变为部分可拦）────────────
      //     Bug→Check：第 1 课实测「Card 1/2/3/4 正文无生活类比」「Card 5 缺桥接句」
      //     此前只靠人工语义判断，且容易被漏。以下三条把它变成机械可检测。

      // 14) 非首卡：正文首段须一句话回顾上一卡结论（桥接）
      //     依据 20-content-rules 第七节 #5
      const isFirstCard = cards.indexOf(card) === 0;
      if (!isFirstCard) {
        const firstSec = /<div class="content-section"[^>]*>([\s\S]*?)<\/div>/.exec(cardHtml);
        const firstSecText = firstSec ? stripTags(firstSec[1]).trim() : '';
        const BRIDGE = /上一|前一|前卡|前面|之前|刚才|接着|延续|回到|上张/;
        const ok = BRIDGE.test(firstSecText.slice(0, 40));
        record(label, cardLabel, '非首卡正文首句有桥接（回顾上一卡）', ok ? 'PASS' : 'WARN', 2,
          ok ? '' : `首句未见桥接信号：${firstSecText.slice(0, 28)}`);
      }

      // 15) 新机制须配可复用生活类比，且写在正文里（不能只埋在追问）
      //     依据 20-content-rules 第七节 #1
      const ANALOGY = /就像|好比|打个比方|类比|相当于|如同|像一个|像是|想象一下|比方说/;
      const hasAnalogy = cardHtml.includes('analogy-block') || ANALOGY.test(text);
      record(label, cardLabel, '正文含生活类比（.analogy-block 或类比句）', hasAnalogy ? 'PASS' : 'WARN', 2,
        hasAnalogy ? '' : '正文无类比信号，类比可能只埋在追问里（学员要展开才看到）');

      // ── 专业性维度（WARN 级）──────────────────────────────────────────
      //     Bug→Check：第 1 课推理链实测「打比方打到主体丢了」——
      //     用"一组权重"替代 attention weights、用"跑起来"替代自回归解码，
      //     学员学完说不出专业名，也就读不了论文与代码。
      //     依据 20-content-rules 第七节 #6：术语是主体，类比是脚手架。

      // 17) 术语密度下限：正文至少出现 3 个不同的英文技术术语
      //     选英文而非中文做判据：ASCII 词边界明确，误报率低
      //     （中文的"头/值/键"会被"开头/值/关键"误命中）
      //     B-1 骨架位术语：术语必须出现在"骨架位置"（主问题 / 知识背景 / 加粗小标题 / label），
      //     而不是要求正文术语数量 —— 旧版"术语 ≥3 个"是个坏指标：只数数量、不判用法，
      //     实测诱导把 roadmap 写成术语串（"语言建模→token→长距离依赖→时间步串行"）。
      const skeleton = [
        (cardHtml.match(/class="card-q-text"[^>]*>([\s\S]*?)<\/div>/) || [, ''])[1],
        (cardHtml.match(/class="card-bg"[^>]*>([\s\S]*?)<\/div>/) || [, ''])[1],
        (cardHtml.match(/class="label"[^>]*>([\s\S]*?)<\/div>/) || [, ''])[1],
      ].map((x) => stripTags(x)).join(' ');
      const skeletonTerms = new Set((skeleton.match(TERM_RE) || []).map((x) => x.toLowerCase()));
      // 【已下线 2026-09-28】此处原为 B-1「骨架位含技术术语」WARN。
      // 下线理由（走「规则卫生」的降级路径，见 30-dev-rules.md 第八节）：
      //   ① 用"英文词是否出现"这个**近似代理**去测"学员能否记住机制名"这个**软标准**——
      //      硬门禁套软标准会诱导优化指标（实测：逼我把 roadmap 写成术语串）；
      //   ② TERM_RE 词表不全（RNN / LSTM / Transformer 均不在内）→ 对第 1 课 4 张卡**误报**。
      // 改由核验台账「语义」类行承担（人判"机制名是否出现在骨架位"）。
      void skeletonTerms;

      //     B-3 术语堆砌上限：单句技术术语 ≤3 个（防"术语串"，与 B-1 成上下界）
      //     切句口径修复（2026-09-29，独立复核提出）：原实现直接对 `text`（= stripTags(cardHtml)）
      //     按 。！？；; 切句，而 stripTags 已把 </tr> 等块级标签变成空格 —— 于是一整张参数表会被
      //     折成"一个 10 术语的句子"，对 Card 5-1「🧮 参数账」这类**表格卡**稳定误报。
      //     同一文件的 H4 用 claimCount 却先把块级边界换成句号 —— 同文件两套切句口径，属实现缺陷。
      //     现改为与 claimCount 完全一致的归一化顺序（先块级边界→再剥标签→再切句）。
      const overStuffed = (cardHtml
        .replace(/<\/(tr|div|p|li|h[1-6])>/gi, '。')
        .replace(/<br\s*\/?>/gi, '。')
        .replace(/<[^>]+>/g, ' ')
        .split(/[。！？；;]/).map((x) => x.trim().replace(/\s+/g, ' '))
        .filter((x) => new Set((x.match(TERM_RE) || []).map((y) => y.toLowerCase())).size >= 4));
      record(label, cardLabel, '专业性：单句术语 ≤3 个（防术语串）', overStuffed.length === 0 ? 'PASS' : 'WARN', 2,
        overStuffed.length === 0 ? '' : `${overStuffed.length} 句堆了 ≥4 个术语，例：${overStuffed[0].slice(0, 42)}`);

      // 18) 类比配额：每卡类比句 ≤2 处（类比过量会挤占术语建构的认知容量）
      const analogyN = (text.match(/就像|好比|打个比方|类比|相当于|如同|像一个|像是|想象一下|比方说/g) || []).length;
      record(label, cardLabel, '类比配额 ≤2 处', analogyN <= 2 ? 'PASS' : 'WARN', 2,
        analogyN <= 2 ? '' : `${analogyN} 处，类比过量`);

      // 16) 同课基础量口径一致
      //     依据 20-content-rules 第七节 #4
      //     注意：同一张卡里出现多个 d_model 往往是「讲原论文时用 512、讲现代模型时用 4096、
      //     做算术时又用 768」——必须先报「同卡多取值」，而不是拿第一处去和别的量做算术
      //     （早期版本用首个匹配做 h×d_k 比较，会跨语境比对，报出错误理由）。
      //     口径豁免（2026-09-29，独立复核提出）：教学卡片常「用原论文真实配置讲背景、再用压到
      //     4 维的小例子做手算走查」。若该卡**已显式注明**了这种切换（如「原论文真实配置是
      //     d_model=512，这里为便于手算压到 4 维」），则不再报 WARN —— 否则这条检查会稳定误报
      //     所有「小例子走查」型卡片，逼作者删掉手算例子（正是 20-content-rules 第七节 #3 要保的东西）。
      const dModels = [...new Set((text.match(/d_model\s*=\s*([\d,]+)/g) || [])
        .map((s) => s.match(/=\s*([\d,]+)$/)[1].replace(/,/g, '')))];
      const dModelSwitchNoted = /(真实配置|原论文.{0,12}(配置|是)|为便于手算|便于手算|压到\s*\d+\s*维|以\s*d_model\s*=\s*\d+\s*为例)/.test(text);
      if (dModels.length > 1 && !dModelSwitchNoted) {
        record(label, cardLabel, '基础量口径一致（同卡不出现多个 d_model）', 'WARN', 3,
          `同卡出现 d_model=${dModels.join('、')}，人工确认是否都已在上下文注明来源（如「以…为例」）`);
      } else if (dModels.length === 1) {
        const hm = /h\s*=\s*(\d+)/.exec(text);
        const dkm = /d_k\s*=\s*(\d+)/.exec(text);
        if (hm && dkm) {
          const product = Number(hm[1]) * Number(dkm[1]);
          const ok = product === Number(dModels[0]);
          record(label, cardLabel, '基础量口径一致（h × d_k = d_model）', ok ? 'PASS' : 'WARN', 3,
            ok ? '' : `h=${hm[1]}，d_k=${dkm[1]}，d_model=${dModels[0]}；${hm[1]}×${dkm[1]}=${product}≠${dModels[0]}`);
        }
      }
    }
  }

  printReport(quiet);
  return stats.fail > 0 ? 1 : 0;
}

function printReport(quiet) {
  const shown = quiet ? results.filter((r) => r.status !== 'PASS') : results;
  let lastLesson = null;
  for (const r of shown) {
    if (r.lesson !== lastLesson) { console.log(`\n${r.lesson}`); lastLesson = r.lesson; }
    const tag = r.status === 'PASS' ? 'PASS' : r.status === 'WARN' ? 'WARN' : 'FAIL';
    const detail = r.detail ? `  — ${r.detail}` : '';
    console.log(`  [${tag}] ${r.card === '-' ? '' : r.card + ' '}${r.name}${detail}`);
  }
  const score = stats.total ? Math.round((stats.earned / stats.total) * 100) : 0;
  const grade = score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : 'D';
  console.log('\n' + '─'.repeat(56));
  console.log(`PASS ${stats.pass}   WARN ${stats.warn}   FAIL ${stats.fail}`);
  console.log(`内容分 ${score} / 100   等级 ${grade}   （目标 ≥90 / A）`);
  if (stats.fail > 0) console.log('存在 FAIL：禁止交付，按上面定位修完再跑。');
  console.log('');
}

process.exit(check());
