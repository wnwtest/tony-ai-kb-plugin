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

	/** 混合检索（向量+BM25关键词）Top-K。 */
	retrieve: async (inputs, params, ctx) => {
		const vector = inputs.vector as number[];
		const queryText = String(inputs.queryText ?? inputs.text ?? '');
		const topK = Number(params.topK ?? 5);
		const minScore = Number(params.minScore ?? 0);
		if (!ctx.store.store) throw new Error('store 未就绪，请先 Rebuild index');
		const hits = search(vector, queryText, ctx.store.store.chunks, topK).filter((h) => h.score >= minScore);
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
			// 放得下整条 → 加入；放不下 → 跳过看下一条（而非 break）。
			// 旧逻辑 break 会让单个超大 chunk（如 8835 字的 PDAF 校准片段）清空整个 context，
			// 导致 Top-1 超长时 LLM 拿到空上下文 → "不知道"。跳过让后续更短的命片段（如 PDAF 专文）进入。
			if (buf.length + seg.length > maxChars) continue;
			buf += seg;
			used.push(h);
		}
		// 兜底：所有命片段都超长导致 buf 为空时，截断 Top-1 塞入，至少给 LLM 一点上下文
		if (buf.length === 0 && hits.length > 0) {
			const h = hits[0]!;
			const header = `[1] ${h.chunk.file} :: ${h.chunk.header}\n`;
			const content = h.chunk.content.slice(0, Math.max(0, maxChars - header.length - 4));
			buf = `${header}${content}\n\n`;
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
