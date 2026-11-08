#!/usr/bin/env node
// CSDN:无头存草稿。绝不点"发布文章"(.btn-publish)。
// 用法:
//   node csdn.js check                            检查登录态(无头)
//   node csdn.js login                            未登录则弹出可见窗口等你登录,登录后自动退出
//   node csdn.js draft <file.md> [articleId]      存草稿;带 articleId 则覆盖该草稿,不带则新建
// 约定:md 第一行 "# 标题" 是标题,其余是正文。
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
const HOME = 'https://www.csdn.net/';
const NEED = ['UserToken']; // 登录标志 cookie(只比对名字,不打印值)

async function loggedIn(ctx) {
  const names = new Set((await ctx.cookies(HOME)).map((c) => c.name));
  return NEED.every((n) => names.has(n));
}

async function draft(ctx, file, articleId) {
  const raw = fs.readFileSync(file, 'utf-8').split('\n');
  const title = raw[0].replace(/^#\s*/, '').trim();
  const body = raw.slice(1).join('\n').trim();
  const page = await ctx.newPage();
  await page.goto('https://editor.csdn.net/md/' + (articleId ? `?articleId=${articleId}` : ''), { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(6000);

  // 标题:页面上看到的是 div,点一下才变成 input(DOM 里还有一个 0x0 的隐藏 input,别选错)
  await page.locator('.article-bar__title-display').click();
  const ti = page.locator('input.article-bar__title--input');
  await ti.fill(title);
  await ti.press('Enter');

  // 正文:contenteditable 的 PRE。keyboard.insertText 会吞换行,必须用 paste 事件
  await page.locator('.editor__inner').first().click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await page.keyboard.press('Backspace');
  await page.evaluate((t) => {
    const el = document.querySelector('.editor__inner');
    const dt = new DataTransfer();
    dt.setData('text/plain', t);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, body);
  await page.waitForTimeout(2000);

  // 保存:2026-11 起 CSDN 换成新编辑器,取消了"保存草稿"按钮——标题一填就自动保存,
  // 页面上只剩"发布文章"(btn-publish),那个绝不能点。旧版编辑器仍有 btn-save,保留兼容。
  const legacySave = page.locator('button.btn-save');
  if ((await legacySave.count()) && (await legacySave.first().isVisible())) {
    await legacySave.first().click();
    await page.waitForTimeout(1000);
    await page.locator('.el-popover:visible').getByText('保存草稿', { exact: true }).click();
    await page.waitForTimeout(5000);
  } else {
    await page.waitForTimeout(12000); // 等自动保存落库
  }
  await page.screenshot({ path: path.join(OUT, 'csdn_draft.png') });

  const id = (page.url().match(/articleId=(\d+)/) || [])[1];
  console.log('草稿链接:', id ? `https://editor.csdn.net/md?articleId=${id}` : page.url());
  console.log('截图:', path.join(OUT, 'csdn_draft.png'));
  if (!id) { console.log('警告:URL 里没有 articleId,草稿可能没建起来'); process.exitCode = 1; return; }

  // 回读校验:新开页面读服务器上的内容,避免只凭"点了保存"就报成功
  const p2 = await ctx.newPage();
  await p2.goto(`https://editor.csdn.net/md/?articleId=${id}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await p2.waitForTimeout(7000);
  const r = await p2.evaluate(() => {
    const t = document.querySelector('.article-bar__title-display');
    const e = document.querySelector('.editor__inner');
    return { title: t && t.innerText.trim(), chars: e ? e.innerText.length : 0, lines: e ? e.innerText.split('\n').length : 0 };
  });
  const ok = r.title === title && r.lines > 5;
  console.log(`回读: 标题${r.title === title ? '一致' : '不一致'},${r.lines} 行 / ${r.chars} 字符 →`, ok ? '通过' : '未通过');
  if (!ok) process.exitCode = 1;
}

(async () => {
  const [mode, file, articleId] = process.argv.slice(2);
  if (mode === 'login') {
    let ctx = await chromium.launchPersistentContext(PROFILE, { headless: true });
    const ok = await loggedIn(ctx);
    await ctx.close();
    if (ok) { console.log('CSDN 已登录,无需弹窗'); return; }
    ctx = await chromium.launchPersistentContext(PROFILE, { headless: false, viewport: null });
    const page = await ctx.newPage();
    await page.goto('https://passport.csdn.net/login').catch(() => {});
    console.log('已弹出浏览器,请在窗口里登录 CSDN(最长等待 10 分钟)...');
    const end = Date.now() + 10 * 60 * 1000;
    while (Date.now() < end && !(await loggedIn(ctx))) await new Promise((r) => setTimeout(r, 3000));
    console.log((await loggedIn(ctx)) ? '登录成功' : '超时未登录');
    await ctx.close();
    return;
  }
  const ctx = await chromium.launchPersistentContext(PROFILE, { headless: true, viewport: { width: 1400, height: 900 } });
  try {
    if (mode === 'check') console.log('CSDN', (await loggedIn(ctx)) ? '已登录' : '未登录');
    else if (mode === 'draft') {
      if (!file) { console.error('用法: node csdn.js draft <file.md> [articleId]'); process.exitCode = 2; }
      else if (!(await loggedIn(ctx))) { console.error('CSDN 未登录,先运行: node csdn.js login'); process.exitCode = 3; }
      else await draft(ctx, path.resolve(file), articleId);
    } else { console.error('模式应为 check | login | draft'); process.exitCode = 2; }
  } catch (e) { console.error('ERR', e.message.split('\n')[0]); process.exitCode = 1; }
  await ctx.close();
})();
