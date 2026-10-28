import { Notice } from 'obsidian';

/** LLM HTTP 客户端：embedding + chat。支持 Ollama 原生协议及 OpenAI/Anthropic 兼容 API。 */

export type ProviderKind = 'ollama' | 'openai' | 'anthropic';

export interface OllamaClientOptions {
	url: string;
	embeddingModel: string;
	chatModel: string;
	timeoutMs?: number;
	/** chat 供应商，默认 ollama */
	provider?: ProviderKind;
	/** chat API base（openai/anthropic 用），如 https://api.openai.com/v1 */
	providerBaseUrl?: string;
	/** chat API key（openai/anthropic 用） */
	apiKey?: string;
	/** embedding 供应商，默认 ollama（anthropic 无 embedding API） */
	embeddingProvider?: ProviderKind;
	/** embedding API base（openai 用） */
	embeddingBaseUrl?: string;
	/** embedding API key（openai 用） */
	embeddingApiKey?: string;
}

export interface ChatOptions {
	/** 覆盖默认 chat 模型 */
	model?: string;
	/** 系统提示，拼到 messages 前 */
	system?: string;
	/** 生成温度，默认 0.3 */
	temperature?: number;
	/** 是否开启思考链，默认 false（仅 ollama 生效） */
	think?: boolean;
	/** 是否流式，默认 false */
	stream?: boolean;
	/** 外部中止信号 */
	signal?: AbortSignal;
}

export interface ChatResult {
	content: string;
	model: string;
}

export interface ChatMessage {
	role: 'system' | 'user' | 'assistant';
	content: string;
}

