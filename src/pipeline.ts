import { nodeExecutors, type NodeContext, type NodeInputs, type NodeOutputs, type NodeParams } from './nodes';

/**
 * 流水线引擎（参考 Dify 节点流）。
 * 加载 pipeline.json → 拓扑排序 → 顺序执行 → `{{nodeId.outKey}}` 模板取上游输出。
 * 节点 enabled:false 跳过；异常隔离（捕获并标出失败节点）。
 */

export interface NodeDef {
	id: string;
	type: string;
	params?: NodeParams;
	in?: Record<string, string>; // value 形如 "{{nodeId.outKey}}" 或字面量
	out?: string[];
	enabled?: boolean;
	/** 条件分支（仅 type='branch'）：then/else 各自是子节点序列。 */
	branches?: {
		condition: string;   // 表达式，如 "score >= 0.3" / "chunks.length > 0"
		then: NodeDef[];
		else: NodeDef[];
	};
}

export interface Pipeline {
	version: number;
	nodes: NodeDef[];
}

export interface RunResult {
	outputs: Record<string, NodeOutputs>; // 每节点输出
	answer: string;
	citations: unknown[];
	citationList: string;
	model?: string;
}

export type NodeLogCb = (
	id: string,
	type: string,
	inputs: NodeInputs,
	outputs: NodeOutputs,
) => void;

const TMPL = /^\{\{(\w+)\.(\w+)\}\}$/;

/** 默认流水线 DSL（首版，落盘 pipeline.json 后可编辑）。 */
export const DEFAULT_PIPELINE_JSON = `{
  "version": 1,
  "nodes": [
    { "id": "q",        "type": "input",    "out": ["query"] },
    { "id": "embed",    "type": "embed",     "params": { "model": "bge-m3" },     "in": { "text": "{{q.query}}" },          "out": ["vector"] },
    { "id": "retrieve", "type": "retrieve",  "params": { "topK": 12 },             "in": { "vector": "{{embed.vector}}", "queryText": "{{q.query}}" },   "out": ["chunks"] },
    { "id": "rerank",   "type": "rerank",    "params": { "strategy": "mmr", "topK": 6, "lambda": 0.7, "minRel": 0.3 }, "in": { "chunks": "{{retrieve.chunks}}", "queryText": "{{q.query}}" }, "out": ["chunks"] },
    { "id": "ctx",      "type": "context",   "params": { "maxChars": 6000 },      "in": { "chunks": "{{rerank.chunks}}" }, "out": ["context", "citations"] },
    { "id": "chat",     "type": "chat",       "params": {
        "model": "qwen3.5:9b",
        "think": false,
        "temperature": 0.3,
        "stream": false,
        "system": "依据笔记片段回答；无信息则答不知道；引用用 [n]"
      },
      "in": { "context": "{{ctx.context}}", "query": "{{q.query}}" },
      "out": ["answer", "model"]
    },
    { "id": "output",   "type": "output",    "in": { "answer": "{{chat.answer}}", "citations": "{{ctx.citations}}" }, "out": ["answer", "citations", "citationList"] }
  ]
}
`;

/**
 * 旧版 DSL 迁移：retrieve 节点缺 queryText 连线（混合检索 BM25 通道的关键词输入）时，
 * 自动补 `{{<input节点id>.query}}`。就地修改，返回是否发生变更。
 * 背景：盘上已存在的 pipeline.json 不会被 DEFAULT_PIPELINE_JSON 覆盖——
 * 混合检索上线前的旧文件缺这条连线 → BM25 无输入 → 退化为纯向量 → 术语漏检。
 * 仅补缺失项；用户显式配置过的 queryText（模板或字面量）尊重原值。
 */
export function migratePipeline(def: Pipeline): boolean {
	const inputNode = def.nodes.find((n) => n.type === 'input');
	if (!inputNode) return false;
	const ref = `{{${inputNode.id}.query}}`;
	let changed = false;
	const fix = (nodes: NodeDef[]): void => {
		for (const n of nodes) {
			if (n.type === 'retrieve' && n.in?.queryText == null) {
				n.in = { ...(n.in ?? {}), queryText: ref };
				changed = true;
			}
			if (n.branches) {
				fix(n.branches.then);
				fix(n.branches.else);
			}
		}
	};
	fix(def.nodes);
	return changed;
}

