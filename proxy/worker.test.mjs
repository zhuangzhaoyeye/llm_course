// 端到端：用内存版 Durable Object 和假上游，把 worker.js 的整条链路在 Node 里跑一遍。
import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { Limiter } from './worker.js';

const SECRET = 'sk-TEST-SECRET-DO-NOT-LEAK-1234567890';
const ORIGIN = 'https://zhuangzhaoyeye.github.io';

function makeEnv(extra = {}) {
  const store = new Map();
  const state = {
    storage: { get: async (k) => store.get(k), put: async (k, v) => void store.set(k, v) },
    blockConcurrencyWhile: async (fn) => fn(),
  };
  const lim = new Limiter(state);
  return {
    DEEPSEEK_API_KEY: SECRET, ID_SALT: 'salt',
    LIMITER: { idFromName: () => 'x', get: () => ({ fetch: (url, init) => lim.fetch(new Request(url, init)) }) },
    ...extra,
  };
}

let upstreamCalls = [];
function stubUpstream(status = 200, body = { content: [{ type: 'text', text: 'ok' }] }) {
  upstreamCalls = [];
  globalThis.fetch = async (url, init) => {
    upstreamCalls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
}

function req({ origin = ORIGIN, method = 'POST', body, ip = '9.9.9.9' } = {}) {
  const text = body === undefined ? JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }) : body;
  return new Request('https://proxy.example/', {
    method,
    headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}), 'cf-connecting-ip': ip },
    body: method === 'POST' ? text : undefined,
  });
}

test('正常请求：转发到 DeepSeek，key 只出现在发往上游的请求头里，不出现在响应里', async () => {
  stubUpstream();
  const res = await worker.fetch(req(), makeEnv());
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.equal(text.includes(SECRET), false, '响应体不得含 key');
  for (const [k, v] of res.headers) assert.equal(String(v).includes(SECRET), false, `响应头 ${k} 不得含 key`);
  assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal(upstreamCalls.length, 1);
  assert.equal(upstreamCalls[0].url, 'https://api.deepseek.com/anthropic/v1/messages');
  assert.equal(upstreamCalls[0].init.headers['x-api-key'], SECRET);
});

test('上游收到的请求体：模型写死、思考关闭、搜索由服务端注入、user_id 是哈希而非 IP', async () => {
  stubUpstream();
  const body = JSON.stringify({ model: 'deepseek-v4-pro', tools: [{ type: 'bash_20250124', name: 'bash' }], max_tokens: 99999, messages: [{ role: 'user', content: 'hi' }] });
  await worker.fetch(req({ body, ip: '1.2.3.4' }), makeEnv());
  const sent = JSON.parse(upstreamCalls[0].init.body);
  assert.equal(sent.model, 'deepseek-flash');
  assert.equal(sent.max_tokens, 1024);
  assert.deepEqual(sent.thinking, { type: 'disabled' });
  assert.deepEqual(sent.tools, [{ type: 'web_search_20250305', name: 'web_search', max_uses: 2 }]);
  assert.match(sent.metadata.user_id, /^[0-9a-f]{16}$/);
  assert.equal(JSON.stringify(sent).includes('1.2.3.4'), false);
});

test('环境变量 WEB_SEARCH=false 可一键关掉联网搜索', async () => {
  stubUpstream();
  await worker.fetch(req(), makeEnv({ WEB_SEARCH: 'false' }));
  const sent = JSON.parse(upstreamCalls[0].init.body);
  assert.equal('tools' in sent, false);
});

test('来源不在白名单：403，且不会调用上游', async () => {
  stubUpstream();
  const res = await worker.fetch(req({ origin: 'https://evil.example' }), makeEnv());
  assert.equal(res.status, 403);
  assert.equal(upstreamCalls.length, 0);
  const none = await worker.fetch(req({ origin: '' }), makeEnv());
  assert.equal(none.status, 403);
});

test('预检 OPTIONS：白名单来源 204，其他 403', async () => {
  const ok = await worker.fetch(req({ method: 'OPTIONS' }), makeEnv());
  assert.equal(ok.status, 204);
  const bad = await worker.fetch(req({ method: 'OPTIONS', origin: 'https://evil.example' }), makeEnv());
  assert.equal(bad.status, 403);
});

test('GET 被拒绝 405', async () => {
  const res = await worker.fetch(req({ method: 'GET' }), makeEnv());
  assert.equal(res.status, 405);
});

test('非法 JSON / 非法结构：400，不调用上游', async () => {
  stubUpstream();
  assert.equal((await worker.fetch(req({ body: '{not json' }), makeEnv())).status, 400);
  assert.equal((await worker.fetch(req({ body: JSON.stringify({ messages: [] }) }), makeEnv())).status, 400);
  assert.equal(upstreamCalls.length, 0);
});

test('超大请求体：413', async () => {
  stubUpstream();
  const big = JSON.stringify({ messages: [{ role: 'user', content: 'x'.repeat(40 * 1024) }] });
  assert.equal((await worker.fetch(req({ body: big }), makeEnv())).status, 413);
  assert.equal(upstreamCalls.length, 0);
});

test('同一 IP 每分钟第 6 次（默认上限 5）：429 + retry-after，且不调用上游', async () => {
  stubUpstream();
  const env = makeEnv();
  for (let i = 0; i < 5; i++) assert.equal((await worker.fetch(req(), env)).status, 200);
  const res = await worker.fetch(req(), env);
  assert.equal(res.status, 429);
  assert.ok(Number(res.headers.get('retry-after')) > 0);
  assert.equal(upstreamCalls.length, 5);
  const j = await res.json();
  assert.equal(j.error.reason, 'per_minute');
});

