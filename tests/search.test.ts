import { strict as assert } from 'node:assert';
import { search, tokenize } from '../src/search';
import type { StoredChunk } from '../src/store';

let passed = 0;
function check(name: string, fn: () => void): void {
	try { fn(); passed++; console.log(`  ✅ ${name}`); }
	catch (e) { console.error(`  ❌ ${name}`); console.error(e); process.exitCode = 1; }
}

// ── tokenize ──
check('tokenize: 英文+中文2gram', () => {
	const t = tokenize('camera pdaf的工作原理');
	assert.ok(t.includes('camera'));
	assert.ok(t.includes('pdaf'));
	assert.ok(t.includes('工作')); // 中文 2-gram
	assert.ok(t.includes('原理'));
});
check('tokenize: 纯英文', () => {
	const t = tokenize('QNN model quantization');
	assert.deepEqual(t, ['qnn', 'model', 'quantization']);
});
check('tokenize: 数字token', () => {
	const t = tokenize('ros2 humble');
	assert.ok(t.includes('ros2'));
});

// ── 混合检索：模拟 PDAF 案例 ──
// 构造假向量：pdaf 笔记的向量与查询向量余弦低（模拟语义漂移），靠 BM25 拉回
function mkChunk(id: string, content: string, vec: number[]): StoredChunk {
	return { id, file: `f${id}.md`, header: `h${id}`, content, lineStart: 1, mtime: 0, vector: vec };
}
// 查询向量（简化 4 维）
const qv = [0.9, 0.1, 0.0, 0.0];
// 语义相似的干扰项（高余弦：讲相机原理但没 pdaf）
const distractor = mkChunk('d1', '相机成像原理详解，镜头与传感器', [0.95, 0.2, 0.05, 0.0]);
// PDAF 专文（低余弦=语义漂移，但含 pdaf/相位 关键词）
const pdafNote = mkChunk('p1', 'PDAF：Phase Detection Auto-focus 相位对焦。相位对焦原理：根据CIS像素相位差判断镜头移动向量', [0.1, 0.9, 0.3, 0.2]);
const chunks = [distractor, pdafNote];

check('混合检索: pdaf 关键词把 PDAF 专文拉回前列', () => {
	const hits = search(qv, 'camera pdaf的工作原理是什么', chunks, 2);
	// BM25 通道 pdaf 专文必须命中（第1或第2且分数可观）
	const rank = hits.findIndex((h) => h.chunk.id === 'p1');
	assert.ok(rank >= 0 && rank <= 1, `p1 rank=${rank}`);
});
check('混合检索: 纯向量退化（无 queryText）仍按余弦', () => {
	const hits = search(qv, '', chunks, 2);
	assert.equal(hits[0]!.chunk.id, 'd1'); // 余弦最高
});
check('BM25 大幅提升含术语文档得分', () => {
	const withQ = search(qv, 'pdaf', chunks, 2).find((h) => h.chunk.id === 'p1')!.score;
	const noQ = search(qv, '', chunks, 2).find((h) => h.chunk.id === 'p1')!.score;
	assert.ok(withQ > noQ, `withQ=${withQ} noQ=${noQ}`);
});

console.log(`\n${passed} passed`);
