#!/usr/bin/env python3
"""把 KaTeX 0.16.11 的 dist 资源转成可内联的单文件片段。

输入：/tmp/katex/{katex.min.css, katex.min.js, auto-render.min.js, fonts/*.woff2}
输出：src/assets/katex.min.css（字体已 base64 内嵌，仅保留 woff2）
      src/assets/katex.min.js
      src/assets/auto-render.min.js

为什么只保留 woff2：Chrome / Safari / Edge 均支持 woff2；去掉 woff/ttf 可省约 2/3 体积。
"""
import base64
import re
import sys
from pathlib import Path

SRC = Path("/tmp/katex")
OUT = Path(__file__).resolve().parent.parent / "src" / "assets"
OUT.mkdir(parents=True, exist_ok=True)

css = (SRC / "katex.min.css").read_text(encoding="utf-8")

missing = []


def to_data_uri(match: re.Match) -> str:
    fname = match.group(1)
    woff2 = SRC / "fonts" / fname
    if not woff2.exists():
        missing.append(fname)
        return match.group(0)
    b64 = base64.b64encode(woff2.read_bytes()).decode("ascii")
    return f"url(data:font/woff2;base64,{b64})"


# 1) 把 woff2 引用替换成 base64 data URI
css = re.sub(r"url\(fonts/([A-Za-z0-9_.-]+\.woff2)\)", to_data_uri, css)

# 2) 删掉同一个 @font-face 里剩余的 woff / ttf 回退（保留 woff2 那一项）
css = re.sub(r",\s*url\(fonts/[A-Za-z0-9_.-]+\.woff\)\s*format\(['\"]woff['\"]\)", "", css)
css = re.sub(r",\s*url\(fonts/[A-Za-z0-9_.-]+\.ttf\)\s*format\(['\"]truetype['\"]\)", "", css)
# 3) 兜底：任何残留的相对字体引用（未下载到）直接去掉，避免产物里出现外部请求
css = re.sub(r",?\s*url\(fonts/[A-Za-z0-9_.-]+\)(\s*format\([^)]*\))?", "", css)

if missing:
    print("WARN 未找到字体：", ", ".join(sorted(set(missing))))

if "url(fonts/" in css:
    print("FAIL CSS 里仍有相对字体引用")
    sys.exit(1)

(OUT / "katex.min.css").write_text(css, encoding="utf-8")
for name in ("katex.min.js", "auto-render.min.js"):
    (OUT / name).write_text((SRC / name).read_text(encoding="utf-8"), encoding="utf-8")

total = sum((OUT / f).stat().st_size for f in ("katex.min.css", "katex.min.js", "auto-render.min.js"))
print(f"OK  已生成内联资源：css={ (OUT/'katex.min.css').stat().st_size } "
      f"js={(OUT/'katex.min.js').stat().st_size} autorender={(OUT/'auto-render.min.js').stat().st_size} "
      f"合计 {total} 字节")
