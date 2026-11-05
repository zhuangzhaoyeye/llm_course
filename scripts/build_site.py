#!/usr/bin/env python3
"""把 src/ 组装成「每课一个独立 URL」的静态站点 site/（用于 SEO 与站内全文搜索）。

用法:
    python3 scripts/build_site.py            # 生成 site/
    python3 scripts/build_site.py --check    # 只校验 site/ 与源是否一致，不写文件

与 build.py 的关系:
    build.py     -> dist_course.html   单文件自包含，离线双击即用（课程交付物，保持不变）
    build_site.py -> site/             多页站点，部署到 GitHub Pages 才用

设计:
    - 每课一个页面：第 1 课是 index.html（URL 即 /llm-course/），第 N 课是 lesson-N.html。
    - 正文直接写进页面 HTML（爬虫不执行 JS 也能读到），侧边栏与页脚导航都是真链接。
    - CSS / JS / 搜索索引拆成带内容哈希的共享文件，34 个页面共用，浏览器只下载一次。
    - 搜索索引 search-index.<hash>.json：每课 1 行 + 每张卡片 1 行（主问题 + 提示 + 正文），用户聚焦搜索框时才加载。
    - 不改任何课程正文；课程内容仍只在 src/lessons/ 一处维护。
"""
import hashlib
import html as htmllib
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build  # noqa: E402

ROOT = build.ROOT
OUT_DIR = ROOT / "site"
BASE = "https://zhuangzhaoyeye.github.io/llm-course/"
COURSE = "第一性原理大模型课程"
INDEX_TITLE = "第一性原理大模型课程：写给算法工程师，从 Transformer 到 Agent（34 课）"
INDEX_DESC = (
    "写给传统算法工程师的大模型课程，34 课覆盖 Transformer、训练与推理工程、Agent 工程、自主研究。"
    "每张卡片从一个问题出发，用具体数字把 Self-Attention、KV Cache、量化、RLHF、MCP 等机制从头算一遍。免登录，手机可看。"
)
BASE_KEYWORDS = "大模型课程,LLM 教程,算法工程师,推荐算法转大模型"
OG_IMAGE = BASE + "og.png"
PROVIDER = {"@type": "Person", "name": "zhuangzhaoyeye", "url": "https://github.com/zhuangzhaoyeye"}


CANONICAL_RE = re.compile(r'<link\b[^>]*\brel\s*=\s*["\']canonical["\'][^>]*>', re.I)


def external_resource(page: str) -> bool:
    """站点页面是否引用了外部资源。<link rel="canonical"> 只声明标准网址、不加载资源，不算（SEO 必需）。"""
    return bool(build.EXTERNAL_RESOURCE_RE.search(CANONICAL_RE.sub("", page)))


def page_name(n: int) -> str:
    return "index.html" if n == 1 else f"lesson-{n}.html"


def href_of(n: int) -> str:
    """页面内互相链接用的地址。第 1 课指向目录 './'，避免同一页出现 /index.html 与 / 两个 URL（canonical 是后者）。"""
    return "./" if n == 1 else f"lesson-{n}.html"


def page_url(n: int) -> str:
    return BASE if n == 1 else f"{BASE}lesson-{n}.html"


def text_of(fragment: str) -> str:
    """HTML 片段 -> 纯文本（去注释 / script / style / 标签，反转义，折叠空白）。"""
    s = re.sub(r"<!--.*?-->", " ", fragment, flags=re.S)
    s = re.sub(r"<(script|style)\b.*?</\1>", " ", s, flags=re.S | re.I)
    s = re.sub(r"<br\s*/?>", " ", s, flags=re.I)
    s = re.sub(r"<[^>]+>", "", s)
    return re.sub(r"\s+", " ", htmllib.unescape(s)).strip()


def short(s: str, n: int) -> str:
    return s if len(s) <= n else s[: n - 1].rstrip("，、；：,;: ") + "…"


