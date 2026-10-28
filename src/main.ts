import { App, Modal, Notice, Plugin, TFile, WorkspaceLeaf } from 'obsidian';
import { ChatResult, errMsg, OllamaClient } from './ollama';
import { Chunker, RawChunk } from './chunker';
import { VectorStore, type IncrementalResult, type RebuildResult } from './store';
import { search, type SearchHit } from './search';
import { TonyAIKBView, TONY_AI_KB_VIEW_TYPE } from './view';
import { Rag } from './rag';
import { DEFAULT_SETTINGS, migrateSettings, TonyAIKBSettingTab, type TonyAIKBSettings } from './settings';
import { PipelineEditorModal } from './pipeline-editor';

const STORE_PATH = '.obsidian/plugins/tony-ai-kb-plugin/store.json';
const PIPELINE_PATH = '.obsidian/plugins/tony-ai-kb-plugin/pipeline.json';
const HISTORY_PATH = '.obsidian/plugins/tony-ai-kb-plugin/history.json';
const EMBED_BATCH_SIZE = 32;
const VECTOR_DECIMALS = 6;

export default class TonyAIKBPlugin extends Plugin {
	ollama!: OllamaClient;
	chunker!: Chunker;
	store!: VectorStore;
	rag!: Rag;
	settings!: TonyAIKBSettings;
	private incrementalTimer: number | null = null;

	async onload() {
		await this.loadSettings();
		const s = this.settings;
		const chat = s.chatProfiles[s.chatProvider] ?? s.chatProfiles.ollama;
		const emb = s.embeddingProfiles[(s.embeddingProvider === "openai" ? "openai" : "ollama") as "ollama" | "openai"] ?? s.embeddingProfiles.ollama;
		this.chunker = new Chunker(this.app);
		this.ollama = new OllamaClient({
			url: s.chatProfiles.ollama.baseUrl,
			embeddingModel: emb.model,
			chatModel: chat.model,
			provider: s.chatProvider,
			providerBaseUrl: chat.baseUrl,
			apiKey: chat.apiKey,
			embeddingProvider: s.embeddingProvider,
			embeddingBaseUrl: emb.baseUrl,
			embeddingApiKey: emb.apiKey,
		});
		this.store = new VectorStore(this.app, this.chunker, this.ollama, {
			path: STORE_PATH,
			embeddingModel: emb.model,
			batchSize: EMBED_BATCH_SIZE,
			roundDecimals: VECTOR_DECIMALS,
		});
		this.rag = new Rag(this.app, this.ollama, this.store, PIPELINE_PATH);

		this.registerView(TONY_AI_KB_VIEW_TYPE, (leaf: WorkspaceLeaf) =>
			new TonyAIKBView(leaf, this.ollama, this.store, this.rag, this),
		);

		this.addRibbonIcon('search', 'Tony AI KB', () => {
			void this.activateView();
		});

		this.addCommand({
			id: 'open-tony-ai-kb',
			name: 'Open Tony AI KB view',
			callback: () => {
				void this.activateView();
			},
		});

		this.addCommand({
			id: 'ping-ollama',
			name: 'Ping Ollama',
			callback: () => {
				void this.pingOllama();
			},
		});

		this.addCommand({
			id: 'chunk-current-file',
			name: 'Chunk current file',
			callback: () => {
				void this.chunkCurrentFile();
			},
		});

		this.addCommand({
			id: 'rebuild-index',
			name: 'Rebuild index',
			callback: () => {
				void this.rebuildIndex();
			},
		});

		this.addCommand({
			id: 'embed-current-file',
			name: 'Embed current file (smoke test)',
			callback: () => {
				void this.embedCurrentFile();
			},
		});

		this.addCommand({
			id: 'search-dev-test',
			name: 'Search (dev test)',
			callback: () => {
				void this.searchDev();
			},
		});

		this.addCommand({
			id: 'reindex-current-file',
			name: 'Re-index current file',
			callback: () => {
				void this.reindexCurrentFile();
			},
		});

		this.addCommand({
			id: 'incremental-update',
			name: 'Incremental update (scan)',
			callback: () => {
				void this.runIncrementalUpdate();
			},
		});

		this.addCommand({
			id: 'ask-rag-dev-test',
			name: 'Ask (RAG dev test)',
			callback: () => {
				void this.askRag();
			},
		});

		// M7：vault 事件 → 节流增量。registerEvent 自动随插件卸载解绑。
		const trigger = (file: unknown) => {
			if (!this.settings.autoReindexOnSave) return;
			if (file instanceof TFile && file.extension === 'md') this.scheduleIncremental();
		};
		this.registerEvent(this.app.vault.on('modify', trigger));
		this.registerEvent(this.app.vault.on('create', trigger));
		this.registerEvent(this.app.vault.on('delete', trigger));
		this.registerEvent(this.app.vault.on('rename', (file) => trigger(file)));

		this.addCommand({
			id: 'edit-pipeline',
			name: 'Edit pipeline.json',
			callback: () => {
				void this.editPipeline();
			},
		});

		this.addSettingTab(new TonyAIKBSettingTab(this.app, this));

		// 启动兜底：加载后自动增量一次（静默），对齐外部脚本生成的旁车/离线修改的文件
		// （vault 事件只覆盖 Obsidian 内的改动；Python 抽取脚本在 Obsidian 外写盘，事件不可靠）
		if (this.settings.autoReindexOnSave) {
			this.incrementalTimer = window.setTimeout(() => {
				this.incrementalTimer = null;
				void this.runIncrementalUpdate(true);
			}, 8000); // 等 Obsidian 完成库索引后再扫，延迟 8s
		}

		console.log('[tony-ai-kb] loaded; M10 complete. Commands: Ping Ollama, Chunk current file, Rebuild index, Embed current file, Search (dev test), Open Tony AI KB view, Re-index current file, Incremental update (scan), Ask (RAG dev test), Edit pipeline.json');
	}