export class OllamaError extends Error {
	constructor(message: string, public readonly cause?: unknown) {
		super(message);
		this.name = 'OllamaError';
	}
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class OllamaClient {
	url: string;
	embeddingModel: string;
	chatModel: string;
	provider: ProviderKind;
	providerBaseUrl: string;
	apiKey: string;
	embeddingProvider: ProviderKind;
	embeddingBaseUrl: string;
	embeddingApiKey: string;
	readonly timeoutMs: number;

	constructor(opts: OllamaClientOptions) {
		this.url = opts.url.replace(/\/+$/, '');
		this.embeddingModel = opts.embeddingModel;
		this.chatModel = opts.chatModel;
		this.provider = opts.provider ?? 'ollama';
		this.providerBaseUrl = (opts.providerBaseUrl ?? '').replace(/\/+$/, '');
		this.apiKey = opts.apiKey ?? '';
		this.embeddingProvider = opts.embeddingProvider ?? 'ollama';
		this.embeddingBaseUrl = (opts.embeddingBaseUrl ?? '').replace(/\/+$/, '');
		this.embeddingApiKey = opts.embeddingApiKey ?? '';
		this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	}

	/** POST JSON，统一超时 + 错误归一为 OllamaError */
	private async postJSON(path: string, body: unknown, signal?: AbortSignal): Promise<any> {
		const controller = new AbortController();
		const timer = window.setTimeout(() => controller.abort(), this.timeoutMs);
		if (signal) {
			if (signal.aborted) {
				window.clearTimeout(timer);
				throw new OllamaError('请求已中止');
			}
			signal.addEventListener('abort', () => controller.abort(), { once: true });
		}
		try {
			const res = await fetch(`${this.url}${path}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
				signal: controller.signal,
			});
			if (!res.ok) {
				const text = await res.text().catch(() => '');
				throw new OllamaError(`Ollama HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
			}
			return await res.json();
		} catch (e) {
			if (e instanceof OllamaError) throw e;
			if (e instanceof DOMException && e.name === 'AbortError') {
				throw new OllamaError('请求超时或被中止');
			}
			throw new OllamaError('无法连接远端服务', e);
		} finally {
			window.clearTimeout(timer);
		}
	}

	/** 调 /api/embeddings（ollama）或 /embeddings（openai 兼容），返回 L2 归一化后的向量。 */
	async getEmbedding(text: string, model?: string): Promise<number[]> {
		const m = model ?? this.embeddingModel;
		if (this.embeddingProvider === 'openai') {
			const vec = await this.openAIEmbedding([text], m, undefined);
			return vec[0]!;
		}
		const data = await this.postJSON('/api/embeddings', { model: m, prompt: text });
		const vec: unknown = data?.embedding;
		if (!Array.isArray(vec) || vec.length === 0) {
			throw new OllamaError('Embedding 返回为空');
		}
		return l2normalize(vec as number[]);
	}

	/** OpenAI 兼容 /embeddings。 */
	private async openAIEmbedding(texts: string[], model: string, signal?: AbortSignal): Promise<number[][]> {
		const base = this.embeddingBaseUrl || 'https://api.openai.com/v1';
		let res: Response;
		try {
			res = await fetch(`${base}/embeddings`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					...(this.embeddingApiKey ? { Authorization: `Bearer ${this.embeddingApiKey}` } : {}),
				},
				body: JSON.stringify({ model, input: texts }),
				signal,
			});
		} catch (e) {
			if (e instanceof DOMException && e.name === 'AbortError') throw new OllamaError('已中止');
			throw new OllamaError('无法连接远端服务', e);
		}
		if (!res.ok) {
			const text = await res.text().catch(() => '');
			throw new OllamaError(`OpenAI 兼容 Embedding HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
		}
		const data: any = await res.json();
		const list: unknown = data?.data;
		if (!Array.isArray(list) || list.length !== texts.length) throw new OllamaError('Embedding 返回数量不匹配');
		const out: number[][] = [];
		for (const item of list as Array<{ embedding?: unknown }>) {
			const v = item?.embedding;
			if (!Array.isArray(v) || v.length === 0) throw new OllamaError('Embedding 返回为空');
			out.push(l2normalize(v as number[]));
		}
		return out;
	}

	/** 调 /api/embed 批量接口，返回逐条 L2 归一化后的向量（顺序与输入一致）。
	 *  单条超长会超出 bge-m3 ctx（8192 token；CJK 约 1 字≈1+ token）令整个 batch 400，
	 *  故先截断到 maxChars（默认 2000，CJK ≤ ~3000 token，安全）。
	 *  若 batch 整体仍 400（个别异常项），降级逐条 embedding + 激进截断，避免拖垮整库。 */
	async embedBatch(texts: string[], model?: string, maxChars = 2000): Promise<number[][]> {
		if (texts.length === 0) return [];
		const m = model ?? this.embeddingModel;
		const input = texts.map((t) => truncate(t, maxChars));
		if (this.embeddingProvider === 'openai') {
			return this.openAIEmbedding(input, m);
		}
		try {
			const data = await this.postJSON('/api/embed', { model: m, input });
			const embs: unknown = data?.embeddings;
			if (!Array.isArray(embs) || embs.length !== texts.length) {
				throw new OllamaError(`批量 Embedding 返回数量不匹配（期望 ${texts.length}，实际 ${Array.isArray(embs) ? embs.length : '非数组'}）`);
			}
			return (embs as number[][]).map(l2normalize);
		} catch (e) {
			if (!(e instanceof OllamaError) || !e.message.includes('400')) throw e;
			// 降级：逐条 embedding，逐级截断
			console.warn('[tony-ai-k] batch 400，降级逐条 embedding', texts.length);
			const out: number[][] = [];
			for (const t of texts) {
				out.push(await this.embedOneSafe(t, m));
			}
			return out;
		}
	}

	/** 单条 embedding 带逐级截断兜底：maxChars → 1000 → 300 → 空。 */
	private async embedOneSafe(text: string, model: string): Promise<number[]> {
		for (const limit of [2000, 1000, 300]) {
			try {
				return await this.getEmbedding(truncate(text, limit), model);
			} catch (e) {
				if (!(e instanceof OllamaError) || !e.message.includes('400')) throw e;
			}
		}
		// 仍失败：embed 空串占位（保证数量一致，检索时该片段相似度趋近 0）
		console.warn('[tony-ai-k] embedding 全部截断仍失败，用零向量占位');
		return this.getEmbedding(' ', model);
	}

	/** 调 /api/chat，默认 think:false 关闭思考链。M2 用非流式。 */
	async chat(prompt: string, opts: ChatOptions = {}): Promise<ChatResult> {
		const model = opts.model ?? this.chatModel;
		const think = opts.think ?? false;
		const stream = opts.stream ?? false;
		const messages: ChatMessage[] = [];
		if (opts.system) messages.push({ role: 'system', content: opts.system });
		messages.push({ role: 'user', content: prompt });

		// openai/anthropic：复用流式实现聚合为完整答案
		if (this.provider !== 'ollama') {
			return this.chatStream(messages, { ...opts, stream: true }, () => { /* 聚合，不逐 token */ });
		}

		const data = await this.postJSON(
			'/api/chat',
			{
				model,
				messages,
				stream,
				think,
				options: { temperature: opts.temperature ?? 0.3 },
			},
			opts.signal,
		);

		const content: unknown = data?.message?.content;
		if (typeof content !== 'string') {
			throw new OllamaError('Chat 返回格式异常');
		}
		return { content, model: (data?.model as string) ?? model };
	}

	/** 流式 chat：按 provider 分发（ollama NDJSON / openai SSE / anthropic SSE），统一 onToken + AbortSignal。 */
	async chatStream(
		messages: ChatMessage[],
		opts: ChatOptions,
		onToken: (token: string) => void,
	): Promise<ChatResult> {
		if (this.provider === 'openai') return this.chatStreamOpenAI(messages, opts, onToken);
		if (this.provider === 'anthropic') return this.chatStreamAnthropic(messages, opts, onToken);
		return this.chatStreamOllama(messages, opts, onToken);
	}

	/** OpenAI 兼容 /chat/completions（SSE 流式）。适用 openai 及各类兼容中转站。 */
	private async chatStreamOpenAI(
		messages: ChatMessage[],
		opts: ChatOptions,
		onToken: (token: string) => void,
	): Promise<ChatResult> {
		const model = opts.model ?? this.chatModel;
		const base = this.providerBaseUrl || 'https://api.openai.com/v1';
		let res: Response;
		try {
			res = await fetch(`${base}/chat/completions`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
				},
				body: JSON.stringify({
					model,
					messages,
					temperature: opts.temperature ?? 0.3,
					stream: true,
				}),
				signal: opts.signal,
			});
		} catch (e) {
			if (e instanceof DOMException && e.name === 'AbortError') throw new OllamaError('已中止');
			throw new OllamaError('无法连接远端服务', e);
		}
		if (!res.ok) {
			const text = await res.text().catch(() => '');
			throw new OllamaError(`OpenAI 兼容 API HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
		}
		return this.consumeSSE(res, (payload) => {
			const delta = payload?.choices?.[0]?.delta?.content;
			return typeof delta === 'string' ? delta : '';
		}, model, onToken);
	}

