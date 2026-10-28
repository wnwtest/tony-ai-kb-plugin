// 参数调优：用真实 bge-m3 查询向量，扫描 topK 与 KEYWORD_WEIGHT 组合，
// 找让 PDAF 专文进 Top-K 前列的配置。不修改生产代码，只读 store + 临时权重。
import { readFileSync } from 'node:fs';
import { tokenize } from '../src/search';
import type { StoredChunk } from '../src/store';

const STORE_PATH = 'D:/obsidian/.obsidian/plugins/tony-ai-kb-plugin/store.json';
const store = JSON.parse(readFileSync(STORE_PATH, 'utf8')) as { chunks: StoredChunk[] };
const chunks = store.chunks;
const expertFile = 'PDAF对焦(Phase Detection Auto Focus)';

function cosine(a: number[], b: number[]): number {
	const n = Math.min(a.length, b.length);
	let dot = 0, na = 0, nb = 0;
	for (let i = 0; i < n; i++) { dot += a[i]! * b[i]!; na += a[i]! ** 2; nb += b[i]! ** 2; }
	const d = Math.sqrt(na) * Math.sqrt(nb);
	return d === 0 ? 0 : dot / d;
}

// 复制 search.ts 的 BM25（参数化 keyword weight）
function chunkTokens(c: StoredChunk): string[] { return tokenize(`${c.header} ${c.content}`); }
function bm25(qTokens: string[], chunkList: StoredChunk[]): number[] {
	const k1 = 1.5, b = 0.75, N = Math.max(chunkList.length, 1);
	const freqList = chunkList.map((c) => {
		const f = new Map<string, number>(); for (const t of chunkTokens(c)) f.set(t, (f.get(t) ?? 0) + 1); return f;
	});
	const lenList = freqList.map((f) => { let n = 0; for (const v of f.values()) n += v; return n; });
	const avgLen = lenList.reduce((a, x) => a + x, 0) / N || 1;
	const df = new Map<string, number>();
	qTokens.forEach((qt) => { if (df.has(qt)) return; let d = 0; for (const f of freqList) if (f.has(qt)) d++; df.set(qt, d); });
	return chunkList.map((_, i) => {
		const f = freqList[i]!, len = lenList[i]!; let s = 0;
		for (const qt of new Set(qTokens)) {
			const tf = f.get(qt) ?? 0; if (!tf) continue;
			const n = df.get(qt) ?? 0; const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
			s += idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * len / avgLen));
		}
		return s;
	});
}
function norm(arr: number[]): number[] {
	const min = Math.min(...arr), max = Math.max(...arr);
	return max - min < 1e-9 ? arr.map(() => 0.5) : arr.map((v) => (v - min) / (max - min));
}
function hybridSearch(qv: number[], qText: string, kwWeight: number, topK: number) {
	const cos = chunks.map((c) => cosine(qv, c.vector));
	const cosN = norm(cos);
	const qTokens = qText ? tokenize(qText) : [];
	const kw = qTokens.length ? bm25(qTokens, chunks) : cos.map(() => 0);
	const kwN = norm(kw);
	const vw = 1 - kwWeight;
	const scored = chunks.map((c, i) => ({ c, s: vw * cosN[i]! + kwWeight * kwN[i]! }));
	scored.sort((a, b) => b.s - a.s);
	return scored.slice(0, topK);
}

const resp = await fetch('http://192.168.119.219:11434/api/embed', {
	method: 'POST', headers: { 'Content-Type': 'application/json' },
	body: JSON.stringify({ model: 'bge-m3:latest', input: 'camera pdaf的工作原理是什么' }),
});
const j = await resp.json() as { embeddings: number[][] };
const qv = j.embeddings[0]!;
const QUERY = 'camera pdaf的工作原理是什么';

console.log(`查询: "${QUERY}"\n`);
console.log('kwWeight | topK | PDAF专文排名 | Top-5 构成');
console.log('---------|------|-------------|---------');
for (const kw of [0.4, 0.35, 0.3, 0.25, 0.2]) {
	for (const topK of [5, 8]) {
		const hits = hybridSearch(qv, QUERY, kw, topK);
		const rank = hits.findIndex((h) => h.c.file.includes(expertFile));
		const top5 = hits.slice(0, 5).map((h) => h.c.file.includes('Exported image') ? 'img' : h.c.file.includes('013-PDAF') ? '校准' : h.c.file.includes(expertFile) ? '★专文' : '其他').join(',');
		console.log(`  ${kw}   |  ${topK}  | ${rank >= 0 ? '#' + (rank + 1) : '出Top-' + topK}     | ${top5}`);
	}
}

// 也测纯向量（kw=0）作对照
const pure = hybridSearch(qv, '', 0, 8);
console.log(`\n纯向量 topK=8:`);
pure.forEach((h, i) => {
	const star = h.c.file.includes(expertFile) ? ' ← ★PDAF 专文' : '';
	console.log(`  ${i + 1}. ${h.s.toFixed(3)} len=${h.c.content.length} ${h.c.file.slice(0, 50)}${star}`);
});
