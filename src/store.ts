import { App, TFile } from 'obsidian';
import { Chunker, type RawChunk } from './chunker';
import { OllamaClient, errMsg } from './ollama';

/**
 * 向量库：落盘 store.json + 内存索引。
 * M4 = 全量重建；M7 在此基础上做 mtime 增量。
 */

export interface StoredChunk extends RawChunk {
	id: string; // `${file}::${lineStart}`
	vector: number[]; // 已 L2 归一化 + 6 位小数舍入（省体积，余弦精度足够）
}

export interface Store {
	version: number; // 1
	model: string; // 建库所用 embedding 模型，变更则失效
	dim: number;
	complete: boolean; // 是否完整建完（中断则为 false）
	builtAt: number; // ms 时间戳
	chunks: StoredChunk[];
}

export interface RebuildResult {
	files: number;
	skippedFiles: number;
	chunks: number;
	dim: number;
	ms: number;
}

export interface IncrementalResult {
	scanned: number;
	changed: number;
	newFiles: number;
	deleted: number;
	reindexedChunks: number;
	totalChunks: number;
	ms: number;
}

export type ProgressCb = (done: number, total: number, label: string) => void;

export interface VectorStoreOptions {
	path: string; // vault 相对路径，如 .obsidian/plugins/tony-ai-kb-plugin/store.json
	embeddingModel: string;
	batchSize: number;
	roundDecimals: number;
}

const STORE_VERSION = 1;
const DEFAULT_ROUND = 6;

export class VectorStore {
	store: Store | null = null;
	/** 进行中的加载 promise：去重，避免 view 与后台增量同时读 298MB store.json。 */
	private loadPromise: Promise<Store | null> | null = null;

	constructor(
		private readonly app: App,
		private readonly chunker: Chunker,
		private readonly ollama: OllamaClient,
		public opts: VectorStoreOptions,
	) {}

	/** 读盘 → 内存。已加载则直接返回（缓存）；正在加载则复用同一 promise（去重）。 */
	async load(): Promise<Store | null> {
		if (this.store) return this.store;
		if (this.loadPromise) return this.loadPromise;
		this.loadPromise = this.doLoad();
		try {
			return await this.loadPromise;
		} finally {
			this.loadPromise = null;
		}
	}

	private async doLoad(): Promise<Store | null> {
		try {
			if (await this.app.vault.adapter.exists(this.opts.path)) {
				const raw = await this.app.vault.adapter.read(this.opts.path);
				const s = JSON.parse(raw) as Store;
				if (s && typeof s === 'object' && Array.isArray(s.chunks)) {
					this.store = s;
					return s;
				}
			}
		} catch (e) {
			console.warn('[tony-ai-kb] load store failed:', errMsg(e));
		}
		this.store = null;
		return null;
	}

	/** 内存 → 落盘。 */
	async save(): Promise<void> {
		if (!this.store) return;
		await this.app.vault.adapter.write(this.opts.path, JSON.stringify(this.store));
	}

	/** 全量重建：切片 → 批量向量化 → 落盘。 */
	async rebuild(onProgress?: ProgressCb, signal?: AbortSignal): Promise<RebuildResult> {
		const t0 = Date.now();
		const files = this.chunker.listFiles();
		const all: RawChunk[] = [];
		let skippedFiles = 0;

		// 1) 切片全 vault
		for (let i = 0; i < files.length; i++) {
			if (signal?.aborted) throw new Error('已中止');
			try {
				const cs = await this.chunker.chunkFile(files[i]!);
				for (const c of cs) all.push(c);
			} catch (e) {
				skippedFiles++;
				console.warn('[tony-ai-kb] chunk skip:', files[i]!.path, errMsg(e));
			}
			if (onProgress && (i % 10 === 0 || i === files.length - 1)) {
				onProgress(i + 1, files.length, `切片 ${i + 1}/${files.length}`);
			}
		}

		// 2) 批量向量化
		const stored: StoredChunk[] = [];
		let dim = 0;
		const dp = this.opts.roundDecimals ?? DEFAULT_ROUND;
		for (let i = 0; i < all.length; i += this.opts.batchSize) {
			if (signal?.aborted) throw new Error('已中止');
			const batch = all.slice(i, i + this.opts.batchSize);
			const vecs = await this.ollama.embedBatch(batch.map((c) => c.content));
			for (let j = 0; j < batch.length; j++) {
				const v = vecs[j]!;
				if (dim === 0) dim = v.length;
				else if (v.length !== dim) {
					throw new Error(`向量维度不一致：期望 ${dim}，实际 ${v.length}`);
				}
				const c = batch[j]!;
				stored.push({
					...c,
					id: `${c.file}::${c.lineStart}`,
					vector: dp > 0 ? roundVec(v, dp) : v,
				});
			}
			if (onProgress) {
				const done = Math.min(i + this.opts.batchSize, all.length);
				onProgress(done, all.length, `向量化 ${done}/${all.length}`);
			}
		}

		// 3) 落盘
		this.store = {
			version: STORE_VERSION,
			model: this.opts.embeddingModel,
			dim,
			complete: true,
			builtAt: Date.now(),
			chunks: stored,
		};
		await this.save();

		return {
			files: files.length,
			skippedFiles,
			chunks: stored.length,
			dim,
			ms: Date.now() - t0,
		};
	}

