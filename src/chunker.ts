import { App, TFile } from 'obsidian';
import { chunkText, type ChunkTextOptions, type RawChunk } from './chunk-text';

/** Chunker.chunkFile 的选项。 */
export interface ChunkOptions {
	minChunkLen?: number;
}

/**
 * 切片器：在 Obsidian API 之上封装，把 TFile 读出后交给纯函数 {@link chunkText}。
 */
export class Chunker {
	constructor(private readonly app: App) {}

	/** 全 vault md 文件列表（M4 建库用）。 */
	listFiles(): TFile[] {
		return this.app.vault.getMarkdownFiles();
	}

	/** 把单个 TFile 切成 RawChunk[]。 */
	async chunkFile(file: TFile, opts: ChunkOptions = {}): Promise<RawChunk[]> {
		const content = await this.app.vault.read(file);
		const textOpts: ChunkTextOptions = {
			file: file.path,
			fileName: file.basename,
			mtime: file.stat?.mtime ?? 0,
			minLen: opts.minChunkLen,
		};
		return chunkText(content, textOpts);
	}
}

export type { RawChunk } from './chunk-text';
export { chunkText, DEFAULT_MIN_CHUNK_LEN } from './chunk-text';
