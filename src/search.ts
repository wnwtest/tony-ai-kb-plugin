import { cosine } from './ollama';
import type { StoredChunk } from './store';

/**
 * 检索：query 向量与库内所有 chunk 向量做余弦相似度，取 Top-K。
 * 纯函数，不依赖 Obsidian API，便于单测。
 * 向量在入库时已 L2 归一化，cosine 等价点积；这里仍用通用 cosine 兼容未归一化输入。
 */

export interface SearchHit {
	chunk: StoredChunk;
	score: number;
}

export function search(queryVec: number[], chunks: StoredChunk[], topK = 5): SearchHit[] {
	const hits: SearchHit[] = [];
	for (const chunk of chunks) {
		hits.push({ chunk, score: cosine(queryVec, chunk.vector) });
	}
	hits.sort((a, b) => b.score - a.score);
	return hits.slice(0, Math.max(1, topK));
}