	/** 重嵌指定文件：先删该文件旧片段，再切片+批量向量化+回填。 */
	async reindexFiles(files: TFile[], onProgress?: ProgressCb): Promise<{ reindexedChunks: number }> {
		if (!this.store) throw new Error('store 未加载');
		const dp = this.opts.roundDecimals ?? DEFAULT_ROUND;
		let reindexedChunks = 0;
		// 先删旧
		const paths = new Set(files.map((f) => f.path));
		this.store.chunks = this.store.chunks.filter((c) => !paths.has(c.file));

		for (let i = 0; i < files.length; i++) {
			const file = files[i]!;
			let raw: RawChunk[];
			try {
				raw = await this.chunker.chunkFile(file);
			} catch (e) {
				console.warn('[tony-ai-kb] incremental chunk skip:', file.path, errMsg(e));
				continue;
			}
			if (raw.length === 0) continue;
			const vecs = await this.ollama.embedBatch(raw.map((c) => c.content));
			for (let j = 0; j < raw.length; j++) {
				const c = raw[j]!;
				const v = vecs[j]!;
				this.store.chunks.push({
					...c,
					id: `${c.file}::${c.lineStart}`,
					vector: dp > 0 ? roundVec(v, dp) : v,
				});
			}
			reindexedChunks += raw.length;
			if (onProgress) onProgress(i + 1, files.length, `增量重嵌 ${i + 1}/${files.length}`);
		}
		this.store.builtAt = Date.now();
		await this.save();
		return { reindexedChunks };
	}

	/** 增量扫描：比对 mtime 找 变更/新增/删除，只重嵌变化文件。 */
	async incrementalUpdate(onProgress?: ProgressCb, signal?: AbortSignal): Promise<IncrementalResult> {
		const t0 = Date.now();
		if (!this.store) await this.load();
		if (!this.store) throw new Error('store 未就绪，请先 Rebuild index');

		const all = this.chunker.listFiles();
		const storedMtime = new Map<string, number>();
		for (const c of this.store.chunks) {
			if (!storedMtime.has(c.file) || c.mtime > (storedMtime.get(c.file) ?? 0)) {
				storedMtime.set(c.file, c.mtime);
			}
		}

		const currentPaths = new Set<string>();
		const changed: TFile[] = [];
		let newCount = 0;
		for (const f of all) {
			if (signal?.aborted) throw new Error('已中止');
			currentPaths.add(f.path);
			const curM = f.stat?.mtime ?? 0;
			const prev = storedMtime.get(f.path);
			if (prev === undefined) {
				newCount++;
				changed.push(f);
			} else if (prev !== curM) {
				changed.push(f);
			}
		}
		const deleted: string[] = [];
		for (const p of storedMtime.keys()) {
			if (!currentPaths.has(p)) deleted.push(p);
		}
		// 删除已不存在的文件片段
		if (deleted.length > 0) {
			const del = new Set(deleted);
			this.store.chunks = this.store.chunks.filter((c) => !del.has(c.file));
		}

		let reindexedChunks = 0;
		if (changed.length > 0) {
			const r = await this.reindexFiles(changed, onProgress);
			reindexedChunks = r.reindexedChunks;
		} else if (deleted.length > 0) {
			this.store.builtAt = Date.now();
			await this.save();
		}

		return {
			scanned: all.length,
			changed: changed.length,
			newFiles: newCount,
			deleted: deleted.length,
			reindexedChunks,
			totalChunks: this.store.chunks.length,
			ms: Date.now() - t0,
		};
	}
}

/** 舍入到 n 位小数，省 JSON 体积。 */
function roundVec(vec: number[], decimals: number): number[] {
	const f = Math.pow(10, decimals);
	const out = new Array<number>(vec.length);
	for (let i = 0; i < vec.length; i++) out[i] = Math.round(vec[i]! * f) / f;
	return out;
}
