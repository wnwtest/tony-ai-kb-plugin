import { strict as assert } from 'node:assert';
import { migratePipeline, type NodeDef, type Pipeline } from '../src/pipeline';

let passed = 0;
function check(name: string, fn: () => void): void {
	try { fn(); passed++; console.log(`  ✅ ${name}`); }
	catch (e) { console.error(`  ❌ ${name}`); console.error(e); process.exitCode = 1; }
}

/** 旧版 DSL：retrieve 缺 queryText 连线（混合检索上线前的盘上文件）。 */
function oldDsl(): Pipeline {
	const raw = `{
  "version": 1,
  "nodes": [
    { "id": "q",        "type": "input",    "out": ["query"] },
    { "id": "embed",    "type": "embed",    "in": { "text": "{{q.query}}" }, "out": ["vector"] },
    { "id": "retrieve", "type": "retrieve", "params": { "topK": 5 }, "in": { "vector": "{{embed.vector}}" }, "out": ["chunks"] },
    { "id": "ctx",      "type": "context",  "in": { "chunks": "{{retrieve.chunks}}" }, "out": ["context", "citations"] },
    { "id": "chat",     "type": "chat",     "in": { "context": "{{ctx.context}}", "query": "{{q.query}}" }, "out": ["answer"] },
    { "id": "output",   "type": "output",   "in": { "answer": "{{chat.answer}}" }, "out": ["answer"] }
  ]
}`;
	return JSON.parse(raw) as Pipeline;
}

const retrieveOf = (def: Pipeline): NodeDef => {
	const r = def.nodes.find((n) => n.type === 'retrieve');
	if (!r) throw new Error('no retrieve node');
	return r;
};

check('旧 DSL retrieve 缺 queryText → 自动补 {{q.query}}', () => {
	const def = oldDsl();
	assert.ok(migratePipeline(def), '应报告发生变更');
	const retrieve = retrieveOf(def);
	assert.equal(retrieve.in!.queryText, '{{q.query}}');
	assert.equal(retrieve.in!.vector, '{{embed.vector}}', '已有连线不动');
});

check('新版 DSL 已有 queryText → 不变更', () => {
	const def = oldDsl();
	retrieveOf(def).in!.queryText = '{{q.query}}';
	assert.equal(migratePipeline(def), false, '不应报告变更');
});

check('用户自定义 queryText 被尊重（字面量）', () => {
	const def = oldDsl();
	retrieveOf(def).in!.queryText = 'pdaf 对焦原理'; // 用户显式填的检索词
	assert.equal(migratePipeline(def), false);
	assert.equal(retrieveOf(def).in!.queryText, 'pdaf 对焦原理');
});

check('branch 子流里的 retrieve 也会被迁移', () => {
	const def = oldDsl();
	const elseNodes: NodeDef[] = [
		{ id: 'r2', type: 'retrieve', params: { topK: 3 }, in: { vector: '{{embed.vector}}' }, out: ['chunks'] },
	];
	def.nodes.push({
		id: 'br', type: 'branch',
		branches: { condition: 'has_results', then: [], else: elseNodes },
	});
	assert.ok(migratePipeline(def));
	assert.equal(elseNodes[0]!.in!.queryText, '{{q.query}}');
});

check('无 input 节点 → 不变更不崩溃', () => {
	const def: Pipeline = { version: 1, nodes: [{ id: 'r', type: 'retrieve', in: {}, out: ['chunks'] }] };
	assert.equal(migratePipeline(def), false);
});

console.log(`\n${passed} passed`);
