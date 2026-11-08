#!/usr/bin/env python3
"""给搜索索引里的每一行生成语义向量（Cloudflare Workers AI · bge-m3），存成 src/search/embeddings.{bin,json}。

用法:
    python3 scripts/embed_docs.py            # 只补算内容变了的行（按文本哈希判断），已有的复用
    python3 scripts/embed_docs.py --all      # 全部重算
    python3 scripts/embed_docs.py --dry-run  # 只统计要算几行，不联网

远程方式（本机实测可用；`wrangler dev` 的远程转发在国内网络每次都失败）:
    cd proxy/embed-tool
    npx wrangler deploy -c wrangler.remote.toml
    TOKEN=$(python3 -c "import secrets;print(secrets.token_hex(24))"); echo "$TOKEN" | npx wrangler secret put PROBE_TOKEN -c wrangler.remote.toml
    # 自定义域名生效约需 3 分钟（首次实测）
    cd ../.. && EMBED_URL=https://ai-probe.taleverse.cn/ EMBED_TOKEN=$TOKEN python3 scripts/embed_docs.py
    cd proxy/embed-tool && npx wrangler delete --name llm-course-ai-probe --force   # 用完即删

原理:
    起一个只监听 127.0.0.1 的 wrangler dev 小 Worker（proxy/embed-tool），它调用账号里的 Workers AI。
    需要先 `npx wrangler login`。Workers AI 在本地开发也会计费：238 行约 1 千 Neurons，免费额度每天 1 万。

文件格式 embeddings.bin（小端）:
    uint32 N | uint32 D | float32 scale[N] | int8 data[N*D]
    每个向量先 L2 归一化，再按 max|x| 量化到 int8；还原 x ≈ data * scale。
"""
import json
import math
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_site as bs  # noqa: E402
import os  # noqa: E402

import ssl  # noqa: E402

# python.org 安装的 Python 在 macOS 上默认不带根证书；优先 certifi，否则用系统自带的 /etc/ssl/cert.pem。不关闭证书校验。
def _ssl_ctx():
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except Exception:
        return ssl.create_default_context(cafile="/etc/ssl/cert.pem") if Path("/etc/ssl/cert.pem").exists() else ssl.create_default_context()


SSL_CTX = _ssl_ctx()
REMOTE_URL = os.environ.get("EMBED_URL", "").strip()
REMOTE_TOKEN = os.environ.get("EMBED_TOKEN", "").strip()

PORT = 8799
TOOL_DIR = bs.ROOT / "proxy" / "embed-tool"
BATCH = 20


def post(texts: list, tries: int = 5) -> list:
    """调本机 dev worker。上游偶发 "Network connection lost" / 5xx 时指数退避重试；4xx 不重试。"""
    last = ""
    for attempt in range(tries):
        if REMOTE_URL:
            body = {"model": bs.EMB_MODEL, "input": {"text": texts}}
            req = urllib.request.Request(REMOTE_URL, data=json.dumps(body).encode("utf-8"), method="POST",
                                         headers={"content-type": "application/json", "x-probe-token": REMOTE_TOKEN,
                                                  # Cloudflare 对 Python-urllib 默认 UA 返回 1010（按浏览器签名拦截），显式写明用途
                                                  "user-agent": "llm-course-embed-docs/1.0"})
        else:
            req = urllib.request.Request(
                f"http://127.0.0.1:{PORT}/", data=json.dumps({"texts": texts}).encode("utf-8"),
                headers={"content-type": "application/json"}, method="POST",
            )
        try:
            with urllib.request.urlopen(req, timeout=120, context=SSL_CTX) as r:
                data = json.loads(r.read().decode("utf-8"))
            vecs = data.get("vectors") or data.get("data")
            if len(vecs) != len(texts):
                raise SystemExit(f"返回 {len(vecs)} 个向量，预期 {len(texts)} 个")
            return vecs
        except urllib.error.HTTPError as e:
            last = f"{e.code}：{e.read().decode('utf-8', 'replace')[:200]}"
            if e.code < 500:
                break
        except Exception as e:  # 超时、连接被重置等
            last = repr(e)
        wait = 2 ** attempt
        if attempt == tries - 1:
            break
        print(f"    调用失败（{last[:90]}），{wait}s 后重试 {attempt + 1}/{tries - 1}")
        time.sleep(wait)
    raise SystemExit(f"Workers AI 连续 {tries} 次失败：{last}")


