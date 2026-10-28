// 端到端：真实 bge-m3 查询向量 + 真实 store + 完整流水线（retrieve→rerank→context），
// 确认引用质量评估 + MMR 多样化后，PDAF 专文进入最终 context，且引用列表多样化。
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { search, tokenize } from '../src/search';
import { nodeExecutors } from '../src/nodes';
import type { StoredChunk } from '../src/store';

const OLLAMA = 'http://192.168.119.219:11434';
const STORE_PATH = 'D:/obsidian/.obsidian/plugins/tony-ai-kb-plugin/store.json';
const QUERY = 'camera pdaf的工作原理是什么';

const store = JSON.parse(readFileSync(STORE_PATH, 'utf8')) as { chunks: StoredChunk[] };
const chunks = store.chunks;

async function main(): Promise<void> {
	const resp = await fetch(`${OLLAMA}/api/embed`, {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ model: 'bge-m3:latest', input: QUERY }),
	});
	const j = await resp.json() as { embeddings: number[][] };
	const qv = j.embeddings[0]!;
	console.log(`查询: "${QUERY}"\n`);

	// retrieve topK=12（候选池）
	const retrieved = search(qv, QUERY, chunks, 12);
	console.log('[retrieve topK=12]:');
	retrieved.forEach((h, i) => {
		const tag = h.chunk.file.includes('PDAF对焦(Phase Detection') ? ' ← ★专文'
			: h.chunk.file.includes('Exported image') ? ' img'
			: h.chunk.file.includes('013-PDAF') ? ' 校准(超长)' : '';
		console.log(`  ${i + 1}. ${h.score.toFixed(3)} len=${String(h.chunk.content.length).padStart(4)} ${h.chunk.file.slice(0, 48)}${tag}`);
	});

	// rerank MMR topK=6 lambda=0.7
	const reranked = (await nodeExecutors.rerank(
		{ chunks: retrieved, queryText: QUERY },
		{ strategy: 'mmr', topK: 6, lambda: 0.7 },
		{} as never,
	)).chunks as ReturnType<typeof search>;
	console.log('\n[rerank MMR topK=6]:');
	reranked.forEach((h, i) => {
		const tag = h.chunk.file.includes('PDAF对焦(Phase Detection') ? ' ← ★专文' : h.chunk.file.includes('Exported image') ? ' img' : '';
		console.log(`  ${i + 1}. q=${h.score.toFixed(3)} len=${String(h.chunk.content.length).padStart(4)} ${h.chunk.file.slice(0, 48)}${tag}`);
	});

	// context
	const ctx = await nodeExecutors.context({ chunks: reranked }, { maxChars: 6000 }, {} as never);
	const ctxStr = String(ctx.context);
	console.log(`\n[context] 长度=${ctxStr.length}`);
	console.log(`  含 PDAF 专文(Phase Detection Auto Focus): ${ctxStr.includes('Phase Detection Auto Focus')}`);

	const expertInRerank = reranked.some((h) => h.chunk.file.includes('PDAF对焦(Phase Detection'));
	assert.ok(expertInRerank, 'rerank 后 PDAF 专文必须在 Top-6（引用质量评估应保住它）');
	assert.ok(ctxStr.length > 200, 'context 非空');
	assert.ok(ctxStr.includes('Phase Detection Auto Focus'), 'PDAF 专文内容必须进入 context');

	// 多样化检查：rerank 后不应全是图片旁车
	const imgCount = reranked.filter((h) => h.chunk.file.includes('Exported image')).length;
	assert.ok(imgCount < 6, `rerank 后不应全是图片（应留位给实质笔记），图数=${imgCount}`);
	console.log(`\n✅ 端到端通过：专文入选 rerank Top-6 并进入 context，图片旁车 ${imgCount}/6（多样化生效）`);
}
void main().catch((e) => { console.error(e); process.exit(1); });