	/** 激活/收起 Tony AI KB 侧边栏视图（toggle）。 */
	private async activateView(): Promise<void> {
		const { app } = this;
		const existing = app.workspace.getLeavesOfType(TONY_AI_KB_VIEW_TYPE);
		if (existing.length > 0) {
			existing[0]!.detach();
			return;
		}
		const leaf = app.workspace.getRightLeaf(false);
		if (!leaf) return;
		await leaf.setViewState({ type: TONY_AI_KB_VIEW_TYPE, state: {} });
		app.workspace.revealLeaf(leaf);
	}

	async loadSettings(): Promise<void> {
		const raw = (await this.loadData()) as Record<string, unknown> | null;
		this.settings = migrateSettings(raw);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	/** 设置变更后即时刷新 client（从当前选中的 profile 取值，无硬编码）。 */
	applySettingsToClients(): void {
		const s = this.settings;
		const chat = s.chatProfiles[s.chatProvider] ?? s.chatProfiles.ollama;
		const emb = s.embeddingProfiles[(s.embeddingProvider === "openai" ? "openai" : "ollama") as "ollama" | "openai"] ?? s.embeddingProfiles.ollama;
		this.ollama.url = s.chatProfiles.ollama.baseUrl;
		this.ollama.provider = s.chatProvider;
		this.ollama.providerBaseUrl = chat.baseUrl;
		this.ollama.apiKey = chat.apiKey;
		this.ollama.chatModel = chat.model;
		this.ollama.embeddingProvider = s.embeddingProvider;
		this.ollama.embeddingBaseUrl = emb.baseUrl;
		this.ollama.embeddingApiKey = emb.apiKey;
		this.ollama.embeddingModel = emb.model;
		// 向量库的 embedding 模型随 profile 变化（重建时生效）
		this.store.opts.embeddingModel = emb.model;
	}

	/** 测试指定协议链路连通（设置面板「测试连通」按钮）。 */
	async testProvider(kind: string, _role: 'chat'): Promise<{ ok: boolean; msg: string }> {
		const s = this.settings;
		const k = kind as 'ollama' | 'openai' | 'anthropic';
		const profile = s.chatProfiles[k];
		if (!profile) return { ok: false, msg: '未知协议' };
		const url = profile.baseUrl.replace(/\/+$/, '');
		try {
			if (k === 'ollama') {
				// 用 1 token chat 探活
				const res = await fetch(`${url}/api/chat`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ model: profile.model, messages: [{ role: 'user', content: 'hi' }], stream: false, think: false, options: { num_predict: 1 } }),
				});
				if (!res.ok) return { ok: false, msg: `HTTP ${res.status}` };
				return { ok: true, msg: '' };
			}
			if (k === 'openai') {
				const res = await fetch(`${url}/chat/completions`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json', ...(profile.apiKey ? { Authorization: `Bearer ${profile.apiKey}` } : {}) },
					body: JSON.stringify({ model: profile.model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
				});
				if (!res.ok) return { ok: false, msg: `HTTP ${res.status}` };
				return { ok: true, msg: '' };
			}
			// anthropic
			const res = await fetch(`${url}/v1/messages`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'x-api-key': profile.apiKey, 'anthropic-version': '2023-06-01' },
				body: JSON.stringify({ model: profile.model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
			});
			if (!res.ok) return { ok: false, msg: `HTTP ${res.status}` };
			return { ok: true, msg: '' };
		} catch (e: any) {
			return { ok: false, msg: e?.message ?? '网络错误' };
		}
	}

	/** 编辑 pipeline.json（M10：JSON 文本编辑器；设置面板与视图入口共用）。 */
	async editPipeline(): Promise<void> {
		new PipelineEditorModal(this.app, this, PIPELINE_PATH).open();
	}

	onunload() {
		if (this.incrementalTimer !== null) window.clearTimeout(this.incrementalTimer);
		console.log('[tony-ai-kb] unloaded');
	}

	/** 节流触发增量更新（编辑/创建/删除/重命名 md 后）。 */
	private scheduleIncremental(delayMs?: number): void {
		if (this.incrementalTimer !== null) window.clearTimeout(this.incrementalTimer);
		this.incrementalTimer = window.setTimeout(() => {
			this.incrementalTimer = null;
			void this.runIncrementalUpdate();
		}, delayMs ?? this.settings.autoReindexDelayMs);
	}

	/** 增量扫描 + 重嵌变化文件。quiet=true 时不弹无变化 Notice（启动兜底静默用）。 */
	private async runIncrementalUpdate(quiet = false): Promise<void> {
		if (!this.store.store) return; // 库未建，跳过（避免误触发全量）
		const progress = new ProgressNotice();
		progress.show('增量更新：扫描中…');
		try {
			const r: IncrementalResult = await this.store.incrementalUpdate(
				(_d, _t, label) => progress.show(label),
			);
			progress.hide();
			if (r.changed === 0 && r.deleted === 0) {
				if (!quiet) new Notice(`增量：无变化（扫描 ${r.scanned} 文件）`, 3000);
				return;
			}
			const lines = [
				`✅ 增量更新完成`,
				`扫描 ${r.scanned} / 变更 ${r.changed}（新增 ${r.newFiles}）/ 删除 ${r.deleted}`,
				`重嵌 ${r.reindexedChunks} 片段 / 总计 ${r.totalChunks}`,
				`耗时 ${(r.ms / 1000).toFixed(1)}s`,
			];
			this.showResult(lines);
			console.log('[tony-ai-kb] incremental', r);
		} catch (e) {
			progress.hide();
			new Notice(`增量失败：${errMsg(e)}`, 0);
			console.error('[tony-ai-kb] incremental failed', e);
		}
	}

	/** 重嵌当前活动文件。 */
	private async reindexCurrentFile(): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		if (!file || file.extension !== 'md') {
			new Notice('请先打开一个 Markdown 文件');
			return;
		}
		if (!this.store.store) {
			new Notice('库未就绪，请先 Rebuild index', 0);
			return;
		}
		const progress = new ProgressNotice();
		progress.show(`重嵌 ${file.name}…`);
		try {
			const r = await this.store.reindexFiles([file]);
			progress.hide();
			const lines = [
				`✅ 重嵌完成：${file.name}`,
				`片段 ${r.reindexedChunks} / 总计 ${this.store.store?.chunks.length ?? 0}`,
			];
			this.showResult(lines);
			console.log('[tony-ai-kb] reindex file', file.path, r);
		} catch (e) {
			progress.hide();
			new Notice(`重嵌失败：${errMsg(e)}`, 0);
			console.error('[tony-ai-kb] reindex file failed', e);
		}
	}

	/** 诊断远端连通性：bge-m3 维度 + qwen3.5:9b think:false 就绪状态。 */
	private async pingOllama(): Promise<void> {
		const notice = new Notice('正在 ping Ollama …', 0);
		const lines: string[] = [];

		// 1) embedding 模型：取一个向量，确认维度
		try {
			const vec = await this.ollama.getEmbedding('ping');
			lines.push(`✅ ${this.ollama.embeddingModel}: 联通，维度 ${vec.length}（已 L2 归一化）`);
		} catch (e) {
			lines.push(`❌ ${this.ollama.embeddingModel}: ${errMsg(e)}`);
		}

		// 2) chat 模型：think:false 关思考，要它只回 pong
		try {
			const r: ChatResult = await this.ollama.chat('请只回复两个字：pong', {
				think: false,
				temperature: 0,
			});
			const echo = r.content.trim().replace(/\s+/g, ' ').slice(0, 24);
			lines.push(`✅ ${this.ollama.chatModel}: 联通，think:false 已生效，回声 "${echo}"`);
		} catch (e) {
			lines.push(`❌ ${this.ollama.chatModel}: ${errMsg(e)}`);
		}

		notice.hide();
		this.showResult(lines);
		console.log('[tony-ai-kb] ping result', lines);
	}

	/** 全量重建向量库：切片 → 批量向量化 → 落盘，带进度 Notice + 完成报告。 */
	private async rebuildIndex(): Promise<void> {
		const progress = new ProgressNotice();
		progress.show('重建索引：准备中…');
		let lastLabel = '准备中';
		try {
			const r: RebuildResult = await this.store.rebuild(
				(_done, _total, label) => {
					lastLabel = label;
					progress.show(label);
				},
			);
			const sec = (r.ms / 1000).toFixed(1);
			const lines = [
				`✅ 索引重建完成`,
				`文件 ${r.files}（跳过 ${r.skippedFiles}）/ 片段 ${r.chunks}`,
				`模型 ${this.ollama.embeddingModel} / 维度 ${r.dim}`,
				`耗时 ${sec}s / ${(r.chunks / (r.ms / 1000)).toFixed(0)} 片段/秒`,
				`落盘 ${STORE_PATH}`,
			];
			progress.hide();
			this.showResult(lines);
			console.log('[tony-ai-kb] rebuild done', r);
		} catch (e) {
			progress.hide();
			// 常驻错误 Notice，带最后进度，便于定位失败阶段
			new Notice(`重建失败（停在：${lastLabel}）：${errMsg(e)}`, 0);
			console.error('[tony-ai-kb] rebuild failed at', lastLabel, e);
		}
	}

	/** 烟雾测试：只对当前活动文件跑完整链路（切片→批量向量化），不动 store。 */
	private async embedCurrentFile(): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		if (!file || file.extension !== 'md') {
			new Notice('请先打开一个 Markdown 文件');
			return;
		}
		const progress = new ProgressNotice();
		progress.show(`切片 ${file.name}…`);
		let chunks: RawChunk[];
		try {
			chunks = await this.chunker.chunkFile(file);
		} catch (e) {
			progress.hide();
			new Notice(`切片失败：${errMsg(e)}`, 0);
			return;
		}
		if (chunks.length === 0) {
			progress.hide();
			new Notice(`${file.name}: 切片为空（无有效内容）`, 0);
			return;
		}
		progress.show(`向量化 ${chunks.length} 片段…`);
		try {
			const vecs = await this.ollama.embedBatch(chunks.map((c) => c.content));
			const dim = vecs[0]?.length ?? 0;
			progress.hide();
			const lines = [
				`✅ ${file.name} 烟雾测试通过`,
				`片段 ${chunks.length} / 维度 ${dim}`,
				`首片段 header: ${chunks[0]!.header.slice(0, 40)}`,
				`向量化全部成功，链路 OK`,
			];
			this.showResult(lines);
			console.log('[tony-ai-kb] embed smoke', { chunks: chunks.length, dim });
		} catch (e) {
			progress.hide();
			new Notice(`向量化失败：${errMsg(e)}`, 0);
			console.error('[tony-ai-kb] embed smoke failed', e);
		}
	}

	/** 切片当前活动文件，console 打印结果用于 M3 肉眼验证。 */
	private async chunkCurrentFile(): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		if (!file || file.extension !== 'md') {
			new Notice('请先打开一个 Markdown 文件');
			return;
		}
		let chunks: RawChunk[];
		try {
			chunks = await this.chunker.chunkFile(file);
		} catch (e) {
			new Notice(`切片失败：${errMsg(e)}`, 8000);
			return;
		}

		const summary = chunks.map((c, i) => ({
			'#': i + 1,
			header: c.header.slice(0, 30),
			line: c.lineStart,
			chars: c.content.length,
			preview: c.content.replace(/\n/g, ' ').slice(0, 60),
		}));

		console.group(`[tony-ai-kb] chunk: ${file.path} → ${chunks.length} 片段`);
		console.table(summary);
		console.log('raw chunks:', chunks);
		console.groupEnd();

		new Notice(`${file.name}: ${chunks.length} 片段（详见 Console，Ctrl+Shift+I）`, 8000);
	}

	/** M5 检索验证：输入 query → 向量化 → 余弦 Top-K → console.table + Notice。 */
	private async searchDev(): Promise<void> {
		if (!this.store.store) {
			const loaded = await this.store.load();
			if (!loaded || !loaded.complete) {
				new Notice('向量库未就绪，请先 Rebuild index', 0);
				return;
			}
		}
		new InputModal(this.app, '搜索查询', '输入问题/关键词…', async (q) => {
			const query = q.trim();
			if (!query) return;
			const progress = new ProgressNotice();
			progress.show('向量化查询…');
			try {
				const qv = await this.ollama.getEmbedding(query);
				progress.show('检索中…');
				const store = this.store.store!;
				const t0 = Date.now();
				const hits: SearchHit[] = search(qv, store.chunks, 5);
				const ms = Date.now() - t0;
				progress.hide();
				const summary = hits.map((h, i) => ({
					'#': i + 1,
					score: Number(h.score.toFixed(4)),
					file: h.chunk.file,
					header: h.chunk.header.slice(0, 24),
					line: h.chunk.lineStart,
					preview: h.chunk.content.replace(/\n/g, ' ').slice(0, 50),
				}));
				console.group(`[tony-ai-kb] search: "${query}" → ${hits.length} hits in ${ms}ms`);
				console.table(summary);
				console.log('raw hits:', hits);
				console.groupEnd();
				const lines = [
					`🔍 "${query}"`,
					`检索 ${ms}ms / ${store.chunks.length} 片段`,
					...hits.map((h, i) => `${i + 1}. ${h.score.toFixed(3)} ${h.chunk.file} · ${h.chunk.header.slice(0, 20)}`),
				];
				this.showResult(lines);
			} catch (e) {
				progress.hide();
				new Notice(`检索失败：${errMsg(e)}`, 0);
				console.error('[tony-ai-kb] search failed', e);
			}
		}).open();
	}

	/** M8 RAG 端到端：输入问题 → 跑流水线 → console 打印每节点 I/O + 最终答案 + 引用。 */
	private askRag(): void {
		if (!this.store.store) {
			void this.store.load().then((l) => {
				if (!l || !l.complete) {
					new Notice('库未就绪，请先 Rebuild index', 0);
					return;
				}
				this.openAskModal();
			});
			return;
		}
		this.openAskModal();
	}

	private openAskModal(): void {
		new InputModal(this.app, 'RAG 问答', '输入问题…', (q) => {
			const query = q.trim();
			if (!query) return;
			void this.runRag(query);
		}).open();
	}

	private async runRag(query: string): Promise<void> {
		const progress = new ProgressNotice();
		progress.show('RAG：检索+生成中…');
		const t0 = Date.now();
		try {
			const r = await this.rag.run(query, (id, type, inputs, outputs) => {
				console.log(`[tony-ai-kb] node ${id}(${type})`, 'in=', inputs, 'out=', outputs);
			});
			progress.hide();
			const sec = ((Date.now() - t0) / 1000).toFixed(1);
			console.group(`[tony-ai-kb] RAG: "${query}" (${sec}s, model=${r.model ?? '?'})`);
			console.log('answer:', r.answer);
			console.log('citations:', r.citationList);
			console.log('all node outputs:', r.outputs);
			console.groupEnd();
			const lines = [
				`💬 "${query}"`,
				`模型 ${r.model ?? '?'} / ${sec}s`,
				r.answer.slice(0, 400),
				'— 引用 —',
				r.citationList.slice(0, 600),
			];
			this.showResult(lines);
		} catch (e) {
			progress.hide();
			new Notice(`RAG 失败：${errMsg(e)}`, 0);
			console.error('[tony-ai-kb] rag failed', e);
		}
	}

	/** 多行结果用 Notice 渲染（默认 Notice 不换行，故用 fragment）。 */
	private showResult(lines: string[]): void {
		const frag = document.createDocumentFragment();
		for (const line of lines) {
			frag.appendChild(createEl('div', { text: line }));
		}
		new Notice(frag, 12_000);
	}
}

