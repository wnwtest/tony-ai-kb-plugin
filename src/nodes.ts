import type { OllamaClient } from './ollama';
import type { VectorStore } from './store';
import { cosine, search, tokenize, type SearchHit } from './search';

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

	/**
	 * 重排：引用质量评估 + MMR 多样化。
	 * 质量分（quality）= 0.6·相关性(混合检索归一分) + 0.2·查询术语覆盖率 + 0.2·内容丰富度(log长度)。
	 * MMR 贪心选下一条：score = λ·quality - (1-λ)·与已选片段最大余弦。
	 * λ 默认 0.7（质量主导，多样性软约束）——同源但内容互补的仍可入选，
	 * 只把高度雷同的（如同一张图的多个旁车）压下去。不以来源一刀切。
	 */
	rerank: async (inputs, params) => {
		const hits = ((inputs.chunks ?? []) as SearchHit[]).filter((h) => h && h.chunk);
		const queryText = String(inputs.queryText ?? '');
		const strategy = String(params.strategy ?? 'mmr');
		const topK = Number(params.topK ?? 6);

		if (strategy === 'keyword' || strategy === 'length') {
			// 简单策略：keyword（查询术语命中数）/ length（内容长度）
			const qt = new Set(tokenize(queryText));
			const ov = (h: SearchHit): number => {
				const toks = new Set(tokenize(`${h.chunk.header} ${h.chunk.content}`));
				let n = 0; for (const t of qt) if (toks.has(t)) n++;
				return n;
			};
			const sorted = [...hits].sort((a, b) =>
				strategy === 'length' ? b.chunk.content.length - a.chunk.content.length : ov(b) - ov(a),
			);
			return { chunks: sorted.slice(0, topK) };
		}

		// MMR + quality（默认策略）
		const lambda = Number(params.lambda ?? 0.7);
		const minRel = Number(params.minRel ?? 0.3);
		// 相关性下限：过滤掉 retrieve 分过低的候选（哪怕长文档丰富度高），
		// 防止 tangential 长文（如压力测试 PDF 偶尔提到 camera）靠长度红利混入。
		// 全部低于下限时回退到原候选，不返回空。
		let pool = hits.filter((h) => h.score >= minRel);
		if (pool.length === 0) pool = hits;
		const qualities = computeQualities(pool, queryText);
		const selected: SearchHit[] = [];
		const remaining = pool.map((_, i) => i);
		while (selected.length < topK && remaining.length) {
			let bestI = -1;
			let bestScore = -Infinity;
			for (const i of remaining) {
				const diversity = selected.length === 0
					? 0
					: Math.max(...selected.map((s) => cosine(pool[i]!.chunk.vector, s.chunk.vector)));
				const mmr = lambda * qualities[i]! - (1 - lambda) * diversity;
				if (mmr > bestScore) { bestScore = mmr; bestI = i; }
			}
			if (bestI < 0) break;
			selected.push({ chunk: pool[bestI]!.chunk, score: qualities[bestI]! });
			remaining.splice(remaining.indexOf(bestI), 1);
		}
		return { chunks: selected };
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

// ───────── 引用质量评估（rerank 用） ─────────

/**
 * 引用质量分：0.7·相关性 + 0.2·查询术语覆盖率 + 0.1·内容丰富度。
 * - 相关性：直接用 retrieve 混合检索分（search 已对全库归一，落 [0,1]），不在批内
 *   二次归一——否则最低分候选 rel=0 抹掉大半质量，把检索分稍低但内容扎实的专文误杀。
 *   权重 0.6→0.7：相关性主导，压制长文档靠丰富度越级。
 * - 覆盖率：chunk 命中的查询 token 比例（token 去重）——奖励真正谈到查询概念的片段。
 * - 丰富度：log(contentLen)/log(2000)，2000 字封顶。权重 0.2→0.1：弱化长度红利，
 *   避免长但 tangential 的文档（如偶提 camera 的压力测试 PDF）挤掉实质笔记。
 */
function computeQualities(hits: SearchHit[], queryText: string): number[] {
	const queryTokens = [...new Set(tokenize(queryText))];
	const qtCount = Math.max(queryTokens.length, 1);
	return hits.map((h) => {
		const rel = Math.max(0, Math.min(1, h.score));
		const chunkToks = new Set(tokenize(`${h.chunk.header} ${h.chunk.content}`));
		let covered = 0;
		for (const t of queryTokens) if (chunkToks.has(t)) covered++;
		const coverage = covered / qtCount;
		const richness = Math.min(1, Math.log(h.chunk.content.length + 1) / Math.log(2000));
		return 0.7 * rel + 0.2 * coverage + 0.1 * richness;
	});
}
