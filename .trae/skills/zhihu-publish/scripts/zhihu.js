#!/usr/bin/env node
// 知乎:无头存草稿。绝不点"发布"。
// 用法:
//   node zhihu.js check                         检查登录态(无头)
//   node zhihu.js login                         未登录则弹出可见窗口等你登录,登录后自动退出
//   node zhihu.js draft <file.md> [articleId]   存草稿;带 articleId 则覆盖该草稿,不带则新建
// 约定:md 第一行 "# 标题" 是标题,其余是正文。正文按 Markdown 转 HTML 后粘贴。
const fs = require('fs');
const os = require('os');
const path = require('path');

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
const HOME = 'https://www.zhihu.com/';
const NEED = ['z_c0']; // 登录标志 cookie(只比对名字,不打印值)

async function loggedIn(ctx) {
  const names = new Set((await ctx.cookies(HOME)).map((c) => c.name));
  return NEED.every((n) => names.has(n));
}

// ---- 最小 Markdown -> HTML:标题/表格/列表/段落/加粗/行内码/链接 ----
function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
}
function cells(line) {
  return line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}
function mdToHtml(md) {
  const lines = md.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    const h = l.match(/^(#{1,6})\s+(.*)$/);
    if (h) { const n = h[1].length; out.push(`<h${n}>${inline(h[2])}</h${n}>`); i++; continue; }
    if (/^\|/.test(l) && /^\|[\s:|-]+\|?$/.test(lines[i + 1] || '')) {
      const head = cells(l);
      const body = [];
      i += 2;
      while (i < lines.length && /^\|/.test(lines[i])) { body.push(cells(lines[i])); i++; }
      const th = head.map((c) => `<th>${inline(c)}</th>`).join('');
      const trs = body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('');
      out.push(`<table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`);
      continue;
    }
    if (/^[-*]\s+/.test(l)) {
      const items = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) { items.push(lines[i].replace(/^[-*]\s+/, '')); i++; }
      out.push(`<ul>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</ul>`);
      continue;
    }
    if (/^\d+\.\s+/.test(l)) {
      const items = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) { items.push(lines[i].replace(/^\d+\.\s+/, '')); i++; }
      out.push(`<ol>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</ol>`);
      continue;
    }
    const buf = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|\||[-*]\s|\d+\.\s)/.test(lines[i])) { buf.push(lines[i]); i++; }
    out.push(`<p>${inline(buf.join(''))}</p>`);
  }
  return out.join('\n');
}

async function draft(ctx, file, articleId) {
  const raw = fs.readFileSync(file, 'utf-8').split('\n');
  const title = raw[0].replace(/^#\s*/, '').trim();
  const body = mdToHtml(raw.slice(1).join('\n').trim());
  const page = await ctx.newPage();
  const url = articleId ? `https://zhuanlan.zhihu.com/p/${articleId}/edit` : 'https://zhuanlan.zhihu.com/write';
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(6000);

  const ti = page.locator('textarea[placeholder*="请输入标题"]').first();
  await ti.click();
  await ti.fill(title);
  await page.waitForTimeout(500);

  const ed = page.locator('.public-DraftEditor-content').first();
  await ed.click();
  if (articleId) {
    // 覆盖已有草稿:先清空编辑器,否则粘贴内容会追加到原文后面
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(1000);
  }
  // Draft.js 的粘贴走 onPaste,必须带 text/html 才会保留标题/表格/列表结构
  await page.evaluate((html) => {
    const el = document.querySelector('.public-DraftEditor-content');
    const dt = new DataTransfer();
    dt.setData('text/html', html);
    dt.setData('text/plain', el.innerText);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, body);
  await page.waitForTimeout(3000);

  // 知乎自动保存:URL 会变成 /p/<id>/edit
  let id = null;
  const end = Date.now() + 40000;
  while (Date.now() < end) {
    const m = page.url().match(/\/p\/(\d+)/);
    if (m) { id = m[1]; break; }
    await page.waitForTimeout(2000);
  }
  await page.screenshot({ path: path.join(OUT, 'zhihu_draft.png'), fullPage: false });
  console.log('截图:', path.join(OUT, 'zhihu_draft.png'));
  if (!id) { console.log('警告:URL 里没有草稿 id,可能没保存成功。当前 URL:', page.url()); process.exitCode = 1; return; }

  console.log('草稿链接:', `https://zhuanlan.zhihu.com/p/${id}/edit`);

  // 回读:新开页面读服务器上的草稿
  const p2 = await ctx.newPage();
  await p2.goto(`https://zhuanlan.zhihu.com/p/${id}/edit`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await p2.waitForTimeout(8000);
  const r = await p2.evaluate(() => {
    const t = document.querySelector('textarea[placeholder*="请输入标题"]');
    const e = document.querySelector('.public-DraftEditor-content');
    return { title: t ? t.value.trim() : '', chars: e ? e.innerText.length : 0, lines: e ? e.innerText.split('\n').length : 0 };
  });
  const ok = r.title === title && r.chars > 500;
  console.log(`回读: 标题${r.title === title ? '一致' : '不一致'},${r.lines} 行 / ${r.chars} 字符 →`, ok ? '通过' : '未通过');
  if (!ok) process.exitCode = 1;
}

(async () => {
  const [mode, file, articleId] = process.argv.slice(2);
  if (mode === 'login') {
    let ctx = await chromium.launchPersistentContext(PROFILE, { headless: true });
    const ok = await loggedIn(ctx);
    await ctx.close();
    if (ok) { console.log('知乎 已登录,无需弹窗'); return; }
    ctx = await chromium.launchPersistentContext(PROFILE, { headless: false, viewport: null });
    const page = await ctx.newPage();
    await page.goto('https://www.zhihu.com/signin').catch(() => {});
    console.log('已弹出浏览器,请在窗口里登录知乎(最长等待 10 分钟)...');
    const end = Date.now() + 10 * 60 * 1000;
    while (Date.now() < end && !(await loggedIn(ctx))) await new Promise((r) => setTimeout(r, 3000));
    console.log((await loggedIn(ctx)) ? '登录成功' : '超时未登录');
    await ctx.close();
    return;
  }
  const ctx = await chromium.launchPersistentContext(PROFILE, { headless: true, viewport: { width: 1400, height: 900 } });
  try {
    if (mode === 'check') console.log('知乎', (await loggedIn(ctx)) ? '已登录' : '未登录');
    else if (mode === 'draft') {
      if (!file) { console.error('用法: node zhihu.js draft <file.md> [articleId]'); process.exitCode = 2; }
      else if (!(await loggedIn(ctx))) { console.error('知乎 未登录,先运行: node zhihu.js login'); process.exitCode = 3; }
      else await draft(ctx, path.resolve(file), articleId);
    } else { console.error('模式应为 check | login | draft'); process.exitCode = 2; }
  } catch (e) { console.error('ERR', e.message.split('\n')[0]); process.exitCode = 1; }
  await ctx.close();
})();
