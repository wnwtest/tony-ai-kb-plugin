import { App, Modal, Notice } from 'obsidian';
import type TonyAIKBPlugin from './main';
import type { NodeDef, Pipeline } from './pipeline';
import { DEFAULT_PIPELINE_JSON } from './pipeline';

/** 节点类型元数据：图标、标题、说明、默认输出。 */
const NODE_META: Record<string, { icon: string; title: string; desc: string; out: string[] }> = {
	input: { icon: '⌨️', title: '输入', desc: '接收用户问题', out: ['query'] },
	embed: { icon: '🔢', title: '向量化', desc: '文本 → embedding 向量', out: ['vector'] },
	retrieve: { icon: '🔍', title: '检索', desc: '余弦相似度 Top-K 片段', out: ['chunks'] },
	rerank: { icon: '🔄', title: '重排', desc: '按关键词/长度重排、去重', out: ['chunks'] },
	context: { icon: '📄', title: '拼上下文', desc: '[n] 引用标记 + 截断 + 去重', out: ['context', 'citations'] },
	condition: { icon: '🔀', title: '条件', desc: 'score < 阈值则跳过生成', out: ['chunks'] },
	branch: { icon: '🔱', title: '条件分支', desc: 'IF/ELSE：按条件分叉执行 then 或 else 子流', out: ['answer', 'citations'] },
	chat: { icon: '🤖', title: '生成', desc: 'LLM 流式回答（thinking 默认关）', out: ['answer', 'model'] },
	output: { icon: '📤', title: '输出', desc: '答案 + 引用回链列表', out: ['answer', 'citations', 'citationList'] },
};

/** 可添加的节点类型列表（顺序=面板展示顺序）。 */
const AVAILABLE_TYPES = ['input', 'embed', 'retrieve', 'rerank', 'context', 'condition', 'branch', 'chat', 'output'];

interface ParamSpec {
	key: string;
	label: string;
	desc: string;
	type: 'text' | 'number' | 'toggle' | 'textarea';
}

/** 各节点类型的可编辑参数定义。 */
const PARAM_SPECS: Record<string, ParamSpec[]> = {
	input: [],
	embed: [
		{ key: 'model', label: '模型', desc: 'embedding 模型名', type: 'text' },
	],
	retrieve: [
		{ key: 'topK', label: 'Top-K', desc: '返回片段数', type: 'number' },
		{ key: 'minScore', label: '最低分数', desc: '低于此分过滤（0=不过滤）', type: 'number' },
	],
	rerank: [
		{ key: 'strategy', label: '策略', desc: 'keyword 或 length', type: 'text' },
	],
	context: [
		{ key: 'maxChars', label: '最大字符', desc: '上下文总字符上限', type: 'number' },
	],
	condition: [
		{ key: 'threshold', label: '阈值', desc: '低于此分跳过生成', type: 'number' },
	],
	branch: [
		{ key: 'condition', label: '条件表达式', desc: '如 score >= 0.3 或 has_results 或 chunks.length > 0', type: 'text' },
	],
	chat: [
		{ key: 'model', label: '模型', desc: 'chat 模型名', type: 'text' },
		{ key: 'think', label: '思考模式', desc: '开=允许 thinking（仅 ollama）', type: 'toggle' },
		{ key: 'temperature', label: '温度', desc: '0–1，RAG 偏低', type: 'number' },
		{ key: 'stream', label: '流式', desc: '逐 token 输出', type: 'toggle' },
		{ key: 'system', label: '系统提示', desc: 'RAG 约束（无信息答不知道、引用用 [n]）', type: 'textarea' },
	],
	output: [],
};

