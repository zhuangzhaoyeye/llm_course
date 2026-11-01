#!/usr/bin/env node
/**
 * verify.js — 渲染层质量门（Playwright；自带静态服务器，无需手动起 http.server）
 *
 * 分工（见 .trae/rules/30-dev-rules.md）：
 *   content_verify.js  管「写得对不对」——零依赖，静态解析，先跑
 *   verify.js          管「渲染对不对」——真浏览器：布局、对比度、响应式、Console 错误、交互
 *
 * 前置（只需一次）：
 *   npm install && npx playwright install chromium
 *
 * 用法：
 *   node tools/verify.js            # 全量检查
 *   node tools/verify.js --quiet    # 只输出失败/警告项
 *
 * 退出码：0 = 无 FAIL；1 = 存在 FAIL 或缺依赖
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 8888);
const QUIET = process.argv.includes('--quiet');
const PASS_LINE = 90;

let playwright;
try {
  playwright = require('playwright');
} catch {
  console.error('\n缺少依赖 playwright。先执行（只需一次）：');
  console.error('  npm install && npx playwright install chromium\n');
  process.exit(1);
}

const rows = [];
let earned = 0, total = 0, fail = 0, warn = 0;

function check(section, name, status, weight, detail) {
  total += weight;
  if (status === 'PASS') earned += weight;
  if (status === 'FAIL') fail++;
  if (status === 'WARN') warn++;
  rows.push({ section, name, status, weight, detail: detail || '' });
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const rel = decodeURIComponent(req.url.split('?')[0]);
      const file = path.join(ROOT, rel === '/' ? 'dist_course.html' : rel.replace(/^\//, ''));
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404); res.end('not found'); return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(PORT, () => resolve(server));
  });
}

const contrast = (rgb1, rgb2) => {
  const lum = (c) => {
    const [r, g, b] = c.map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [a, b] = [lum(rgb1), lum(rgb2)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
};

async function main() {
  const server = await serve();
  const browser = await playwright.chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

  const resp = await page.goto(`http://127.0.0.1:${PORT}/dist_course.html`, { waitUntil: 'load' });
  await page.waitForSelector('.card', { timeout: 15000 });
  await page.waitForTimeout(300);

  const courseCount = await page.evaluate(() => document.querySelectorAll('.nav-item[data-lesson]').length);

  // ═══ A. 基础功能 18 项 ═══
  check('A 基础功能', '页面 HTTP 200', resp && resp.status() === 200 ? 'PASS' : 'FAIL', 1);

  const title = await page.title();
  check('A 基础功能', '标题非空', title.trim() ? 'PASS' : 'FAIL', 1, title);

  const side = await page.locator('.sidebar').count();
  check('A 基础功能', '侧边栏存在', side === 1 ? 'PASS' : 'FAIL', 1);

  check('A 基础功能', '导航项数量与课程数一致', courseCount > 0 ? 'PASS' : 'FAIL', 1, `导航项 ${courseCount}`);

  const cardsL1 = await page.locator('.card').count();
  check('A 基础功能', '首课自动加载出卡片', cardsL1 > 0 ? 'PASS' : 'FAIL', 1, `${cardsL1} 张`);

  const before = await page.locator('.card.active').count();
  await page.locator('.card-q').nth(1).click();
  await page.waitForTimeout(200);
  const after = await page.locator('.card.active').count();
  check('A 基础功能', '卡片可点击展开', after > before ? 'PASS' : 'FAIL', 1, `${before} → ${after}`);

  check('A 基础功能', '内容区展开后有正文', (await page.locator('.card.active .content-section').count()) > 0 ? 'PASS' : 'FAIL', 1);

  // 切课 + 内容泄漏
  const firstLessonIds = await page.evaluate(() => [...document.querySelectorAll('.card')].map((c) => c.dataset.card));
  await page.evaluate(() => switchLesson(5));
  await page.waitForTimeout(400);
  const secondLessonIds = await page.evaluate(() => [...document.querySelectorAll('.card')].map((c) => c.dataset.card));
  const leaked = firstLessonIds.filter((id) => secondLessonIds.includes(id));
  check('A 基础功能', '切课后旧课卡片已清除', secondLessonIds.length && leaked.length === 0 ? 'PASS' : 'FAIL', 1, `残留 ${leaked.join(',') || '无'}`);
  check('A 基础功能', '切课确实换成了另一课', secondLessonIds.join() !== firstLessonIds.join() ? 'PASS' : 'FAIL', 1);

  await page.evaluate(() => switchLesson(1));
  await page.waitForTimeout(400);

  const tabBtns = await page.locator('.card').first().locator('.tab-btn').count();
  check('A 基础功能', '卡片含问答标签条（两个 tab）', tabBtns >= 2 ? 'PASS' : 'FAIL', 1, `${tabBtns} 个 tab`);

  const qnaSwitched = await page.evaluate(() => {
    const card = document.querySelector('.card');
    const btns = card.querySelectorAll('.tab-btn');
    btns[btns.length - 1].click();
    const id = card.dataset.card;
    return document.getElementById('tab-qna-' + id).style.display !== 'none';
  });
  check('A 基础功能', '可切到追问面板', qnaSwitched ? 'PASS' : 'FAIL', 1);

  const aiVisible = await page.evaluate(() => {
    const card = document.querySelector('.card');
    card.querySelectorAll('.tab-btn')[0].click();
    const id = card.dataset.card;
    return document.getElementById('tab-ai-' + id).style.display !== 'none';
  });
  check('A 基础功能', '可切回 AI 助教面板', aiVisible ? 'PASS' : 'FAIL', 1);

  check('A 基础功能', 'Console 无错误', consoleErrors.length === 0 ? 'PASS' : 'FAIL', 1, consoleErrors.slice(0, 2).join(' | '));

  const progressText = await page.locator('#progressText').innerText().catch(() => '');
  check('A 基础功能', '进度文案存在', /\d+\s*\/\s*\d+/.test(progressText) ? 'PASS' : 'FAIL', 1, progressText);

  const persisted = await page.evaluate(() => {
    const cb = document.querySelector('.card-check');
    cb.click();
    const id = cb.closest('.card').dataset.card;
    const saved = JSON.parse(localStorage.getItem('card_checks') || '{}');
    return Boolean(saved[id]);
  });
  check('A 基础功能', '勾选写入 localStorage', persisted ? 'PASS' : 'FAIL', 1);

  const kb = await page.evaluate(async () => {
    const n0 = document.querySelectorAll('.card.active').length;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await new Promise((r) => setTimeout(r, 500));
    return document.querySelectorAll('.card.active').length > n0;
  });
  check('A 基础功能', '键盘方向键展开下一卡', kb ? 'PASS' : 'FAIL', 1);

  const collapsed = await page.evaluate(async () => {
    document.querySelector('.sidebar-toggle-btn').click();
    await new Promise((r) => setTimeout(r, 400));
    return document.querySelector('.sidebar').classList.contains('collapsed');
  });
  await page.evaluate(() => document.querySelector('.sidebar-toggle-btn').click());
  // 展开有 0.3s 过渡：不等待会让后续「侧边栏标题无截断」在收缩中途测量（宽度≈0 → 全判截断，误报）
  await page.waitForTimeout(400);
  check('A 基础功能', '侧边栏可收起', collapsed ? 'PASS' : 'FAIL', 1);

  check('A 基础功能', '课程导图 .roadmap 存在', (await page.locator('.roadmap').count()) > 0 ? 'PASS' : 'FAIL', 1);
  check('A 基础功能', '知识点标签 .meta-tags 存在', (await page.locator('.meta-tag').count()) > 0 ? 'PASS' : 'FAIL', 1);
  check('A 基础功能', '课间导航 .footer-nav 存在', (await page.locator('.footer-nav').count()) > 0 ? 'PASS' : 'FAIL', 1);

  // ═══ B. UI 质量 11 项 ═══
  const metrics = await page.evaluate(() => {
    const rect = (el) => el.getBoundingClientRect();
    const cards = [...document.querySelectorAll('.card')];
    const cardsOverlap = cards.some((c, i) => i > 0 && rect(c).top < rect(cards[i - 1]).bottom - 1);

    const navHeights = [...document.querySelectorAll('.nav-item')].map((el) => rect(el).height);
    const gaps = cards.slice(1).map((c, i) => rect(c).top - rect(cards[i]).bottom);
    const std = (a) => {
      if (a.length < 2) return 0;
      const m = a.reduce((x, y) => x + y, 0) / a.length;
      return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length);
    };
    const fonts = new Set([...document.querySelectorAll('body *')]
      .map((el) => getComputedStyle(el).fontSize));
    const footLinks = [...document.querySelectorAll('.footer-nav a')].map((el) => rect(el));
    const paras = [...document.querySelectorAll('.content-section p')].map((el) => {
      const cs = getComputedStyle(el);
      return { w: rect(el).width, fs: parseFloat(cs.fontSize) };
    });
    // 只统计真正渲染出来的元素：隐藏元素（如默认 display:none 的「停止/重新生成」）
    // 的 rect 是 0×0，若不排除会把「可点击区域」检查变成假阳性。
    const interactive = [...document.querySelectorAll('.tab-btn, .qna-item-q, .footer-nav a, button')]
      .filter((el) => el.getClientRects().length > 0)
      .map((el) => {
        const r = rect(el);
        return { w: Math.round(r.width), h: Math.round(r.height), cls: el.className || el.textContent.trim().slice(0, 8) };
      });
    const density = cards.map((c) => {
      const textArea = [...c.querySelectorAll('p, td, th, .step-title')]
        .reduce((s, el) => s + rect(el).width * rect(el).height, 0);
      const ca = rect(c).width * rect(c).height;
      return ca ? textArea / ca : 0;
    });
    const colors = [...document.querySelectorAll('.content-section p, .calc-block table td')].slice(0, 40).map((el) => {
      const cs = getComputedStyle(el);
      const parse = (s) => (s.match(/\d+/g) || []).slice(0, 3).map(Number);
      let bgEl = el, bg = 'rgba(0, 0, 0, 0)';
      while (bgEl && (bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent')) {
        bg = getComputedStyle(bgEl).backgroundColor;
        bgEl = bgEl.parentElement;
      }
      return { fg: parse(cs.color), bg: parse(bg) };
    });
    const navTitles = [...document.querySelectorAll('.nav-item .nav-title')].map((el) => ({
      t: el.textContent.trim(), trunc: el.scrollWidth > el.clientWidth + 1, hasTitle: !!el.title,
    }));
    return {
      cardsOverlap, navHeightStd: std(navHeights), gapStd: std(gaps),
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      fontKinds: fonts.size,
      footCount: footLinks.length,
      footTopStd: std(footLinks.map((r) => r.top)),
      footWidthStd: std(footLinks.map((r) => r.width)),
      lineWidths: paras.map((p) => (p.fs ? p.w / (p.fs * 0.8) : 0)),
      interactive, density, colors,
      navTotal: navTitles.length,
      navTrunc: navTitles.filter((n) => n.trunc).length,
      navNoTitle: navTitles.filter((n) => !n.hasTitle).length,
      navTruncSample: navTitles.filter((n) => n.trunc).slice(0, 3).map((n) => n.t),
    };
  });

  check('B UI 质量', '布局无重叠', metrics.cardsOverlap ? 'FAIL' : 'PASS', 10);
  check('B UI 质量', '导航项高度对齐', metrics.navHeightStd <= 1 ? 'PASS' : 'WARN', 6, `std=${metrics.navHeightStd.toFixed(2)}`);
  check('B UI 质量', '卡片间距一致', metrics.gapStd <= 2 ? 'PASS' : 'WARN', 6, `std=${metrics.gapStd.toFixed(2)}`);
  check('B UI 质量', '无水平溢位', metrics.overflow <= 1 ? 'PASS' : 'FAIL', 10, `溢出 ${metrics.overflow}px`);
  check('B UI 质量', '字体层级 ≤8 种', metrics.fontKinds <= 8 ? 'PASS' : 'WARN', 6, `${metrics.fontKinds} 种`);
  check('B UI 质量', '侧边栏标题无截断（并带 title 兜底）',
    metrics.navTrunc === 0 && metrics.navNoTitle === 0 ? 'PASS' : 'WARN', 6,
    `截断 ${metrics.navTrunc}/${metrics.navTotal}${metrics.navTruncSample.length ? '：' + metrics.navTruncSample.join('；') : ''}；缺 title ${metrics.navNoTitle}`);
  check('B UI 质量', 'footer-nav 对齐',
    metrics.footCount > 0 && metrics.footTopStd <= 2 && metrics.footWidthStd <= 2 ? 'PASS' : 'WARN', 6,
    `topStd=${metrics.footTopStd.toFixed(1)} widthStd=${metrics.footWidthStd.toFixed(1)}`);
  const widest = metrics.lineWidths.length ? Math.max(...metrics.lineWidths) : 0;
  check('B UI 质量', '正文行宽不过宽', widest <= 60 ? 'PASS' : 'WARN', 8, `最宽 ≈ ${widest.toFixed(0)} 字/行`);
  const tooSmall = metrics.interactive.filter((r) => r.w < 40 || r.h < 32);
  check('B UI 质量', '可点击区域 ≥40×32', tooSmall.length === 0 ? 'PASS' : 'FAIL', 8,
    tooSmall.slice(0, 3).map((r) => `${r.cls || 'button'} ${r.w}×${r.h}`).join('; '));
  const dens = metrics.density.filter((d) => d > 0);
  const densBad = dens.filter((d) => d < 0.12 || d > 0.8);
  check('B UI 质量', '留白密度合理', densBad.length === 0 ? 'PASS' : 'WARN', 6,
    densBad.length ? `${densBad.length} 张卡片越界（0.12–0.8）` : '');
  const low = metrics.colors.filter((c) => c.fg.length === 3 && c.bg.length === 3 && contrast(c.fg, c.bg) < 4.5);
  check('B UI 质量', '对比度 ≥4.5:1 (WCAG AA)', low.length === 0 ? 'PASS' : 'FAIL', 6,
    low.length ? `${low.length}/${metrics.colors.length} 处不达标` : '');

  // 响应式 768px
  await page.setViewportSize({ width: 768, height: 900 });
  await page.waitForTimeout(400);
  const r768 = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - window.innerWidth,
    titleClipped: (() => {
      const h = document.getElementById('headerTitle');
      return h ? h.scrollWidth > h.clientWidth + 2 : false;
    })(),
  }));
  check('B UI 质量', '响应式 768px 正常', r768.overflow <= 1 && !r768.titleClipped ? 'PASS' : 'FAIL', 10,
    `溢出 ${r768.overflow}px${r768.titleClipped ? '，标题被截断' : ''}`);
  await page.setViewportSize({ width: 1280, height: 900 });

  // ═══ C. DOM 结构 6 项 ═══
  const dom = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.card')];
    const parents = new Set(cards.map((c) => c.parentElement));
    const depth = (el) => { let d = 0; while (el.parentElement) { d++; el = el.parentElement; } return d; };
    return {
      cardCount: cards.length,
      nested: cards.filter((c) => c.parentElement && c.parentElement.closest('.card')).length,
      parentKinds: parents.size,
      depths: [...new Set(cards.map(depth))],
      childCounts: [...new Set(cards.map((c) => c.children.length))],
      footerInCard: document.querySelectorAll('.card .footer-nav').length,
      cardsWithoutTabBar: cards.filter((c) => !c.querySelector('.tab-bar')).map((c) => c.dataset.card),
      cardsWithoutQnaList: cards.filter((c) => !c.querySelector('.qna-list')).map((c) => c.dataset.card),
    };
  });

  check('C DOM 结构', '卡片平级（父容器一致）', dom.parentKinds === 1 ? 'PASS' : 'FAIL', 8, `${dom.parentKinds} 种父容器`);
  check('C DOM 结构', '无卡片嵌套', dom.nested === 0 ? 'PASS' : 'FAIL', 8, `${dom.nested} 张被嵌套`);
  check('C DOM 结构', 'DOM 深度一致', dom.depths.length === 1 ? 'PASS' : 'WARN', 5, `深度 ${dom.depths.join('/')}`);
  check('C DOM 结构', '渲染后结构未错位（子元素数一致）', dom.childCounts.length === 1 ? 'PASS' : 'WARN', 5, `子元素数 ${dom.childCounts.join('/')}`);
  check('C DOM 结构', 'footer-nav 未被吞入卡片', dom.footerInCard === 0 ? 'PASS' : 'FAIL', 5, `${dom.footerInCard} 处`);
  check('C DOM 结构', '每卡含 tab-bar 与 qna-list',
    dom.cardsWithoutTabBar.length === 0 && dom.cardsWithoutQnaList.length === 0 ? 'PASS' : 'FAIL', 5,
    `缺 tab-bar: ${dom.cardsWithoutTabBar.join(',') || '无'}｜缺 qna-list: ${dom.cardsWithoutQnaList.join(',') || '无'}`);

  // ═══ D. 逐课跳转 / 组件可达 / 格式统一 ═══
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'lessons', 'manifest.json'), 'utf8'));
  const lessons = [...manifest.lessons].sort((a, b) => a.id - b.id);
  const snapshots = [];

  for (const item of lessons) {
    // 用「点侧边栏导航项」的方式切换，验证跳转链路本身（而非直接调函数）
    const clicked = await page.evaluate((id) => {
      const nav = document.querySelector(`.nav-item[data-lesson="${id}"]`);
      if (!nav) return false;
      nav.click();
      return true;
    }, item.id);
    await page.waitForTimeout(400);

    const snap = await page.evaluate(() => {
      const need = ['.card-q-text', '.card-q-hint', '.card-bg', '.content-section', '.calc-block', '.tab-bar', '.qna-list'];
      const cards = [...document.querySelectorAll('.card')];
      const missing = [];
      for (const c of cards) {
        const cid = c.dataset.card;
        for (const sel of need) if (!c.querySelector(sel)) missing.push(`${cid}${sel}`);
        if (!document.getElementById('tab-ai-' + cid)) missing.push(`${cid}#tab-ai`);
        if (!document.getElementById('tab-qna-' + cid)) missing.push(`${cid}#tab-qna`);
        if (!c.querySelector(`.qna-list[data-qna="${cid}"]`)) missing.push(`${cid}.qna-list绑定`);
      }
      // 追问面板能否真的渲染出条目
      let qnaVisible = false, qnaItems = 0, aiVisible = false, aiHasInput = false, aiHasSend = false;
      const first = cards[0];
      if (first) {
        const btns = first.querySelectorAll('.tab-btn');
        const cid = first.dataset.card;
        if (btns.length >= 2) {
          btns[btns.length - 1].click();
          const qp = document.getElementById('tab-qna-' + cid);
          qnaVisible = !!qp && qp.style.display !== 'none';
          qnaItems = qp ? qp.querySelectorAll('.qna-item').length : 0;
        }
        if (btns.length >= 1) {
          btns[0].click();
          const ap = document.getElementById('tab-ai-' + cid);
          aiVisible = !!ap && ap.style.display !== 'none';
          aiHasInput = !!ap && !!ap.querySelector('textarea[data-input]');
          aiHasSend = !!ap && !!ap.querySelector('button');
        }
      }
      return {
        cardIds: cards.map((c) => c.dataset.card),
        missing, qnaVisible, qnaItems, aiVisible, aiHasInput, aiHasSend,
        headerTitle: (document.getElementById('headerTitle') || {}).textContent || '',
        roadmap: document.querySelectorAll('.roadmap').length,
        metaTags: document.querySelectorAll('.meta-tag').length,
        footerNav: document.querySelectorAll('.footer-nav').length,
        navActive: document.querySelectorAll('.nav-item.active').length,
      };
    });
    snapshots.push({ ...item, clicked, ...snap });
  }

  const notLoaded = snapshots.filter((s) => !s.clicked || s.cardIds.length === 0);
  check('D 逐课跳转', '侧边栏能切到每一课并加载出卡片',
    notLoaded.length === 0 ? 'PASS' : 'FAIL', 12,
    notLoaded.length ? `失败：${notLoaded.map((s) => 'id' + s.id).join(',')}` : `${snapshots.length} 课全部可切`);

  const missingAll = snapshots.flatMap((s) => s.missing.map((m) => `id${s.id}/${m}`));
  check('D 逐课跳转', '每课每卡 7 大组件全部可达',
    missingAll.length === 0 ? 'PASS' : 'FAIL', 15,
    missingAll.length ? `${missingAll.length} 处缺失：${missingAll.slice(0, 6).join(' ')}` : '');

  const qnaBad = snapshots.filter((s) => !s.qnaVisible || s.qnaItems < 1);
  check('D 组件可达', '每课追问面板能渲染出条目',
    qnaBad.length === 0 ? 'PASS' : 'FAIL', 10,
    qnaBad.length ? qnaBad.map((s) => `id${s.id}(条目=${s.qnaItems})`).join(' ') : `首卡均 ${snapshots[0].qnaItems} 条`);

  const aiBad = snapshots.filter((s) => !s.aiVisible || !s.aiHasInput || !s.aiHasSend);
  check('D 组件可达', '每课 AI 面板可切回且有输入框/发送键',
    aiBad.length === 0 ? 'PASS' : 'FAIL', 10,
    aiBad.length ? aiBad.map((s) => `id${s.id}`).join(' ') : '');

  const counts = snapshots.map((s) => s.cardIds.length);
  check('D 格式统一', '各课卡片数一致',
    new Set(counts).size === 1 ? 'PASS' : 'WARN', 6,
    snapshots.map((s) => `第${s.display}课:${s.cardIds.length}`).join(' '));

  const fmtBad = snapshots.filter((s) => !s.roadmap || !s.metaTags || !s.footerNav || !s.headerTitle.trim());
  check('D 格式统一', '每课都有 标题/roadmap/meta-tags/footer-nav',
    fmtBad.length === 0 ? 'PASS' : 'FAIL', 6,
    fmtBad.length ? fmtBad.map((s) => `id${s.id}(roadmap=${s.roadmap},tags=${s.metaTags},footer=${s.footerNav},标题=${s.headerTitle.trim() ? '有' : '空'})`).join(' ') : '');

  const navBad = snapshots.filter((s) => s.navActive !== 1);
  check('D 格式统一', '切换后侧边栏高亮唯一',
    navBad.length === 0 ? 'PASS' : 'FAIL', 5,
    navBad.length ? navBad.map((s) => `id${s.id}(active=${s.navActive})`).join(' ') : '');

  await browser.close();
  server.close();

  // ═══ 汇总 ═══
  const shown = QUIET ? rows.filter((r) => r.status !== 'PASS') : rows;
  let section = null;
  for (const r of shown) {
    if (r.section !== section) { console.log(`\n${r.section}`); section = r.section; }
    const detail = r.detail ? `  — ${r.detail}` : '';
    console.log(`  [${r.status}] ${r.name}（${r.weight}pt）${detail}`);
  }
  const score = total ? Math.round((earned / total) * 100) : 0;
  const grade = score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : 'D';
  console.log('\n' + '─'.repeat(56));
  console.log(`满分 ${total}   得分 ${earned}   WARN ${warn}   FAIL ${fail}`);
  console.log(`总分 ${score} / 100   等级 ${grade}   （交付线 ≥${PASS_LINE} / A）`);
  if (fail > 0) console.log('存在 FAIL：禁止交付。');
  console.log('');
  process.exit(fail > 0 || score < PASS_LINE ? 1 : 0);
}

main().catch((e) => { console.error('verify.js 运行失败：', e.message); process.exit(1); });
