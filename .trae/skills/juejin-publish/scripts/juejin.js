#!/usr/bin/env node
// 掘金:默认只存草稿;publish 模式在用户明确授权后点"发布"。
// 用法:
//   node juejin.js check                          检查登录态(无头)
//   node juejin.js login                          未登录则弹出可见窗口等你登录,登录后自动退出
//   node juejin.js draft <file.md> [draftId]      存草稿;带 draftId 则覆盖该草稿,不带则新建
//   node juejin.js publish <file.md> [draftId]    发布(填分类/标签/摘要后点"确定并发布");需用户明确授权
// 约定:md 第一行 "# 标题" 是标题,其余是正文。
const fs = require('fs');
const os = require('os');
const path = require('path');

// playwright 从仓库根 node_modules 解析(仓库已有依赖),脚本放哪都能找到
function loadPlaywright() {
  const roots = [process.cwd(), path.resolve(__dirname, '../../../..')];
  for (const r of roots) {
    try { return require(require.resolve('playwright', { paths: [r] })); } catch (e) { /* try next */ }
  }
  console.error('找不到 playwright:先在仓库根执行 npm install');
  process.exit(2);
}
const { chromium } = loadPlaywright();

const PROFILE = process.env.PUBLISH_PROFILE || path.join(os.homedir(), '.llm_course_publish_profile');
const OUT = process.env.PUBLISH_OUT || os.tmpdir();
const HOME = 'https://juejin.cn/';
const NEED = ['sessionid']; // 登录标志 cookie(只比对名字,不打印值)

async function loggedIn(ctx) {
  const names = new Set((await ctx.cookies(HOME)).map((c) => c.name));
  return NEED.every((n) => names.has(n));
}

