#!/usr/bin/env node
/**
 * 台账时效性检查（铁律锁）
 *
 * 为什么要它：此前「内容改了但没重做核验」**没有任何检查能发现**——
 * 第 2 课那次就是这样：我补完追问继续往下做，门禁不会报，没人拦得住。
 *
 * 铁律：只要某课内容被改动（正文文件 或 该课 QnA 所在的 shell.html），
 *       它的台账即视为过期，必须重新逐条核验；未重新核验前该课 FAIL。
 *
 * 用法：
 *   node tools/provenance_check.js                 # 检查全部课
 *   node tools/provenance_check.js --lesson=5      # 只查某课
 *   node tools/provenance_check.js --lesson=5 --stamp   # 核验完成后写入指纹（人工显式执行）
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const MAN = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/lessons/manifest.json'), 'utf8'));
const sha = (s) => crypto.createHash('sha1').update(s.replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 16);

/**
 * shellHash 只覆盖「**本课自己**的课程数据」：该课在 `allCardTopics` 与
 * `allHardcodedQnA` 里的那一段（按 `  11: {` 这样的课号键切分）。
 *
 * 为什么不做全文件哈希（2026-09-30 修正一）：
 *   全文件哈希把 shell.html 里的 **CSS / 渲染 JS / 系统提示词** 也算进去，
 *   于是任何一次与课程数据无关的改动（改一个 CSS 颜色值、调一句 AI 助教的提示词）
 *   都会让**全部课**报 [WARN]——而它们的正文与问答数据一字未动。这是误报。
 *
 * 为什么不做「整段数据区」哈希（2026-09-30 修正二）：
 *   把 `allCardTopics … allHardcodedQnA` 整段当一个哈希，会让**新增一课**时
 *   把其余所有课全部判成 [WARN]（因为整段变长了）——但那些课的数据一字未动。
 *   检查器自己写的条件就是「若**本课** QnA 有改动则必须重新核验」，按课切片才与之一致。
 *
 * 负向自测（本轮实测）：
 *   ① 只改 CSS / 提示词 → 各课哈希不变（误报消除）；
 *   ② 新增一课的数据块 → 其余各课哈希不变、新课哈希为新值；
 *   ③ 改某课自己 QnA 里的一个字符 → 仅该课哈希改变（仍能拦）。
 */
const SHELL_RAW = fs.readFileSync(path.join(ROOT, 'src/shell.html'), 'utf8');
const TOPIC_START = SHELL_RAW.indexOf('const allCardTopics');
const QNA_START = SHELL_RAW.indexOf('const allHardcodedQnA');
const QNA_END = SHELL_RAW.indexOf('window.allHardcodedQnA');
if (TOPIC_START < 0 || QNA_START <= TOPIC_START || QNA_END <= QNA_START) {
  console.error('FAIL 无法在 src/shell.html 定位课程数据区（allCardTopics / allHardcodedQnA）');
  process.exit(1);
}
const TOPIC_REGION = SHELL_RAW.slice(TOPIC_START, QNA_START);
const QNA_REGION = SHELL_RAW.slice(QNA_START, QNA_END);

/** 按课号键（形如 `\n  11: {`）切出某一课的数据块；用「字符串感知的花括号配平」定终点 */
function lessonSlice(region, id) {
  const m = new RegExp('\\n\\s*' + id + '\\s*:\\s*\\{').exec(region);
  if (!m) return null;
  const start = region.indexOf('{', m.index);
  let depth = 0, inStr = null, esc = false;
  for (let j = start; j < region.length; j++) {
    const ch = region[j];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === "'" || ch === '"') { inStr = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return region.slice(m.index, j + 1); }
  }
  return region.slice(m.index);
}
/** 某一课的 shell 指纹 = 它在两个数据区里的切片之和 */
function shellHashOf(id) {
  const t = lessonSlice(TOPIC_REGION, id);
  const q = lessonSlice(QNA_REGION, id);
  if (t == null && q == null) return null;
  return sha((t || '') + '\u0000' + (q || ''));
}
const HASH_RE = /<!--\s*content-hash:\s*lesson=([0-9a-f]+)\s+shell=([0-9a-f]+)\s*-->/;

const STAMP = process.argv.includes('--stamp');
const ONLY = (process.argv.find((a) => a.startsWith('--lesson=')) || '').split('=')[1];

let pass = 0, warn = 0, fail = 0;
console.log('\n台账时效性检查 provenance_check.js\n');
for (const L of MAN.lessons) {
  const id = String(L.id);
  if (ONLY && ONLY !== id) continue;
  const label = `第${L.display}课 id=${id}`;
  const lessonHash = sha(fs.readFileSync(path.join(ROOT, 'src/lessons', L.file), 'utf8'));
  const shellHash = shellHashOf(id);
  if (shellHash == null) {
    console.log(`  [FAIL] ${label} 在 shell.html 的 allCardTopics / allHardcodedQnA 中找不到本课数据块`); fail++; continue;
  }
  const rp = path.join(ROOT, 'reports', `${id}-逐条核验.md`);

  if (!fs.existsSync(rp)) {
    console.log(`  [FAIL] ${label} 缺 reports/${id}-逐条核验.md → 未做逐条核验`); fail++; continue;
  }
  const md = fs.readFileSync(rp, 'utf8');
  if (STAMP) {
    const line = `<!-- content-hash: lesson=${lessonHash} shell=${shellHash} -->`;
    fs.writeFileSync(rp, HASH_RE.test(md) ? md.replace(HASH_RE, line) : line + '\n' + md);
    console.log(`  [STAMP] ${label} 已写入内容指纹（核验完成确认）`); pass++; continue;
  }
  const m = md.match(HASH_RE);
  if (!m) {
    console.log(`  [FAIL] ${label} 台账未记录内容指纹 → 无法证明时效性`); fail++; continue;
  }
  if (m[1] !== lessonHash) {
    console.log(`  [FAIL] ${label} 正文自上次核验后被修改 → 台账已过期，必须重新逐条核验`); fail++; continue;
  }
  if (m[2] !== shellHash) {
    console.log(`  [WARN] ${label} shell.html 变了（若本课 QnA 有改动则必须重新核验）`); warn++; continue;
  }
  console.log(`  [PASS] ${label} 台账与内容一致（内容未变）`); pass++;
}
console.log(`\nPASS ${pass}   WARN ${warn}   FAIL ${fail}`);
if (fail) console.log('存在 FAIL：禁止进入下一任务，必须先完成该课的逐条核验（并 --stamp 记录指纹）。');
process.exit(fail ? 1 : 0);
