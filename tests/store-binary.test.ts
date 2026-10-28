// 验证二进制向量存储：save/load 往返精度 + 旧格式（向量内嵌 JSON）自动迁移到 store.bin。
// 用内存 mock adapter，不依赖 Obsidian。
import { strict as assert } from 'node:assert';
import { VectorStore, type Store, type StoredChunk } from '../src/store';

let passed = 0;
let failed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
	try { await fn(); passed++; console.log(`  ✅ ${name}`); }
	catch (e) { failed++; console.error(`  ❌ ${name}`); console.error(e); process.exitCode = 1; }
}

/** 内存 mock adapter：实现 read/write/readBinary/writeBinary/exists。 */
class MemAdapter {
	files = new Map<string, string>();
	bins = new Map<string, ArrayBuffer>();
	async exists(path: string): Promise<boolean> { return this.files.has(path) || this.bins.has(path); }
	async read(path: string): Promise<string> { return this.files.get(path) ?? ''; }
	async write(path: string, data: string): Promise<void> { this.files.set(path, data); }
	async readBinary(path: string): Promise<ArrayBuffer> { return this.bins.get(path) ?? new ArrayBuffer(0); }
	async writeBinary(path: string, data: ArrayBuffer): Promise<void> { this.bins.set(path, data); }
}

function mkStore(): Store {
	const chunks: StoredChunk[] = [
		{ id: 'a::1', file: 'a.md', header: 'ha', content: '内容A PDAF 对焦', lineStart: 1, mtime: 100, vector: [0.12, -0.34, 0.56, 0.78] },
		{ id: 'b::1', file: 'b.md', header: 'hb', content: '内容B 相位差', lineStart: 1, mtime: 200, vector: [-0.11, 0.22, -0.33, 0.44] },
		{ id: 'c::5', file: 'c.md', header: 'hc', content: '内容C 镜头', lineStart: 5, mtime: 300, vector: [0.91, 0.82, 0.73, 0.64] },
	];
	return { version: 1, model: 'bge-m3', dim: 4, complete: true, builtAt: 1234567, chunks };
}

const approx = (a: number, b: number): boolean => Math.abs(a - b) < 1e-5;