test('不同 IP 互不影响', async () => {
  stubUpstream();
  const env = makeEnv();
  for (let i = 0; i < 5; i++) await worker.fetch(req({ ip: '1.1.1.1' }), env);
  assert.equal((await worker.fetch(req({ ip: '1.1.1.1' }), env)).status, 429);
  assert.equal((await worker.fetch(req({ ip: '2.2.2.2' }), env)).status, 200);
});

test('全站日上限到顶：所有人都 429，原因 global_day，提示里写明额度与重置时间', async () => {
  stubUpstream();
  const env = makeEnv({ GLOBAL_PER_DAY: '3' });
  for (let i = 0; i < 3; i++) assert.equal((await worker.fetch(req({ ip: `3.3.3.${i}` }), env)).status, 200);
  const res = await worker.fetch(req({ ip: '4.4.4.4' }), env);
  assert.equal(res.status, 429);
  const j = await res.json();
  assert.equal(j.error.reason, 'global_day');
  assert.match(j.error.message, /3 次/);
  assert.match(j.error.message, /早上 8 点/);
  assert.equal(upstreamCalls.length, 3);
});

test('默认配置下：整站第 101 次请求被拒（全站每天一共 100 次），之前 100 次全部放行', async () => {
  stubUpstream();
  const env = makeEnv({ PER_IP_PER_DAY: '1000', PER_IP_PER_MINUTE: '1000' });
  let ok = 0;
  for (let i = 0; i < 100; i++) if ((await worker.fetch(req({ ip: `7.7.${i >> 8}.${i & 255}` }), env)).status === 200) ok++;
  assert.equal(ok, 100);
  const res = await worker.fetch(req({ ip: '8.8.8.8' }), env);
  assert.equal(res.status, 429);
  assert.equal((await res.json()).error.reason, 'global_day');
  assert.equal(upstreamCalls.length, 100);
});

test('一个人不能独占全站额度：单 IP 每天 20 次后被拒，其他人还能用', async () => {
  stubUpstream();
  const env = makeEnv({ PER_IP_PER_MINUTE: '1000' });
  let ok = 0;
  for (let i = 0; i < 25; i++) if ((await worker.fetch(req({ ip: '9.9.9.9' }), env)).status === 200) ok++;
  assert.equal(ok, 20);
  assert.equal((await worker.fetch(req({ ip: '9.9.9.10' }), env)).status, 200);
});

test('被限流拒绝的请求不消耗全站额度', async () => {
  stubUpstream();
  const env = makeEnv({ GLOBAL_PER_DAY: '12', PER_IP_PER_MINUTE: '2' });
  for (let i = 0; i < 6; i++) await worker.fetch(req({ ip: '5.5.5.5' }), env); // 只有前 2 次通过，占去全站 2 个额度
  for (let i = 0; i < 10; i++) assert.equal((await worker.fetch(req({ ip: `6.6.6.${i}` }), env)).status, 200); // 剩下 10 个额度恰好够
});

test('上游返回错误时原样透传状态码，且错误信息里没有 key', async () => {
  stubUpstream(401, { error: { message: 'invalid api key' } });
  const res = await worker.fetch(req(), makeEnv());
  assert.equal(res.status, 401);
  assert.equal((await res.text()).includes(SECRET), false);
});

test('每日清理 alarm：删掉非今天的 IP 记录，保留今天的和 global，并重新设闹钟', async () => {
  const store = new Map();
  let alarmAt = null;
  const today = new Date().toISOString().slice(0, 10);
  store.set('ip:old1', { day: '2020-01-01', dayCount: 99, minuteStamps: [] });
  store.set('ip:old2', { day: '2020-01-02', dayCount: 1, minuteStamps: [] });
  store.set('ip:new1', { day: today, dayCount: 5, minuteStamps: [] });
  store.set('global', { globalDay: today, globalCount: 7 });
  const state = {
    storage: {
      get: async (k) => store.get(k), put: async (k, v) => void store.set(k, v),
      list: async ({ prefix }) => new Map([...store].filter(([k]) => k.startsWith(prefix))),
      delete: async (keys) => { for (const k of [].concat(keys)) store.delete(k); },
      getAlarm: async () => alarmAt, setAlarm: async (t) => { alarmAt = t; },
    },
    blockConcurrencyWhile: async (fn) => fn(),
  };
  const lim = new Limiter(state);
  await lim.alarm();
  assert.equal(store.has('ip:old1'), false);
  assert.equal(store.has('ip:old2'), false);
  assert.equal(store.has('ip:new1'), true);
  assert.equal(store.has('global'), true);
  assert.ok(alarmAt > Date.now(), '应重新设置下一次闹钟');
});

test('首次请求会设置闹钟，已设置则不重复设置', async () => {
  const store = new Map(); let alarmAt = null; let setCount = 0;
  const state = {
    storage: {
      get: async (k) => store.get(k), put: async (k, v) => void store.set(k, v),
      getAlarm: async () => alarmAt, setAlarm: async (t) => { alarmAt = t; setCount++; },
    },
    blockConcurrencyWhile: async (fn) => fn(),
  };
  const lim = new Limiter(state);
  const call = () => lim.fetch(new Request('https://limiter/check', { method: 'POST', body: JSON.stringify({ id: 'a', limits: { PER_IP_PER_MINUTE: 10, PER_IP_PER_DAY: 100, GLOBAL_PER_DAY: 1000 } }) }));
  await call(); await call();
  assert.equal(setCount, 1);
});

test('没配置 key：500，且提示不含任何密钥', async () => {
  const res = await worker.fetch(req(), makeEnv({ DEEPSEEK_API_KEY: '' }));
  assert.equal(res.status, 500);
});