/** 进度 Notice：recreate 模式更新文本（Obsidian Notice 无公开 setMessage）。 */
class ProgressNotice {
	private notice: Notice | null = null;

	show(message: string): void {
		this.notice?.hide();
		this.notice = new Notice(message, 0);
	}

	hide(): void {
		this.notice?.hide();
		this.notice = null;
	}
}

/** 简易输入框 Modal：用于 M5/M9 输入查询。 */
class InputModal extends Modal {
	private inputEl!: HTMLInputElement;

	constructor(
		app: App,
		private readonly titleText: string,
		private readonly placeholder: string,
		private readonly onSubmit: (value: string) => void,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl, titleEl } = this;
		titleEl.setText(this.titleText);
		const form = contentEl.createEl('form');
		this.inputEl = form.createEl('input', { type: 'text' });
		this.inputEl.placeholder = this.placeholder;
		this.inputEl.style.cssText = 'width:100%;padding:6px 8px;margin-bottom:8px;';
		const btn = form.createEl('button', { text: '搜索', type: 'submit' });
		btn.style.cssText = 'padding:6px 14px;';
		form.addEventListener('submit', (e) => {
			e.preventDefault();
			const v = this.inputEl.value;
			this.close();
			this.onSubmit(v);
		});
		setTimeout(() => this.inputEl.focus(), 50);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

// PipelineEditorModal 已移至 src/pipeline-editor.ts（图形化编辑器）
