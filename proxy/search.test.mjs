// 语义搜索接口 /s：来源校验、入参校验、独立限流、模型调用与返回格式。AI 绑定用假实现。
import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { Limiter, SEARCH_MAX_CHARS } from './worker.js';

const ORIGIN = 'https://zhuangzhaoyeye.github.io';

function makeEnv(extra = {}) {
  const stores = {};
  const calls = [];
  return {
    calls,
    ID_SALT: 'salt',
    DEEPSEEK_API_KEY: 'sk-test',
    AI: { run: async (model, input) => { calls.push({ model, input }); return { shape: [1, 1024], data: [Array.from({ length: 1024 }, (_, i) => (i % 7) / 7 - 0.123456789)] }; } },
    LIMITER: {
      idFromName: (n) => n,
      get: (name) => {
        if (!stores[name]) {
          const m = new Map();
          stores[name] = new Limiter({ storage: { get: async (k) => m.get(k), put: async (k, v) => void m.set(k, v) }, blockConcurrencyWhile: async (fn) => fn() });
        }
        return { fetch: (url, init) => stores[name].fetch(new Request(url, init)) };
      },
    },
    ...extra,
  };
}
const req = (body, { origin = ORIGIN, ip = '9.9.9.9', method = 'POST' } = {}) => new Request('https://proxy.example/s', {
  method, headers: { 'content-type': 'text/plain;charset=UTF-8', ...(origin ? { origin } : {}), 'cf-connecting-ip': ip },
  body: method === 'POST' ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
});

test('/s 正常：调用 bge-m3，返回 1024 维向量（保留 4 位小数），不缓存', async () => {
  const env = makeEnv();
  const res = await worker.fetch(req({ q: '大模型为什么会胡说' }), env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const { v } = await res.json();
  assert.equal(v.length, 1024);
  assert.equal(v[0], -0.1235);
  assert.deepEqual(env.calls, [{ model: '@cf/baai/bge-m3', input: { text: ['大模型为什么会胡说'] } }]);
});

test('/s 来源不在白名单：403，不调用模型', async () => {
  const env = makeEnv();
  assert.equal((await worker.fetch(req({ q: 'x' }, { origin: 'https://evil.example' }), env)).status, 403);
  assert.equal((await worker.fetch(req({ q: 'x' }, { origin: '' }), env)).status, 403);
  assert.equal(env.calls.length, 0);
});

test('/s 可单独配置来源（SEARCH_ORIGINS），不影响 AI 助教的白名单', async () => {
  const env = makeEnv({ SEARCH_ORIGINS: 'http://127.0.0.1:8766' });
  assert.equal((await worker.fetch(req({ q: 'x' }, { origin: 'http://127.0.0.1:8766' }), env)).status, 200);
  const tutor = new Request('https://proxy.example/', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:8766' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }) });
  assert.equal((await worker.fetch(tutor, env)).status, 403);
});

test('/s 入参校验：非法 JSON / 非字符串 / 空 / 超长 → 400，不调用模型', async () => {
  const env = makeEnv();
  for (const b of ['{oops', { q: 1 }, { q: '   ' }, { q: 'x'.repeat(SEARCH_MAX_CHARS + 1) }]) {
    assert.equal((await worker.fetch(req(b), env)).status, 400, JSON.stringify(b));
  }
  assert.equal((await worker.fetch(req('x'.repeat(2000)), env)).status, 413);
  assert.equal(env.calls.length, 0);
});

test('/s 控制字符被清掉再送模型', async () => {
  const env = makeEnv();
  await worker.fetch(req({ q: 'kv\u0000cache\n' }), env);
  assert.deepEqual(env.calls[0].input, { text: ['kv cache'] });
});

test('/s 独立限流：同一 IP 每分钟第 31 次 429；统计和 AI 助教额度不受影响', async () => {
  const env = makeEnv();
  for (let i = 0; i < 30; i++) assert.equal((await worker.fetch(req({ q: 'q' + i }), env)).status, 200);
  const r = await worker.fetch(req({ q: 'over' }), env);
  assert.equal(r.status, 429);
  assert.ok(Number(r.headers.get('retry-after')) > 0);
  globalThis.fetch = async () => new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  const tutor = new Request('https://proxy.example/', { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN, 'cf-connecting-ip': '9.9.9.9' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }) });
  assert.equal((await worker.fetch(tutor, env)).status, 200);
});

test('/s 没绑定 AI：503；模型报错：502（前端据此退回纯词法）', async () => {
  assert.equal((await worker.fetch(req({ q: 'x' }), makeEnv({ AI: undefined }))).status, 503);
  const bad = makeEnv({ AI: { run: async () => { throw new Error('InferenceUpstreamError'); } } });
  assert.equal((await worker.fetch(req({ q: 'x' }), bad)).status, 502);
  const short = makeEnv({ AI: { run: async () => ({ data: [[0.1, 0.2]] }) } });
  assert.equal((await worker.fetch(req({ q: 'x' }), short)).status, 502);
});

test('/s 预检 OPTIONS：白名单 204，其他 403', async () => {
  const env = makeEnv();
  assert.equal((await worker.fetch(new Request('https://proxy.example/s', { method: 'OPTIONS', headers: { origin: ORIGIN } }), env)).status, 204);
  assert.equal((await worker.fetch(new Request('https://proxy.example/s', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } }), env)).status, 403);
});
