import { strict as assert } from 'node:assert';
import { chunkText, type RawChunk } from '../src/chunk-text';

let passed = 0;
function check(name: string, fn: () => void): void {
	try {
		fn();
		passed++;
		console.log(`  ✅ ${name}`);
	} catch (e) {
		console.error(`  ❌ ${name}`);
		console.error(e);
		process.exitCode = 1;
	}
}

function find(chunks: RawChunk[], header: string): RawChunk {
	const c = chunks.find((x) => x.header === header);
	if (!c) throw new Error(`chunk not found: ${header}`);
	return c;
}

const LONG = '正文内容'.repeat(60); // 240 字符，>200 不被合并
const SHORT = '短'; // <200

// Case A: frontmatter + 前言 + 两个 H2 段（都够长）
{
	const text = `---
title: demo
tags: [a]
---
${LONG}
## 一、开始
${LONG}
## 二、结束
${LONG}
`;
	const chunks = chunkText(text, { file: 'demo.md', fileName: 'demo', mtime: 100 });
	check('A: 片段数 = 3（前言 + 2 段）', () => assert.equal(chunks.length, 3));
	check('A: 前言 header = 文件名', () => assert.equal(chunks[0]!.header, 'demo'));
	check('A: 前言不含 frontmatter', () => assert.ok(!chunks[0]!.content.includes('title: demo')));
	check('A: 前言 lineStart = 5（frontmatter 后）', () => assert.equal(chunks[0]!.lineStart, 5));
	check('A: H2 header 含 "## "', () => assert.equal(find(chunks, '## 一、开始').header, '## 一、开始'));
	check('A: H2 lineStart 对应标题行', () => {
		const lines = text.split('\n');
		const idx = lines.findIndex((l) => l === '## 一、开始');
		assert.equal(find(chunks, '## 一、开始').lineStart, idx + 1);
	});
}

// Case B: 无 H2，整篇前言且过短 → 仍保留 1 片段
{
	const chunks = chunkText(SHORT, { file: 'short.md', fileName: 'short', mtime: 1 });
	check('B: 短文件保留 1 片段', () => assert.equal(chunks.length, 1));
	check('B: header = 文件名', () => assert.equal(chunks[0]!.header, 'short'));
}

// Case C: 中间过短片段合并入前一片段
{
	const text = `## A
${LONG}
## B（短）
${SHORT}
## C
${LONG}
`;
	const chunks = chunkText(text, { file: 'merge.md', fileName: 'merge', mtime: 2 });
	check('C: 短的 B 被合并掉，剩 2 片段', () => assert.equal(chunks.length, 2));
	check('C: 合并后 A 的 content 含 B 的内容', () => assert.ok(chunks[0]!.content.includes('## B（短）')));
}

// Case D: 无 frontmatter，前言 + 1 个 H2 段
{
	const text = `${LONG}
## 标题
${LONG}
`;
	const chunks = chunkText(text, { file: 'nofm.md', fileName: 'nofm', mtime: 3 });
	check('D: 无 frontmatter 时前言 lineStart = 1', () => assert.equal(chunks[0]!.lineStart, 1));
	check('D: 2 片段', () => assert.equal(chunks.length, 2));
}

// Case E: frontmatter 未闭合 → 按无 frontmatter 处理
{
	const text = `---
title: broken
${LONG}
## 标题
${LONG}
`;
	const chunks = chunkText(text, { file: 'broken.md', fileName: 'broken', mtime: 4 });
	check('E: 未闭合 frontmatter 不被剥离（前言含 title 行）', () =>
		assert.ok(chunks[0]!.content.includes('title: broken')));
}

console.log(`\n${passed} passed`);