	/** Anthropic /v1/messages（SSE 流式）。system 从 messages 中抽出放顶层。 */
	private async chatStreamAnthropic(
		messages: ChatMessage[],
		opts: ChatOptions,
		onToken: (token: string) => void,
	): Promise<ChatResult> {
		const model = opts.model ?? this.chatModel;
		const base = this.providerBaseUrl || 'https://api.anthropic.com';
		const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
		const rest = messages.filter((m) => m.role !== 'system')
			.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
		let res: Response;
		try {
			res = await fetch(`${base}/v1/messages`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'x-api-key': this.apiKey,
					'anthropic-version': '2023-06-01',
				},
				body: JSON.stringify({
					model,
					...(system ? { system } : {}),
					messages: rest,
					max_tokens: 2048,
					temperature: opts.temperature ?? 0.3,
					stream: true,
				}),
				signal: opts.signal,
			});
		} catch (e) {
			if (e instanceof DOMException && e.name === 'AbortError') throw new OllamaError('已中止');
			throw new OllamaError('无法连接远端服务', e);
		}
		if (!res.ok) {
			const text = await res.text().catch(() => '');
			throw new OllamaError(`Anthropic API HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
		}
		return this.consumeSSE(res, (payload) => {
			if (payload?.type === 'content_block_delta' && typeof payload?.delta?.text === 'string') return payload.delta.text;
			return '';
		}, model, onToken);
	}

	/** 通用 SSE 消费：data: {...} 行 → extract(payload) → token；[DONE] 结束。 */
	private async consumeSSE(
		res: Response,
		extract: (payload: any) => string,
		fallbackModel: string,
		onToken?: (token: string) => void,
	): Promise<ChatResult> {
		if (!res.body) throw new OllamaError('远端未返回流主体');
		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';
		let content = '';
		let model = fallbackModel;
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				let nl: number;
				while ((nl = buffer.indexOf('\n')) >= 0) {
					const line = buffer.slice(0, nl).trim();
					buffer = buffer.slice(nl + 1);
					if (!line.startsWith('data:')) continue;
					const dataStr = line.slice(5).trim();
					if (dataStr === '[DONE]') return { content, model };
					let obj: any;
					try { obj = JSON.parse(dataStr); } catch { continue; }
					if (typeof obj?.model === 'string' && obj.model) model = obj.model;
					const token = extract(obj);
					if (token) { content += token; onToken?.(token); }
				}
			}
		} finally {
			try { reader.releaseLock(); } catch { /* ignore */ }
		}
		return { content, model };
	}

	/** Ollama 原生 /api/chat NDJSON 流式。 */
	private async chatStreamOllama(
		messages: ChatMessage[],
		opts: ChatOptions,
		onToken: (token: string) => void,
	): Promise<ChatResult> {
		const model = opts.model ?? this.chatModel;
		const think = opts.think ?? false;
		let res: Response;
		try {
			res = await fetch(`${this.url}/api/chat`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					model,
					messages,
					stream: true,
					think,
					options: { temperature: opts.temperature ?? 0.3 },
				}),
				signal: opts.signal,
			});
		} catch (e) {
			if (e instanceof DOMException && e.name === 'AbortError') throw new OllamaError('已中止');
			throw new OllamaError('无法连接远端服务', e);
		}
		if (!res.ok) {
			const text = await res.text().catch(() => '');
			throw new OllamaError(`Ollama HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
		}
		if (!res.body) throw new OllamaError('远端未返回流主体');

		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';
		let content = '';
		let gotModel = model;

		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				let nl: number;
				while ((nl = buffer.indexOf('\n')) >= 0) {
					const line = buffer.slice(0, nl).trim();
					buffer = buffer.slice(nl + 1);
					if (!line) continue;
					let obj: any;
					try {
						obj = JSON.parse(line);
					} catch {
						continue;
					}
					if (typeof obj?.model === 'string') gotModel = obj.model;
					const tok: unknown = obj?.message?.content;
					if (typeof tok === 'string' && tok.length > 0) {
						content += tok;
						onToken(tok);
					}
					if (obj?.done === true) {
						return { content, model: gotModel };
					}
				}
			}
		} finally {
			try {
				reader.releaseLock();
			} catch { /* ignore */ }
		}
		return { content, model: gotModel };
	}

	/** GET /api/tags，返回模型名列表（ping 诊断用） */
	async listModels(): Promise<string[]> {
		const controller = new AbortController();
		const timer = window.setTimeout(() => controller.abort(), this.timeoutMs);
		try {
			const res = await fetch(`${this.url}/api/tags`, { signal: controller.signal });
			if (!res.ok) throw new OllamaError(`HTTP ${res.status}`);
			const data = await res.json();
			return ((data?.models ?? []) as Array<{ name?: string }>)
				.map((m) => m.name)
				.filter((n): n is string => typeof n === 'string');
		} catch (e) {
			if (e instanceof OllamaError) throw e;
			throw new OllamaError('无法连接远端服务', e);
		} finally {
			window.clearTimeout(timer);
		}
	}

	/**
	 * 静态：按协议拉取模型列表（设置面板用，无需实例化）。
	 * ollama: GET /api/tags；openai: GET /v1/models；anthropic: GET /v1/models。
	 */
	static async fetchModelList(provider: ProviderKind, baseUrl: string, apiKey: string): Promise<string[]> {
		const base = baseUrl.replace(/\/+$/, '') || (provider === 'ollama' ? 'http://localhost:11434' : provider === 'openai' ? 'https://api.openai.com/v1' : 'https://api.anthropic.com');
		const headers: Record<string, string> = {};
		if (provider === 'openai' && apiKey) headers.Authorization = `Bearer ${apiKey}`;
		if (provider === 'anthropic') {
			headers['x-api-key'] = apiKey;
			headers['anthropic-version'] = '2023-06-01';
		}
		let res: Response;
		try {
			res = await fetch(provider === 'ollama' ? `${base}/api/tags` : `${base}/models`, { headers });
		} catch (e) {
			throw new OllamaError('无法连接服务', e);
		}
		if (!res.ok) {
			const t = await res.text().catch(() => '');
			throw new OllamaError(`HTTP ${res.status}${t ? `: ${t.slice(0, 120)}` : ''}`);
		}
		const data: any = await res.json();
		// ollama: {models:[{name}]}；openai: {data:[{id}]}；anthropic: {data:[{id}]}
		const list: string[] = [];
		const models = data?.models ?? data?.data ?? [];
		if (Array.isArray(models)) {
			for (const m of models) {
				const name = typeof m?.name === 'string' ? m.name : typeof m?.id === 'string' ? m.id : null;
				if (name) list.push(name);
			}
		}
		return list;
	}
}

/** L2 归一化：单条与批量接口向量量级不同，统一归一化后余弦相似度才可比。 */
export function l2normalize(vec: number[]): number[] {
	let sum = 0;
	for (const v of vec) sum += v * v;
	const norm = Math.sqrt(sum);
	if (norm === 0) return vec.slice();
	return vec.map((v) => v / norm);
}

/** 截断到 maxChars 字符（按 UTF-16 code unit），超出部分丢弃。 */
export function truncate(text: string, maxChars: number): string {
	return text.length > maxChars ? text.slice(0, maxChars) : text;
}

/** 余弦相似度。向量已归一化时等价于点积，这里仍写通用实现。 */
export function cosine(a: number[], b: number[]): number {
	const n = Math.min(a.length, b.length);
	let dot = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < n; i++) {
		const av = a[i]!;
		const bv = b[i]!;
		dot += av * bv;
		na += av * av;
		nb += bv * bv;
	}
	const d = Math.sqrt(na) * Math.sqrt(nb);
	return d === 0 ? 0 : dot / d;
}

/** 便捷：用 Notice 弹一行消息。 */
export function notify(message: string, timeoutMs = 4000): void {
	new Notice(message, timeoutMs);
}
