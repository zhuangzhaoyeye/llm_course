// 匿名使用统计的事件清洗。纯函数，不依赖 Cloudflare 运行时，可在 Node 里直接单测。
// 原则：字段白名单、长度上限、枚举值校验；不认识的字段一律丢弃；不接收任何用户输入文本。

export const EVENT_LIMITS = {
  MAX_BODY_BYTES: 8 * 1024,
  MAX_EVENTS: 50,
  MAX_REFERRER_LEN: 80,
  // 事件时间偏移（相对本批 t0）最大 1 天，超出的当脏数据丢弃。
  MAX_OFFSET_MS: 24 * 60 * 60 * 1000,
  // 单次停留最大 30 分钟，超出的按 30 分钟截断（标签页挂机不算学习时长）。
  MAX_DWELL_MS: 30 * 60 * 1000,
};

const ID_RE = /^[A-Za-z0-9]{8,32}$/;
const LESSON_RE = /^\d{1,3}$/;
const CARD_RE = /^\d{1,3}(-\d{1,2})?$/;
const QNA_RE = /^\d{1,3}(-\d{1,2})?-\d{1,2}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DEVICES = ['mobile', 'tablet', 'desktop'];
const TABS = ['ai', 'qna'];
const LINKS = ['github', 'other'];
const SEARCH_KINDS = ['hit', 'miss'];
const RESUME_FROM = ['banner'];

// 每种事件允许携带的字段与校验函数。没列出的字段一律丢弃。
const SCHEMAS = {
  open: {},
  lesson: { l: (v) => LESSON_RE.test(v) },
  card: { l: (v) => LESSON_RE.test(v), c: (v) => CARD_RE.test(v), s: (v) => v === 'open' || v === 'close' },
  dwell: { l: (v) => LESSON_RE.test(v), c: (v) => CARD_RE.test(v), ms: 'dwell' },
  check: { l: (v) => LESSON_RE.test(v), c: (v) => CARD_RE.test(v), s: (v) => v === 'on' || v === 'off' },
  tab: { c: (v) => CARD_RE.test(v), tab: (v) => TABS.includes(v) },
  qna: { q: (v) => QNA_RE.test(v) },
  ai_open: { c: (v) => CARD_RE.test(v) },
  ai_ask: { c: (v) => CARD_RE.test(v) },
  link: { k: (v) => LINKS.includes(v) },
  search: { k: (v) => SEARCH_KINDS.includes(v), n: (v) => Number.isInteger(v) && v >= 0 && v <= 999 },
  resume: { l: (v) => LESSON_RE.test(v), from: (v) => RESUME_FROM.includes(v) },
};

function cleanEvent(raw, limits) {
  if (!raw || typeof raw !== 'object') return null;
  const schema = SCHEMAS[raw.e];
  if (!schema) return null;
  const out = { e: raw.e };
  const t = raw.t;
  if (!Number.isInteger(t) || t < 0 || t > limits.MAX_OFFSET_MS) return null;
  out.t = t;
  for (const [key, rule] of Object.entries(schema)) {
    const v = raw[key];
    if (rule === 'dwell') {
      if (!Number.isFinite(v) || v < 0) return null;
      out.ms = Math.min(Math.round(v), limits.MAX_DWELL_MS);
      continue;
    }
    if (v === undefined) {
      // 必填：每种事件声明的字段都必须带
      return null;
    }
    if (!rule(v)) return null;
    out[key] = v;
  }
  return out;
}

// 返回 { ok:true, row } 或 { ok:false, error }。row 对应 D1 表 batches 的一行。
export function sanitizeBatch(raw, limits = EVENT_LIMITS) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'body must be a JSON object' };
  if (raw.v !== 1) return { ok: false, error: 'unsupported version' };
  if (typeof raw.cid !== 'string' || !ID_RE.test(raw.cid)) return { ok: false, error: 'bad cid' };
  if (typeof raw.sid !== 'string' || !ID_RE.test(raw.sid)) return { ok: false, error: 'bad sid' };
  if (!Array.isArray(raw.ev) || raw.ev.length === 0) return { ok: false, error: 'no events' };
  if (raw.ev.length > limits.MAX_EVENTS) return { ok: false, error: 'too many events' };

  const visit = Number.isInteger(raw.vn) && raw.vn >= 1 && raw.vn <= 100000 ? raw.vn : 1;
  const first = typeof raw.fd === 'string' && DAY_RE.test(raw.fd) ? raw.fd : '';
  const dev = DEVICES.includes(raw.dev) ? raw.dev : 'desktop';
  const w = Number.isInteger(raw.w) && raw.w >= 0 && raw.w <= 10000 ? raw.w : 0;
  // 来源只留主机名，不留路径和查询串。
  let ref = '';
  if (typeof raw.ref === 'string' && raw.ref) {
    ref = raw.ref.slice(0, limits.MAX_REFERRER_LEN);
    if (!/^[A-Za-z0-9.-]+$/.test(ref)) ref = '';
  }

  const events = [];
  for (const e of raw.ev) {
    const c = cleanEvent(e, limits);
    if (c) events.push(c);
  }
  if (events.length === 0) return { ok: false, error: 'no valid events' };

  return {
    ok: true,
    row: { cid: raw.cid, sid: raw.sid, vn: visit, fd: first, dev, w, ref, n: events.length, ev: JSON.stringify(events) },
  };
}

export const SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  cid TEXT NOT NULL,
  sid TEXT NOT NULL,
  vn INTEGER NOT NULL,
  fd TEXT NOT NULL,
  dev TEXT NOT NULL,
  w INTEGER NOT NULL,
  ref TEXT NOT NULL,
  n INTEGER NOT NULL,
  ev TEXT NOT NULL
)`;

export const INSERT_SQL = 'INSERT INTO batches (ts, cid, sid, vn, fd, dev, w, ref, n, ev) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
