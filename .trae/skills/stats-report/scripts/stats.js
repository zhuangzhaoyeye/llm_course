#!/usr/bin/env node
// 统计汇总：从 Cloudflare D1 读匿名事件，聚合成人可读的报表。
// 用法:
//   node stats.js                # 最近 7 天
//   node stats.js --days 30      # 最近 30 天
//   node stats.js --json         # 输出原始聚合 JSON(给程序用)
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '../../../..');
const PROXY = path.join(REPO, 'proxy');
const DB = 'llm-course-stats';
const TZ = 'Asia/Shanghai'; // 按北京时间分日,和课程站的目标读者一致

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : dflt;
}
const DAYS = Number(arg('--days', 7)) || 7;
const AS_JSON = process.argv.includes('--json');

function query(sql) {
  const out = execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', DB, '--remote', '--json', '--command', sql],
    { cwd: PROXY, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  const m = out.match(/\[\s*\{[\s\S]*\}\s*\]/);
  if (!m) throw new Error('无法解析 wrangler 输出');
  const arr = JSON.parse(m[0]);
  return (arr[0] && arr[0].results) || [];
}

function day(ts) {
  return new Date(ts).toLocaleDateString('sv-SE', { timeZone: TZ });
}

function lessons() {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(REPO, 'src/lessons/manifest.json'), 'utf-8'));
    const map = {};
    (m.lessons || []).forEach((l) => { map[String(l.id)] = l.title; });
    return map;
  } catch (e) { return {}; }
}

const since = Date.now() - DAYS * 24 * 3600 * 1000;
const rows = query(`SELECT ts, cid, sid, vn, dev, w, ref, n, ev FROM batches WHERE ts >= ${since} ORDER BY ts`);

const evs = [];
const days = {};
const visitors = new Set();
const sessions = new Set();
let batches = 0;
for (const r of rows) {
  batches++;
  visitors.add(r.cid);
  sessions.add(r.sid);
  const d = day(r.ts);
  days[d] = days[d] || { pv: 0, uv: new Set(), sess: new Set() };
  days[d].uv.add(r.cid);
  days[d].sess.add(r.sid);
  let list = [];
  try { list = JSON.parse(r.ev); } catch (e) { list = []; }
  for (const e of list) evs.push({ ...e, _d: d, _dev: r.dev, _ref: r.ref });
}
const opens = evs.filter((e) => e.e === 'open');
for (const e of opens) days[e._d].pv++;
for (const d of Object.keys(days)) { days[d].uv = days[d].uv.size; days[d].sess = days[d].sess.size; }

const byLesson = {};
const byCard = {};
const dwell = {};
const search = { hit: 0, miss: 0 };
const ai = { open: 0, ask: 0 };
const dev = {};
const ref = {};
for (const e of evs) {
  if (e.e === 'lesson') byLesson[e.l] = (byLesson[e.l] || 0) + 1;
  if (e.e === 'card' && e.s === 'open') byCard[e.c] = (byCard[e.c] || 0) + 1;
  if (e.e === 'dwell') (dwell[e.c] = dwell[e.c] || []).push(e.ms);
  if (e.e === 'search') search[e.k] = (search[e.k] || 0) + 1;
  if (e.e === 'ai_open') ai.open++;
  if (e.e === 'ai_ask') ai.ask++;
  if (e._dev) dev[e._dev] = (dev[e._dev] || 0) + 1;
  if (e._ref) ref[e._ref] = (ref[e._ref] || 0) + 1;
}
const dwellAvg = {};
for (const [c, arr] of Object.entries(dwell)) {
  dwellAvg[c] = Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
}
const sortObj = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]);
const T = lessons();

const report = {
  range: { days: DAYS, since: day(since), until: day(Date.now()) },
  totals: { batches, events: evs.length, visitors: visitors.size, sessions: sessions.size },
  daily: Object.entries(days).sort().map(([d, v]) => ({ date: d, pv: v.pv, uv: v.uv, sessions: v.sess })),
  lessons: sortObj(byLesson).map(([l, n]) => ({ lesson: l, title: T[l] || '', opens: n })),
  cards: sortObj(byCard).map(([c, n]) => ({ card: c, opens: n, avgDwellMs: dwellAvg[c] || 0 })),
  search: { ...search, rate: search.hit + search.miss ? +(search.hit / (search.hit + search.miss) * 100).toFixed(1) : null },
  ai,
  devices: sortObj(dev),
  referrers: sortObj(ref).slice(0, 10),
};

if (AS_JSON) { console.log(JSON.stringify(report, null, 2)); process.exit(0); }

if (!batches) {
  console.log(`统计区间 ${report.range.since} ~ ${report.range.until}（北京时间）：D1 里没有任何数据。`);
  console.log('可能原因：还没有人访问线上站点（数据从 2026-11-06 07:26 UTC 才开始记录）。');
  process.exit(0);
}

console.log(`统计区间：${report.range.since} ~ ${report.range.until}（北京时间，最近 ${DAYS} 天）`);
console.log(`批次 ${batches}｜事件 ${evs.length}｜独立访客 ${visitors.size}｜会话 ${sessions.size}`);
console.log('');
console.log('日期         PV    访客   会话   展开/人');
for (const d of report.daily) {
  const opensD = evs.filter((e) => e._d === d.date && e.e === 'card' && e.s === 'open').length;
  console.log(`${d.date}   ${String(d.pv).padEnd(5)} ${String(d.uv).padEnd(5)} ${String(d.sessions).padEnd(5)} ${d.uv ? (opensD / d.uv).toFixed(1) : '-'}`);
}
console.log('');
if (report.lessons.length) {
  console.log('各课打开次数：');
  for (const l of report.lessons.slice(0, 12)) {
    console.log(`  第${l.lesson}课 ${l.title || ''}  ${l.opens}`);
  }
  console.log('');
}
if (report.cards.length) {
  console.log('卡片展开 TOP10（展开次数 / 平均停留）：');
  for (const c of report.cards.slice(0, 10)) {
    console.log(`  ${c.card}  ${c.opens} 次  ${(c.avgDwellMs / 1000).toFixed(1)}s`);
  }
  console.log('');
}
console.log(`搜索：命中 ${search.hit}｜未命中 ${search.miss}｜命中率 ${report.search.rate === null ? '-' : report.search.rate + '%'}`);
console.log(`AI 助教：打开 ${ai.open} 次｜提问 ${ai.ask} 次`);
if (report.devices.length) console.log(`设备：${report.devices.map(([k, v]) => `${k} ${v}`).join('｜')}`);
if (report.referrers.length) console.log(`来源：${report.referrers.map(([k, v]) => `${k} ${v}`).join('｜')}`);
