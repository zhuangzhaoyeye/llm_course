#!/usr/bin/env node
/**
 * tools/source_check.js —— 原文摘录的「可回链」校验（联网，独立脚本，不进 gate 必跑链）
 *
 * 解决的是**L-C 缺口**：台账里的行「有链接」不等于「链接的原文支持这句话」。
 * 本项目曾实测：29–34 课的 P1 缺陷**全部都带链接**（链接是真的、话是错的）——
 * 例如原文写 less than $15，卡片写 $10–15；原文评的是 v1，卡片当 v2 用。
 *
 * 本脚本做一件机械且强的事：**摘录必须是链接页面里的逐字片段**。
 *   · 能抓到的：编造摘录、挂无关链接（摘录不在该页）、张冠李戴（抄了别的论文的句子）
 *   · 抓不到的：「摘录确实在页面里，但不支持该断言」——那是语义判断，仍需人/第 6 方（保留人工抽查）
 *
 * 用法：
 *   node tools/source_check.js --lesson 29      # 校验第 29 课台账里所有带摘录的行
 *   node tools/source_check.js --all            # 全部课
 *   node tools/source_check.js --lesson 29 --quiet
 *
 * 台账约定（写进 card-review skill）：事实类/经验类的「来源·算式」列建议写成
 *   摘录="<逐字原文，≤60 字>" | <URL> | 定位=<表号/章节/页>
 * 行内若没有 摘录= 字段 → 记为「未提供摘录」，**不算失败**（存量不追溯），但计入读数分母之外单独统计。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const norm = (s) => String(s).replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/\s+/g, ' ').trim();
const normTight = (s) => norm(s).replace(/[\s\u3000]/g, '');

function rowsOf(file) {
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.startsWith('|')) continue;
    const c = line.replace(/^\||\|$/g, '').split('|').map((x) => x.trim());
    if (c.length >= 9 && /^\d+$/.test(c[0])) out.push(c);
  }
  return out;
}

async function fetchText(url) {
  const r = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0 (course-source-check)' } });
  const ct = r.headers.get('content-type') || '';
  if (/pdf/i.test(ct) || /\.pdf($|\?)/i.test(url)) return { kind: 'pdf' };
  if (!r.ok) return { kind: 'http', status: r.status };
  return { kind: 'ok', text: await r.text() };
}

(async () => {
  const args = process.argv.slice(2);
  const get = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/lessons/manifest.json'), 'utf8'));
  const ids = args.includes('--all') ? manifest.lessons.map((l) => l.id) : [Number(get('--lesson'))];
  const quiet = args.includes('--quiet');

  let withEx = 0, hit = 0, miss = 0, noEx = 0, pdf = 0, err = 0;
  const bad = [];
  for (const id of ids) {
    const f = path.join(ROOT, 'reports', `${id}-逐条核验.md`);
    if (!fs.existsSync(f)) continue;
    for (const c of rowsOf(f)) {
      const src = c[5] || '';
      const m = src.match(/摘录\s*=\s*[“"']?([^”"'|]+)[”"']?/);
      const url = (src.match(/https?:\/\/[^\s|)]+/) || [])[0];
      if (!m) { noEx++; continue; }
      withEx++;
      const ex = m[1].trim();
      if (!url) { miss++; bad.push(`第${id}课 行${c[0]}：有摘录但无 URL`); continue; }
      let ft;
      try { ft = await fetchText(url); } catch (e) { err++; bad.push(`第${id}课 行${c[0]}：抓取失败 ${e.message.slice(0, 40)}`); continue; }
      if (ft.kind === 'pdf') { pdf++; bad.push(`第${id}课 行${c[0]}：PDF 无法逐字比对（需人工） ${url}`); continue; }
      if (ft.kind === 'http') { err++; bad.push(`第${id}课 行${c[0]}：HTTP ${ft.status} ${url}`); continue; }
      const ok = normTight(ft.text).includes(normTight(ex));
      if (ok) hit++; else { miss++; bad.push(`第${id}课 行${c[0]}：【摘录在页面中找不到】摘录=「${ex.slice(0, 40)}」 ${url}（页面 ${ft.text.length} 字符）`); }
    }
  }
  const denom = withEx - pdf - err;
  const rate = denom > 0 ? ((hit / denom) * 100).toFixed(1) : '—';
  console.log(`\n=== 原文摘录可回链率 ===`);
  console.log(`  带摘录的行：${withEx}   逐字命中：${hit}   不命中：${miss}   PDF/网络不可比：${pdf + err}`);
  console.log(`  可回链率 = ${hit}/${denom || 0} = ${rate}%`);
  console.log(`  未提供摘录的行：${noEx}（存量不追溯；新增行按 card-review skill 要求填）`);
  if (bad.length && !quiet) { console.log('\n--- 明细 ---'); bad.forEach((x) => console.log('  ' + x)); }
  process.exit(miss > 0 ? 1 : 0);
})();
