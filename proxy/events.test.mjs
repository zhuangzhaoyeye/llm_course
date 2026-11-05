// 匿名统计：事件清洗 + /e 路由 + 真实 SQLite 建表与分析 SQL。
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import worker, { Limiter } from './worker.js';
import { sanitizeBatch, SCHEMA_SQL } from './events.js';

const ORIGIN = 'https://zhuangzhaoyeye.github.io';
const CID = 'abcd1234efgh5678';
const SID = 'sess1234sess5678';

const batch = (ev, extra = {}) => ({ v: 1, cid: CID, sid: SID, vn: 3, fd: '2026-11-01', dev: 'mobile', w: 390, ref: 'www.google.com', ev, ...extra });

// 用 node:sqlite 做一个 D1 形状的适配器（prepare/bind/run），让测试跑真实 SQL。
function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA_SQL);
  return {
    raw: db,
    prepare(sql) {
      return { bind: (...args) => ({ run: async () => { db.prepare(sql).run(...args); return { success: true }; } }) };
    },
  };
}

function makeEnv(extra = {}) {
  const store = new Map();
  const state = { storage: { get: async (k) => store.get(k), put: async (k, v) => void store.set(k, v) }, blockConcurrencyWhile: async (fn) => fn() };
  const lim = new Limiter(state);
  return {
    ID_SALT: 'salt',
    LIMITER: { idFromName: () => 'x', get: () => ({ fetch: (url, init) => lim.fetch(new Request(url, init)) }) },
    DB: makeDb(),
    ...extra,
  };
}

function req(body, { origin = ORIGIN, ip = '9.9.9.9', method = 'POST', contentType = 'text/plain;charset=UTF-8' } = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new Request('https://proxy.example/e', {
    method,
    headers: { 'content-type': contentType, ...(origin ? { origin } : {}), 'cf-connecting-ip': ip },
    body: method === 'POST' ? text : undefined,
  });
}

const OK_EVENTS = [
  { e: 'open', t: 0 },
  { e: 'lesson', t: 5, l: '1' },
  { e: 'card', t: 900, l: '1', c: '3', s: 'open' },
  { e: 'dwell', t: 20000, l: '1', c: '3', ms: 19100 },
];

test('清洗：合法批次通过，事件按白名单保留', () => {
  const r = sanitizeBatch(batch(OK_EVENTS));
  assert.equal(r.ok, true);
  assert.equal(r.row.n, 4);
  assert.deepEqual(JSON.parse(r.row.ev)[2], { e: 'card', t: 900, l: '1', c: '3', s: 'open' });
  assert.equal(r.row.ref, 'www.google.com');
});

test('清洗：未知字段被丢弃，不会写进库（含试图夹带的提问文本）', () => {
  const r = sanitizeBatch(batch([{ e: 'ai_ask', t: 10, c: '2', text: '我的隐私问题', q: 'x' }]));
  assert.equal(r.ok, true);
  const ev = JSON.parse(r.row.ev)[0];
  assert.deepEqual(ev, { e: 'ai_ask', t: 10, c: '2' });
  assert.equal(r.row.ev.includes('隐私'), false);
});

test('清洗：未知事件类型、缺必填字段、字段值非法的事件被丢弃，其余保留', () => {
  const r = sanitizeBatch(batch([
    { e: 'hack', t: 1 },
    { e: 'card', t: 2, l: '1', c: '3' },                    // 缺 s
    { e: 'card', t: 3, l: '1', c: '3; DROP', s: 'open' },   // c 非法
    { e: 'card', t: 4, l: '1', c: '3', s: 'open' },         // 合法
    { e: 'open', t: -5 },                                    // 负偏移
    { e: 'open', t: 999999999999 },                          // 超过 1 天
  ]));
  assert.equal(r.ok, true);
  assert.equal(r.row.n, 1);
});

test('清洗：全部事件非法 → 拒绝；空数组 / 超过 50 条 → 拒绝', () => {
  assert.equal(sanitizeBatch(batch([{ e: 'hack', t: 1 }])).ok, false);
  assert.equal(sanitizeBatch(batch([])).ok, false);
  assert.equal(sanitizeBatch(batch(Array.from({ length: 51 }, () => ({ e: 'open', t: 0 })))).ok, false);
  assert.equal(sanitizeBatch(batch(Array.from({ length: 50 }, () => ({ e: 'open', t: 0 })))).ok, true);
});

