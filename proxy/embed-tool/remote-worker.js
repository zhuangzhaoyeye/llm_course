// 生成文档向量用的临时 Worker（远程版）。本机 `wrangler dev` 的远程转发在国内网络实测每次都失败（Network connection lost / internal error），
// 部署到 Cloudflare 后直接在其内部调用 Workers AI 则正常。用完即删，见 scripts/embed_docs.py 顶部说明。
// 只接受带正确 x-probe-token 的 POST；密钥用 `wrangler secret put PROBE_TOKEN` 设置，不写进代码。
export default {
  async fetch(request, env) {
    if (request.method !== 'POST' || !env.PROBE_TOKEN || request.headers.get('x-probe-token') !== env.PROBE_TOKEN) {
      return new Response('not found', { status: 404 });
    }
    const { model, input } = await request.json();
    if (model !== '@cf/baai/bge-m3' || !input || !Array.isArray(input.text) || input.text.length === 0 || input.text.length > 100) {
      return Response.json({ ok: false, error: 'bad request' }, { status: 400 });
    }
    try {
      const out = await env.AI.run(model, { text: input.text });
      return Response.json({ ok: true, shape: out.shape, data: out.data });
    } catch (e) {
      return Response.json({ ok: false, error: String((e && e.message) || e).split('\n')[0] }, { status: 502 });
    }
  },
};