/** 解析模板值：`{{id.key}}` → outputs[id][key]（保留类型，如 number[]/数组）；否则原样返回。 */
function resolveValue(v: unknown, outputs: Record<string, NodeOutputs>): unknown {
	if (typeof v === 'string') {
		const m = v.match(TMPL);
		if (m) {
			const id = m[1]!;
			const key = m[2]!;
			return outputs[id]?.[key];
		}
	}
	return v;
}

/** 拓扑排序：依据 in 字段中的模板引用建依赖图。 */
function topoSort(nodes: NodeDef[]): NodeDef[] {
	const map = new Map(nodes.map((n) => [n.id, n]));
	const deps = new Map<string, string[]>();
	for (const n of nodes) {
		const d: string[] = [];
		for (const v of Object.values(n.in ?? {})) {
			if (typeof v === 'string') {
				const m = v.match(TMPL);
				if (m && map.has(m[1]!)) d.push(m[1]!);
			}
		}
		deps.set(n.id, d);
	}
	const sorted: NodeDef[] = [];
	const visited = new Set<string>();
	const visiting = new Set<string>();
	const visit = (id: string): void => {
		if (visited.has(id)) return;
		if (visiting.has(id)) throw new Error(`流水线存在环：${id}`);
		visiting.add(id);
		for (const dep of deps.get(id) ?? []) visit(dep);
		visiting.delete(id);
		visited.add(id);
		const n = map.get(id);
		if (n) sorted.push(n);
	};
	for (const n of nodes) visit(n.id);
	return sorted;
}

/**
 * 安全求值分支条件表达式。支持两种形式：
 *  1. 简单比较："score >= 0.3" / "chunks.length > 0" — 从 inputs/outputs 中取变量值
 *  2. 关键词："has_results" / "no_results" — 根据 chunks 是否为空
 * 不使用 eval()，用正则解析。
 */
async function evalBranchCondition(
	expr: string,
	inputs: NodeInputs,
	outputs: Record<string, NodeOutputs>,
): Promise<boolean> {
	const e = expr.trim();
	if (!e) return true;
	// 关键词简写
	if (e === 'has_results') {
		const chunks = (inputs.chunks ?? []) as unknown[];
		return Array.isArray(chunks) && chunks.length > 0;
	}
	if (e === 'no_results') {
		const chunks = (inputs.chunks ?? []) as unknown[];
		return !Array.isArray(chunks) || chunks.length === 0;
	}
	// 正则：变量 op 数值
	const m = e.match(/^(\w+(?:\.\w+)?)\s*(>=|<=|>|<|==|!=)\s*(.+)$/);
	if (!m) return Boolean(e); // 非空字符串 = true
	const [, varPath, op, valStr] = m;
	// 取变量值：先从 inputs 找，再从 outputs 里找 nodeId.key
	let val: unknown;
	if (varPath!.includes('.')) {
		const parts = varPath!.split('.');
		const nid = parts[0]!;
		const key = parts[1]!;
		val = outputs[nid]?.[key];
	} else {
		val = inputs[varPath!];
	}
	// 数值化
	const left = typeof val === 'number' ? val
		: Array.isArray(val) ? val.length
		: parseFloat(String(val ?? '0'));
	const right = parseFloat(valStr!.trim());
	if (isNaN(left) || isNaN(right)) return false;
	switch (op) {
		case '>=': return left >= right;
		case '<=': return left <= right;
		case '>':  return left > right;
		case '<':  return left < right;
		case '==': return left === right;
		case '!=': return left !== right;
		default:   return false;
	}
}

export class PipelineEngine {
	constructor(
		private readonly def: Pipeline,
		private readonly ctx: NodeContext,
	) {}

	async run(query: string, onNode?: NodeLogCb): Promise<RunResult> {
		const order = topoSort(this.def.nodes);
		const outputs: Record<string, NodeOutputs> = {};
		let last: NodeOutputs = {};

		await this.execNodes(order, query, outputs, onNode, (out) => { last = out; });

		const outNode = this.def.nodes.find((n) => n.type === 'output' && n.enabled !== false);
		const final = outNode ? outputs[outNode.id] ?? {} : last;

		return {
			outputs,
			answer: String(final.answer ?? ''),
			citations: Array.isArray(final.citations) ? final.citations : [],
			citationList: String(final.citationList ?? ''),
			model: typeof final.model === 'string'
				? final.model
				: typeof outputs.chat?.model === 'string' ? outputs.chat.model : undefined,
		};
	}

