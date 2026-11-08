#!/usr/bin/env node
// 掘金:无头存草稿。绝不点"发布"。
// 用法:
//   node juejin.js check                          检查登录态(无头)
//   node juejin.js login                          未登录则弹出可见窗口等你登录,登录后自动退出
//   node juejin.js draft <file.md> [draftId]      存草稿;带 draftId 则覆盖该草稿,不带则新建
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
    } else { console.error('模式应为 check | login | draft'); process.exitCode = 2; }
  } catch (e) { console.error('ERR', e.message.split('\n')[0]); process.exitCode = 1; }
  await ctx.close();
})();
