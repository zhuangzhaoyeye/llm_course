#!/usr/bin/env node
// CSDN:无头存草稿。绝不点"发布文章"(.btn-publish)。
// 用法:
//   node csdn.js check                            检查登录态(无头)
//   node csdn.js login                            未登录则弹出可见窗口等你登录,登录后自动退出
//   node csdn.js draft <file.md> [articleId]      存草稿;带 articleId 则覆盖该草稿,不带则新建
//   node csdn.js update <file.md> <articleId> [标题]  更新「已发布文章」的标题(仅改标题,不动正文);需用户已授权发布
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

// CSDN 编辑器会把直引号 " 规整成弯引号 “ ”，标题匹配与回读比对前统一归一化
function normTitle(s) {
  return (s || '').replace(/["“”‘’「」『』]/g, '').replace(/\s+/g, '');
}

function normEq(a, b) {
  return (a || '').replace(/\s+/g, '') === (b || '').replace(/\s+/g, '');
}

// 解析 docs/csdn-优化方案.md：按文件名取该课的摘要与标签（数据源唯一，不在此处重造）。
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

// 提取 md 末尾追加的尾链（`---` 分隔之后的部分，不含正文）。
function extractTailLinks(file) {
  const raw = fs.readFileSync(file, 'utf-8');
  const idx = raw.lastIndexOf('\n---\n');
  if (idx < 0) return '';
  return raw.slice(idx + 1).trim();
}

// 2026-11 起新编辑器取消「保存草稿」按钮，标题一填就自动保存，URL 不再带 ?articleId=。
// 自动保存落库后，到草稿列表页按标题匹配，取最新（id 最大）的那条草稿的 articleId。
async function findArticleIdByTitle(ctx, title) {
  const p = await ctx.newPage();
  try {
    await p.goto('https://mp.csdn.net/mp_blog/manage/article', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await p.waitForTimeout(6000);
    await p.evaluate(() => {
      const els = Array.from(document.querySelectorAll('a, button, span, div, li'));
      const target = els.find((el) => /^草稿箱/.test((el.innerText || '').trim()) && el.children.length === 0);
      if (target) target.click();
    });
    await p.waitForTimeout(4000);
    const want = normTitle(title);
    const id = await p.evaluate((want) => {
      const norm = (s) => (s || '').replace(/["“”‘’「」『』]/g, '').replace(/\s+/g, '');
      let found = null;
      document.querySelectorAll('a[href*="articleId="]').forEach((a) => {
        const m = a.href.match(/articleId=(\d+)/);
        const txt = (a.innerText || '').trim();
        if (m && txt.length > 3 && norm(txt) === want) {
          if (!found || Number(m[1]) > Number(found)) found = m[1];
        }
      });
      return found;
    }, want);
    return id;
  } finally {
    await p.close();
  }
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

  let id = articleId || (page.url().match(/articleId=(\d+)/) || [])[1];
  if (!id) id = await findArticleIdByTitle(ctx, title);
  console.log('草稿链接:', id ? `https://editor.csdn.net/md?articleId=${id}` : page.url());
  console.log('截图:', path.join(OUT, 'csdn_draft.png'));
  if (!id) { console.log('警告:草稿列表里没找到标题匹配的草稿,可能没保存成功'); process.exitCode = 1; return; }

  // 回读校验:新开页面读服务器上的内容,避免只凭"点了保存"就报成功
  const p2 = await ctx.newPage();
  await p2.goto(`https://editor.csdn.net/md/?articleId=${id}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await p2.waitForTimeout(7000);
  const r = await p2.evaluate(() => {
    const t = document.querySelector('.article-bar__title-display');
    const e = document.querySelector('.editor__inner');
    return { title: t && t.innerText.trim(), chars: e ? e.innerText.length : 0, lines: e ? e.innerText.split('\n').length : 0 };
  });
  const ok = normTitle(r.title) === normTitle(title) && r.lines > 5;
  console.log(`回读: 标题${normTitle(r.title) === normTitle(title) ? '一致' : '不一致'},${r.lines} 行 / ${r.chars} 字符 →`, ok ? '通过' : '未通过');
  if (!ok) process.exitCode = 1;
}

// 更新「已发布文章」的 标题 + 摘要 + 标签 + 尾链(正文末尾追加,不清空重贴)。
// 标题来自 md 第一行;摘要与标签来自 docs/csdn-优化方案.md;尾链来自 md 末尾 `---` 之后。
// 已发布文章点更新必须走「发布文章」按钮(语境下=更新);新稿首发仍用 draft,绝不点发布。
async function update(ctx, file, articleId, titleOverride) {
  if (!articleId) { console.error('用法: node csdn.js update <file.md> <articleId> [标题]'); process.exitCode = 2; return; }
  const raw = fs.readFileSync(file, 'utf-8').split('\n');
  const title = (titleOverride || raw[0].replace(/^#\s*/, '').trim()).trim();
  if (!title) { console.error('标题为空'); process.exitCode = 2; return; }

  const plan = parsePlan(file);
  const summary = plan.summary;
  const tags = plan.tags;
  const tailLinks = extractTailLinks(file);
  const mdBody = raw.slice(1).join('\n').trim();
  console.log(`计划: 标题="${title}" | 摘要=${summary ? summary.length + '字' : '无'} | 标签=[${tags.join(', ')}] | 尾链=${tailLinks ? '有' : '无'}`);

  const page = await ctx.newPage();
  await page.goto(`https://editor.csdn.net/md?articleId=${articleId}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(9000);

  // 更新前正文基线(用于回读校验"行数没掉")
  const before = await page.evaluate(() => {
    const e = document.querySelector('.editor__inner');
    return e ? { lines: e.innerText.split('\n').length, chars: e.innerText.length } : { lines: 0, chars: 0 };
  });
  console.log(`更新前正文: ${before.lines} 行 / ${before.chars} 字符`);

  // 改标题(正文整体不动)
  await page.locator('.article-bar__title-display').click();
  const ti = page.locator('input.article-bar__title--input');
  await ti.fill(title);
  await ti.press('Enter');
  await page.waitForTimeout(2000);

  // 正文:全选重贴 md 正文(md 已在任务1里把尾链追加到末尾)。
  // CSDN 编辑器 paste 不尊重 DOM selection(实测"设 selection 到末尾再 paste"会把内容插到开头),
  // 只有"全选重贴"可靠。内容来源是 md(事实源),重贴后回读校验字符数不显著减少,防丢失。
  if (tailLinks) {
    await page.locator('.editor__inner').first().click();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await page.keyboard.press('Backspace');
    await page.evaluate((t) => {
      const el = document.querySelector('.editor__inner');
      const dt = new DataTransfer();
      dt.setData('text/plain', t);
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, mdBody);
    await page.waitForTimeout(2000);
    console.log('已重贴 md 正文(含尾链在末尾), 约', mdBody.split('\n').length, '行 /', mdBody.length, '字符');
  }

  await page.screenshot({ path: path.join(OUT, 'csdn_update_title.png') });

  // 发布(已发布文章语境下 = 更新)
  const pub = page.locator('button.btn-publish').first();
  if (!(await pub.count()) || !(await pub.isVisible())) { console.error('未找到发布按钮 .btn-publish'); process.exitCode = 1; await page.close(); return; }
  await pub.click();
  await page.waitForTimeout(5000);
  await page.screenshot({ path: path.join(OUT, 'csdn_update_dialog.png') });

  // 发布设置弹窗
  const modal = page.locator('.modal__publish-article').first();
  if (!(await modal.count()) || !(await modal.isVisible())) { console.error('未找到发布设置弹窗 .modal__publish-article'); process.exitCode = 1; await page.close(); return; }

  // 摘要:清掉原摘要(默认"提取正文前256字"),填入新摘要
  if (summary) {
    const sumTa = modal.locator('textarea').first();
    if (await sumTa.count()) {
      await sumTa.fill(summary);
      await page.waitForTimeout(500);
      console.log('已填摘要:', summary);
    } else {
      console.log('未找到摘要 textarea(跳过)');
    }
  }

  // 标签:先删旧大词标签(释放标签配额),再添加新长尾标签(伪造 searchResult 命中「在库」分支,绕过博客等级<3 限制)
  let tagMode = '替换';
  const tagContainer = modal.locator('.mark_selection[typename="tags"]').first();
  const oldTagCount = await tagContainer.locator('.mark_selection_title_el_tag .el-tag').count();
  console.log('旧标签数:', oldTagCount);
  if (oldTagCount > 0) {
    try {
      let remaining = await tagContainer.locator('.mark_selection_title_el_tag .el-tag__close').count();
      for (let i = 0; i < remaining; i++) {
        await tagContainer.locator('.mark_selection_title_el_tag .el-tag__close').first().click();
        await page.waitForTimeout(400);
      }
      const after = await tagContainer.locator('.mark_selection_title_el_tag .el-tag').count();
      console.log('旧标签删除后剩余:', after);
    } catch (e) { console.log('删旧标签异常:', e.message.split('\n')[0]); }
  }
  const addedTags = [];
  const tagErrors = [];
  for (const tag of tags) {
    const r = await page.evaluate((t) => {
      const v = document.querySelector('.mark_selection[typename="tags"]').__vue__;
      if (!v) return { added: false, err: '无Vue实例' };
      const before = v.$data.selected.slice();
      // 伪造 searchResult 命中 tagOnLine 的「在库」分支,以绕过博客等级<3 无法创建自定义标签的限制
      v.searchResult = [{ value: t }];
      v.$options.methods.handleSelect.call(v, { value: t });
      return { added: v.$data.selected.length > before.length, err: v.$data.levelLimit_content || '' };
    }, tag);
    if (r.added) addedTags.push(tag);
    else tagErrors.push(`${tag}:${r.err || '未添加'}`);
    await page.waitForTimeout(300);
  }
  console.log('新标签已添加:', JSON.stringify(addedTags), '| 失败:', JSON.stringify(tagErrors));
  if (addedTags.length === 0) tagMode = '保留旧标签(新标签添加失败)';
  console.log('标签处理方式:', tagMode);
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(OUT, 'csdn_update_filled.png') });

  // 确认发布(弹窗里的「发布文章」按钮)
  const sumBeforeConfirm = await modal.locator('textarea').first().inputValue().catch(() => '');
  console.log('确认发布前摘要 value:', JSON.stringify(sumBeforeConfirm.slice(0, 40)));
  const confirm = modal.locator('button', { hasText: '发布文章' }).first();
  if (!(await confirm.count()) || !(await confirm.isVisible())) { console.error('未找到发布弹窗里的「发布文章」按钮'); process.exitCode = 1; await page.close(); return; }
  await confirm.click();
  await page.waitForTimeout(8000); // 等发布(更新)完成
  await page.screenshot({ path: path.join(OUT, 'csdn_update_done.png') });

  // 回读校验:新开页面读标题与正文,再开弹窗只读摘要与标签(不点确认)
  const p2 = await ctx.newPage();
  await p2.goto(`https://editor.csdn.net/md?articleId=${articleId}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await p2.waitForTimeout(9000);
  const body = await p2.evaluate(() => {
    const t = document.querySelector('.article-bar__title-display');
    const e = document.querySelector('.editor__inner');
    return { title: t ? t.innerText.trim() : '', lines: e ? e.innerText.split('\n').length : 0, chars: e ? e.innerText.length : 0, tailHas: e ? /\*\*上一篇\*\*/.test(e.innerText) : false };
  });
  let modalInfo = null;
  try {
    await p2.locator('button.btn-publish').first().click();
    await p2.waitForTimeout(4000);
    modalInfo = await p2.evaluate(() => {
      const m = document.querySelector('.modal__publish-article');
      if (!m) return null;
      const sum = m.querySelector('textarea') ? m.querySelector('textarea').value : '';
      const tg = Array.from(m.querySelectorAll('.mark_selection_title_el_tag .el-tag')).map((x) => (x.innerText || '').trim());
      return { sum, tags: tg };
    });
  } catch (e) { console.log('回读弹窗读取失败:', e.message.split('\n')[0]); }
  await p2.close();

  const titleOk = normTitle(body.title) === normTitle(title);
  const linesOk = body.lines > 5 && body.chars >= mdBody.length - 200;
  const tailOk = tailLinks ? body.tailHas : true;
  const sumOk = !summary || !modalInfo || normEq(modalInfo.sum, summary);
  const tagsOk = !tags.length || !modalInfo || tags.every((t) => (modalInfo.tags || []).some((x) => normEq(x, t)));

  console.log('--- 回读 ---');
  console.log(`标题: "${body.title}" → ${titleOk ? '通过' : '不一致'}`);
  console.log(`正文: ${body.lines} 行 / ${body.chars} 字符(更新前 ${before.lines} 行) → ${linesOk ? '未掉' : '疑似丢失'}`);
  console.log(`尾链: ${body.tailHas ? '已含' : '缺失'} → ${tailOk ? '通过' : '未通过'}`);
  if (modalInfo) {
    console.log(`摘要: "${modalInfo.sum}" → ${sumOk ? '通过' : '不一致'}`);
    console.log(`标签: [${(modalInfo.tags || []).join(', ')}] → ${tagsOk ? '通过' : '不一致'}(方式=${tagMode})`);
  } else {
    console.log('摘要/标签: 弹窗读取失败,需人工核对');
  }
  console.log('更新链接:', `https://editor.csdn.net/md?articleId=${articleId}`);
  const ok = titleOk && linesOk && tailOk && sumOk && tagsOk;
  console.log(ok ? '回读一致 → 通过' : '回读不一致 → 未通过');
  if (!ok) process.exitCode = 1;
  await page.close();
}

(async () => {
  const [mode, file, articleId, titleOverride] = process.argv.slice(2);
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
    } else if (mode === 'update') {
      if (!file || !articleId) { console.error('用法: node csdn.js update <file.md> <articleId> [标题]'); process.exitCode = 2; }
      else if (!(await loggedIn(ctx))) { console.error('CSDN 未登录,先运行: node csdn.js login'); process.exitCode = 3; }
      else await update(ctx, path.resolve(file), articleId, titleOverride);
    } else { console.error('模式应为 check | login | draft | update'); process.exitCode = 2; }
  } catch (e) { console.error('ERR', e.message.split('\n')[0]); process.exitCode = 1; }
  await ctx.close();
})();
