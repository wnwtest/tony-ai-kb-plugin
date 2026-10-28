import { strict as assert } from 'node:assert';
import { nodeExecutors } from '../src/nodes';
import type { SearchHit } from '../src/search';
import type { StoredChunk } from '../src/store';

let passed = 0;
let failed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
	try { await fn(); passed++; console.log(`  ✅ ${name}`); }
	catch (e) { failed++; console.error(`  ❌ ${name}`); console.error(e); process.exitCode = 1; }
}

function mkHit(id: string, content: string, score = 0.5): SearchHit {
	const chunk = {
		id, file: `f${id}.md`, header: `h${id}`, content,
		lineStart: 1, mtime: 0, vector: [],
	} as StoredChunk;
	return { chunk, score };
}

const runContext = async (hits: SearchHit[], maxChars: number) => {
	const out = await nodeExecutors.context(
		{ chunks: hits },
		{ maxChars },
		{} as never, // context 节点不读 ctx
	);
	return { context: String(out.context), citations: out.citations as SearchHit[] };
};

// 复现 PDAF bug：Top-1 是 8835 字超大 chunk，后面是 3146 字 PDAF 专文
const BIG = 'X'.repeat(8835);
const PDAF = 'P'.repeat(3146);
const SMALL = 's'.repeat(300);

void (async () => {
await check('Top-1 超长不清空 context：跳过它，PDAF 专文进入', async () => {
	const hits = [mkHit('big', BIG, 0.62), mkHit('img1', SMALL, 0.59), mkHit('img2', SMALL, 0.59), mkHit('pdaf', PDAF, 0.59), mkHit('small', SMALL, 0.58)];
	const { context, citations } = await runContext(hits, 6000);
	assert.ok(context.length > 0, 'context 不能为空');
	assert.ok(context.includes('hpdaf'), 'PDAF 专文必须进入 context');
	assert.ok(!context.includes('hbig'), '超长 Top-1 应被跳过');
	// 引用列表也不含被跳过的 big
	assert.ok(!citations.some((c) => c.chunk.id === 'big'));
});

await check('旧逻辑 break 会清空：新逻辑保证非空（只要有一条能放下）', async () => {
	const hits = [mkHit('big', BIG, 0.9), mkHit('s1', SMALL, 0.5)];
	const { context } = await runContext(hits, 6000);
	assert.ok(context.includes('hs1'), '跳过 big 后 s1 应进入');
});

await check('全部超长时兜底截断 Top-1，context 非空', async () => {
	const hits = [mkHit('big1', BIG, 0.9), mkHit('big2', BIG, 0.8)];
	const { context, citations } = await runContext(hits, 6000);
	assert.ok(context.length > 0, '兜底截断后 context 非空');
	assert.equal(citations.length, 1);
	assert.equal(citations[0]!.chunk.id, 'big1');
	assert.ok(context.length <= 6000, '不超过 maxChars');
});

await check('正常情况：按顺序填满 maxChars 后停止', async () => {
	const hits = [mkHit('a', 'a'.repeat(2000)), mkHit('b', 'b'.repeat(2000)), mkHit('c', 'c'.repeat(2000)), mkHit('d', 'd'.repeat(2000))];
	const { context, citations } = await runContext(hits, 5000);
	// 5000 预算：a(2010) + b(2010) = 4020，c 会超 → 跳过，d 超 → 跳过
	assert.ok(context.includes('ha') && context.includes('hb'));
	assert.ok(!context.includes('hc'));
	assert.equal(citations.length, 2);
});

await check('去重：同 file+lineStart 只保留一条', async () => {
	const dup = mkHit('x', 'content');
	const hits = [dup, { chunk: dup.chunk, score: 0.4 }];
	const { citations } = await runContext(hits, 6000);
	assert.equal(citations.length, 1);
});

await check('空 hits → 空 context', async () => {
	const { context, citations } = await runContext([], 6000);
	assert.equal(context, '');
	assert.equal(citations.length, 0);
});

console.log(`\n${passed} passed${failed ? `, ${failed} failed` : ''}`);
})();
