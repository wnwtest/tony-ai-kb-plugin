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

function mkHit(id: string, content: string, score: number, vec: number[]): SearchHit {
	const chunk = { id, file: `f${id}.md`, header: `h${id}`, content, lineStart: 1, mtime: 0, vector: vec } as StoredChunk;
	return { chunk, score };
}

const runRerank = async (hits: SearchHit[], params: Record<string, unknown> = {}, queryText = 'camera pdaf的工作原理') => {
	const out = await nodeExecutors.rerank(
		{ chunks: hits, queryText },
		{ strategy: 'mmr', topK: 6, lambda: 0.7, ...params },
		{} as never,
	);
	return out.chunks as SearchHit[];
};

// 场景：6 张近乎雷同的图片旁车（短、术语密集、向量相近）+ 1 篇 PDAF 专文（长、高质量、向量与旁车不同）
const IMG_VEC = [0.9, 0.1, 0.0];
const EXPERT_VEC = [0.1, 0.95, 0.2];
// 图片旁车：短、术语密集、向量相近、检索分中等
const imgHits = Array.from({ length: 6 }, (_, i) => mkHit(`img${i}`, `图片描述 PDAF 对焦 自动对焦 算法 ${i}`, 0.80 + i * 0.01, IMG_VEC));
// 专文：检索分最高（真实数据 expert rel ~0.92，高于图）、内容长、查询术语覆盖高
const EXPERT_BODY = 'PDAF 相位检测自动对焦工作原理：根据 CIS 像素相位差判断镜头移动向量，实现快速对焦。'.repeat(8);
const expert = mkHit('expert', EXPERT_BODY, 0.92, EXPERT_VEC);
const allHits = [...imgHits, expert];

void (async () => {
await check('MMR 不因同源一刀切：高质量专文必入选', async () => {
	const out = await runRerank(allHits, { topK: 3 });
	const ids = out.map((h) => h.chunk.id);
	assert.ok(ids.includes('expert'), `专文必须入选，实际: ${ids.join(',')}`);
});

await check('MMR 去重：雷同图片旁车不全选，留出位置给专文', async () => {
	// topK=3，6 张雷同图 + 1 专文。MMR 应选 ~1-2 张图 + 专文，而非 3 张雷同图
	const out = await runRerank(allHits, { topK: 3 });
	const imgCount = out.filter((h) => h.chunk.id.startsWith('img')).length;
	assert.ok(imgCount <= 2, `雷同图不应全选（应≤2），实际 ${imgCount}`);
});

await check('质量主导：lambda=1 时纯按质量排序（不去重）', async () => {
	// lambda=1 → 多样性权重 0 → 完全按 quality 排序
	// 专文 quality 高（长+覆盖率高），应排第一
	const out = await runRerank(allHits, { topK: 3, lambda: 1.0 });
	assert.equal(out[0]!.chunk.id, 'expert', 'lambda=1 时质量最高的专文应排第一');
});

await check('多样性主导：lambda=0 时优先选不同的', async () => {
	// lambda=0 → 纯多样性：第一条随机/首条，后续都选与已选最不同的
	// 第一条按实现是 remaining 第一个（img0），第二条应选与 img0 最不同的 = expert（向量不同）
	const out = await runRerank(allHits, { topK: 2, lambda: 0.0 });
	assert.ok(out.some((h) => h.chunk.id === 'expert'), 'lambda=0 时专文（向量独特）应入选');
});

await check('引用质量分：长内容+高覆盖 > 短内容+低覆盖', async () => {
	// 两条 score 相同的 hit，专文（长+覆盖多）quality 应高于短图
	const a = mkHit('short', 'pdaf', 0.8, IMG_VEC);
	const b = mkHit('long', 'camera pdaf 相位对焦 工作原理 相位差 计算 对焦点', 0.8, EXPERT_VEC);
	const out = await runRerank([a, b], { topK: 2, lambda: 1.0 });
	assert.equal(out[0]!.chunk.id, 'long', '长+高覆盖的 quality 应更高');
});

await check('候选不足 topK：按 quality 排序返回全部，不丢内容', async () => {
	const out = await runRerank([imgHits[0]!, imgHits[1]!], { topK: 6 });
	assert.equal(out.length, 2, '候选不足时应全部返回');
});

await check('keyword 策略：按查询术语命中数排序', async () => {
	const low = mkHit('low', '无关内容', 0.9, IMG_VEC);
	const high = mkHit('high', 'camera pdaf 对焦 原理 相位', 0.5, EXPERT_VEC);
	const out = await runRerank([low, high], { strategy: 'keyword', topK: 2 });
	assert.equal(out[0]!.chunk.id, 'high', 'keyword 策略应让术语命中多的排前');
});

await check('length 策略：按内容长度排序', async () => {
	const short = mkHit('s', '短', 0.9, IMG_VEC);
	const long = mkHit('l', '长'.repeat(500), 0.5, EXPERT_VEC);
	const out = await runRerank([short, long], { strategy: 'length', topK: 2 });
	assert.equal(out[0]!.chunk.id, 'l');
});

await check('空输入不崩溃', async () => {
	const out = await runRerank([], { topK: 6 });
	assert.equal(out.length, 0);
});

await check('minRel 相关性下限：过滤低分 tangential 长文', async () => {
	// 一条相关短文（检索分高）+ 一条 tangential 长文（检索分低、但内容长丰富度高）
	const relevant = mkHit('rel', 'camera pdaf 对焦 原理 相位差', 0.85, EXPERT_VEC);
	const tangential = mkHit('tan', '压力测试 稳定性 长文档'.repeat(50), 0.20, IMG_VEC);
	// minRel=0.3：tangential(0.20) 被过滤，只剩 relevant
	const out = await runRerank([relevant, tangential], { topK: 2, minRel: 0.3 });
	const ids = out.map((h) => h.chunk.id);
	assert.ok(!ids.includes('tan'), `tangential 长文应被 minRel 过滤，实际入选: ${ids.join(',')}`);
	assert.ok(ids.includes('rel'));
});

await check('minRel 全部低于下限时回退，不返回空', async () => {
	// 两条都低于 minRel → 回退到原候选，按 MMR 选
	const a = mkHit('a', '内容', 0.10, IMG_VEC);
	const b = mkHit('b', '内容', 0.15, EXPERT_VEC);
	const out = await runRerank([a, b], { topK: 2, minRel: 0.3 });
	assert.equal(out.length, 2, '全部低于下限时应回退返回全部');
});

console.log(`\n${passed} passed${failed ? `, ${failed} failed` : ''}`);
})();
