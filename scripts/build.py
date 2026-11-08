#!/usr/bin/env python3
"""把 src/ 组装成单文件自包含产物 dist_course.html。

用法:
    python3 scripts/build.py            # 构建到 dist_course.html，并复制一份到 ~/Downloads/
    python3 scripts/build.py --check    # 只校验当前产物与源是否一致，不写文件

交付约定（2026-11-08 用户要求）:
    每次真正构建后，产物会自动复制到 ~/Downloads/dist_course.html，
    方便直接双击查看，不必回项目目录找。--check 不复制。

原理:
    src/shell.html 是除课程正文以外的全部内容（head / style / body 骨架 / 侧边栏 / 全部 JS），
    其中课程正文处留了占位符 /*__LESSONS__*/。
    src/lessons/lesson-<id>.html 是每课的正文 HTML（纯文本，不含转义）。
    构建 = 按 manifest 顺序，把每课正文 JSON 转义后填回占位符。

为什么必须 JSON 转义:
    引擎用 `const INLINE_LESSONS = { 1: "..." }` 承载正文，
    正文里的 " 和换行必须转义，否则整个 <script> 语法崩掉（历史 Bug 之一）。
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SHELL = ROOT / "src" / "shell.html"
LESSON_DIR = ROOT / "src" / "lessons"
MANIFEST = LESSON_DIR / "manifest.json"
ASSETS = ROOT / "src" / "assets"
OUT = ROOT / "dist_course.html"
PLACEHOLDER = "/*__LESSONS__*/"

# KaTeX 内联占位符：让产物不依赖任何 CDN，双击离线可用。
# 资源由 scripts/build_katex_inline.py 从官方 dist 生成（字体已 base64 内嵌）。
KATEX_CSS_PLACEHOLDER = "<!--__KATEX_CSS__-->"
KATEX_JS_PLACEHOLDER = "<!--__KATEX_JS__-->"


def inline_katex(shell: str) -> str:
    """把 KaTeX 的 CSS/JS 就地内联，并确保产物里不再出现外部 CDN 引用。"""
    for ph in (KATEX_CSS_PLACEHOLDER, KATEX_JS_PLACEHOLDER):
        if shell.count(ph) != 1:
            raise SystemExit(f"shell.html 中占位符 {ph} 必须恰好出现 1 次，实际 {shell.count(ph)} 次")

    for name in ("katex.min.css", "katex.min.js", "auto-render.min.js"):
        if not (ASSETS / name).exists():
            raise SystemExit(f"缺少内联资源 {ASSETS / name}，请先运行 python3 scripts/build_katex_inline.py")

    css = (ASSETS / "katex.min.css").read_text(encoding="utf-8")
    katex_js = (ASSETS / "katex.min.js").read_text(encoding="utf-8")
    auto_render_js = (ASSETS / "auto-render.min.js").read_text(encoding="utf-8")

    shell = shell.replace(KATEX_CSS_PLACEHOLDER, "<style>\n" + css + "\n</style>")
    shell = shell.replace(
        KATEX_JS_PLACEHOLDER,
        "<script>\n" + katex_js + "\n</script>\n<script>\n" + auto_render_js + "\n</script>",
    )
    return shell


def render() -> str:
    shell = SHELL.read_text(encoding="utf-8")
    if shell.count(PLACEHOLDER) != 1:
        raise SystemExit(f"shell.html 中占位符 {PLACEHOLDER} 必须恰好出现 1 次，实际 {shell.count(PLACEHOLDER)} 次")

    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    lessons = sorted(manifest["lessons"], key=lambda x: x["id"])

    entries = []
    for item in lessons:
        path = LESSON_DIR / item["file"]
        if not path.exists():
            raise SystemExit(f"缺少课程正文文件: {path}")
        body = path.read_text(encoding="utf-8")
        if not body.strip():
            raise SystemExit(f"课程正文为空: {path}（空卡片会被 verify 拦下）")
        # ensure_ascii=True 与原产物一致，保证构建可复现
        entries.append(f'  {item["id"]}: {json.dumps(body, ensure_ascii=True)},')

    shell = shell.replace(PLACEHOLDER, "\n".join(entries))
    return inline_katex(shell)


EXTERNAL_RESOURCE_RE = re.compile(
    r'<(?:script|link|img|iframe|source|video|audio|embed|track)\b[^>]*?\b(?:src|href)\s*=\s*["\']https?://',
    re.I,
)


def deliver_to_downloads(data: bytes) -> None:
    """把产物复制到 ~/Downloads，方便直接双击打开。复制失败只告警，不让构建失败。"""
    target = Path.home() / "Downloads" / OUT.name
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        print(f"OK    已复制到 {target}")
    except OSError as exc:
        print(f"WARN  复制到 {target} 失败（构建产物本身有效）：{exc}")


def main() -> int:
    built = render()

    # 自包含铁律：产物里不允许再出现任何外部资源引用（会加载资源的标签的 src= / href= 指向 http(s)）。
    # <a href> 只是导航、不加载资源，离线照常可用，不算（2026-11-05 收窄，原因见 30-dev-rules.md 8.1）。
    external = EXTERNAL_RESOURCE_RE.findall(built)
    if external:
        raise SystemExit(f"FAIL 产物仍含 {len(external)} 处外部资源引用，已不是自包含单文件")

    check_only = "--check" in sys.argv

    if check_only:
        current = OUT.read_text(encoding="utf-8") if OUT.exists() else ""
        if current == built:
            print("PASS  产物与源一致（dist_course.html 是最新的）")
            return 0
        print("FAIL  产物与源不一致，请运行 python3 scripts/build.py 重新构建")
        return 1

    OUT.write_text(built, encoding="utf-8")
    size = OUT.stat().st_size
    print(f"OK    已生成 {OUT.relative_to(ROOT)}（{len(built)} 字符 / {size} 字节）")
    deliver_to_downloads(built.encode("utf-8"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
