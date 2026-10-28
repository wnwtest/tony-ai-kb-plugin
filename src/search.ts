import type { StoredChunk } from './store';

/** 余弦相似度（本地实现，避免依赖 ollama.ts→obsidian 的链，便于纯 node 单测）。 */
function cosine(a: number[], b: number[]): number {
	const n = Math.min(a.length, b.length);
	let dot = 0, na = 0, nb = 0;
	for (let i = 0; i < n; i++) {
		const av = a[i]!, bv = b[i]!;
		dot += av * bv; na += av * av; nb += bv * bv;
	}
	const d = Math.sqrt(na) * Math.sqrt(nb);
	return d === 0 ? 0 : dot / d;
}

/**
 * 混合检索（对标 Dify hybrid）：向量余弦 + BM25 关键词得分加权融合。
 * 中英统一 token 化：英文/数字连续串为独立 token；中文按 2-gram 切分。
 * 解决中英混合查询（"camera pdaf的工作原理"）里术语被口语稀释导致漏检的问题——
 * BM25 对 token 精确匹配，pdaf/量化/对焦 无论 embedding 语义怎么漂移都能命中。
 * 纯 TS 实现，无分词库依赖。
 */

export interface SearchHit {
	chunk: StoredChunk;
	score: number;
}

// ───────── token 化（中英统一） ─────────

/** 提取 token：英文/数字连续串（≥2字符） + 中文 2-gram。 */
export function tokenize(text: string): string[] {
	const tokens: string[] = [];
	// 英文/数字/下划线/点 连续串
	const latin = text.match(/[A-Za-z][A-Za-z0-9_.-]+|\d+/g) ?? [];
	for (const t of latin) {
		tokens.push(t.toLowerCase());
	}
	// 中文 2-gram（连续汉字滑窗）
	const han = text.match(/[一-鿿]+/g) ?? [];
	for (const seg of han) {
		if (seg.length === 1) { tokens.push(seg); continue; }
		for (let i = 0; i + 1 < seg.length; i++) {
			tokens.push(seg.slice(i, i + 2));
		}
	}
	return tokens;
}

/** chunk 关键词集合缓存（WeakMap by array identity，store 重建后自动失效）。 */
const tokenCache = new WeakMap<object, Map<string, number>>();

function chunkTokenFreqs(chunk: StoredChunk): Map<string, number> {
	const cached = tokenCache.get(chunk as unknown as object);
	if (cached) return cached;
	const tokens = tokenize(`${chunk.header} ${chunk.content}`);
	const freqs = new Map<string, number>();
	for (const t of tokens) freqs.set(t, (freqs.get(t) ?? 0) + 1);
	tokenCache.set(chunk as unknown as object, freqs);
	return freqs;
}

// ───────── BM25 ─────────

/**
 * BM25 打分（对每个 chunk 的 token 频率表）。
 * k1=1.5, b=0.75 经典参数。idf 按包含该 token 的 chunk 数估算（无全局索引，用候选集近似）。
 */
function bm25Scores(
	queryTokens: string[],
	chunks: StoredChunk[],
): number[] {
	const k1 = 1.5;
	const b = 0.75;
	const N = Math.max(chunks.length, 1);

	// 每 chunk 的 token 频率与长度
	const freqList = chunks.map((c) => chunkTokenFreqs(c));
	const lenList = freqList.map((f) => {
		let n = 0; for (const v of f.values()) n += v; return n;
	});
	const avgLen = lenList.reduce((a, x) => a + x, 0) / N || 1;

	// df：包含各 query token 的 chunk 数
	const df = new Map<string, number>();
	queryTokens.forEach((qt) => {
		if (df.has(qt)) return;
		let d = 0;
		for (const f of freqList) if (f.has(qt)) d++;
		df.set(qt, d);
	});

	const scores: number[] = [];
	for (let i = 0; i < chunks.length; i++) {
		const f = freqList[i]!;
		const len = lenList[i]!;
		let s = 0;
		for (const qt of new Set(queryTokens)) {
			const tf = f.get(qt) ?? 0;
			if (tf === 0) continue;
			const n = df.get(qt) ?? 0;
			const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
			s += idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * len / avgLen));
		}
		scores.push(s);
	}
	return scores;
}

// ───────── 混合检索 ─────────

/** 向量权重：0.6 语义 + 0.4 关键词（Dify 默认 hybrid 常用 0.7/0.3~0.5/0.5 区间，取中）。 */
export const VECTOR_WEIGHT = 0.6;
export const KEYWORD_WEIGHT = 0.4;

/**
 * 混合检索 Top-K。
 * 仅向量（queryVec 为空数组）时退化为纯语义检索。
 */
export function search(queryVec: number[], queryText: string, chunks: StoredChunk[], topK = 5): SearchHit[] {
	if (chunks.length === 0) return [];
	const cosScores: number[] = [];
	for (const c of chunks) cosScores.push(queryVec.length ? cosine(queryVec, c.vector) : 0);
	const queryTokens = queryText ? tokenize(queryText) : [];
	const kwScores = queryTokens.length ? bm25Scores(queryTokens, chunks) : cosScores.map(() => 0);

	// 归一化到 0–1（各自 min-max），再加权
	const norm = (arr: number[]): number[] => {
		const min = Math.min(...arr); const max = Math.max(...arr);
		return max - min < 1e-9 ? arr.map(() => 0.5) : arr.map((v) => (v - min) / (max - min));
	};
	const cosN = norm(cosScores);
	const kwN = norm(kwScores);

	const hits: SearchHit[] = chunks.map((chunk, i) => ({
		chunk,
		score: VECTOR_WEIGHT * cosN[i]! + KEYWORD_WEIGHT * kwN[i]!,
	}));
	hits.sort((a, b) => b.score - a.score);
	return hits.slice(0, Math.max(1, topK));
}
