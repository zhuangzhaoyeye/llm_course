#!/usr/bin/env node
/**
 * tools/crossscope_check.js —— 跨课数值口径一致性检查（离线，零依赖）
 *
 * 为什么有它：第 6 方盲审在 28 课里查出**最高频的一类 P1 是跨课/课内数值口径冲突**
 * （第 9 课记 512 张、第 13 课记 576 张；同一量两课取值相反）。这类冲突**判据唯一**，
 * 属于"有唯一正确答案 → 该固化成脚本"（见 30-dev-rules §8.1）。
 *
 * 事实源是 `docs/scope-table.json`（人维护的数据，不是代码）：
 *   新增一个口径 = 往表里加一条，不改本脚本。
 *
 * 用法：
 *   node tools/crossscope_check.js              # 全课扫描
 *   node tools/crossscope_check.js --list       # 只列出各口径在每课的取值集合（发现用）
 *   exit 1 表示存在口径外取值
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const table = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/scope-table.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/lessons/manifest.json'), 'utf8'));
const listOnly = process.argv.includes('--list');

// 关键：先剥掉 HTML 标签再匹配。
// 教训（本轮实测）：口径短语常被 <b>/<span> 包住（如「75 个 <b>Kaggle</b> 竞赛」），
// 直接对原始 HTML 用正则会**失配**或**误配**——检查器失明比没有检查更糟。
const strip = (s) => s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

const fail = [];
for (const sc of table.scopes) {
  const re = new RegExp(sc.re, 'g');
  const perLesson = new Map();
  for (const { id } of manifest.lessons) {
    const html = strip(fs.readFileSync(path.join(ROOT, `src/lessons/lesson-${id}.html`), 'utf8'));
    const vals = [];
    let m;
    while ((m = re.exec(html)) !== null) vals.push(m[1]);
    if (!vals.length) continue;
    perLesson.set(id, vals);
    if (listOnly) continue;
    const bad = vals.filter((v) => !sc.allowed.includes(v));
    if (!bad.length) continue;
    const exempted = sc.exempt.some((w) => html.includes(w));
    if (exempted) continue;
    // 逐条报准位置：给出出现的课号与取值
    fail.push(`[FAIL] 口径「${sc.name}」— 第${id}课出现口径外取值 ${[...new Set(bad)].join('/')}（允许：${sc.allowed.join('/')}；豁免词：${sc.exempt.join('/') || '无'}）`);
  }
  if (listOnly) {
    const all = new Set();
    for (const v of perLesson.values()) v.forEach((x) => all.add(x));
    const tag = [...all].every((v) => sc.allowed.includes(v)) ? 'OK' : '⚠ 有口径外取值';
    console.log(`${tag}  ${sc.name}（允许 ${sc.allowed.join('/')}）`);
    for (const [id, vals] of [...perLesson].sort((a, b) => a[0] - b[0])) console.log(`     第${id}课: ${[...new Set(vals)].join(', ')}`);
  }
}

if (listOnly) process.exit(0);
console.log(`\n=== 跨课口径一致性 ===`);
console.log(`  口径表条目：${table.scopes.length}   违规：${fail.length}`);
fail.forEach((f) => console.log('  ' + f));
process.exit(fail.length ? 1 : 0);
