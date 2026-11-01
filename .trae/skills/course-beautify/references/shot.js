/**
 * 逐卡截图（美化前后对比用）
 * 用法：node .trae/skills/course-beautify/references/shot.js <html文件> --out <输出目录>
 * 说明：自动展开全部卡片、隐藏 sticky header（否则会遮挡卡片顶部）。
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

(async () => {
  const file = process.argv[2];
  const outFlag = process.argv.indexOf('--out');
  const outDir = outFlag > 0 ? process.argv[outFlag + 1] : path.join(process.cwd(), 'tmp', 'shots');
  if (!file) {
    console.error('用法: node shot.js <html文件> --out <目录>');
    process.exit(1);
  }
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
  await page.goto('file://' + path.resolve(file));
  await page.waitForTimeout(1200);
  await page.evaluate(() => {
    document.querySelectorAll('.card').forEach((c) => { if (!c.classList.contains('active')) c.classList.add('active'); });
    const h = document.querySelector('.header'); if (h) h.style.display = 'none';
  });
  await page.waitForTimeout(600);
  const name = path.basename(file).replace(/\.html$/, '');
  const cards = await page.$$('.card');
  for (let i = 0; i < cards.length; i++) {
    const id = await cards[i].getAttribute('data-card');
    await cards[i].screenshot({ path: path.join(outDir, `${name}-card${id}.png`) });
  }
  await page.screenshot({ path: path.join(outDir, `${name}-top.png`) });
  console.log('done ->', outDir, 'cards:', cards.length);
  await browser.close();
})();