def quantize(vec: list) -> tuple:
    n = math.sqrt(sum(x * x for x in vec)) or 1.0
    v = [x / n for x in vec]
    m = max(abs(x) for x in v) or 1.0
    scale = m / 127.0
    return scale, [max(-127, min(127, round(x / scale))) for x in v]


def dequantize(scale: float, q: list) -> list:
    return [x * scale for x in q]


def main() -> int:
    bs.LESSON_TITLE_BY_ID.update({L["id"]: L["title"] for L in bs.load_lessons()})
    rows = bs.search_rows(bs.load_lessons())
    keys = [bs.row_key(r) for r in rows]
    texts = [bs.embed_text(r) for r in rows]
    hashes = [bs.text_hash(t) for t in texts]

    old = {}
    if bs.EMB_BIN.exists() and bs.EMB_META.exists() and "--all" not in sys.argv:
        meta = json.loads(bs.EMB_META.read_text(encoding="utf-8"))
        if meta.get("model") == bs.EMB_MODEL:
            raw = bs.EMB_BIN.read_bytes()
            n, d = struct.unpack_from("<II", raw, 0)
            scales = struct.unpack_from(f"<{n}f", raw, 8)
            data = struct.unpack_from(f"<{n * d}b", raw, 8 + 4 * n)
            for i, (k, h) in enumerate(zip(meta["keys"], meta["hashes"])):
                old[k] = (h, scales[i], list(data[i * d:(i + 1) * d]))

    todo = [i for i in range(len(rows)) if keys[i] not in old or old[keys[i]][0] != hashes[i]]
    chars = sum(len(texts[i]) for i in todo)
    print(f"共 {len(rows)} 行；需要计算 {len(todo)} 行，约 {chars} 字（≈{chars} tokens，约 {chars * 1.1 / 1000:.0f} Neurons）")
    if "--dry-run" in sys.argv:
        return 0

    fresh = {}
    if todo and REMOTE_URL:
        for s in range(0, len(todo), BATCH):
            idx = todo[s:s + BATCH]
            for i, v in zip(idx, post([texts[i] for i in idx])):
                if len(v) != 1024:
                    raise SystemExit(f"向量维度 {len(v)} ≠ 1024")
                fresh[keys[i]] = quantize(v)
            print(f"  已完成 {min(s + BATCH, len(todo))}/{len(todo)}")
    elif todo:
        proc = subprocess.Popen(
            ["npx", "-y", "wrangler@latest", "dev", "--ip", "127.0.0.1", "--port", str(PORT)],
            cwd=TOOL_DIR, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        )
        try:
            ready = False
            t0 = time.time()
            while time.time() - t0 < 240:
                line = proc.stdout.readline()
                if line and "Ready on" in line:
                    ready = True
                    break
                if not line and proc.poll() is not None:
                    raise SystemExit("wrangler dev 提前退出，请先确认已执行 npx wrangler login")
            if not ready:
                raise SystemExit("等待 wrangler dev 启动超过 240 秒")
            for s in range(0, len(todo), BATCH):
                idx = todo[s:s + BATCH]
                vecs = post([texts[i] for i in idx])
                for i, v in zip(idx, vecs):
                    if len(v) != 1024:
                        raise SystemExit(f"向量维度 {len(v)} ≠ 1024")
                    fresh[keys[i]] = quantize(v)
                print(f"  已完成 {min(s + BATCH, len(todo))}/{len(todo)}")
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except Exception:
                proc.kill()

    scales, blob = [], bytearray()
    for i, k in enumerate(keys):
        if k in fresh:
            sc, q = fresh[k]
        else:
            _, sc, q = old[k]
        scales.append(sc)
        blob += struct.pack(f"<{len(q)}b", *q)
    D = 1024
    out = struct.pack("<II", len(keys), D) + struct.pack(f"<{len(keys)}f", *scales) + bytes(blob)
    bs.EMB_DIR.mkdir(parents=True, exist_ok=True)
    bs.EMB_BIN.write_bytes(out)
    bs.EMB_META.write_text(json.dumps({"model": bs.EMB_MODEL, "dim": D, "keys": keys, "hashes": hashes}, ensure_ascii=False), encoding="utf-8")
    print(f"OK    已写入 {bs.EMB_BIN.relative_to(bs.ROOT)}（{len(out) // 1024} KB）与 {bs.EMB_META.relative_to(bs.ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
