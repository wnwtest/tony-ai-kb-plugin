#!/usr/bin/env python3
"""图片视觉描述抽取：本地嵌入图片 → qwen2.5vl 生成中文描述 → 旁车 .md.txt 入库。

范围收敛：
- 仅处理被 md 笔记嵌入引用的本地图片（![[img.png]] / ![](path.png)）
- 排除远程 URL、.codex_tmp* 临时目录、SVG（无视觉信息）
- 已有旁车且新于源图 → 跳过（增量）

产物: <图片名>.md.txt
  ## @@img:<图片相对路径>@@ 🖼 <图片名>（来源: <引用它的笔记相对路径>）
  <视觉模型生成的中文描述>

用法:
  python extract_images.py --root D:\\obsidian --ollama http://192.168.119.219:11434 --model qwen2.5vl:7b [--limit N] [--min-bytes 10240]
"""
import argparse
import base64
import json
import re
import sys
import time
import urllib.request
from pathlib import Path

EMBED_RE = re.compile(r"!\[\[([^\]\|]+?)(?:\|[^\]]*)?\]\]|!\[([^\]]*)\]\(([^)]+)\)")

def find_local_images(root: Path) -> dict[str, list[str]]:
    """扫描全部 md，返回 {图片绝对路径: [引用它的 md 相对路径, ...]}。"""
    skip_dirs = {".obsidian", ".git", ".smart-env", "node_modules", ".trash"}
    refs: dict[str, list[str]] = {}
    for md in root.rglob("*.md"):
        if any(p in skip_dirs or p.startswith(".codex_tmp") for p in md.parts):
            continue
        try:
            text = md.read_text(encoding="utf-8", errors="ignore")
        except Exception:
            continue
        for m in EMBED_RE.finditer(text):
            target = (m.group(1) or m.group(3) or "").strip()
            if not target or target.startswith("http://") or target.startswith("https://"):
                continue
            # 解析 vault 相对路径：[[name]] 可能无路径 → 全库按文件名查找
            cand = (root / target) if ("/" in target or "\\" in target) else None
            if cand is None:
                # 短名嵌入：按文件名在常见附件目录找（限一次全局扫描）
                cand = BY_NAME.get(Path(target).name)
            if cand and cand.exists():
                refs.setdefault(str(cand), []).append(md.relative_to(root).as_posix())
    return refs

