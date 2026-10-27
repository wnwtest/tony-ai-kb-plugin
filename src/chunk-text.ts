/**
 * 切片纯逻辑：无 Obsidian 依赖，可独立单测。
 * 规则（开发计划 §5.1）：
 *  - 按 `##` 二级标题切分；header 含 "## " 前缀，lineStart = 标题所在行
 *  - 文件开头到首个 `##` 之间为"前言"片段，header = 文件名（无扩展名）
 *  - YAML frontmatter 不作为切片内容，从前言中剥离
 *  - 片段正文（trimEnd 后）< minLen 的合并入前一片段；首片段即使过短也保留
 */

export interface RawChunk {
	file: string; // vault 相对路径
	header: string; // "## 标题" 或 前言=文件名
	content: string; // 含标题行的片段正文（已 trimEnd）
	lineStart: number; // 1-indexed，标题所在行（前言为首个内容行）
	mtime: number; // 源文件 mtime (ms)
}

export interface ChunkTextOptions {
	file: string; // vault 相对路径
	fileName: string; // 文件名（无扩展名），用作前言 header
	mtime: number;
	minLen?: number;
}

export const DEFAULT_MIN_CHUNK_LEN = 200;

const H2 = /^##\s+/;
const FENCE = /^---\s*$/;

export function chunkText(text: string, opts: ChunkTextOptions): RawChunk[] {
	const { file, fileName, mtime } = opts;
	const minLen = opts.minLen ?? DEFAULT_MIN_CHUNK_LEN;
	const lines = text.split('\n');

	// 1) 剥离 YAML frontmatter
	let startIdx = 0;
	if (FENCE.test(lines[0] ?? '')) {
		for (let i = 1; i < lines.length; i++) {
			if (FENCE.test(lines[i] ?? '')) {
				startIdx = i + 1;
				break;
			}
			if (i === lines.length - 1) startIdx = 0; // 未闭合，按无 frontmatter
		}
	}

	const slices: RawChunk[] = [];
	let curHeader: string | null = null;
	let curStart = 0;
	let curBuf: string[] = [];

	const flush = (): void => {
		if (curHeader === null) return;
		const body = curBuf.join('\n').trimEnd();
		if (body.length > 0) {
			slices.push({ file, header: curHeader, content: body, lineStart: curStart, mtime });
		}
		curBuf = [];
	};

	// 2) 前言：header = 文件名，lineStart = 剥离 frontmatter 后首个内容行
	curHeader = fileName;
	curStart = startIdx === 0 ? 1 : startIdx + 1;
	curBuf = [];

	for (let i = startIdx; i < lines.length; i++) {
		const line = lines[i]!;
		const lineNo = i + 1;
		if (H2.test(line)) {
			flush();
			curHeader = line; // 含 "## "
			curStart = lineNo;
			curBuf = [line];
		} else {
			curBuf.push(line);
		}
	}
	flush();

	// 3) 合并过短片段：非首片段 → 追加到前一片段；首片段保留
	const merged: RawChunk[] = [];
	for (const slice of slices) {
		if (slice.content.length < minLen && merged.length > 0) {
			const prev = merged[merged.length - 1]!;
			prev.content += '\n' + slice.content;
		} else {
			merged.push(slice);
		}
	}
	return merged;
}