void (async () => {
await check('save 写出 store.json(无向量) + store.bin', async () => {
	const adapter = new MemAdapter();
	const st = new VectorStore({ vault: { adapter } } as never, {} as never, {} as never, { path: 'store.json', embeddingModel: 'bge-m3', batchSize: 8, roundDecimals: 6 });
	st.store = mkStore();
	await st.save();
	assert.ok(adapter.files.has('store.json'), 'store.json 写出');
	assert.ok(adapter.bins.has('store.bin'), 'store.bin 写出');
	// 元数据 JSON 不含 vector 字段
	const meta = JSON.parse(adapter.files.get('store.json')!);
	assert.equal(meta.chunks[0].vector, undefined, '元数据 chunk 不应含 vector');
	assert.equal(meta.dim, 4);
	// 二进制大小：3 chunks × 4 dim × 4 bytes = 48 bytes
	assert.equal(adapter.bins.get('store.bin')!.byteLength, 48);
});

await check('load 从 store.bin 还原向量（Float32 精度内）', async () => {
	const adapter = new MemAdapter();
	const st = new VectorStore({ vault: { adapter } } as never, {} as never, {} as never, { path: 'store.json', embeddingModel: 'bge-m3', batchSize: 8, roundDecimals: 6 });
	st.store = mkStore();
	await st.save();
	// 清内存后重新加载
	const orig = st.store!;
	st.store = null;
	const loaded = await st.load();
	assert.ok(loaded);
	assert.equal(loaded!.chunks.length, 3);
	for (let i = 0; i < 3; i++) {
		assert.equal(loaded!.chunks[i]!.file, orig.chunks[i]!.file);
		assert.equal(loaded!.chunks[i]!.content, orig.chunks[i]!.content);
		assert.equal(loaded!.chunks[i]!.vector.length, 4);
		for (let j = 0; j < 4; j++) {
			assert.ok(approx(loaded!.chunks[i]!.vector[j]!, orig.chunks[i]!.vector[j]!), `chunk${i}[${j}] ${loaded!.chunks[i]!.vector[j]} vs ${orig.chunks[i]!.vector[j]}`);
		}
	}
});

await check('旧格式自动迁移：向量内嵌 JSON → 迁移到 store.bin', async () => {
	const adapter = new MemAdapter();
	// 旧格式 store.json：向量在 chunk.vector 里（内嵌）
	const legacy = mkStore();
	adapter.files.set('store.json', JSON.stringify(legacy));
	assert.ok(!adapter.bins.has('store.bin'), '迁移前无 store.bin');
	const st = new VectorStore({ vault: { adapter } } as never, {} as never, {} as never, { path: 'store.json', embeddingModel: 'bge-m3', batchSize: 8, roundDecimals: 6 });
	const loaded = await st.load();
	assert.ok(loaded);
	// 迁移后 store.bin 应存在
	assert.ok(adapter.bins.has('store.bin'), '迁移后应写出 store.bin');
	// 元数据 JSON 应已剥离 vector
	const meta = JSON.parse(adapter.files.get('store.json')!);
	assert.equal(meta.chunks[0].vector, undefined, '迁移后元数据应剥离 vector');
	// 向量仍正确（从迁移后的 .bin 或内存读取）
	assert.equal(loaded!.chunks[0]!.vector.length, 4);
	assert.ok(approx(loaded!.chunks[0]!.vector[0]!, 0.12));
});

await check('迁移后第二次 load 走 store.bin（快路径）', async () => {
	const adapter = new MemAdapter();
	const legacy = mkStore();
	adapter.files.set('store.json', JSON.stringify(legacy));
	const st = new VectorStore({ vault: { adapter } } as never, {} as never, {} as never, { path: 'store.json', embeddingModel: 'bge-m3', batchSize: 8, roundDecimals: 6 });
	await st.load(); // 触发迁移
	st.store = null; // 清缓存
	const loaded = await st.load(); // 第二次，走 .bin
	assert.ok(loaded);
	assert.equal(loaded!.chunks.length, 3);
	assert.ok(approx(loaded!.chunks[2]!.vector[0]!, 0.91));
	assert.ok(approx(loaded!.chunks[2]!.vector[3]!, 0.64));
});

await check('空 store 不崩溃', async () => {
	const adapter = new MemAdapter();
	const st = new VectorStore({ vault: { adapter } } as never, {} as never, {} as never, { path: 'store.json', embeddingModel: 'bge-m3', batchSize: 8, roundDecimals: 6 });
	st.store = { version: 1, model: 'bge-m3', dim: 4, complete: true, builtAt: 0, chunks: [] };
	await st.save();
	st.store = null;
	const loaded = await st.load();
	assert.ok(loaded);
	assert.equal(loaded!.chunks.length, 0);
});

await check('load 缓存：已加载不重读', async () => {
	const adapter = new MemAdapter();
	adapter.files.set('store.json', JSON.stringify(mkStore()));
	const st = new VectorStore({ vault: { adapter } } as never, {} as never, {} as never, { path: 'store.json', embeddingModel: 'bge-m3', batchSize: 8, roundDecimals: 6 });
	const a = await st.load();
	// 篡改磁盘文件，缓存应仍返回旧值
	adapter.files.set('store.json', 'corrupt');
	const b = await st.load();
	assert.equal(b, a, '缓存应返回同一对象');
});

await check('中断安全：首次迁移写 bin 时被打断 → 回退 JSON 向量重迁', async () => {
	const adapter = new MemAdapter();
	// 旧格式 store.json（含向量），模拟首次迁移在写 bin 时中断：bin 只写了一部分
	adapter.files.set('store.json', JSON.stringify(mkStore()));
	adapter.bins.set('store.bin', new ArrayBuffer(10)); // 截断的 bin（非 4 对齐，模拟中断）
	const st = new VectorStore({ vault: { adapter } } as never, {} as never, {} as never, { path: 'store.json', embeddingModel: 'bge-m3', batchSize: 8, roundDecimals: 6 });
	const loaded = await st.load();
	assert.ok(loaded);
	// 回退到 JSON 向量后重迁，向量正确
	assert.equal(loaded!.chunks[0]!.vector.length, 4);
	assert.ok(approx(loaded!.chunks[0]!.vector[0]!, 0.12));
	// bin 被重写为完整大小（48 = 3×4×4）
	assert.equal(adapter.bins.get('store.bin')!.byteLength, 48);
});

console.log(`\n${passed} passed${failed ? `, ${failed} failed` : ''}`);
})();