/** 生成唯一节点 id：type + 4 位随机。 */
function genId(type: string): string {
	return `${type}_${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * 图形化流水线编辑器：节点卡片 + 流动连线 + 参数表单 + 增删/排序/自动连线。
 */
export class PipelineEditorModal extends Modal {
	private pipe!: Pipeline;

	constructor(app: App, private readonly plugin: TonyAIKBPlugin, private readonly path: string) {
		super(app);
		this.titleEl.setText('流水线配置');
	}

	async onOpen(): Promise<void> {
		await this.loadPipeline();
		this.render();
	}

	private async loadPipeline(): Promise<void> {
		try {
			if (await this.plugin.app.vault.adapter.exists(this.path)) {
				this.pipe = JSON.parse(await this.plugin.app.vault.adapter.read(this.path)) as Pipeline;
			} else {
				this.pipe = JSON.parse(DEFAULT_PIPELINE_JSON) as Pipeline;
			}
			if (!this.pipe?.nodes?.length) throw new Error('空');
		} catch {
			this.pipe = JSON.parse(DEFAULT_PIPELINE_JSON) as Pipeline;
		}
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('tony-ai-kb-pipe-editor');

		contentEl.createEl('p', {
			text: '节点从上到下执行。可增删、上下移动、编辑参数。新节点自动连线到前一个节点。',
			cls: 'tony-ai-kb-pipe-intro',
		});

		const flow = contentEl.createDiv({ cls: 'tony-ai-kb-pipe-flow' });
		const nodes = this.pipe.nodes ?? [];
		nodes.forEach((node, i) => {
			this.renderNode(flow, node, i);
			if (i < nodes.length - 1) {
				flow.createDiv({ cls: 'tony-ai-kb-pipe-arrow' });
			}
		});

		// 添加节点面板
		this.renderAddBar(flow, nodes.length);

		// 底部按钮
		const bar = contentEl.createDiv({ cls: 'tony-ai-kb-pipe-bar' });
		const reset = bar.createEl('button', { text: '恢复默认' });
		const save = bar.createEl('button', { text: '保存', cls: 'tony-ai-kb-pipe-save' });
		reset.addEventListener('click', () => {
			this.pipe = JSON.parse(DEFAULT_PIPELINE_JSON) as Pipeline;
			this.render();
		});
		save.addEventListener('click', () => void this.save());
	}

	private renderNode(flow: HTMLElement, node: NodeDef, index: number): void {
		const meta = NODE_META[node.type] ?? { icon: '❓', title: node.type, desc: '', out: [] };
		const card = flow.createDiv({ cls: `tony-ai-kb-pipe-node tony-ai-kb-pipe-node-${node.type}` });
		card.style.animationDelay = `${index * 60}ms`;

		// 头部：图标 + 标题 + id + 操作按钮
		const header = card.createDiv({ cls: 'tony-ai-kb-pipe-node-header' });
		header.createEl('span', { cls: 'tony-ai-kb-pipe-node-icon', text: meta.icon });
		header.createEl('span', { cls: 'tony-ai-kb-pipe-node-title', text: meta.title });
		header.createEl('span', { cls: 'tony-ai-kb-pipe-node-id', text: node.id });

		// 操作区：上移 / 下移 / 删除
		const ops = header.createDiv({ cls: 'tony-ai-kb-pipe-node-ops' });
		const upBtn = ops.createEl('button', { text: '↑', cls: 'tony-ai-kb-pipe-op', attr: { title: '上移' } });
		upBtn.disabled = index === 0;
		upBtn.addEventListener('click', () => this.moveNode(index, -1));
		const downBtn = ops.createEl('button', { text: '↓', cls: 'tony-ai-kb-pipe-op', attr: { title: '下移' } });
		downBtn.disabled = index === this.pipe.nodes.length - 1;
		downBtn.addEventListener('click', () => this.moveNode(index, 1));
		const delBtn = ops.createEl('button', { text: '✕', cls: 'tony-ai-kb-pipe-op tony-ai-kb-pipe-del', attr: { title: '删除' } });
		delBtn.addEventListener('click', () => this.deleteNode(index));

		card.createEl('div', { cls: 'tony-ai-kb-pipe-node-desc', text: meta.desc });

		// 参数表单
		const specs = PARAM_SPECS[node.type] ?? [];
		if (specs.length > 0) {
			const paramsEl = card.createDiv({ cls: 'tony-ai-kb-pipe-params' });
			for (const spec of specs) this.renderParam(paramsEl, node, spec);
		} else {
			card.createEl('div', { cls: 'tony-ai-kb-pipe-node-noparams', text: '（无需配置）' });
		}

		// branch 节点：展开 then/else 两列子流
		if (node.type === 'branch') {
			this.renderBranchSubflow(card, node);
		}
	}

	private renderParam(container: HTMLElement, node: NodeDef, spec: ParamSpec): void {
		const row = container.createDiv({ cls: 'tony-ai-kb-pipe-param' });
		const info = row.createDiv({ cls: 'tony-ai-kb-pipe-param-info' });
		info.createEl('div', { cls: 'tony-ai-kb-pipe-param-label', text: spec.label });
		info.createEl('div', { cls: 'tony-ai-kb-pipe-param-desc', text: spec.desc });

		const val = node.params?.[spec.key];
		if (spec.type === 'toggle') {
			const cb = row.createEl('input', { type: 'checkbox' }) as HTMLInputElement;
			cb.checked = val === true;
			cb.dataset.nodeId = node.id;
			cb.dataset.param = spec.key;
			cb.dataset.pType = 'toggle';
			row.addClass('is-toggle');
		} else if (spec.type === 'textarea') {
			row.addClass('is-textarea');
			const ta = row.createEl('textarea') as HTMLTextAreaElement;
			ta.value = typeof val === 'string' ? val : '';
			ta.rows = 2;
			ta.dataset.nodeId = node.id;
			ta.dataset.param = spec.key;
			ta.dataset.pType = 'textarea';
			ta.addClass('tony-ai-kb-pipe-param-input');
		} else {
			const inp = row.createEl('input', { type: spec.type === 'number' ? 'number' : 'text' }) as HTMLInputElement;
			inp.value = val != null ? String(val) : '';
			inp.dataset.nodeId = node.id;
			inp.dataset.param = spec.key;
			inp.dataset.pType = spec.type;
			inp.addClass('tony-ai-kb-pipe-param-input');
		}
	}

	/** branch 节点展开 then/else 两列子流。 */
	private renderBranchSubflow(card: HTMLElement, node: NodeDef): void {
		if (!node.branches) {
			node.branches = { condition: 'has_results', then: [], else: [] };
		}
		const br = node.branches;
		const subflow = card.createDiv({ cls: 'tony-ai-kb-pipe-subflow' });
		this.renderBranchColumn(subflow, '✅ THEN（条件成立）', br.then);
		this.renderBranchColumn(subflow, '❌ ELSE（不成立）', br.else);
	}

	/** 渲染一个分支列（then 或 else）。 */
	private renderBranchColumn(container: HTMLElement, label: string, nodes: NodeDef[]): void {
		const col = container.createDiv({ cls: 'tony-ai-kb-pipe-branch-col' });
		col.createEl('div', { cls: 'tony-ai-kb-pipe-branch-label', text: label });
		if (nodes.length === 0) {
			col.createEl('div', { cls: 'tony-ai-kb-pipe-branch-empty', text: '（空——跳过此分支）' });
		} else {
			nodes.forEach((sub, i) => {
				this.renderSubNode(col, sub, i, nodes);
				if (i < nodes.length - 1) col.createDiv({ cls: 'tony-ai-kb-pipe-arrow tony-ai-kb-pipe-arrow-sm' });
			});
		}
		// 添加节点 chip（不含 input/branch，防嵌套）
		const addBar = col.createDiv({ cls: 'tony-ai-kb-pipe-addbar tony-ai-kb-pipe-addbar-sm' });
		for (const type of AVAILABLE_TYPES) {
			if (type === 'input' || type === 'branch') continue;
			const meta = NODE_META[type]!;
			const chip = addBar.createEl('button', { cls: `tony-ai-kb-pipe-chip tony-ai-kb-pipe-node-${type}` });
			chip.createEl('span', { cls: 'tony-ai-kb-pipe-chip-icon', text: meta.icon });
			chip.createEl('span', { text: meta.title });
			chip.addEventListener('click', () => {
				const id = genId(type);
				const newSub: NodeDef = { id, type, out: meta.out, params: {} };
				// 默认参数
				const specs = PARAM_SPECS[type] ?? [];
				for (const spec of specs) {
					if (spec.type === 'toggle') newSub.params![spec.key] = spec.key === 'stream';
					else if (spec.type === 'number') newSub.params![spec.key] = spec.key === 'topK' ? 5 : spec.key === 'temperature' ? 0.3 : spec.key === 'maxChars' ? 6000 : 0;
					else newSub.params![spec.key] = '';
				}
				nodes.push(newSub);
				this.render();
			});
		}
	}

	/** 渲染子流内的节点（简化版：只有删除，无上移下移，不渲染嵌套 branch）。 */
	private renderSubNode(col: HTMLElement, sub: NodeDef, index: number, nodes: NodeDef[]): void {
		const meta = NODE_META[sub.type] ?? { icon: '❓', title: sub.type, desc: '', out: [] };
		const card = col.createDiv({ cls: `tony-ai-kb-pipe-node tony-ai-kb-pipe-node-${sub.type} tony-ai-kb-pipe-subnode` });
		const header = card.createDiv({ cls: 'tony-ai-kb-pipe-node-header' });
		header.createEl('span', { cls: 'tony-ai-kb-pipe-node-icon', text: meta.icon });
		header.createEl('span', { cls: 'tony-ai-kb-pipe-node-title', text: meta.title });
		header.createEl('span', { cls: 'tony-ai-kb-pipe-node-id', text: sub.id });
		const ops = header.createDiv({ cls: 'tony-ai-kb-pipe-node-ops' });
		const delBtn = ops.createEl('button', { text: '✕', cls: 'tony-ai-kb-pipe-op tony-ai-kb-pipe-del' });
		delBtn.addEventListener('click', () => { nodes.splice(index, 1); this.render(); });
		card.createEl('div', { cls: 'tony-ai-kb-pipe-node-desc', text: meta.desc });
		const specs = PARAM_SPECS[sub.type] ?? [];
		if (specs.length > 0) {
			const paramsEl = card.createDiv({ cls: 'tony-ai-kb-pipe-params' });
			for (const spec of specs) this.renderParam(paramsEl, sub, spec);
		} else {
			card.createEl('div', { cls: 'tony-ai-kb-pipe-node-noparams', text: '（无需配置）' });
		}
	}

	/** 添加节点面板：一行可点击的节点类型 chip。 */
	private renderAddBar(flow: HTMLElement, _nodeCount: number): void {
		const addBar = flow.createDiv({ cls: 'tony-ai-kb-pipe-addbar' });
		addBar.createEl('span', { cls: 'tony-ai-kb-pipe-addbar-label', text: '+ 添加节点' });
		for (const type of AVAILABLE_TYPES) {
			const meta = NODE_META[type]!;
			const chip = addBar.createEl('button', {
				cls: `tony-ai-kb-pipe-chip tony-ai-kb-pipe-node-${type}`,
				attr: { 'data-add-type': type },
			});
			chip.createEl('span', { cls: 'tony-ai-kb-pipe-chip-icon', text: meta.icon });
			chip.createEl('span', { text: meta.title });
			chip.addEventListener('click', () => this.addNode(type));
		}
	}

	// ───────── 节点操作 ─────────

	/** 添加节点到末尾，自动连线前一个节点的输出。 */
	private addNode(type: string): void {
		const id = genId(type);
		const meta = NODE_META[type]!;
		const prev = this.pipe.nodes[this.pipe.nodes.length - 1];
		const inDef = this.autoWireIn(prev, type);
		const node: NodeDef = { id, type, in: inDef, out: meta.out, params: {} };
		// 设默认参数值
		const specs = PARAM_SPECS[type] ?? [];
		for (const spec of specs) {
			if (spec.type === 'toggle') node.params![spec.key] = (spec.key === 'stream') ? true : false;
			else if (spec.type === 'number') node.params![spec.key] = (spec.key === 'topK') ? 5 : (spec.key === 'temperature') ? 0.3 : (spec.key === 'maxChars') ? 6000 : 0;
			else if (spec.type === 'text') node.params![spec.key] = type === 'branch' ? 'has_results' : '';
			else if (spec.type === 'textarea') node.params![spec.key] = '';
		}
		// branch 节点设默认子流
		if (type === 'branch') {
			node.branches = { condition: 'has_results', then: [], else: [] };
		}
		this.pipe.nodes.push(node);
		this.render();
	}

	/** 根据前一个节点自动生成 in 引用。 */
	private autoWireIn(prev: NodeDef | undefined, newType: string): Record<string, string> {
		if (newType === 'input' || !prev) return {};
		const prevId = prev.id;
		const prevOut = prev.out?.[0] ?? '';
		const ref = `{{${prevId}.${prevOut}}}`;
		const wiring: Record<string, Record<string, string>> = {
			embed: { text: ref },
			retrieve: { vector: ref },			rerank: { chunks: ref },
			context: { chunks: ref },
			condition: { chunks: ref },
			chat: { context: ref },
			output: { answer: ref },
		};
		const inDef = { ...(wiring[newType] ?? {}) };
		// retrieve 还需要 queryText（混合检索的 BM25 通道，从 input 节点取原文）
		if (newType === 'retrieve') {
			const inputNode = this.pipe.nodes.find((n) => n.type === 'input');
			if (inputNode) inDef.queryText = `{{${inputNode.id}.query}}`;
		}
		// chat 还需要 query（从 input 节点）
		if (newType === 'chat') {
			const inputNode = this.pipe.nodes.find((n) => n.type === 'input');
			if (inputNode) inDef.query = `{{${inputNode.id}.query}}`;
		}
		// output 还需要 citations（从最近的 context 节点）
		if (newType === 'output') {
			const ctxNode = [...this.pipe.nodes].reverse().find((n) => n.type === 'context');
			if (ctxNode) inDef.citations = `{{${ctxNode.id}.citations}}`;
		}
		return inDef;
	}

	/** 删除节点（按索引）。 */
	private deleteNode(index: number): void {
		if (this.pipe.nodes.length <= 1) {
			new Notice('至少保留一个节点', 3000);
			return;
		}
		this.pipe.nodes.splice(index, 1);
		this.render();
	}

	/** 上移/下移节点。 */
	private moveNode(index: number, dir: -1 | 1): void {
		const target = index + dir;
		if (target < 0 || target >= this.pipe.nodes.length) return;
		const nodes = this.pipe.nodes;
		[nodes[index]!, nodes[target]!] = [nodes[target]!, nodes[index]!];
		this.render();
	}

	// ───────── 保存 ─────────

	private async save(): Promise<void> {
		// 递归收集参数（含 branch 子节点）
		this.collectParams(this.pipe.nodes);
		// 校验：至少有一个 input 节点
		if (!this.pipe.nodes.some((n) => n.type === 'input')) {
			new Notice('流水线需要至少一个 input 节点', 0);
			return;
		}
		const json = JSON.stringify({ version: this.pipe.version ?? 1, nodes: this.pipe.nodes }, null, 2);
		try { JSON.parse(json); } catch { new Notice('保存失败：内部错误', 0); return; }
		await this.plugin.app.vault.adapter.write(this.path, json);
		new Notice('✅ 流水线已保存，下次对话即生效。', 4000);
		this.close();
	}

	/** 递归遍历节点（含 branch 子流），从 DOM 收集参数。 */
	private collectParams(nodes: NodeDef[]): void {
		for (const node of nodes) {
			const params: Record<string, unknown> = {};
			const els = this.contentEl.querySelectorAll<HTMLElement>(`[data-node-id="${node.id}"]`);
			els.forEach((el) => {
				const key = el.dataset.param!;
				const pType = el.dataset.pType!;
				if (pType === 'toggle') params[key] = (el as HTMLInputElement).checked;
				else if (pType === 'number') {
					const n = parseFloat((el as HTMLInputElement).value);
					params[key] = isNaN(n) ? 0 : n;
				} else params[key] = (el as HTMLInputElement | HTMLTextAreaElement).value;
			});
			if (Object.keys(params).length > 0) node.params = params;
			// 递归 branch 子流
			if (node.branches) {
				this.collectParams(node.branches.then);
				this.collectParams(node.branches.else);
			}
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
