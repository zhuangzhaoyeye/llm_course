// 限流与请求清洗的纯逻辑。不依赖 Cloudflare 运行时，可以在 Node 里直接单测。
// 限额数字是初始建议值，不是 DeepSeek 官方给的（官方只限账号级并发，见 README 对话记录）。

export const DEFAULTS = {
  PER_IP_PER_MINUTE: 5,
  PER_IP_PER_DAY: 20,
  GLOBAL_PER_DAY: 100,
  MODEL: 'deepseek-flash',
  MAX_TOKENS: 1024,
  MAX_BODY_BYTES: 32 * 1024,
  MAX_MESSAGES: 40,
  WEB_SEARCH: true,
  WEB_SEARCH_MAX_USES: 2,
};

const MINUTE = 60 * 1000;

// 当天 00:00 UTC 的毫秒数，用作"每天"计数的分桶键。
export function dayKey(now) {
  return new Date(now).toISOString().slice(0, 10);
}

// 纯函数：给定当前状态与时间，返回是否放行以及新状态。
// state = { day, dayCount, globalDay, globalCount, minuteStamps: number[] }
export function decide(state, now, limits = DEFAULTS) {
  const today = dayKey(now);
  const s = {
    day: state.day === today ? state.day : today,
    dayCount: state.day === today ? state.dayCount : 0,
    minuteStamps: (state.minuteStamps || []).filter((t) => now - t < MINUTE),
  };
  if (s.minuteStamps.length >= limits.PER_IP_PER_MINUTE) {
    const retryAfter = Math.ceil((s.minuteStamps[0] + MINUTE - now) / 1000);
    return { ok: false, reason: 'per_minute', retryAfter, state: s };
  }
  if (s.dayCount >= limits.PER_IP_PER_DAY) {
    return { ok: false, reason: 'per_day', retryAfter: secondsToNextUtcDay(now), state: s };
  }
  s.minuteStamps.push(now);
  s.dayCount += 1;
  return { ok: true, state: s };
}

export function secondsToNextUtcDay(now) {
  const d = new Date(now);
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  return Math.ceil((next - now) / 1000);
}

export function decideGlobal(state, now, limits = DEFAULTS) {
  const today = dayKey(now);
  const count = state.globalDay === today ? state.globalCount : 0;
  if (count >= limits.GLOBAL_PER_DAY) {
    return { ok: false, reason: 'global_day', retryAfter: secondsToNextUtcDay(now), state: { globalDay: today, globalCount: count } };
  }
  return { ok: true, state: { globalDay: today, globalCount: count + 1 } };
}

// 只保留前端需要的字段；模型、max_tokens 由服务端写死。客户端传来的 tools 一律丢弃；
// 联网搜索由服务端按开关自行注入，并限制单次请求最多搜几次（搜索按次计费，每次 0.005 元）。
export function sanitizeBody(raw, limits = DEFAULTS) {
  if (raw == null || typeof raw !== 'object') return { ok: false, error: 'body must be a JSON object' };
  if (!Array.isArray(raw.messages) || raw.messages.length === 0) return { ok: false, error: 'messages required' };
  if (raw.messages.length > limits.MAX_MESSAGES) return { ok: false, error: 'too many messages' };
  const messages = [];
  for (const m of raw.messages) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) return { ok: false, error: 'invalid role' };
    if (typeof m.content !== 'string') return { ok: false, error: 'content must be string' };
    messages.push({ role: m.role, content: m.content });
  }
  const system = typeof raw.system === 'string' ? raw.system : '';
  const body = {
    model: limits.MODEL,
    max_tokens: limits.MAX_TOKENS,
    thinking: { type: 'disabled' },
    system,
    messages,
  };
  if (limits.WEB_SEARCH) {
    body.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: limits.WEB_SEARCH_MAX_USES }];
  }
  return { ok: true, body };
}

export function originAllowed(origin, allowed) {
  if (!origin) return false;
  return allowed.includes(origin);
}

// 不把原始 IP 发给 DeepSeek：用 SHA-256 前 16 位十六进制作为 user_id（仅字母数字，符合官方对 user_id 的建议）。
export async function hashId(text, salt = '') {
  const buf = new TextEncoder().encode(salt + text);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
}
