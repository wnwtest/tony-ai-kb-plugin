// 端到端验证：真实 bge-m3 查询向量 + 真实 store + 部署的 search()/context 节点，
// 确认"问 camera pdaf 的工作原理答不知道"已修复——核心是 context 节点不再因超大 chunk 清空。
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
const pdafExpert = chunks.find((c) => c.file.includes('PDAF对焦(Phase Detection Auto Focus)'));
if (!pdafExpert) throw new Error('PDAF 专文不在 store');

function cosine(a: number[], b: number[]): number {
	const n = Math.min(a.length, b.length);
	let dot = 0, na = 0, nb = 0;
	for (let i = 0; i < n; i++) { dot += a[i]! * b[i]!; na += a[i]! ** 2; nb += b[i]! ** 2; }
	const d = Math.sqrt(na) * Math.sqrt(nb);
	return d === 0 ? 0 : dot / d;
}

async function main(): Promise<void> {
const resp = await fetch(`${OLLAMA}/api/embed`, {
	method: 'POST',
	headers: { 'Content-Type': 'application/json' },
	body: JSON.stringify({ model: 'bge-m3:latest', input: QUERY }),
});
if (!resp.ok) throw new Error(`Ollama embed ${resp.status}: ${await resp.text()}`);
const j = await resp.json() as { embeddings: number[][] };
const queryVec = j.embeddings[0]!;
console.log(`查询: "${QUERY}"  | bge-m3 维度: ${queryVec.length}`);
console.log('tokenize:', tokenize(QUERY).slice(0, 12).join(', '), '...');
console.log(`PDAF 专文与查询余弦: ${cosine(queryVec, pdafExpert.vector).toFixed(4)}\n`);

const expertName = 'PDAF对焦(Phase Detection Auto Focus)';
const showTop = (label: string, hits: ReturnType<typeof search>): void => {
	console.log(`[${label}] Top-${hits.length}:`);
	hits.forEach((h, i) => {
		const star = h.chunk.file.includes(expertName) ? ' ← PDAF 专文' : '';
		console.log(`  ${i + 1}. ${h.score.toFixed(3)} len=${h.chunk.content.length} ${h.chunk.file.slice(0, 52)}${star}`);
	});
};

// 纯向量（旧 DSL 行为）
const pureVec = search(queryVec, '', chunks, 8);
showTop('纯向量', pureVec);

// 混合检索（修复后 DSL：retrieve 带 queryText）
const hybrid = search(queryVec, QUERY, chunks, 8);
showTop('混合检索', hybrid);

// ── 核心验证：context 节点不再因超大 Top-1 清空 ──
// 旧 bug：纯向量 Top-1 是 8835 字的 013-PDAF校准，seg > maxChars → break → context 空 → "不知道"
const ctxPure = await nodeExecutors.context({ chunks: pureVec }, { maxChars: 6000 }, {} as never);
const ctxPureStr = String(ctxPure.context);
const ctxHybrid = await nodeExecutors.context({ chunks: hybrid }, { maxChars: 6000 }, {} as never);
const ctxHybridStr = String(ctxHybrid.context);

console.log(`\n[context 节点 · 纯向量输入] 长度=${ctxPureStr.length}`);
console.log(`  含 PDAF 专文: ${ctxPureStr.includes('Phase Detection Auto Focus')}`);
console.log(`[context 节点 · 混合输入] 长度=${ctxHybridStr.length}`);
console.log(`  含 PDAF 专文: ${ctxHybridStr.includes('Phase Detection Auto Focus')}`);

// 核心断言：context 必须非空（修复"不知道"的关键）
assert.ok(ctxPureStr.length > 200, '纯向量 context 不能为空（旧 bug：遇超大 chunk break 清空 → 不知道）');
assert.ok(ctxHybridStr.length > 200, '混合 context 不能为空');
// 至少一种检索路径把 PDAF 专文送进 context
const pdafInEither = ctxPureStr.includes('Phase Detection Auto Focus') || ctxHybridStr.includes('Phase Detection Auto Focus');
assert.ok(pdafInEither, '至少一条路径应把 PDAF 专文送入 context');
console.log('\n✅ 端到端验证通过：context 非空，PDAF 相关信息能送达 LLM');
}
void main().catch((e) => { console.error(e); process.exit(1); });