async function draft(ctx, file, draftId) {
  const raw = fs.readFileSync(file, 'utf-8').split('\n');
  const title = raw[0].replace(/^#\s*/, '').trim();
  const body = raw.slice(1).join('\n').trim();
  const page = await ctx.newPage();
  const url = draftId ? `https://juejin.cn/editor/drafts/${draftId}` : 'https://juejin.cn/editor/drafts/new?v=2';
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForSelector('.title-input', { timeout: 20000 });
  await page.waitForTimeout(3000);
  await page.fill('.title-input', title);
  // 正文是 CodeMirror 5:直接 setValue,换行会保留
  await page.evaluate((t) => { document.querySelector('.CodeMirror').CodeMirror.setValue(t); }, body);
  await page.waitForTimeout(10000); // 编辑器自动保存,约 10 秒内落盘
  await page.screenshot({ path: path.join(OUT, 'juejin_draft.png') });
  const saved = await page.evaluate(() => document.body.innerText.includes('保存成功'));
  const id = (page.url().match(/\/drafts\/(\d+)/) || [])[1];
  console.log('草稿链接:', page.url());
  console.log('编辑器提示"保存成功":', saved);
  console.log('截图:', path.join(OUT, 'juejin_draft.png'));
  if (!id) { console.log('警告:URL 里没有草稿 ID,草稿可能没建起来'); process.exitCode = 1; return; }

  // 回读校验:新开页面读服务器上的内容,避免只凭"提示保存成功"就报成功
  const p2 = await ctx.newPage();
  await p2.goto(`https://juejin.cn/editor/drafts/${id}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await p2.waitForSelector('.title-input', { timeout: 20000 });
  await p2.waitForTimeout(5000);
  const r = await p2.evaluate(() => ({
    title: document.querySelector('.title-input').value,
    lines: document.querySelector('.CodeMirror').CodeMirror.getValue().split('\n').length,
  }));
  const ok = r.title === title && r.lines > 5;
  console.log(`回读: 标题${r.title === title ? '一致' : '不一致'},${r.lines} 行 →`, ok ? '通过' : '未通过');
  if (!ok) process.exitCode = 1;
}

// 解析 docs/csdn-优化方案.md：按文件名取该课的摘要与标签（数据源唯一，不在脚本里重造）。
function parsePlan(file) {
  const planPath = path.resolve(__dirname, '../../../..', 'docs', 'csdn-优化方案.md');
  if (!fs.existsSync(planPath)) return { summary: '', tags: [] };
  const text = fs.readFileSync(planPath, 'utf-8');
  const base = path.basename(file);
  const idx = text.indexOf('## ' + base);
  if (idx < 0) return { summary: '', tags: [] };
  const nextIdx = text.indexOf('\n## ', idx + 1);
  const section = text.slice(idx, nextIdx < 0 ? undefined : nextIdx);
  const sum = (section.match(/-\s*\*\*摘要\*\*：([^\n]*)/) || [])[1];
  const tagLine = (section.match(/-\s*\*\*标签\*\*：([^\n]*)/) || [])[1] || '';
  const tags = [...tagLine.matchAll(/`([^`]+)`/g)].map((m) => m[1]).filter(Boolean);
  return { summary: sum ? sum.trim() : '', tags };
}

// 发布后 URL 会跳到 /published，拿不到文章 ID：重开草稿编辑器，从 article_draft/detail 接口读 article_id。
async function getArticleIdByDraft(ctx, draftId) {
  if (!draftId) return '';
  const p = await ctx.newPage();
  let aid = '';
  p.on('response', async (r) => {
    if (!/article_draft\/detail/.test(r.url()) || aid) return;
    try { const j = await r.json(); aid = (j.data && j.data.article_draft && j.data.article_draft.article_id) || ''; } catch (e) {}
  });
  await p.goto(`https://juejin.cn/editor/drafts/${draftId}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  for (let i = 0; i < 10 && !aid; i++) await p.waitForTimeout(2000);
  await p.close();
  return aid;
}

// 发布：填分类「人工智能」+ 标签 + 摘要，点「确定并发布」，回读公开页。
async function publish(ctx, file, draftId) {
  const raw = fs.readFileSync(file, 'utf-8').split('\n');
  const title = raw[0].replace(/^#\s*/, '').trim();
  const body = raw.slice(1).join('\n').trim();
  const plan = parsePlan(file);
  const summary = process.env.PUBLISH_SUMMARY || plan.summary;
  const tags = process.env.PUBLISH_TAGS ? process.env.PUBLISH_TAGS.split(',').map((s) => s.trim()).filter(Boolean) : plan.tags;
  console.log(`计划: 标题="${title}" | 摘要=${summary ? summary.length + '字' : '无'} | 标签=[${tags.join(', ')}]`);

  const page = await ctx.newPage();
  const url = draftId ? `https://juejin.cn/editor/drafts/${draftId}` : 'https://juejin.cn/editor/drafts/new?v=2';
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForSelector('.title-input', { timeout: 20000 });
  await page.waitForTimeout(3000);

  // 内容以 md 为事实源，覆盖草稿标题与正文
  await page.fill('.title-input', title);
  await page.evaluate((t) => { document.querySelector('.CodeMirror').CodeMirror.setValue(t); }, body);
  await page.waitForTimeout(8000);

  // 新建草稿时，自动保存后 URL 才会出现 draftId，先记下来供发布后取 article_id
  const liveDraftId = draftId || (page.url().match(/\/drafts\/(\d+)/) || [])[1] || '';
  console.log('草稿 ID:', liveDraftId || '(未拿到)');

  const cur = await page.evaluate(() => ({
    title: document.querySelector('.title-input').value,
    lines: document.querySelector('.CodeMirror').CodeMirror.getValue().split('\n').length,
  }));
  const contentOk = cur.title === title && cur.lines > 5;
  console.log(`发布前校验: 标题${cur.title === title ? '一致' : '不一致'} / ${cur.lines} 行 →`, contentOk ? '通过' : '未通过');
  if (!contentOk) { console.error('草稿标题或正文不正确，停止发布'); process.exitCode = 1; await page.close(); return; }

  // 打开发布弹窗
  const clicked = await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find((x) => /^(发布|更新)$/.test((x.innerText || '').trim()));
    if (b) { b.click(); return b.innerText.trim(); }
    return '';
  });
  console.log('打开发布弹窗:', clicked || '(未找到按钮)');
  if (!clicked) { process.exitCode = 1; await page.close(); return; }
  await page.waitForTimeout(4000);

  // 分类：人工智能
  const catOk = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('.category-list .item, [class*="category"] .item, [class*="category"] > *'));
    const target = items.find((el) => (el.innerText || '').trim() === '人工智能');
    if (target) { target.click(); return true; }
    return false;
  });
  console.log('选分类「人工智能」:', catOk);
  await page.waitForTimeout(1200);

  // 标签：掘金只能从平台已有标签中选（本账号上限 2 个），逐个搜索后点击精确匹配项。
  // 注意：不能按 Meta+A/Backspace 清空输入——输入框为空时 Backspace 会删掉已选标签。
  const selectedNow = async () => page.evaluate(() => {
    const row = document.querySelector('.publish-popup .tag-input.select');
    if (!row) return [];
    const pill = row.querySelector('.select-plus').__vue__;
    return (pill && pill.$data.selected ? pill.$data.selected : []).map((x) => x.label);
  });
  const ddOpen = async () => page.evaluate(() => {
    const dd = document.querySelector('.byte-select-dropdown.tag-select-add-margin');
    return !!dd && getComputedStyle(dd).display !== 'none';
  });
  const addedTags = [];
  for (const tag of tags) {
    const cur = await selectedNow();
    if (cur.includes(tag)) { console.log(`标签「${tag}」: 已在列表中`); addedTags.push(tag); continue; }
    if (!(await ddOpen())) { await page.click('.publish-popup .tag-input.select .byte-select'); await page.waitForTimeout(900); }
    await page.keyboard.type(tag, { delay: 120 });
    await page.waitForTimeout(3000);
    const opts = page.locator('.byte-select-dropdown.tag-select-add-margin li.byte-select-option');
    const exact = opts.filter({ hasText: new RegExp('^\\s*' + tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$') }).first();
    if (!(await exact.count())) {
      console.log(`标签「${tag}」: 掘金无此标签（不可自建），跳过`);
      await page.keyboard.press('Escape').catch(() => {});
      continue;
    }
    await exact.click();
    await page.waitForTimeout(1500);
    const after = await selectedNow();
    if (after.includes(tag)) { console.log(`标签「${tag}」: 已添加`); addedTags.push(tag); }
    else console.log(`标签「${tag}」: 添加后未出现在已选列表`);
  }
  console.log('已添加标签:', JSON.stringify(addedTags));

  // 摘要
  let sumOk = false;
  if (summary) {
    sumOk = await page.evaluate((s) => {
      const items = Array.from(document.querySelectorAll('.publish-popup .form-item'));
      const row = items.find((it) => (it.querySelector('label') || it).innerText.trim().startsWith('编辑摘要'));
      const ta = row ? row.querySelector('textarea.byte-input__textarea') : null;
      if (!ta) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, '');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      setter.call(ta, s);
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }, summary);
  }
  console.log('填摘要:', sumOk);
  await page.waitForTimeout(1200);

  const precheck = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('.publish-popup .form-item'));
    const sumRow = items.find((it) => (it.querySelector('label') || it).innerText.trim().startsWith('编辑摘要'));
    return { sum: sumRow && sumRow.querySelector('textarea') ? sumRow.querySelector('textarea').value : '' };
  });
  console.log('发布前校验 — 摘要:', JSON.stringify(precheck.sum));
  await page.screenshot({ path: path.join(OUT, 'juejin_before_publish.png') });

  // 确定并发布 / 确定并更新
  const clickedConfirm = await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('.publish-popup button')).find((x) => /^确定并(发布|更新)$/.test((x.innerText || '').trim()));
    if (b) { b.click(); return b.innerText.trim(); }
    return '';
  });
  if (!clickedConfirm) { console.error('未找到「确定并发布/更新」按钮'); process.exitCode = 1; await page.close(); return; }
  console.log('已点「' + clickedConfirm + '」');

  let postId = null;
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(2000);
    const m = page.url().match(/\/post\/(\d+)/);
    if (m) { postId = m[1]; break; }
    if (/\/published/.test(page.url())) break;
    const st = await page.evaluate(() => ({ txt: document.body.innerText.slice(-600) })).catch(() => ({}));
    if (/发布成功|审核中|已发布|更新成功/.test(st.txt || '') && i > 3) break;
  }
  await page.screenshot({ path: path.join(OUT, 'juejin_after_publish.png') });
  console.log('发布后 URL:', page.url());
  if (!postId) postId = await getArticleIdByDraft(ctx, liveDraftId);
  if (!postId) { console.error('未拿到公开文章 ID，发布可能失败'); process.exitCode = 1; await page.close(); return; }
  console.log('公开链接:', `https://juejin.cn/post/${postId}`);

  // 回读公开页（新稿可能先进入审核，短暂 404 属正常）
  const p2 = await ctx.newPage();
  const resp = await p2.goto(`https://juejin.cn/post/${postId}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await p2.waitForTimeout(4000);
  const rb = await p2.evaluate(() => ({
    title: (document.querySelector('h1.article-title, .article-title') || {}).innerText || document.title,
    chars: document.body.innerText.length,
  }));
  const status = resp ? resp.status() : 0;
  const ok = status === 200 && rb.chars > 1000;
  if (ok) {
    console.log(`回读: status=${status}, 标题="${(rb.title || '').trim().slice(0, 60)}", 正文 ${rb.chars} 字符 → 通过`);
  } else {
    console.log(`回读: status=${status} → 尚未公开（新稿通常先进入审核）。文章 ID=${postId}，链接 https://juejin.cn/post/${postId}`);
    process.exitCode = 2; // 已提交但审核中，不是失败
  }
  await p2.close();
  await page.close();
  return postId;
}

