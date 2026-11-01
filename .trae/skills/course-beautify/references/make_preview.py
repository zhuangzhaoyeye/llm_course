#!/usr/bin/env python3
"""生成「只改表现层」的本地预览：dist_course.html + beautify.css 注入（不注入任何脚本）。

不修改 src/ 下任何源文件，也不覆盖 dist_course.html。
用法：python3 .trae/skills/course-beautify/references/make_preview.py

前置：dist_course.html 必须是最新构建（python3 scripts/build.py --check）。
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
SRC = ROOT / "dist_course.html"
OUT = ROOT / "tmp" / "preview_course_beautify.html"
HERE = Path(__file__).resolve().parent
CSS = HERE / "beautify.css"

html = SRC.read_text(encoding="utf-8")
if "/*__LESSONS__*/" in html:
    raise SystemExit("dist_course.html 仍是未构建模板，请先 python3 scripts/build.py")

inject = (
    '\n<style id="bf-beautify-css">\n'
    + CSS.read_text(encoding="utf-8")
    + "\n</style>\n"
)

if "</body>" not in html:
    raise SystemExit("找不到 </body>")
OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(html.replace("</body>", inject + "</body>"), encoding="utf-8")
print(f"OK -> {OUT}  ({OUT.stat().st_size / 1024 / 1024:.2f} MB)")
