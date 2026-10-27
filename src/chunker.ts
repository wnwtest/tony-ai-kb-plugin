import { App, TFile } from 'obsidian';
import { chunkText, type ChunkTextOptions, type RawChunk } from './chunk-text';

/** Chunker.chunkFile 的选项。 */
export interface ChunkOptions {
	minChunkLen?: number;
}

/** 资源种类：md 笔记 / 抽取的文档(pdf/pptx/docx/xlsx) / 视觉图片描述 / 源码。 */
export type ChunkKind = 'md' | 'doc' | 'img' | 'code';

/** 全部可索引的扩展名（旁车 .md.txt 文档 + 源码文本）。 */
const DOC_SIDECAR_EXT = ['.pdf.md.txt', '.pptx.md.txt', '.docx.md.txt', '.doc.md.txt', '.xlsx.md.txt'];
const CODE_EXTS = new Set(['h', 'c', 'cpp', 'cc', 'java', 'py', 'js', 'ts', 'mk', 'sh', 'aidl', 'dts', 'dtsi', 'xml', 'html', 'css', 'json']);

/**
 * 切片器：md 走 chunkText；文档旁车(.md.txt)按 @@doc: 头分块；源码按文件整体+头注释。
 */
export class Chunker {
	constructor(private readonly app: App) {}

	/** 全 vault 可索引文件（md + 文档旁车 + 源码），供建库扫描。 */
	listFiles(): TFile[] {
		return this.app.vault.getFiles().filter((f) =>
			f.extension === 'md' ||
			DOC_SIDECAR_EXT.some((e) => f.name.toLowerCase().endsWith(e)) ||
			CODE_EXTS.has(f.extension.toLowerCase()),
		);
	}

	private kindOf(file: TFile): ChunkKind {
		if (file.extension === 'md') return 'md';
		if (DOC_SIDECAR_EXT.some((e) => file.name.toLowerCase().endsWith(e))) return 'doc';
		return 'code';
	}

	/** 把单个 TFile 切成 RawChunk[]（按 kind 分派）。 */
	async chunkFile(file: TFile, opts: ChunkOptions = {}): Promise<RawChunk[]> {
		const content = await this.app.vault.read(file);
		const mtime = file.stat?.mtime ?? 0;
		const kind = this.kindOf(file);
		if (kind === 'doc') return this.chunkSidecar(file, content, mtime, opts);
		if (kind === 'code') return this.chunkCode(file, content, mtime, opts);
		return chunkText(content, {
			file: file.path,
			fileName: file.basename,
			mtime,
			minLen: opts.minChunkLen,
		});
	}

	/** 文档旁车：按 `## @@doc:path#page N@@ 标题` 分隔行切块，头行写进 header。 */
	private chunkSidecar(file: TFile, content: string, mtime: number, opts: ChunkOptions): RawChunk[] {
		const lines = content.split('\n');
		const out: RawChunk[] = [];
		let header = '';
		let startLine = 1;
		let buf: string[] = [];
		const flush = (): void => {
			const body = buf.join('\n').trim();
			if (header && body.length >= (opts.minChunkLen ?? 200)) {
				out.push({ file: file.path, header, content: body, lineStart: startLine, mtime });
			}
			buf = [];
		};
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i]!;
			const m = line.match(/^## @@doc:(.+?)#\w+\s*[\w\s.]*@@\s*(.*)$/);
			if (m) {
				flush();
				const title = m[2] || m[1] || '';
				header = `📄 ${title}`.trim();
				startLine = i + 1;
			} else if (header) {
				buf.push(line);
			}
		}
		flush();
		return out;
	}

	/** 源码：文件头注释 + 首个函数/类定义前为一块；过长截断由 embedding 层兜底。 */
	private chunkCode(file: TFile, content: string, mtime: number, opts: ChunkOptions): RawChunk[] {
		const lang = file.extension;
		const header = `💻 ${file.name} (${lang})`;
		// 文件头注释块（连续 // 或 /* */ 或 # 开头）优先成块
		const lines = content.split('\n');
		const commentLines: string[] = [];
		let i = 0;
		while (i < lines.length) {
			const t = lines[i]!.trim();
			if (t.startsWith('//') || t.startsWith('#') || t.startsWith('/*') || t.startsWith('*')) {
				commentLines.push(lines[i]!);
				i++;
			} else if (t === '') { i++; } else break;
		}
		const chunks: RawChunk[] = [];
		if (commentLines.length >= 3) {
			const body = commentLines.join('\n').trim();
			if (body.length >= (opts.minChunkLen ?? 200)) {
				chunks.push({ file: file.path, header, content: body, lineStart: 1, mtime });
			}
		}
		// 整文件兜底块（函数级切块过重，先用整体语义块；embedding 截断保证安全）
		const whole = content.trim();
		if (whole.length >= (opts.minChunkLen ?? 200)) {
			chunks.push({ file: file.path, header: `${header} [全文]`, content: whole, lineStart: 1, mtime });
		}
		return chunks;
	}
}

export type { RawChunk } from './chunk-text';
export { chunkText, DEFAULT_MIN_CHUNK_LEN } from './chunk-text';