(async () => {
  const [mode, file, draftId] = process.argv.slice(2);
  if (mode === 'login') {
    let ctx = await chromium.launchPersistentContext(PROFILE, { headless: true });
    const ok = await loggedIn(ctx);
    await ctx.close();
    if (ok) { console.log('掘金已登录,无需弹窗'); return; }
    ctx = await chromium.launchPersistentContext(PROFILE, { headless: false, viewport: null });
    const page = await ctx.newPage();
    await page.goto(HOME).catch(() => {});
    console.log('已弹出浏览器,请在窗口里登录掘金(最长等待 10 分钟)...');
    const end = Date.now() + 10 * 60 * 1000;
    while (Date.now() < end && !(await loggedIn(ctx))) await new Promise((r) => setTimeout(r, 3000));
    console.log((await loggedIn(ctx)) ? '登录成功' : '超时未登录');
    await ctx.close();
    return;
  }
  const ctx = await chromium.launchPersistentContext(PROFILE, { headless: true, viewport: { width: 1400, height: 900 } });
  try {
    if (mode === 'check') console.log('掘金', (await loggedIn(ctx)) ? '已登录' : '未登录');
    else if (mode === 'draft') {
      if (!file) { console.error('用法: node juejin.js draft <file.md> [draftId]'); process.exitCode = 2; }
      else if (!(await loggedIn(ctx))) { console.error('掘金未登录,先运行: node juejin.js login'); process.exitCode = 3; }
      else await draft(ctx, path.resolve(file), draftId);
    } else if (mode === 'publish') {
      if (!file) { console.error('用法: node juejin.js publish <file.md> [draftId]'); process.exitCode = 2; }
      else if (!(await loggedIn(ctx))) { console.error('掘金未登录,先运行: node juejin.js login'); process.exitCode = 3; }
      else await publish(ctx, path.resolve(file), draftId);
    } else { console.error('模式应为 check | login | draft | publish'); process.exitCode = 2; }
  } catch (e) { console.error('ERR', e.message.split('\n')[0]); process.exitCode = 1; }
  await ctx.close();
})();
