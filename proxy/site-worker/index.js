// 课程站镜像的入口：只做一件事——把根路径映射到 index.html。
// 站点内部链接写的是 lesson-N.html，所以 assets 用 html_handling="none"（不重写扩展名），
// 代价是 "/" 不会被自动解析成 index.html，这里补上。
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/') url.pathname = '/index.html';
    return env.ASSETS.fetch(new Request(url, request));
  },
};
