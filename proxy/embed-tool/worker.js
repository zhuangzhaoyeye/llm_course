// 本机一次性工具：POST {texts:[...]} -> {vectors:[[...1024 个数]]}。不做鉴权，只允许从 127.0.0.1 访问（wrangler dev --ip 127.0.0.1）。
// 异常原样返回给本机调用方：wrangler 对未捕获的异常只显示 "internal error"，看不到原因。
const MODEL = '@cf/baai/bge-m3';

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') return new Response('POST only', { status: 405 });
    const { texts } = await request.json();
    if (!Array.isArray(texts) || texts.length === 0 || texts.length > 100) return Response.json({ error: 'texts must be 1..100 strings' }, { status: 400 });
    try {
      const out = await env.AI.run(MODEL, { text: texts });
      return Response.json({ vectors: out.data, shape: out.shape });
    } catch (e) {
      return Response.json({ error: String((e && e.message) || e).split('\n')[0], name: e && e.name }, { status: 502 });
    }
  },
};