test('清洗：cid / sid / 版本不合法 → 拒绝', () => {
  assert.equal(sanitizeBatch(batch(OK_EVENTS, { cid: 'short' })).ok, false);
  assert.equal(sanitizeBatch(batch(OK_EVENTS, { cid: 'abc def 12345678' })).ok, false);
  assert.equal(sanitizeBatch(batch(OK_EVENTS, { sid: 123 })).ok, false);
  assert.equal(sanitizeBatch(batch(OK_EVENTS, { v: 2 })).ok, false);
  assert.equal(sanitizeBatch(null).ok, false);
});

test('清洗：停留时间超过 30 分钟按 30 分钟截断；来源只留主机名', () => {
  const r = sanitizeBatch(batch([{ e: 'dwell', t: 1, l: '2', c: '2-1', ms: 99 * 60 * 1000 }], { ref: 'https://evil.example/path?q=1' }));
  assert.equal(JSON.parse(r.row.ev)[0].ms, 30 * 60 * 1000);
  assert.equal(r.row.ref, '');
});

test('清洗：搜索事件只收「命中/未命中 + 条数」，没有查询词字段', () => {
  const r = sanitizeBatch(batch([{ e: 'search', t: 1, k: 'hit', n: 7, query: 'KV Cache' }]));
  assert.deepEqual(JSON.parse(r.row.ev)[0], { e: 'search', t: 1, k: 'hit', n: 7 });
});

test('/e 正常写入：204，带 CORS 与 allow-credentials，库里恰好 1 行', async () => {
  const env = makeEnv();
  const res = await worker.fetch(req(batch(OK_EVENTS)), env);
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal(res.headers.get('access-control-allow-credentials'), 'true');
  const rows = env.DB.raw.prepare('SELECT * FROM batches').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].cid, CID);
  assert.equal(rows[0].n, 4);
  assert.equal(JSON.parse(rows[0].ev).length, 4);
});

test('/e 来源不在白名单：403，库里没有数据', async () => {
  const env = makeEnv();
  assert.equal((await worker.fetch(req(batch(OK_EVENTS), { origin: 'https://evil.example' }), env)).status, 403);
  assert.equal((await worker.fetch(req(batch(OK_EVENTS), { origin: '' }), env)).status, 403);
  assert.equal(env.DB.raw.prepare('SELECT count(*) c FROM batches').get().c, 0);
});

test('/e 非法 JSON → 400；非法批次 → 400；超大体 → 413；都不写库', async () => {
  const env = makeEnv();
  assert.equal((await worker.fetch(req('{not json'), env)).status, 400);
  assert.equal((await worker.fetch(req(batch([{ e: 'hack', t: 1 }])), env)).status, 400);
  assert.equal((await worker.fetch(req('x'.repeat(9 * 1024)), env)).status, 413);
  assert.equal(env.DB.raw.prepare('SELECT count(*) c FROM batches').get().c, 0);
});

test('/e 未绑定 D1：静默丢弃，204 + x-stats: disabled，不报错', async () => {
  const env = makeEnv({ DB: undefined });
  const res = await worker.fetch(req(batch(OK_EVENTS)), env);
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('x-stats'), 'disabled');
});

test('/e 预检 OPTIONS：白名单 204 且带 allow-credentials；其他 403', async () => {
  const ok = await worker.fetch(new Request('https://proxy.example/e', { method: 'OPTIONS', headers: { origin: ORIGIN } }), makeEnv());
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get('access-control-allow-credentials'), 'true');
  const bad = await worker.fetch(new Request('https://proxy.example/e', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } }), makeEnv());
  assert.equal(bad.status, 403);
});

test('/e 限流：同一 IP 每分钟第 31 次 → 429，且不写库；其他 IP 不受影响', async () => {
  const env = makeEnv();
  for (let i = 0; i < 30; i++) assert.equal((await worker.fetch(req(batch(OK_EVENTS)), env)).status, 204);
  const res = await worker.fetch(req(batch(OK_EVENTS)), env);
  assert.equal(res.status, 429);
  assert.ok(Number(res.headers.get('retry-after')) > 0);
  assert.equal(env.DB.raw.prepare('SELECT count(*) c FROM batches').get().c, 30);
  assert.equal((await worker.fetch(req(batch(OK_EVENTS), { ip: '8.8.8.8' }), env)).status, 204);
});

