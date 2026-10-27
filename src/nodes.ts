import type { OllamaClient } from './ollama';
import type { VectorStore } from './store';
import { search, type SearchHit } from './search';

/**
 * 流水线节点实现（参考 Dify 节点）。
 * 每节点：(inputs, params, ctx) → outputs
 * 节点间通过 `in` 字段的 `{{nodeId.outKey}}` 模板取上游输出（由 pipeline.ts 解析）。
 */

export interface NodeContext {
	ollama: OllamaClient;
	store: VectorStore;
}

export type NodeParams = Record<string, unknown>;
export type NodeOutputs = Record<string, unknown>;
export type NodeInputs = Record<string, unknown>;

export type NodeExecutor = (
	inputs: NodeInputs,
	params: NodeParams,
	ctx: NodeContext,
) => Promise<NodeOutputs>;

export const nodeExecutors: Record<string, NodeExecutor> = {
	/** 接收用户 query（engine 注入 inputs.query）。 */
	input: async (inputs) => ({ query: String(inputs.query ?? '') }),

	/** 调 Ollama embedding。 */
	embed: async (inputs, params, ctx) => {
		const text = String(inputs.text ?? '');
		const model = typeof params.model === 'string' ? params.model : undefined;
		const vector = await ctx.ollama.getEmbedding(text, model);
		return { vector };
	},

	/** 余弦检索 Top-K。 */
	retrieve: async (inputs, params, ctx) => {
		const vector = inputs.vector as number[];
		const topK = Number(params.topK ?? 5);
		const minScore = Number(params.minScore ?? 0);
		if (!ctx.store.store) throw new Error('store 未就绪，请先 Rebuild index');
		const hits = search(vector, ctx.store.store.chunks, topK).filter((h) => h.score >= minScore);
		return { chunks: hits };
	},

	/** 拼 [n] 上下文 + 截断 + 去重（同 file+header 去重）。 */
	context: async (inputs, params) => {
		const hits = (inputs.chunks ?? []) as SearchHit[];
		const maxChars = Number(params.maxChars ?? 6000);
		const seen = new Set<string>();
		const used: SearchHit[] = [];
		let buf = '';
		for (let i = 0; i < hits.length; i++) {
			const h = hits[i]!;
			const key = `${h.chunk.file}::${h.chunk.lineStart}`;
			if (seen.has(key)) continue;
			seen.add(key);
			const seg = `[${used.length + 1}] ${h.chunk.file} :: ${h.chunk.header}\n${h.chunk.content}\n\n`;
			if (buf.length + seg.length > maxChars) break;
			buf += seg;
			used.push(h);
		}
		return { context: buf, citations: used };
	},

	/** 调 Ollama /api/chat，默认 think:false。M8 非流式。 */
	chat: async (inputs, params, ctx) => {
		const context = String(inputs.context ?? '');
		const query = String(inputs.query ?? '');
		const system = typeof params.system === 'string'
			? params.system
			: '依据笔记片段回答；无信息则答不知道；引用用 [n]';
		const prompt = `${context}\n\n问题：${query}`;
		const r = await ctx.ollama.chat(prompt, {
			model: typeof params.model === 'string' ? params.model : undefined,
			think: params.think !== false ? Boolean(params.think) : false, // 默认 false
			temperature: typeof params.temperature === 'number' ? params.temperature : 0.3,
			stream: params.stream === true,
			system,
		});
		return { answer: r.content, model: r.model };
	},

	/** 输出节点：格式化答案 + 引用回链列表。 */
	output: async (inputs) => {
		const citations = (inputs.citations ?? []) as SearchHit[];
		const citationList = citations
			.map((h, i) => `[${i + 1}] ${h.chunk.file} → ${h.chunk.header} (line ${h.chunk.lineStart}, score ${h.score.toFixed(3)})`)
			.join('\n');
		return {
			answer: String(inputs.answer ?? ''),
			citations,
			citationList,
		};
	},
};