	/** 执行一组节点（主流或子分支共用）。遇到 branch 节点递归执行匹配分支。 */
	private async execNodes(
		nodes: NodeDef[],
		query: string,
		outputs: Record<string, NodeOutputs>,
		onNode: NodeLogCb | undefined,
		onEach: (out: NodeOutputs) => void,
		depth = 0,
	): Promise<void> {
		if (depth > 2) throw new Error('条件分支嵌套超过 2 层');
		for (const node of nodes) {
			if (node.enabled === false) continue;

			// 分支节点：求值条件 → 只跑匹配的子分支
			if (node.type === 'branch' && node.branches) {
				const inputs: NodeInputs = {};
				for (const [k, v] of Object.entries(node.in ?? {})) {
					inputs[k] = resolveValue(v, outputs);
				}
				const branchResult = await evalBranchCondition(node.branches.condition, inputs, outputs);
				onNode?.(node.id, node.type, inputs, { branch: branchResult ? 'then' : 'else' });
				const subNodes = branchResult ? node.branches.then : node.branches.else;
				if (subNodes?.length) {
					await this.execNodes(subNodes, query, outputs, onNode, onEach, depth + 1);
				}
				continue;
			}

			const exec = nodeExecutors[node.type];
			if (!exec) throw new Error(`未知节点类型：${node.type}（节点 ${node.id}）`);
			const inputs: NodeInputs = {};
			for (const [k, v] of Object.entries(node.in ?? {})) {
				inputs[k] = resolveValue(v, outputs);
			}
			if (node.type === 'input') inputs.query = query;
			const out = await exec(inputs, node.params ?? {}, this.ctx);
			outputs[node.id] = out;
			onNode?.(node.id, node.type, inputs, out);
			onEach(out);
		}
	}

	/**
	 * M9 流式：跑 input→embed→retrieve→context，停在 chat 前，返回上下文、引用与 chat 节点参数。
	 * 调用方据此拼多轮 messages 后用 ollama.chatStream 流式生成。
	 */
	async prepareContext(query: string, onNode?: NodeLogCb): Promise<PreparedContext> {
		const order = topoSort(this.def.nodes);
		const outputs: Record<string, NodeOutputs> = {};
		let context = '';
		let citations: unknown[] = [];
		let chatParams: NodeParams = {};
		let chatSystem = '依据笔记片段回答；无信息则答不知道；引用用 [n]';

		const walk = async (nodes: NodeDef[], depth: number): Promise<void> => {
			if (depth > 2) throw new Error('条件分支嵌套超过 2 层');
			for (const node of nodes) {
				if (node.enabled === false) continue;
				if (node.type === 'chat' || node.type === 'output') {
					if (node.type === 'chat') {
						chatParams = node.params ?? {};
						if (typeof chatParams.system === 'string') chatSystem = chatParams.system;
					}
					continue;
				}
				if (node.type === 'branch' && node.branches) {
					const inputs: NodeInputs = {};
					for (const [k, v] of Object.entries(node.in ?? {})) inputs[k] = resolveValue(v, outputs);
					const result = await evalBranchCondition(node.branches.condition, inputs, outputs);
					onNode?.(node.id, node.type, inputs, { branch: result ? 'then' : 'else' });
					const subNodes = result ? node.branches.then : node.branches.else;
					if (subNodes?.length) await walk(subNodes, depth + 1);
					continue;
				}
				const exec = nodeExecutors[node.type];
				if (!exec) throw new Error(`未知节点类型：${node.type}（节点 ${node.id}）`);
				const inputs: NodeInputs = {};
				for (const [k, v] of Object.entries(node.in ?? {})) inputs[k] = resolveValue(v, outputs);
				if (node.type === 'input') inputs.query = query;
				const out = await exec(inputs, node.params ?? {}, this.ctx);
				outputs[node.id] = out;
				onNode?.(node.id, node.type, inputs, out);
				if (node.type === 'context') {
					context = String(out.context ?? '');
					citations = Array.isArray(out.citations) ? out.citations : [];
				}
			}
		};
		await walk(order, 0);
		return { context, citations, system: chatSystem, chatParams, outputs };
	}
}

export interface PreparedContext {
	context: string;
	citations: unknown[];
	system: string;
	chatParams: NodeParams;
	outputs: Record<string, NodeOutputs>;
}
