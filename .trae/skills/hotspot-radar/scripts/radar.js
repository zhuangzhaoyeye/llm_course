#!/usr/bin/env node
// 热点雷达 v1：采集多源 AI 前沿信号，合并去重，输出结构化候选 + 基础信号。
//
// 定位：只做「采集 + 可规则化的信号」，不做语义聚类与「成课适配度」打分——那两步
// 由 LLM 步骤完成（见 ../SKILL.md 的 rubric）。为什么：判断「新范式 vs 新名词」「能否
// 计算走查」「与现有 34 课的衔接」没有唯一答案，按规则卫生 §8.1 应走 AI 判而非脚本。
//
// 用法:
//   node radar.js                 # 人类可读清单
//   node radar.js --json          # 结构化 JSON（给 LLM 步骤消费）
//   node radar.js --days 3        # 只看最近 N 天提交的 arXiv 论文
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../../../..');
const REG_FILE = path.join(__dirname, '../registry.json');

const DAYS = Number(process.argv[process.argv.indexOf('--days') + 1] || 3) || 3;
const AS_JSON = process.argv.includes('--json');

// ---- 数据源 1：arXiv（cs.AI / cs.LG / cs.CL 最近提交）----
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function fetchArxiv() {
  const cats = ['cs.AI', 'cs.LG', 'cs.CL'];
  const q = cats.map((c) => `cat:${c}`).join('+OR+');
  const url = `https://export.arxiv.org/api/query?search_query=${q}&sortBy=submittedDate&sortOrder=descending&start=0&max_results=200`;
  let res;
  for (let i = 0; i < 3; i++) {
    res = await fetch(url, { headers: { 'User-Agent': 'llm-course-hotspot-radar/1.0' } });
    if (res.status !== 429) break;
    await sleep(5000 * (i + 1)); // arXiv 限流：退避重试
  }
  const xml = await res.text();
  const entries = xml.split(/<entry>/).slice(1);
  const since = Date.now() - DAYS * 24 * 3600 * 1000;
  const out = [];
  for (const e of entries) {
    const id = (e.match(/<id>([^<]+)<\/id>/) || [])[1] || '';
    const title = unescape((e.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '').trim();
    const summary = unescape((e.match(/<summary>([\s\S]*?)<\/summary>/) || [])[1] || '').trim();
    const published = (e.match(/<published>([^<]+)<\/published>/) || [])[1] || '';
    const cat = (e.match(/<category term="([^"]+)"/) || [])[1] || '';
    const ts = Date.parse(published);
    if (!title || !id) continue;
    if (ts && ts < since) continue;
    out.push({ source: 'arxiv', id: id.split('/').pop(), title, summary, published, cat, ts });
  }
  return out;
}

// ---- 数据源 2：HuggingFace Daily Papers ----
async function fetchHF() {
  try {
    const res = await fetch('https://huggingface.co/api/daily_papers', { headers: { 'User-Agent': 'llm-course-hotspot-radar/1.0' } });
    const data = await res.json();
    return (data || []).map((d) => {
      const p = d.paper || d || {};
      return {
        source: 'hf',
        id: p.id || '',
        title: p.title || '',
        summary: p.summary || '',
        published: p.publishedAt || p.published_at || '',
        cat: '',
        ts: Date.parse(p.publishedAt || p.published_at || '') || 0,
        upvotes: p.upvotes ?? 0, // upvotes 在 paper 对象内，不在榜单条目顶层
        githubRepo: p.githubRepo || '',
        githubStars: p.githubStars || 0,
      };
    }).filter((x) => x.title);
  } catch (e) {
    return [];
  }
}

function unescape(s) {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, ' ');
}

function normTitle(t) {
  return t.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, ' ');
}

// 基础信号：可规则化的「一手来源」与「多源确认」，不做语义判断。
function loadReg() {
  try { return JSON.parse(fs.readFileSync(REG_FILE, 'utf-8')); } catch (e) { return {}; }
}
function saveReg(r) { fs.writeFileSync(REG_FILE, JSON.stringify(r, null, 2) + '\n'); }

(async () => {
  const [arxiv, hf] = await Promise.all([fetchArxiv(), fetchHF()]);
  const items = [...arxiv, ...hf];
  const byTitle = new Map();
  for (const it of items) {
    const key = normTitle(it.title).slice(0, 60);
    if (!byTitle.has(key)) { byTitle.set(key, { ...it, sources: [it.source] }); }
    else {
      const cur = byTitle.get(key);
      cur.sources.push(it.source);
      if (!cur.upvotes) cur.upvotes = it.upvotes;
    }
  }
  const merged = [...byTitle.values()].sort((a, b) => (b.upvotes || 0) - (a.upvotes || 0) || (b.ts || 0) - (a.ts || 0));

  const report = {
    generated: new Date().toISOString(),
    windowDays: DAYS,
    counts: { arxiv: arxiv.length, hf: hf.length, merged: merged.length },
    candidates: merged.map((it) => ({
      title: it.title,
      id: it.id,
      sources: it.sources,
      arxiv: it.source === 'arxiv' || it.sources.includes('arxiv'),
      hfRanked: it.sources.includes('hf'),
      upvotes: it.upvotes || 0,
      cat: it.cat,
      published: it.published,
      summary: it.summary.slice(0, 400),
    })),
  };

  if (AS_JSON) { console.log(JSON.stringify(report, null, 2)); process.exit(0); }

  console.log(`热点雷达 v1 · ${report.windowDays} 天窗口 · 生成于 ${report.generated}`);
  console.log(`arXiv ${report.counts.arxiv} 篇 ｜ HuggingFace ${report.counts.hf} 条 ｜ 合并去重后 ${report.counts.merged} 条`);
  console.log('');
  console.log('以下为采集层原始候选（已按 HF upvote 排序）。语义聚类与「成课适配度」打分见 SKILL.md 的 LLM 步骤。');
  console.log('');
  const reg = loadReg();
  for (const c of report.candidates.slice(0, 40)) {
    const src = c.hfRanked ? 'HF★' : 'arxiv';
    const seen = reg.seen && reg.seen[c.id] ? ' (已见)' : '';
    console.log(`[${src}] ${c.title}${seen}`);
    if (c.hfRanked) console.log(`        upvotes=${c.upvotes}  ${c.published}`);
    console.log(`        ${c.summary.replace(/\n/g, ' ').slice(0, 160)}`);
  }
  console.log('');
  console.log('下一步：把 --json 输出交给 LLM，按 SKILL.md 的 6 维 rubric 打分，产出入选清单。');
})();