test('/e 全站每天上限：到顶后所有人 429', async () => {
  const env = makeEnv({ EVENTS_GLOBAL_PER_DAY: '3', EVENTS_PER_IP_PER_MINUTE: '1000', EVENTS_PER_IP_PER_DAY: '1000' });
  for (let i = 0; i < 3; i++) assert.equal((await worker.fetch(req(batch(OK_EVENTS), { ip: `1.1.1.${i}` }), env)).status, 204);
  assert.equal((await worker.fetch(req(batch(OK_EVENTS), { ip: '2.2.2.2' }), env)).status, 429);
});

test('/e 与 AI 助教额度互不占用：统计打满后，AI 助教请求仍能放行（限流命名空间独立）', async () => {
  const env = makeEnv({ DEEPSEEK_API_KEY: 'sk-test', EVENTS_GLOBAL_PER_DAY: '1', EVENTS_PER_IP_PER_MINUTE: '1000' });
  // makeEnv 里所有 idFromName 都返回 'x'，会共用同一个 DO；这里换成按名字区分的实现来验证真实部署行为。
  const stores = {};
  env.LIMITER = {
    idFromName: (n) => n,
    get: (name) => {
      if (!stores[name]) {
        const store = new Map();
        stores[name] = new Limiter({ storage: { get: async (k) => store.get(k), put: async (k, v) => void store.set(k, v) }, blockConcurrencyWhile: async (fn) => fn() });
      }
      return { fetch: (url, init) => stores[name].fetch(new Request(url, init)) };
    },
  };
  assert.equal((await worker.fetch(req(batch(OK_EVENTS)), env)).status, 204);
  assert.equal((await worker.fetch(req(batch(OK_EVENTS), { ip: '5.5.5.5' }), env)).status, 429); // 统计已满
  globalThis.fetch = async () => new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  const ai = new Request('https://proxy.example/', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, 'cf-connecting-ip': '6.6.6.6' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal((await worker.fetch(ai, env)).status, 200);
});

test('分析 SQL 在真实 SQLite 上可跑：日活、回访率、卡片展开排行（json_each）', async () => {
  const env = makeEnv();
  const send = (cid, sid, vn, ev, ip) => worker.fetch(req(batch(ev, { cid, sid, vn }), { ip }), env);
  await send('visitorAAAA1111', 'sessAAAA00000001', 1, [{ e: 'open', t: 0 }, { e: 'card', t: 5, l: '1', c: '2', s: 'open' }], '1.1.1.1');
  await send('visitorAAAA1111', 'sessAAAA00000002', 2, [{ e: 'open', t: 0 }, { e: 'card', t: 5, l: '1', c: '2', s: 'open' }, { e: 'card', t: 9, l: '1', c: '3', s: 'open' }], '1.1.1.1');
  await send('visitorBBBB2222', 'sessBBBB00000001', 1, [{ e: 'open', t: 0 }, { e: 'card', t: 5, l: '1', c: '2', s: 'open' }], '2.2.2.2');

  const db = env.DB.raw;
  const visits = db.prepare(`SELECT count(DISTINCT sid) v, count(DISTINCT cid) u FROM batches`).get();
  assert.deepEqual({ v: visits.v, u: visits.u }, { v: 3, u: 2 });

  const returning = db.prepare(`SELECT count(DISTINCT cid) c FROM batches WHERE vn >= 2`).get().c;
  assert.equal(returning, 1);

  const top = db.prepare(`
    SELECT json_extract(j.value,'$.l') l, json_extract(j.value,'$.c') c, count(*) n
    FROM batches, json_each(batches.ev) j
    WHERE json_extract(j.value,'$.e')='card' AND json_extract(j.value,'$.s')='open'
    GROUP BY l, c ORDER BY n DESC, c`).all();
  assert.deepEqual(top.map((r) => [r.c, r.n]), [['2', 3], ['3', 1]]);
});