# 全局文件名索引（短名 [[image.png]] 解引用用）
BY_NAME: dict[str, Path] = {}
refs_cache: dict[str, list[str]] = {}
def index_by_name(root: Path):
    skip_dirs = {".obsidian", ".git", ".smart-env", "node_modules", ".trash"}
    for p in root.rglob("*"):
        if not p.is_file():
            continue
        if any(part in skip_dirs or part.startswith(".codex_tmp") for part in p.parts):
            continue
        if p.suffix.lower() in {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"}:
            BY_NAME.setdefault(p.name, p)

PROMPT = (
    "这是一张技术笔记里的图片。请用中文客观描述图片内容："
    "如果是架构图/流程图/框图，说明模块名与连接关系；"
    "如果是数据表/规格表，逐项列出关键字段；"
    "如果是代码/日志截图，转写其中可读文本；"
    "如果是照片或硬件图，描述对象与关键特征。"
    "不要猜测图中没有的信息，控制在 150 字内。"
)

def describe(ollama: str, model: str, img_path: Path, timeout: int = 120) -> str:
    data = img_path.read_bytes()
    # webp/bmp 等 Ollama 不认的容器 → PIL 转 PNG
    if img_path.suffix.lower() in {".webp", ".bmp"} or data[:4] == b"RIFF":
        from io import BytesIO
        from PIL import Image
        with Image.open(BytesIO(data)) as im:
            buf = BytesIO()
            im.convert("RGB").save(buf, format="PNG")
            data = buf.getvalue()
    b64 = base64.b64encode(data).decode()
    body = json.dumps({
        "model": model,
        "messages": [{"role": "user", "content": PROMPT, "images": [b64]}],
        "stream": False, "think": False,
        "options": {"temperature": 0.2},
    }).encode()
    req = urllib.request.Request(f"{ollama}/api/chat", data=body,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = json.loads(resp.read())
    return (data.get("message", {}).get("content") or "").strip()

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=".")
    ap.add_argument("--ollama", default="http://192.168.119.219:11434")
    ap.add_argument("--model", default="qwen2.5vl:7b")
    ap.add_argument("--limit", type=int, default=0, help="最多处理 N 张（0=不限）")
    ap.add_argument("--min-bytes", type=int, default=10240, help="小于此字节的图跳过（多为小图标）")
    ap.add_argument("--unreferenced", action="store_true",
                    help="处理未被 md 引用的实体图片（按文件系统扫描，来源=所在目录推断）")
    args = ap.parse_args()
    root = Path(args.root)

    print("索引图片文件名…")
    index_by_name(root)
    print(f"  共 {len(BY_NAME)} 张本地图片")

    if args.unreferenced:
        # 二批：未被引用的实体图片，来源按最近 md（同目录或父目录）推断
        todo = []
        for name, p in BY_NAME.items():
            if str(p) in refs_cache:
                continue
            if p.stat().st_size < args.min_bytes:
                continue
            side = p.with_suffix(p.suffix + ".md.txt")
            if side.exists() and side.stat().st_mtime >= p.stat().st_mtime:
                continue
            # 来源推断：同目录或最近祖先目录里的 md
            src = None
            for d in [p.parent, *p.parent.parents]:
                if d == root:
                    break
                mds = sorted(d.glob("*.md"))
                if mds:
                    src = mds[0].relative_to(root).as_posix()
                    break
            todo.append((p, [src or p.parent.relative_to(root).as_posix()]))
        print(f"  未被引用、≥{args.min_bytes}B、待处理: {len(todo)} 张")
    else:
        print("扫描 md 嵌入引用…")
        refs_cache.update({k: v for k, v in find_local_images(root).items()})
        print(f"  被引用的本地图片: {len(refs_cache)} 张")
        todo = []
        for img_str, md_refs in refs_cache.items():
            img = Path(img_str)
            if img.stat().st_size < args.min_bytes:
                continue
            side = img.with_suffix(img.suffix + ".md.txt")
            if side.exists() and side.stat().st_mtime >= img.stat().st_mtime:
                continue
            todo.append((img, md_refs))
        print(f"  待处理（新/变更、≥{args.min_bytes}B）: {len(todo)} 张")
    if args.limit:
        todo = todo[:args.limit]
        print(f"  本次 limit={args.limit}")

    ok = fail = 0
    t0 = time.time()
    for i, (img, md_refs) in enumerate(todo, 1):
        try:
            desc = describe(args.ollama, args.model, img)
        except Exception as e:
            fail += 1
            print(f"  ✗ [{i}/{len(todo)}] {img.name}: {e}", file=sys.stderr)
            time.sleep(1)
            continue
        if not desc:
            fail += 1
            continue
        src = "、".join(md_refs[:3])
        header = f"## @@img:{img.relative_to(root).as_posix()}@@ 🖼 {img.stem}（来源: {src}）"
        side = img.with_suffix(img.suffix + ".md.txt")
        side.write_text(header + "\n\n" + desc + "\n", encoding="utf-8")
        ok += 1
        if i % 10 == 0 or i == len(todo):
            rate = i / max(time.time() - t0, 1)
            print(f"  ✓ {i}/{len(todo)}（{rate:.1f} 张/秒，成功 {ok} 失败 {fail}）")
    print(f"\n完成：成功 {ok}，失败 {fail}，耗时 {time.time()-t0:.0f}s")
    sys.exit(0 if fail == 0 else 1)

if __name__ == "__main__":
    main()
