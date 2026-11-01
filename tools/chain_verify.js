#!/usr/bin/env node
/**
 * L1 链式复算检查（零依赖）
 *
 * 为什么需要它：`calc-block` 里"每步数字要么能由上一步导出、要么标示意"
 * 此前**只有人判**，于是第 2 课 Card 5-2 里 9 处算术错误（含加法错、
 * LayerNorm 输出均值≠0）长期无人发现——直到用户逐字追问才暴露。
 *
 * 本检查只做**有唯一答案**的两类判定（判据来自公式定义，不需任何外部知识）：
 *   A. 加法链：一行里 3 个向量，若表头序列是 "x | +y | = 求和"，则第 3 个必须 = 第 1 + 第 2
 *   B. LayerNorm 必要性：若表头含 "LayerNorm"，该列向量在**未给出 γ/β 数值**的前提下，
 *      均值必须 ≈ 0（这是 LayerNorm 的定义性质；γ/β 只做逐元素缩放平移，不改变这点）
 *
 * 用法：node tools/chain_verify.js --lesson=5   或   --all
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const MAN = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/lessons/manifest.json'), 'utf8'));
const ONLY = (process.argv.find((a) => a.startsWith('--lesson=')) || '').split('=')[1];
const ALL = process.argv.includes('--all');

const strip = (s) => s.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
const vec = (s) => {
  // 取**最后一个**向量：单元格可能是 "[和] → [归一化结果]" 这种"过程 → 结果"写法，
  // 结果才是该列语义（首版取第一个 → 把"和"误当成 LayerNorm 输出，产生 3 条误报）
  const all = [...s.matchAll(/\[([-\d.\s,]+)\]/g)];
  if (!all.length) return null;
  const m = all[all.length - 1];
  const a = m[1].split(',').map((x) => parseFloat(x.trim()));
  return a.length && a.every((x) => Number.isFinite(x)) ? a : null;
};
const eq = (a, b, tol = 0.011) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) <= tol);
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

let fail = 0;
const lessons = ALL || !ONLY ? MAN.lessons : MAN.lessons.filter((L) => String(L.id) === ONLY);
console.log('\n链式复算检查 chain_verify.js\n');

for (const L of lessons) {
  const html = fs.readFileSync(path.join(ROOT, 'src/lessons', L.file), 'utf8');
  const cards = html.split(/(?=<div class="card" data-card=)/).slice(1);
  const out = [];
  for (const c of cards) {
    const id = (c.match(/data-card="([^"]+)"/) || [])[1];
    const area = (c.match(/class="card-a"[\s\S]*?(?=<div class="tab-bar")/) || [''])[0];
    const tables = area.match(/<table[\s\S]*?<\/table>/g) || [];
    for (const t of tables) {
      const ths = [...t.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) => strip(m[1]));
      const rows = t.match(/<tr>[\s\S]*?<\/tr>/g) || [];
      const hasLN = ths.some((x) => /LayerNorm|归一化/i.test(x));
      const idxLN = ths.findIndex((x) => /LayerNorm|归一化/i.test(x));
      // 是否给了 gamma / beta 的具体数值（给了就不适用 B）
      const givesGamma = /γ|gamma|β|beta/.test(t) && /γ\s*[=≈]\s*\[|beta\s*[=≈]\s*\[/i.test(t);
      for (const r of rows) {
        const tds = [...r.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => strip(m[1]));
        const vs = tds.map(vec);
        // A. 加法链
        if (vs.length >= 3 && vs[0] && vs[1] && vs[2]) {
          const s = vs[0].map((x, i) => Math.round((x + vs[1][i]) * 1000) / 1000);
          if (!eq(s, vs[2])) {
            out.push(`[FAIL] Card ${id} 加法链 — ${JSON.stringify(vs[0])} + ${JSON.stringify(vs[1])} 应为 ${JSON.stringify(s)}，表中是 ${JSON.stringify(vs[2])}`);
          }
        }
        // B. LayerNorm 输出均值≈0（未给 γ/β 时）
        if (hasLN && !givesGamma && idxLN >= 0) {
          const cell = vs[idxLN];
          if (cell && cell.length >= 3 && Math.abs(mean(cell)) > 0.15) {
            out.push(`[FAIL] Card ${id} LayerNorm 输出 — ${JSON.stringify(cell)} 均值 ${mean(cell).toFixed(3)} ≠ 0（未给出 γ/β 数值时，纯 LayerNorm 输出均值必为 0）`);
          }
        }
      }
    }
  }
  const uniq = [...new Set(out)];
  console.log(`第${L.display}课 id=${L.id} ${L.title}`);
  if (!uniq.length) console.log('  [PASS] 未发现加法链断裂或 LayerNorm 均值异常');
  else { uniq.forEach((x) => console.log('  ' + x)); fail += uniq.length; }
}
console.log(`\n发现问题数: ${fail}`);
process.exit(fail ? 1 : 0);
