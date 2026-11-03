// Cloudflare Worker：AI 助教代理。DeepSeek key 只存在 Worker 的 secret 里，前端拿不到。
// 部署步骤见 proxy/README.md。限流逻辑在 limiter.js（纯函数，有单测）。
import { DEFAULTS, decide, decideGlobal, sanitizeBody, originAllowed, hashId } from './limiter.js';

const UPSTREAM = 'https://api.deepseek.com/anthropic/v1/messages';

function cors(origin) {
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
    vary: 'origin',
  };
}

function json(status, obj, origin, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...(origin ? cors(origin) : {}), ...extra },
  });
}

function allowedOrigins(env) {
  return (env.ALLOWED_ORIGINS || 'https://zhuangzhaoyeye.github.io').split(',').map((s) => s.trim()).filter(Boolean);
}

function limitsFrom(env) {
  const n = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  return {
    ...DEFAULTS,
    PER_IP_PER_MINUTE: n(env.PER_IP_PER_MINUTE, DEFAULTS.PER_IP_PER_MINUTE),
    PER_IP_PER_DAY: n(env.PER_IP_PER_DAY, DEFAULTS.PER_IP_PER_DAY),
    GLOBAL_PER_DAY: n(env.GLOBAL_PER_DAY, DEFAULTS.GLOBAL_PER_DAY),
    MAX_TOKENS: n(env.MAX_TOKENS, DEFAULTS.MAX_TOKENS),
    WEB_SEARCH: String(env.WEB_SEARCH ?? 'true').toLowerCase() !== 'false',
    WEB_SEARCH_MAX_USES: n(env.WEB_SEARCH_MAX_USES, DEFAULTS.WEB_SEARCH_MAX_USES),
  };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('origin') || '';
    const allowed = allowedOrigins(env);

    if (request.method === 'OPTIONS') {
      return originAllowed(origin, allowed)
        ? new Response(null, { status: 204, headers: cors(origin) })
        : new Response(null, { status: 403 });
    }
    if (request.method !== 'POST') return json(405, { error: { message: 'method not allowed' } }, null);
    if (!originAllowed(origin, allowed)) return json(403, { error: { message: 'origin not allowed' } }, null);
    if (!env.DEEPSEEK_API_KEY) return json(500, { error: { message: 'server not configured' } }, origin);

    const len = Number(request.headers.get('content-length') || 0);
    const limits = limitsFrom(env);
    if (len > limits.MAX_BODY_BYTES) return json(413, { error: { message: 'request too large' } }, origin);

    let raw;
    try {
      const text = await request.text();
      if (text.length > limits.MAX_BODY_BYTES) return json(413, { error: { message: 'request too large' } }, origin);
      raw = JSON.parse(text);
    } catch {
      return json(400, { error: { message: 'invalid json' } }, origin);
    }
    const clean = sanitizeBody(raw, limits);
    if (!clean.ok) return json(400, { error: { message: clean.error } }, origin);

    // 先限流，再转发。计数放在 Durable Object 里，原子读写，不会被并发请求绕过。
    const ip = request.headers.get('cf-connecting-ip') || 'unknown';
    const id = await hashId(ip, env.ID_SALT || '');
    const stub = env.LIMITER.get(env.LIMITER.idFromName('global'));
    const verdict = await (await stub.fetch('https://limiter/check', {
      method: 'POST',
      body: JSON.stringify({ id, limits }),
    })).json();
    if (!verdict.ok) {
      const msg = verdict.reason === 'global_day'
        ? `今天全站的 AI 助教额度（${limits.GLOBAL_PER_DAY} 次）已用完，北京时间早上 8 点重置。`
        : verdict.reason === 'per_day'
          ? `你今天的提问次数已达上限（${limits.PER_IP_PER_DAY} 次），北京时间早上 8 点重置。`
          : '提问太快了，稍等一会儿再试。';
      return json(429, { error: { message: msg, reason: verdict.reason } }, origin, { 'retry-after': String(verdict.retryAfter) });
    }

    const upstream = await fetch(UPSTREAM, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': env.DEEPSEEK_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ ...clean.body, metadata: { user_id: id } }),
    });
    const body = await upstream.text();
    return new Response(body, {
      status: upstream.status,
      headers: { 'content-type': upstream.headers.get('content-type') || 'application/json', ...cors(origin) },
    });
  },
};

// 单个全局 Durable Object：key 是 IP 哈希，值是该 IP 的计数状态；另存全站日计数。
export class Limiter {
  constructor(state) {
    this.state = state;
  }

  // 每天清一次：删掉不是今天的 IP 记录，避免存储无限增长。
  async alarm() {
    const today = new Date().toISOString().slice(0, 10);
    const all = await this.state.storage.list({ prefix: 'ip:' });
    const stale = [];
    for (const [k, v] of all) if (!v || v.day !== today) stale.push(k);
    for (let i = 0; i < stale.length; i += 128) await this.state.storage.delete(stale.slice(i, i + 128));
    await this.state.storage.setAlarm(Date.now() + 24 * 60 * 60 * 1000);
  }

  async fetch(request) {
    const { id, limits } = await request.json();
    const now = Date.now();
    if (this.state.storage.getAlarm && this.state.storage.setAlarm && (await this.state.storage.getAlarm()) == null) {
      await this.state.storage.setAlarm(now + 24 * 60 * 60 * 1000);
    }
    return await this.state.blockConcurrencyWhile(async () => {
      const g = decideGlobal((await this.state.storage.get('global')) || {}, now, limits);
      if (!g.ok) return Response.json({ ok: false, reason: g.reason, retryAfter: g.retryAfter });
      const key = 'ip:' + id;
      const d = decide((await this.state.storage.get(key)) || {}, now, limits);
      if (!d.ok) return Response.json({ ok: false, reason: d.reason, retryAfter: d.retryAfter });
      await this.state.storage.put(key, d.state);
      await this.state.storage.put('global', g.state);
      return Response.json({ ok: true });
    });
  }
}
