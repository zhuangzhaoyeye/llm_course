#!/usr/bin/env node
// 一课一发布：把 docs/第<N>课文章.md 存成三个平台（掘金 / CSDN / 知乎）的草稿。
// 只存草稿，不点"发布"。已有草稿 ID 时覆盖，不重复新建。
// 用法:
//   node publish.js 4                 # 三平台都存
//   node publish.js 4 --only juejin,csdn
//   node publish.js --list            # 看已登记的草稿 ID
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '../../../..');
const REG_FILE = path.resolve(__dirname, '../registry.json');
const PLATFORMS = {
  juejin: { script: '.trae/skills/juejin-publish/scripts/juejin.js', label: '掘金' },
  csdn: { script: '.trae/skills/csdn-publish/scripts/csdn.js', label: 'CSDN' },
  zhihu: { script: '.trae/skills/zhihu-publish/scripts/zhihu.js', label: '知乎' },
};

const CN = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
function cnNum(n) {
  if (n < 10) return CN[n];
  if (n < 20) return '十' + (n % 10 ? CN[n % 10] : '');
  if (n < 100) return CN[Math.floor(n / 10)] + '十' + (n % 10 ? CN[n % 10] : '');
  return String(n);
}
function articleOf(n) {
  return path.join(ROOT, 'docs', `第${cnNum(n)}课文章.md`);
}
function loadReg() {
  try { return JSON.parse(fs.readFileSync(REG_FILE, 'utf-8')); } catch (e) { return {}; }
}
function saveReg(r) {
  fs.writeFileSync(REG_FILE, JSON.stringify(r, null, 2) + '\n');
}

function run(platform, file, id) {
  const p = PLATFORMS[platform];
  const args = [p.script, 'draft', file];
  if (id) args.push(String(id));
  const out = execFileSync('node', args, { cwd: ROOT, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  const link = (out.match(/草稿链接:\s*(\S+)/) || [])[1] || '';
  const read = (out.match(/回读:.*/) || [''])[0].trim();
  return { platform, link, read, raw: out };
}

const argv = process.argv.slice(2);
if (argv.includes('--list')) {
  const reg = loadReg();
  console.log(Object.keys(reg).sort((a, b) => a - b).map((k) => {
    const v = reg[k];
    return `第${k}课  ` + Object.entries(v).map(([p, id]) => `${PLATFORMS[p] ? PLATFORMS[p].label : p}:${id}`).join('  ');
  }).join('\n') || '（还没有登记任何草稿）');
  process.exit(0);
}

const n = Number(argv[0]);
if (!n) { console.error('用法: node publish.js <课号> [--only juejin,csdn]'); process.exit(2); }
const file = articleOf(n);
if (!fs.existsSync(file)) {
  console.error(`找不到文章: ${file}`);
  console.error('先按课程内容写好文章，再发布。');
  process.exit(3);
}
const onlyIdx = argv.indexOf('--only');
const list = onlyIdx > -1 && argv[onlyIdx + 1]
  ? argv[onlyIdx + 1].split(',').map((s) => s.trim()).filter(Boolean)
  : Object.keys(PLATFORMS);
const bad = list.filter((p) => !PLATFORMS[p]);
if (bad.length) { console.error('未知平台:', bad.join(',')); process.exit(2); }

const reg = loadReg();
reg[n] = reg[n] || {};
const results = [];
for (const p of list) {
  try {
    const r = run(p, file, reg[n][p]);
    const idm = r.link.match(/\/(?:drafts|articleId=|p)\/?(\d+)/) || r.link.match(/(\d{8,})/);
    if (idm) reg[n][p] = idm[1];
    results.push({ ...r, ok: /通过/.test(r.read) });
  } catch (e) {
    results.push({ platform: p, ok: false, link: '', read: (e.stderr || e.message || '').split('\n')[0].slice(0, 160) });
  }
}
saveReg(reg);

console.log(`\n第 ${n} 课 · ${path.basename(file)}`);
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${PLATFORMS[r.platform].label.padEnd(5)} ${r.link || '（失败）'}`);
  if (!r.ok) console.log(`    ${r.read}`);
}
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\n${failed} 个平台未通过，看上面的回读信息。` : '\n三平台草稿已就绪，发布仍需你手动点。');
process.exitCode = failed ? 1 : 0;
