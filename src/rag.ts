import { App } from 'obsidian';
import type { ChatMessage, OllamaClient } from './ollama';
import type { VectorStore } from './store';
import type { SearchHit } from './search';
import {
	DEFAULT_PIPELINE_JSON,
	PipelineEngine,
	type NodeLogCb,
	type Pipeline,
	type RunResult,
} from './pipeline';

/**
 * RAG 薄壳：加载 pipeline.json → 创建 PipelineEngine → run()。
 * pipeline.json 不存在时落盘默认 DSL。
 */
export class Rag {
	constructor(
		private readonly app: App,
		private readonly ollama: OllamaClient,
		private readonly store: VectorStore,
		private readonly path: string,
	) {}

	async loadDef(): Promise<Pipeline> {
		try {
			if (await this.app.vault.adapter.exists(this.path)) {
				const raw = await this.app.vault.adapter.read(this.path);
				const def = JSON.parse(raw) as Pipeline;
				if (def && Array.isArray(def.nodes) && def.nodes.length > 0) return def;
			}
		} catch (e) {
			console.warn('[tony-ai-kb] load pipeline.json failed，使用默认 DSL', e);
		}
		// 落盘默认
		try {
			await this.app.vault.adapter.write(this.path, DEFAULT_PIPELINE_JSON);
		} catch (e) {
			console.warn('[tony-ai-kb] write default pipeline.json failed', e);
		}
		return JSON.parse(DEFAULT_PIPELINE_JSON) as Pipeline;
	}

	async run(query: string, onNode?: NodeLogCb): Promise<RunResult> {
		const def = await this.loadDef();
		const engine = new PipelineEngine(def, { ollama: this.ollama, store: this.store });
		return engine.run(query, onNode);
	}

	/**
	 * M9 流式：prepareContext 跑检索+上下文，拼多轮 messages，用 ollama.chatStream 逐 token 输出。
	 * history 为已发生的 user/assistant 轮次（不含 system）；signal 用于停止按钮中止。
	 * 检索 query 拼入上一轮用户问题：追问里的"它/这个"对 embedding 无语义，
	 * 不带上文会漂移到无关主题；生成 prompt 仍用追问原文。
	 */
	async runStream(
		query: string,
		history: ChatMessage[],
		onToken: (token: string) => void,
		signal?: AbortSignal,
		systemOverride?: string,
		thinkOverride?: boolean,
	): Promise<RunResult> {
		const def = await this.loadDef();
		const engine = new PipelineEngine(def, { ollama: this.ollama, store: this.store });
		const lastUser = [...history].reverse().find((m) => m.role === 'user')?.content ?? '';
		let retrievalQuery = lastUser ? `${lastUser}\n${query}` : query;
		// 检索 query 增强：中英混合口语查询（"camera pdaf的工作原理是什么"）中，
		// 英文术语权重会被口语稀释导致漏检——提取英文术语片段追加强化。
		retrievalQuery += enhanceQueryTerms(query);
		if (signal?.aborted) throw new Error('已中止');
		const prep = await engine.prepareContext(retrievalQuery);
		if (signal?.aborted) throw new Error('已中止');
		const citations = (prep.citations ?? []) as SearchHit[];
		const citationList = citations
			.map((h, i) => `[${i + 1}] ${h.chunk.file} → ${h.chunk.header} (line ${h.chunk.lineStart}, score ${h.score.toFixed(3)})`)
			.join('\n');
		const messages: ChatMessage[] = [
			{ role: 'system', content: systemOverride ?? prep.system },
			...history,
			{ role: 'user', content: `${prep.context}\n\n问题：${query}` },
		];
		const r = await this.ollama.chatStream(
			messages,
			{
				model: typeof prep.chatParams.model === 'string' ? prep.chatParams.model : undefined,
				think: thinkOverride ?? (prep.chatParams.think !== false ? Boolean(prep.chatParams.think) : false),
				temperature: typeof prep.chatParams.temperature === 'number' ? prep.chatParams.temperature : 0.3,
				signal,
			},
			onToken,
		);
		return {
			outputs: prep.outputs,
			answer: r.content,
			citations,
			citationList,
			model: r.model,
		};
	}
}

/**
 * 查询术语强化：提取中英混合查询里的英文/数字术语（≥2 字符），以 "term term" 形式追加。
 * 例："camera pdaf的工作原理是什么" → "\ncamera pdaf camera pdaf"
 * embedding 对重复词敏感，追加后术语权重上升，避免口语稀释导致漏检。
 * 纯中文查询不受影响（无英文片段则返回空串）。
 */
export function enhanceQueryTerms(query: string): string {
	const terms = query.match(/[A-Za-z][A-Za-z0-9_.-]{1,}/g) ?? [];
	// 过滤太短的常见词（a/of/the 等）与重复
	const filtered = [...new Set(terms.map((t) => t.toLowerCase()))]
		.filter((t) => t.length >= 3 || /^[a-z]{2}\d/i.test(t));
	if (filtered.length === 0) return '';
	return `\n${filtered.join(' ')} ${filtered.join(' ')}`;
}
