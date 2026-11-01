#!/usr/bin/env node
/**
 * tools/pending_facts.js —— 待核清单生成器（离线，零依赖）
 *
 * 为什么有它：`review_check` 的 H4 断言切句器**已经**能把每卡的「可核验断言」切出来，
 * 但只用来**数行数**，没人拿它去驱动联网核验。结果是"逐条联网核验"靠自觉，核完也不留痕。
 * 这个脚本把切句器变成**待核清单**：逐条列出「含数字 / 含归属时间版本声明的句子」，
 * 供人（或第 6 方）逐条填空：原文摘录 + URL + 定位。填完的痕迹落在台账「来源/算式」列。
 *
 * 用法：
 *   node tools/pending_facts.js --lesson 29        # 打印第 29 课的待核清单
 *   node tools/pending_facts.js --lesson 29 --md   # 输出 markdown 表（可直接粘进台账草稿）
 *   node tools/pending_facts.js --all | tail -20   # 全部课的条数汇总
 *
 * 判定口径与 review_check 的 H4 保持一致（避免两套数字）：
 *   · 卡片内容区 = 砍掉 .tab-bar 之后的问答区，再砍掉课程级 .footer-nav
 *   · 按块级边界（</p> </div> </td> </tr> </table> <br> 等）切句
 *   · 剥掉「Step 1：」「第1步：」这类步骤标签编号再判
 *   · 含数字，或含 归属/时间/版本 声明词（提出/发表/首次/出自/原论文/论文/版本/这就是）→ 各算 1 条
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const LESSONS = path.join(ROOT, 'src', 'lessons');

const ATTR = /提出|发表|首次|出自|原论文|论文|版本|这就是/;
const NUM = /\d/;

function stripTags(s) {
  return String(s).replace(/<[^>]+>/g, ' ');
}

/** 从一课 HTML 里切出每张卡的可核验断言 */
function assertionsOf(html) {
  // 逐卡切：data-card="<id>-<n>" 到下一个 data-card 或文件末尾
  const cards = [...html.matchAll(/data-card="([^"]+)"/g)].map((m) => m[1]);
  const out = [];
  for (let i = 0; i < cards.length; i++) {
    const start = html.indexOf(`data-card="${cards[i]}"`);
    const next = i + 1 < cards.length ? html.indexOf(`data-card="${cards[i + 1]}"`) : html.length;
    let seg = html.slice(start, next);
    // 砍掉问答区与页脚
    const cut = seg.search(/<div class="tab-bar">/);
    if (cut > 0) seg = seg.slice(0, cut);
    const footer = seg.search(/<div class="footer-nav">/);
    if (footer > 0) seg = seg.slice(0, footer);
    // 先取出问题与提示（激活区固定算 2 条）
    const q = stripTags((seg.match(/class="card-q-text"[^>]*>([\s\S]*?)<\/div>/) || ['', ''])[1]).trim();
    const hint = stripTags((seg.match(/class="card-q-hint"[^>]*>([\s\S]*?)<\/div>/) || ['', ''])[1]).trim();
    const list = [];
    if (q) list.push({ card: cards[i], kind: '主问题', text: q });
    if (hint) list.push({ card: cards[i], kind: '提示', text: hint });
    // 内容区按块级边界切句
    const body = seg.replace(/<div class="card-q"[\s\S]*?<\/div>\s*<\/div>/, ' ');
    const chunks = stripTags(body.replace(/<\/(p|div|td|tr|table|li|h[1-6])>/g, '\n').replace(/<br\s*\/?>/g, '\n'))
      .split('\n')
      .map((x) => x.replace(/Step\s*\d+\s*[:：]/g, '').replace(/第\s*\d+\s*步\s*[:：]/g, '').replace(/\s+/g, ' ').trim())
      .filter((x) => x.length >= 8);
    for (const c of chunks) {
      if (NUM.test(c) || ATTR.test(c)) list.push({ card: cards[i], kind: '内容', text: c });
    }
    out.push(...list);
  }
  return out;
}

const args = process.argv.slice(2);
const get = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const asMd = args.includes('--md');

// --hints：提示泄题**清单**（不是门槛）。
// 判据不唯一（"这条提示算不算泄题"取决于课程设计），按 30-dev-rules §8.1 应「AI 判，不固化成脚本」，
// 故这里只输出清单供人/第 6 方逐条判，不产出 FAIL/WARN，避免误报训练人忽略告警。
if (args.includes('--hints')) {
  const manifest0 = JSON.parse(fs.readFileSync(path.join(LESSONS, 'manifest.json'), 'utf8'));
  const ids0 = args.includes('--all') ? manifest0.lessons.map((l) => l.id) : [Number(get('--lesson'))];
  for (const id of ids0) {
    const html = fs.readFileSync(path.join(LESSONS, `lesson-${id}.html`), 'utf8');
    console.log(`\n=== 第 ${id} 课 提示（hint）清单 —— 逐条自问：这提示是"给方向"还是"给答案"？ ===`);
    for (const m of html.matchAll(/data-card="([^"]+)"[\s\S]*?class="card-q-hint"[^>]*>([\s\S]*?)<\/div>/g)) {
      console.log(`  [${m[1]}] ${m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120)}`);
    }
  }
  process.exit(0);
}

const manifest = JSON.parse(fs.readFileSync(path.join(LESSONS, 'manifest.json'), 'utf8'));
const targets = args.includes('--all') ? manifest.lessons.map((l) => l.id) : [Number(get('--lesson'))];

let total = 0;
for (const id of targets) {
  const html = fs.readFileSync(path.join(LESSONS, `lesson-${id}.html`), 'utf8');
  const list = assertionsOf(html);
  total += list.length;
  if (!asMd) {
    console.log(`\n=== 第 ${id} 课：待核断言 ${list.length} 条 ===`);
    for (const a of list) console.log(`  [${a.card}/${a.kind}] ${a.text.slice(0, 110)}`);
  } else {
    console.log(`\n### 第 ${id} 课（待核 ${list.length} 条）\n`);
    console.log('| # | 定位 | 待核断言 | 原文摘录（逐字，≤30 字） | URL | 定位（表号/章节/页） |');
    console.log('|---|---|---|---|---|---|');
    list.forEach((a, i) => console.log(`| ${i + 1} | ${a.card}/${a.kind} | ${a.text.slice(0, 90)} |  |  |  |`));
  }
}
if (targets.length > 1) console.log(`\n合计待核断言：${total} 条（${targets.length} 课）`);
