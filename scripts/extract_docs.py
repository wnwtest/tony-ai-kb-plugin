#!/usr/bin/env python3
"""多格式文档抽取：PDF/PPTX/DOC/DOCX/XLSX → 旁车 .md.txt（供插件建库索引）。

用法:
  python extract_docs.py [--root D:\\obsidian] [--out-dir .doc-text] [--ext pdf,pptx,docx,xlsx]

产出: 每个被处理的文档旁生成 `<原名>.md.txt`：
  每页/每slide/每sheet 前加分隔行 `## @@doc:<相对路径>#page N@@ <标题>`
插件 chunker 识别 @@doc: 头并作为 header（跳转用），普通行进入正文。
已存在且 mtime 新于源文件的旁车文件跳过（增量）。
"""
import argparse
import os
import sys
from pathlib import Path

def extract_pdf(path: Path) -> list[str]:
    import fitz
    out = []
    with fitz.open(path) as doc:
        for i, page in enumerate(doc, 1):
            text = page.get_text("text").strip()
            if text:
                out.append(f"## @@doc:{path.as_posix()}#page {i}@@ {path.stem} 第{i}页\n\n{text}")
    return out

def extract_pptx(path: Path) -> list[str]:
    from pptx import Presentation
    out = []
    prs = Presentation(str(path))
    for i, slide in enumerate(prs.slides, 1):
        parts = []
        title = None
        for shape in slide.shapes:
            if shape.has_text_frame:
                t = shape.text_frame.text.strip()
                if t:
                    if title is None and shape == slide.shapes.title:
                        title = t
                    parts.append(t)
            if getattr(shape, "has_table", False):
                for row in shape.table.rows:
                    cells = [c.text.strip() for c in row.cells]
                    parts.append("| " + " | ".join(cells) + " |")
        # 备注
        if slide.has_notes_slide:
            nt = slide.notes_slide.notes_text_frame.text.strip()
            if nt:
                parts.append(f"备注: {nt}")
        body = "\n\n".join(parts).strip()
        if body:
            out.append(f"## @@doc:{path.as_posix()}#slide {i}@@ {path.stem} {title or f'第{i}页'}\n\n{body}")
    return out

def extract_docx(path: Path) -> list[str]:
    import docx
    out = []
    d = docx.Document(str(path))
    parts = []
    for p in d.paragraphs:
        t = p.text.strip()
        if t:
            style = (p.style.name or "").lower()
            prefix = "# " * (int(style.replace("heading ", "")) if style.startswith("heading") and style.split()[-1].isdigit() else 0)
            parts.append((prefix + t) if prefix else t)
    for tbl in d.tables:
        for row in tbl.rows:
            parts.append("| " + " | ".join(c.text.strip() for c in row.cells) + " |")
    body = "\n\n".join(parts).strip()
    if body:
        out.append(f"## @@doc:{path.as_posix()}#doc@@ {path.stem}\n\n{body}")
    return out

def extract_xlsx(path: Path) -> list[str]:
    import openpyxl
    out = []
    wb = openpyxl.load_workbook(str(path), data_only=True, read_only=True)
    for ws in wb.worksheets:
        lines = []
        for row in ws.iter_rows(values_only=True):
            if row is None:
                continue
            cells = ["" if v is None else str(v) for v in row]
            if any(c.strip() for c in cells):
                lines.append("| " + " | ".join(cells) + " |")
        if lines:
            out.append(f"## @@doc:{path.as_posix()}#sheet {ws.title}@@ {path.stem} / {ws.title}\n\n" + "\n".join(lines))
    wb.close()
    return out

EXTRACTORS = {
    ".pdf": extract_pdf,
    ".pptx": extract_pptx,
    ".docx": extract_docx,
    ".xlsx": extract_xlsx,
}
# .doc 旧格式：无可靠纯py库，尝试用 docx 打开，失败则跳过并提示转存 docx
def extract_doc(path: Path) -> list[str]:
    try:
        return extract_docx(path)
    except Exception:
        print(f"  ⚠ {path}: 旧版 .doc 无法解析，请转存为 .docx 后重跑", file=sys.stderr)
        return []

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=os.getcwd())
    ap.add_argument("--ext", default="pdf,pptx,docx,xlsx,doc")
    args = ap.parse_args()
    root = Path(args.root)
    exts = {("." + e.strip().lower()) for e in args.ext.split(",")}
    skip_dirs = {".obsidian", ".git", ".smart-env", "node_modules", ".trash"}
    total = ok = skip = fail = 0
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        if any(part in skip_dirs or part.startswith(".") for part in path.parts[:-1]):
            continue
        if path.suffix.lower() not in exts:
            continue
        total += 1
        side = path.with_suffix(path.suffix + ".md.txt")
        if side.exists() and side.stat().st_mtime >= path.stat().st_mtime:
            skip += 1
            continue
        fn = EXTRACTORS.get(path.suffix.lower()) or (extract_doc if path.suffix.lower() == ".doc" else None)
        if fn is None:
            continue
        try:
            chunks = fn(path)
        except Exception as e:
            fail += 1
            print(f"  ✗ {path}: {e}", file=sys.stderr)
            continue
        if chunks:
            side.write_text("\n\n".join(chunks) + "\n", encoding="utf-8")
            ok += 1
            print(f"  ✓ {path.relative_to(root)} ({len(chunks)} 块)")
        else:
            fail += 1
            print(f"  ✗ {path}: 无可提取文本", file=sys.stderr)
    print(f"\n共 {total} 个文档：提取 {ok}，跳过(已最新) {skip}，失败 {fail}")
    sys.exit(0 if fail == 0 else 1)

if __name__ == "__main__":
    main()
