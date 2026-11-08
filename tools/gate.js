#!/usr/bin/env node
/**
 * gate.js —— 开工闸门（唯一入口）
 *
 * 解决的问题：provenance_check / review_check 虽是非零退出，但我仍可以在它们 FAIL 时继续干新活。
 * 本脚本把两道锁合成一个**判决**，并显式输出"本轮允许做什么"。
 *
 * 用法：
 *   node tools/gate.js            # 判决：OPEN / BLOCKED
 *   node tools/gate.js --json     # 供程序读取
 *
 * 判据（IRON-RULE 第 4 条）：任一课 FAIL 未清 → BLOCKED
 *   BLOCKED 时只允许做「清账」：补核验、修台账、补联网证据；
 *   **禁止**新增课程、改正文、加追问、改 CSS/结构。
 */
const { execSync } = require('child_process');
const path = require('path');
const root = path.resolve(__dirname, '..');

function run(cmd) {
  try {
    const out = execSync(cmd, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status == null ? 1 : e.status, out: (e.stdout || '') + (e.stderr || '') };
  }
}

const p = run('node tools/provenance_check.js');
const r = run('node tools/review_check.js --all');
const c = run('node tools/coverage_check.js');
const s = run('python3 scripts/build_site.py --check');

const tail = (s, n) =>
  s.split('\n').filter((l) => /\[FAIL\]|FAIL \d+|存在 FAIL|禁止/.test(l)).slice(0, n).join('\n');

const blocked = p.code !== 0 || r.code !== 0 || c.code !== 0 || s.code !== 0;

const report = {
  provenance: { code: p.code, fails: tail(p.out, 8) },
  review: { code: r.code, fails: tail(r.out, 8) },
  coverage: { code: c.code, fails: tail(c.out, 8) },
  site: { code: s.code, fails: tail(s.out, 8) },
  verdict: blocked ? 'BLOCKED' : 'OPEN',
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log('========================================');
  console.log('  开工闸门 GATE');
  console.log('========================================');
  console.log(`[锁1] provenance_check (台账时效性)  → exit ${p.code}`);
  if (p.code !== 0) console.log(tail(p.out, 8) || '  (见 provenance_check 完整输出)');
  console.log(`[锁2] review_check --all (逐条/路由/盲审) → exit ${r.code}`);
  if (r.code !== 0) console.log(tail(r.out, 8) || '  (见 review_check 完整输出)');
  console.log(`[锁3] coverage_check (覆盖地图归档/锚点/无残留) → exit ${c.code}`);
  if (c.code !== 0) console.log(tail(c.out, 8) || '  (见 coverage_check 完整输出)');
  const siteFail = s.out.split('\n').filter((l) => /FAIL/.test(l)).slice(0, 4).join('\n');
  console.log(`[锁4] build_site.py --check (语义向量/站点一致) → exit ${s.code}`);
  if (s.code !== 0) console.log(siteFail || '  (见 build_site.py --check 完整输出)');
  console.log('----------------------------------------');
  if (blocked) {
    console.log('GATE = BLOCKED');
    console.log('');
    console.log('本轮【只允许】**清账**：');
    console.log('  · 补逐条核验 / 补联网证据 / 修台账 / 修检查误报');
    console.log('  · 修已判定的 ERROR 与 WARN');
    console.log('');
    console.log('本轮【禁止】：');
    console.log('  · 新增课程、改正文、加追问、改结构或 CSS');
    console.log('  · 声称任何一课「已完成 / 已优化」');
    console.log('  · 插入任何"工具建设"来替代清账');
  } else {
    console.log('GATE = OPEN —— 可以开工');
  }
}

process.exit(blocked ? 1 : 0);
