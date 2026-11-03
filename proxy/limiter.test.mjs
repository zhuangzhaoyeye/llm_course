import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, decide, decideGlobal, sanitizeBody, originAllowed, hashId, secondsToNextUtcDay } from './limiter.js';

const T0 = Date.UTC(2026, 10, 3, 12, 0, 0); // 2026-11-03 12:00:00 UTC

function run(state, times) {
  let s = state; const out = [];
  for (const t of times) { const r = decide(s, t); out.push(r); s = r.state; }
  return out;
}

test('每分钟：前 N 次放行，第 N+1 次拒绝并给出 retryAfter', () => {
  const N = DEFAULTS.PER_IP_PER_MINUTE;
  const times = Array.from({ length: N + 1 }, (_, i) => T0 + i * 1000);
  const r = run({}, times);
  assert.equal(r.slice(0, N).every((x) => x.ok), true);
  assert.equal(r[N].ok, false);
  assert.equal(r[N].reason, 'per_minute');
  assert.equal(r[N].retryAfter, 60 - N); // 第 1 次在 T0，窗口 60s，第 N+1 次在 T0+N 秒 -> 还要等 60-N 秒
});

test('每分钟窗口滑动：60 秒后恢复', () => {
  const N = DEFAULTS.PER_IP_PER_MINUTE;
  const times = Array.from({ length: N }, (_, i) => T0 + i * 1000);
  const r = run({}, [...times, T0 + 61_000]);
  assert.equal(r[N].ok, true);
});

test('每天：第 N 次放行，第 N+1 次拒绝', () => {
  const N = DEFAULTS.PER_IP_PER_DAY;
  // 每次间隔 61 秒，避开分钟限制，只考验日限额
  const times = Array.from({ length: N + 1 }, (_, i) => T0 + i * 61_000);
  const r = run({}, times);
  assert.equal(r[N - 1].ok, true, `第 ${N} 次应放行`);
  assert.equal(r[N].ok, false, `第 ${N + 1} 次应拒绝`);
  assert.equal(r[N].reason, 'per_day');
});

test('跨天重置：UTC 次日 0 点后计数清零', () => {
  const N = DEFAULTS.PER_IP_PER_DAY;
  const times = Array.from({ length: N }, (_, i) => T0 + i * 61_000);
  const r = run({}, times);
  const last = r[N - 1].state;
  const nextDay = Date.UTC(2026, 10, 4, 0, 0, 1);
  const again = decide(last, nextDay);
  assert.equal(again.ok, true);
  assert.equal(again.state.dayCount, 1);
});

test('被拒绝的请求不消耗额度', () => {
  const N = DEFAULTS.PER_IP_PER_MINUTE;
  const times = Array.from({ length: N }, (_, i) => T0 + i * 1000);
  const r = run({}, times);
  const denied = decide(r[N - 1].state, T0 + N * 1000);
  assert.equal(denied.ok, false);
  assert.equal(denied.state.dayCount, N);
});

test('全站日上限', () => {
  const lim = { ...DEFAULTS, GLOBAL_PER_DAY: 3 };
  let s = {};
  const res = [];
  for (let i = 0; i < 4; i++) { const g = decideGlobal(s, T0 + i, lim); res.push(g.ok); if (g.ok) s = g.state; }
  assert.deepEqual(res, [true, true, true, false]);
});

test('secondsToNextUtcDay', () => {
  assert.equal(secondsToNextUtcDay(Date.UTC(2026, 10, 3, 23, 59, 0)), 60);
});

test('sanitizeBody：写死模型与 max_tokens，丢弃客户端的 model / 多余字段，tools 由服务端注入', () => {
  const r = sanitizeBody({
    model: 'deepseek-v4-pro', max_tokens: 99999,
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
    system: 'sys', stream: true, thinking: { type: 'enabled' },
    messages: [{ role: 'user', content: 'hi', extra: 1 }],
  });
  assert.equal(r.ok, true);
  assert.equal(r.body.model, DEFAULTS.MODEL);
  assert.equal(r.body.max_tokens, DEFAULTS.MAX_TOKENS);
  assert.equal('stream' in r.body, false);
  assert.deepEqual(r.body.thinking, { type: 'disabled' });
  assert.deepEqual(r.body.messages, [{ role: 'user', content: 'hi' }]);
});

test('联网搜索开启：服务端注入 web_search，max_uses 取配置值，客户端传的 tools 被丢弃', () => {
  const r = sanitizeBody({
    tools: [{ type: 'bash_20250124', name: 'bash' }, { type: 'web_search_20250305', name: 'web_search', max_uses: 99 }],
    messages: [{ role: 'user', content: 'hi' }],
  }, { ...DEFAULTS, WEB_SEARCH: true, WEB_SEARCH_MAX_USES: 2 });
  assert.deepEqual(r.body.tools, [{ type: 'web_search_20250305', name: 'web_search', max_uses: 2 }]);
});

test('联网搜索关闭：请求体里没有 tools，即使客户端传了也不带上', () => {
  const r = sanitizeBody({
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
    messages: [{ role: 'user', content: 'hi' }],
  }, { ...DEFAULTS, WEB_SEARCH: false });
  assert.equal('tools' in r.body, false);
});

test('默认值符合约定：全站每天 100、单 IP 每天 20、每分钟 5、联网搜索开、最多搜 2 次', () => {
  assert.equal(DEFAULTS.GLOBAL_PER_DAY, 100);
  assert.equal(DEFAULTS.PER_IP_PER_DAY, 20);
  assert.equal(DEFAULTS.PER_IP_PER_MINUTE, 5);
  assert.equal(DEFAULTS.WEB_SEARCH, true);
  assert.equal(DEFAULTS.WEB_SEARCH_MAX_USES, 2);
});

test('sanitizeBody：拒绝非法输入', () => {
  assert.equal(sanitizeBody(null).ok, false);
  assert.equal(sanitizeBody({ messages: [] }).ok, false);
  assert.equal(sanitizeBody({ messages: [{ role: 'system', content: 'x' }] }).ok, false);
  assert.equal(sanitizeBody({ messages: [{ role: 'user', content: { a: 1 } }] }).ok, false);
  const many = Array.from({ length: DEFAULTS.MAX_MESSAGES + 1 }, () => ({ role: 'user', content: 'x' }));
  assert.equal(sanitizeBody({ messages: many }).ok, false);
});

test('originAllowed：精确匹配，不接受子串或空 Origin', () => {
  const allowed = ['https://zhuangzhaoyeye.github.io'];
  assert.equal(originAllowed('https://zhuangzhaoyeye.github.io', allowed), true);
  assert.equal(originAllowed('https://zhuangzhaoyeye.github.io.evil.com', allowed), false);
  assert.equal(originAllowed('http://zhuangzhaoyeye.github.io', allowed), false);
  assert.equal(originAllowed('', allowed), false);
  assert.equal(originAllowed(null, allowed), false);
});

test('hashId：同输入同输出，不含原始 IP，只有十六进制', async () => {
  const a = await hashId('1.2.3.4', 's');
  const b = await hashId('1.2.3.4', 's');
  const c = await hashId('1.2.3.5', 's');
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.equal(a.includes('1.2.3.4'), false);
});