def h8(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()[:8]


# ───────────────────────── shell 拆分 ─────────────────────────

def split_shell() -> dict:
    """把 shell.html 拆成：共享 CSS、共享 JS、body 模板。KaTeX 与 shell 的 CSS/JS 合并进共享文件。"""
    shell = build.SHELL.read_text(encoding="utf-8")
    if shell.count(build.PLACEHOLDER) != 1:
        raise SystemExit("shell.html 的课程占位符必须恰好出现 1 次")
    for ph in (build.KATEX_CSS_PLACEHOLDER, build.KATEX_JS_PLACEHOLDER):
        if shell.count(ph) != 1:
            raise SystemExit(f"shell.html 中占位符 {ph} 必须恰好出现 1 次")

    styles = re.findall(r"<style>(.*?)</style>", shell, flags=re.S)
    scripts = re.findall(r"<script>(.*?)</script>", shell, flags=re.S)
    if len(styles) != 1:
        raise SystemExit(f"shell.html 预期 1 个 <style>，实际 {len(styles)} 个")
    if len(scripts) != 3:
        raise SystemExit(f"shell.html 预期 3 个内联 <script>（统计 / 主逻辑 / 搜索），实际 {len(scripts)} 个。新增脚本块后请同步 build_site.py")

    # 单页版把全部课程塞进 INLINE_LESSONS；站点版每页只有本课，由页面内联脚本提供。
    inline_decl = "const INLINE_LESSONS = {\n" + build.PLACEHOLDER + "\n};"
    main_js = scripts[1]
    if main_js.count(inline_decl) != 1:
        raise SystemExit("找不到 INLINE_LESSONS 声明，build_site.py 需要随 shell.html 同步")
    main_js = main_js.replace(inline_decl, "const INLINE_LESSONS = window.__SITE__.lessons;")
    js_blocks = [scripts[0], main_js, scripts[2]]

    css = (build.ASSETS / "katex.min.css").read_text(encoding="utf-8")
    katex_js = (build.ASSETS / "katex.min.js").read_text(encoding="utf-8")
    auto_js = (build.ASSETS / "auto-render.min.js").read_text(encoding="utf-8")

    body = shell
    body = re.sub(r"<style>.*?</style>", "", body, flags=re.S)
    body = re.sub(r"<script>.*?</script>", "", body, flags=re.S)
    body = body.split("<body>", 1)[1].rsplit("</body>", 1)[0]

    shared_css = css + "\n" + styles[0]
    shared_js = "\n;\n".join([katex_js, auto_js] + js_blocks) + "\n"
    return {"css": shared_css, "js": shared_js, "body": body}


# ───────────────────────── 课程信息 ─────────────────────────

def load_lessons() -> list:
    manifest = json.loads(build.MANIFEST.read_text(encoding="utf-8"))
    out = []
    for item in sorted(manifest["lessons"], key=lambda x: x["id"]):
        n = item["id"]
        body = (build.LESSON_DIR / item["file"]).read_text(encoding="utf-8")
        if not body.strip():
            raise SystemExit(f"课程正文为空: {item['file']}")
        sub = re.search(r'<p class="subtitle">(.*?)</p>', body, flags=re.S)
        goal = re.search(r'<div class="goal-text">(.*?)</div>', body, flags=re.S)
        out.append({
            "id": n, "title": item["title"], "body": body,
            "subtitle": text_of(sub.group(1)) if sub else "",
            "goal": text_of(goal.group(1)) if goal else "",
        })
    return out


def cards_of(body: str) -> list:
    """每张卡片 -> {id, q, hint, text}。text 只取 .card-a 到 .tab-bar 之间的教学正文，不含 AI 对话 / 追问 UI。"""
    cards = []
    for chunk in body.split('<div class="card" data-card="')[1:]:
        cid = chunk.split('"', 1)[0]
        q = re.search(r'<div class="card-q-text">(.*?)</div>', chunk, flags=re.S)
        hint = re.search(r'<div class="card-q-hint">(.*?)</div>', chunk, flags=re.S)
        a = chunk.split('<div class="card-a">', 1)
        main = a[1].split('<div class="tab-bar">', 1)[0] if len(a) > 1 else ""
        cards.append({
            "id": cid,
            "q": text_of(q.group(1)) if q else "",
            "hint": text_of(hint.group(1)) if hint else "",
            "text": text_of(main),
        })
    return cards


def search_rows(lessons: list) -> list:
    """搜索索引：[课号, 卡片id或'', 序号, 标题/主问题, 正文]。与前端 build() 的单页版口径一致（课 + 卡片主问题）。"""
    rows = []
    for L in lessons:
        rows.append([L["id"], "", 0, L["title"], short(L["subtitle"] + " " + L["goal"], 600).strip()])
        for k, c in enumerate(cards_of(L["body"]), 1):
            rows.append([L["id"], c["id"], k, c["q"], short((c["hint"] + " " + c["text"]).strip(), 4000)])
    return rows


# ───────────────────────── 页面 ─────────────────────────

# ───────────────────────── 语义检索向量 ─────────────────────────
# 文档向量由 scripts/embed_docs.py 调 Workers AI 的 bge-m3 生成，存成 src/search/embeddings.{bin,json} 随源码提交。
# 构建时只读文件、不联网。内容变了而向量没重新生成 = 陈旧，--check 会失败，普通构建会跳过语义层并大声警告（站点仍可用词法搜索）。
EMB_DIR = ROOT / "src" / "search"
EMB_BIN = EMB_DIR / "embeddings.bin"
EMB_META = EMB_DIR / "embeddings.json"
EMB_MODEL = "@cf/baai/bge-m3"
SEM_API = "https://tutor.taleverse.cn/s"
EMB_BODY_CHARS = 420  # bge-m3 单条上限 512 token；中文约 1 字 ≈ 1 token，正文只取开头，避免超长被截断后丢失主问题


def embed_text(row: list) -> str:
    """一行搜索索引 -> 用来做向量的文本。课程行：课名 + 简介；卡片行：课名 + 主问题 + 提示/正文开头。"""
    lesson, card, _k, title, body = row
    head = f"第{lesson}课 {LESSON_TITLE_BY_ID.get(lesson, '')}"
    text = f"{head}。{title}" if card else f"{head}。{body}"
    if card and body:
        text += "。" + body
    return text[: EMB_BODY_CHARS + len(head) + len(title) + 8]


def row_key(row: list) -> str:
    return f"{row[0]}:{row[1] or 'L'}"


def text_hash(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()[:12]


LESSON_TITLE_BY_ID: dict = {}


def load_embeddings(rows: list) -> tuple:
    """返回 (bin 字节 | None, 状态说明)。状态：ok / missing / stale:<原因>。"""
    if not EMB_BIN.exists() or not EMB_META.exists():
        return None, "missing"
    meta = json.loads(EMB_META.read_text(encoding="utf-8"))
    if meta.get("model") != EMB_MODEL:
        return None, f"stale:模型 {meta.get('model')} ≠ {EMB_MODEL}"
    want = {row_key(r): text_hash(embed_text(r)) for r in rows}
    have = dict(zip(meta["keys"], meta["hashes"]))
    changed = [k for k in want if have.get(k) != want[k]]
    extra = [k for k in have if k not in want]
    if changed or extra:
        return None, f"stale:{len(changed)} 行内容变了或缺失、{len(extra)} 行已不存在（例：{(changed + extra)[:3]}）"
    if [row_key(r) for r in rows] != meta["keys"]:
        return None, "stale:行顺序与索引不一致"
    return EMB_BIN.read_bytes(), "ok"


def jsonld(obj) -> str:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")


def head_for(L: dict, total: int, css_name: str) -> str:
    n = L["id"]
    if n == 1:
        title, desc = INDEX_TITLE, INDEX_DESC
        kw = BASE_KEYWORDS + ",Transformer,Self-Attention,KV Cache,RLHF,Agent,MCP,RAG"
        ld = {"@context": "https://schema.org", "@type": "Course", "name": COURSE, "description": INDEX_DESC,
              "inLanguage": "zh-CN", "url": BASE, "provider": PROVIDER, "isAccessibleForFree": True,
              "numberOfLessons": total}
        og_type = "website"
    else:
        title = f"第 {n} 课：{L['title']}｜{COURSE}"
        desc = short(f"{L['title']}。{L['subtitle']}", 150)
        kw = f"{L['title']},{BASE_KEYWORDS}"
        ld = {"@context": "https://schema.org", "@type": "LearningResource", "name": f"第 {n} 课：{L['title']}",
              "description": desc, "inLanguage": "zh-CN", "url": page_url(n), "position": n,
              "isAccessibleForFree": True, "provider": PROVIDER,
              "isPartOf": {"@type": "Course", "name": COURSE, "url": BASE}}
        og_type = "article"
    e = htmllib.escape
    url = page_url(n)
    return f"""<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{e(title)}</title>
<meta name="description" content="{e(desc, quote=True)}">
<meta name="keywords" content="{e(kw, quote=True)}">
<meta name="author" content="zhuangzhaoyeye">
<meta name="robots" content="index,follow">
<link rel="canonical" href="{url}">
<meta property="og:type" content="{og_type}">
<meta property="og:locale" content="zh_CN">
<meta property="og:site_name" content="{COURSE}">
<meta property="og:title" content="{e(title, quote=True)}">
<meta property="og:description" content="{e(desc, quote=True)}">
<meta property="og:url" content="{url}">
<meta property="og:image" content="{OG_IMAGE}">
<meta property="og:image:width" content="1280">
<meta property="og:image:height" content="640">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="{e(title, quote=True)}">
<meta name="twitter:description" content="{e(desc, quote=True)}">
<meta name="twitter:image" content="{OG_IMAGE}">
<script type="application/ld+json">{jsonld(ld)}</script>
<link rel="stylesheet" href="{css_name}">
<noscript><style>.card-a{{display:block!important}}.tab-bar,.llm-section,.qna-section{{display:none!important}}</style></noscript>"""


def link_pages(html: str) -> tuple:
    """把 onclick="switchLesson(N);return false;" 的导航改成指向静态页面的真链接。返回 (html, 替换次数)。"""
    cnt = 0

    def sub_nav(m):
        nonlocal cnt
        cnt += 1
        return f'href="{href_of(int(m.group(1)))}"'

    # 侧边栏与课内页脚都是 href="#" onclick="switchLesson(N);return false;" 这一种写法
    html = re.sub(r'href="#"\s+onclick="switchLesson\((\d+)\);return false;"', sub_nav, html)
    return html, cnt


def build_page(L: dict, lessons: list, shell: dict, css_name: str, js_name: str, index_name: str, sem: dict = None) -> str:
    n = L["id"]
    body = shell["body"]

    # 侧边栏：真链接 + 当前课高亮
    body, nav_cnt = link_pages(body)
    if nav_cnt != len(lessons):
        raise SystemExit(f"侧边栏导航改写 {nav_cnt} 处，预期 {len(lessons)} 处（shell 的导航写法变了？）")
    body = re.sub(r'class="nav-item active"', 'class="nav-item"', body)
    pat = re.compile(r'(<a class="nav-item)(" href="%s" )' % re.escape(href_of(n)))
    body, k = pat.subn(r'\1 active\2', body)
    if k != 1:
        raise SystemExit(f"第 {n} 课找不到唯一的侧边栏项（命中 {k}）")

    # 头部徽章 / 标题：静态写好，无 JS 也可见
    body = body.replace('<span class="lesson-badge" id="headerBadge">第 1 课</span>',
                        f'<span class="lesson-badge" id="headerBadge">第 {n} 课</span>')
    old_h1 = '<h1 id="headerTitle">Transformer 回顾 — 从 BERT 到 GPT 的认知桥梁</h1>'
    if body.count(old_h1) != 1:
        raise SystemExit("找不到头部 h1，build_site.py 需要随 shell.html 同步")
    body = body.replace(old_h1, f'<h1 id="headerTitle">{htmllib.escape(L["title"])}</h1>')

    # 课程正文静态写进容器；页脚导航同样改成真链接
    lesson_html, _ = link_pages(L["body"])
    loading = '<div id="lesson-container">\n  <div style="display:flex;align-items:center;justify-content:center;padding:60px;color:var(--text-tertiary);font-size:14px;">正在加载课程...</div>\n</div>'
    if body.count(loading) != 1:
        raise SystemExit("找不到课程容器占位，build_site.py 需要随 shell.html 同步")
    body = body.replace(loading, f'<div id="lesson-container">{lesson_html}</div>')

    site = {"lesson": n, "pages": {str(x["id"]): href_of(x["id"]) for x in lessons}, "index": index_name}
    if sem:
        site["sem"] = sem
    site_js = "window.__SITE__=" + json.dumps(site, ensure_ascii=False, separators=(",", ":")) + ";"
    # lessons 由前端从容器读取，避免正文在 HTML 与 JS 里各存一份
    boot = (
        "<script>" + site_js +
        "window.__SITE__.lessons={};window.__SITE__.lessons[" + str(n) + "]=document.getElementById('lesson-container').innerHTML;</script>\n"
        f'<script src="{js_name}"></script>'
    )
    return (
        '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n' + head_for(L, len(lessons), css_name) +
        "\n</head>\n<body>\n" + body + "\n" + boot + "\n</body>\n</html>\n"
    )


def sitemap(lessons: list) -> str:
    urls = "\n".join(f"  <url><loc>{page_url(L['id'])}</loc></url>" for L in lessons)
    return f'<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n{urls}\n</urlset>\n'


def render_site() -> dict:
    """返回 {相对路径: 字节}。"""
    lessons = load_lessons()
    LESSON_TITLE_BY_ID.update({x["id"]: x["title"] for x in lessons})
    shell = split_shell()
    files = {}

    css_b = shell["css"].encode("utf-8")
    js_b = shell["js"].encode("utf-8")
    css_name = f"site.{h8(css_b)}.css"
    js_name = f"site.{h8(js_b)}.js"
    rows = search_rows(lessons)
    idx_b = json.dumps(rows, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    idx_name = f"search-index.{h8(idx_b)}.json"
    files[css_name] = css_b
    files[js_name] = js_b
    files[idx_name] = idx_b

    # 语义检索：文档向量随站点发布（带内容哈希），查询向量由代理 /s 现算。向量陈旧时不发布语义层。
    emb, emb_status = load_embeddings(rows)
    sem = None
    if emb:
        emb_name = f"sem-index.{h8(emb)}.bin"
        files[emb_name] = emb
        sem = {"vec": emb_name, "api": SEM_API}
    render_site.emb_status = emb_status

    for L in lessons:
        page = build_page(L, lessons, shell, css_name, js_name, idx_name, sem)
        if external_resource(page):
            raise SystemExit(f"{page_name(L['id'])} 含外部资源引用")
        files[page_name(L["id"])] = page.encode("utf-8")
    files["sitemap.xml"] = sitemap(lessons).encode("utf-8")

    # 自检：标题与描述唯一；索引行数 = 课数 + 卡片数
    titles = re.findall(r"<title>(.*?)</title>", "".join(files[page_name(L['id'])].decode() for L in lessons))
    if len(set(titles)) != len(lessons):
        raise SystemExit("页面 <title> 有重复")
    descs = [re.search(r'name="description" content="(.*?)"', files[page_name(L['id'])].decode()).group(1) for L in lessons]
    if len(set(descs)) != len(lessons):
        raise SystemExit("页面 description 有重复")
    n_cards = sum(len(cards_of(L["body"])) for L in lessons)
    if len(rows) != len(lessons) + n_cards:
        raise SystemExit(f"搜索索引行数 {len(rows)} ≠ 课数 {len(lessons)} + 卡片数 {n_cards}")
    return files


def main() -> int:
    files = render_site()
    check_only = "--check" in sys.argv
    st = getattr(render_site, "emb_status", "missing")
    if st != "ok":
        msg = ("语义向量缺失" if st == "missing" else "语义向量已陈旧（" + st[6:] + "）") + "：站点只有词法搜索。请运行 python3 scripts/embed_docs.py 重新生成"
        if check_only:
            print("FAIL  " + msg)
            return 1
        print("WARN  " + msg, file=sys.stderr)

    if check_only:
        problems = []
        on_disk = {p.name for p in OUT_DIR.iterdir()} if OUT_DIR.exists() else set()
        for name, data in files.items():
            f = OUT_DIR / name
            if not f.exists():
                problems.append(f"缺少 {name}")
            elif f.read_bytes() != data:
                problems.append(f"内容过期 {name}")
        for extra in sorted(on_disk - set(files)):
            problems.append(f"多余文件 {extra}")
        if problems:
            print("FAIL  site/ 与源不一致：" + "；".join(problems[:6]) + ("…" if len(problems) > 6 else ""))
            print("      请运行 python3 scripts/build_site.py 重新构建")
            return 1
        print(f"PASS  site/ 与源一致（{len(files)} 个文件）")
        return 0

    OUT_DIR.mkdir(exist_ok=True)
    for old in OUT_DIR.iterdir():
        if old.is_file():
            old.unlink()
    for name, data in files.items():
        (OUT_DIR / name).write_bytes(data)
    pages = [n for n in files if n.endswith(".html")]
    shared = {n: len(files[n]) for n in files if not n.endswith(".html") and n != "sitemap.xml"}
    avg = sum(len(files[n]) for n in pages) // len(pages)
    print(f"OK    已生成 site/：{len(pages)} 个页面（平均 {avg // 1024} KB）+ 共享文件 "
          + "，".join(f"{k.split('.')[0]}.{k.split('.')[-1]} {v // 1024} KB" for k, v in shared.items()))
    return 0


if __name__ == "__main__":
    sys.exit(main())
