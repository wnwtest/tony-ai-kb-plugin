import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import type TonyAIKBPlugin from './main';
import { OllamaClient, type ProviderKind } from './ollama';

/** 单个供应商配置：Base URL + API Key + 模型名。三套并存，切换不丢失。 */
export interface ProviderProfile {
	baseUrl: string;   // ollama: http://…:11434；openai: …/v1；anthropic: https://api.anthropic.com
	apiKey: string;    // ollama 不需要
	model: string;     // 该协议下使用的模型
}

export interface TonyAIKBSettings {
	// 当前选中的协议
	chatProvider: ProviderKind;
	embeddingProvider: ProviderKind;
	// 三套 chat 配置（按协议存，切换不丢）
	chatProfiles: Record<ProviderKind, ProviderProfile>;
	// 两套 embedding 配置（anthropic 无 embedding API）
	embeddingProfiles: Record<'ollama' | 'openai', ProviderProfile>;

	think: boolean;
	temperature: number;
	topK: number;
	maxContextChars: number;
	minChunkLen: number;
	autoReindexOnSave: boolean;
	autoReindexDelayMs: number;
	persistHistory: boolean;
	skillIndex: number;
}

export const DEFAULT_SETTINGS: TonyAIKBSettings = {
	chatProvider: 'ollama',
	embeddingProvider: 'ollama',
	chatProfiles: {
		ollama: { baseUrl: 'http://localhost:11434', apiKey: '', model: 'qwen3.5:9b' },
		openai: { baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-4o-mini' },
		anthropic: { baseUrl: 'https://api.anthropic.com', apiKey: '', model: 'claude-sonnet-4-20250514' },
	},
	embeddingProfiles: {
		ollama: { baseUrl: 'http://localhost:11434', apiKey: '', model: 'bge-m3' },
		openai: { baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'text-embedding-3-small' },
	},

	think: false,
	temperature: 0.3,
	topK: 5,
	maxContextChars: 6000,
	minChunkLen: 200,
	autoReindexOnSave: true,
	autoReindexDelayMs: 5000,
	persistHistory: true,
	skillIndex: 0,
};

/** 从旧版扁平设置迁移到 profiles 结构（loadSettings 时调用一次）。 */
export function migrateSettings(raw: Record<string, unknown> | null): TonyAIKBSettings {
	const s = structuredClone(DEFAULT_SETTINGS);
	if (!raw) return s;
	// 旧字段平移
	if (typeof raw.ollamaUrl === 'string' && raw.ollamaUrl) {
		s.chatProfiles.ollama.baseUrl = raw.ollamaUrl;
		s.embeddingProfiles.ollama.baseUrl = raw.ollamaUrl;
	}
	if (typeof raw.chatModel === 'string' && raw.chatModel) s.chatProfiles.ollama.model = raw.chatModel;
	if (typeof raw.embeddingModel === 'string' && raw.embeddingModel) s.embeddingProfiles.ollama.model = raw.embeddingModel;
	if (typeof raw.provider === 'string') s.chatProvider = raw.provider as ProviderKind;
	if (typeof raw.embeddingProvider === 'string') s.embeddingProvider = raw.embeddingProvider as ProviderKind;
	if (typeof raw.providerBaseUrl === 'string' && raw.providerBaseUrl) {
		const p = s.chatProfiles[s.chatProvider];
		if (p) p.baseUrl = raw.providerBaseUrl;
	}
	if (typeof raw.apiKey === 'string' && raw.apiKey) {
		const p = s.chatProfiles[s.chatProvider];
		if (p) p.apiKey = raw.apiKey;
	}
	if (typeof raw.embeddingBaseUrl === 'string' && raw.embeddingBaseUrl) s.embeddingProfiles.openai.baseUrl = raw.embeddingBaseUrl;
	if (typeof raw.embeddingApiKey === 'string' && raw.embeddingApiKey) s.embeddingProfiles.openai.apiKey = raw.embeddingApiKey;
	// 新结构直接合并
	if (raw.chatProfiles && typeof raw.chatProfiles === 'object') {
		const cp = raw.chatProfiles as Record<string, Partial<ProviderProfile>>;
		for (const k of ['ollama', 'openai', 'anthropic'] as ProviderKind[]) {
			if (cp[k]) s.chatProfiles[k] = { ...s.chatProfiles[k], ...cp[k] } as ProviderProfile;
		}
	}
	if (raw.embeddingProfiles && typeof raw.embeddingProfiles === 'object') {
		const ep = raw.embeddingProfiles as Record<string, Partial<ProviderProfile>>;
		for (const k of ['ollama', 'openai'] as const) {
			if (ep[k]) s.embeddingProfiles[k] = { ...s.embeddingProfiles[k], ...ep[k] } as ProviderProfile;
		}
	}
	if (typeof raw.chatProvider === 'string') s.chatProvider = raw.chatProvider as ProviderKind;
	if (typeof raw.embeddingProvider === 'string') s.embeddingProvider = raw.embeddingProvider as ProviderKind;
	// 其余标量
	for (const key of ['think', 'temperature', 'topK', 'maxContextChars', 'minChunkLen',
		'autoReindexOnSave', 'autoReindexDelayMs', 'persistHistory', 'skillIndex'] as const) {
		if (raw[key] !== undefined) (s as any)[key] = raw[key];
	}
	return s;
}

export class TonyAIKBSettingTab extends PluginSettingTab {
	plugin: TonyAIKBPlugin;

	constructor(app: App, plugin: TonyAIKBPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		const s = this.plugin.settings;
		containerEl.empty();

		new Setting(containerEl)
			.setName('编辑流水线（pipeline.json）')
			.setDesc('打开节点 DSL 编辑器（input→embed→retrieve→context→chat→output）')
			.addButton((b) => b.setButtonText('打开编辑器').onClick(() => {
				(this.plugin as any).editPipeline();
			}));

		// ───── Chat 供应商：单块结构（协议+URL+Key+模型 三行）+ 整块一个 Apply ─────
		containerEl.createEl('h3', { text: 'Chat 供应商' });
		this.renderProviderCard(containerEl, {
			title: 'Chat',
			kinds: ['ollama', 'openai', 'anthropic'],
			currentKind: () => s.chatProvider,
			profiles: () => s.chatProfiles,
			onApplyProvider: (k) => { s.chatProvider = k; },
			modelHint: '生成模型；可输入或从列表选择',
			embHint: false,
		});

		// ───── Embedding 供应商：同构单块 ─────
		containerEl.createEl('h3', { text: 'Embedding 供应商' });
		this.renderProviderCard(containerEl, {
			title: 'Embedding',
			kinds: ['ollama', 'openai'],
			currentKind: () => (s.embeddingProvider === 'anthropic' ? 'ollama' : s.embeddingProvider) as 'ollama' | 'openai',
			profiles: () => s.embeddingProfiles as Record<'ollama' | 'openai', ProviderProfile>,
			onApplyProvider: (k) => { s.embeddingProvider = k; },
			modelHint: '嵌入模型（切换 Apply 后需 Rebuild index）',
			embHint: true,
		});

		containerEl.createEl('p', {
			text: '每个供应商一个 Apply：修改协议/URL/Key/模型后统一提交生效（按钮变黄=有未应用修改）。三套配置独立保存，切协议只是切换编辑对象，不 Apply 不落盘。',
			cls: 'setting-item-description',
		});

		containerEl.createEl('h3', { text: 'RAG 生成' });
		new Setting(containerEl)
			.setName('关闭思考模式 (think)')
			.setDesc('关闭 qwen 思考链，集中回答主问（推荐开）')
			.addToggle((t) => t.setValue(!s.think).onChange(async (v) => {
				s.think = !v; await this.save();
			}));
		new Setting(containerEl)
			.setName('生成温度')
			.setDesc('0–1，RAG 偏低（默认 0.3）')
			.addText((t) => t.setValue(String(s.temperature)).onChange(async (v) => {
				const n = parseFloat(v); if (!isNaN(n)) { s.temperature = n; await this.save(); }
			}));
		new Setting(containerEl)
			.setName('检索 Top-K')
			.setDesc('纯检索模式返回数')
			.addText((t) => t.setValue(String(s.topK)).onChange(async (v) => {
				const n = parseInt(v); if (!isNaN(n)) { s.topK = n; await this.save(); }
			}));
		new Setting(containerEl)
			.setName('上下文最大字符')
			.setDesc('RAG 拼入 prompt 的片段总字符上限')
			.addText((t) => t.setValue(String(s.maxContextChars)).onChange(async (v) => {
				const n = parseInt(v); if (!isNaN(n)) { s.maxContextChars = n; await this.save(); }
			}));

		containerEl.createEl('h3', { text: '切片与增量' });
		new Setting(containerEl)
			.setName('最小片段长度')
			.setDesc('短于此长度的片段合并入相邻（默认 200）')
			.addText((t) => t.setValue(String(s.minChunkLen)).onChange(async (v) => {
				const n = parseInt(v); if (!isNaN(n)) { s.minChunkLen = n; await this.save(); }
			}));
		new Setting(containerEl)
			.setName('编辑后自动增量')
			.setDesc('笔记修改后延迟自动增量重嵌')
			.addToggle((t) => t.setValue(s.autoReindexOnSave).onChange(async (v) => {
				s.autoReindexOnSave = v; await this.save();
			}));
		new Setting(containerEl)
			.setName('增量延迟（毫秒）')
			.setDesc('编辑后静默多久再触发增量')
			.addText((t) => t.setValue(String(s.autoReindexDelayMs)).onChange(async (v) => {
				const n = parseInt(v); if (!isNaN(n)) { s.autoReindexDelayMs = n; await this.save(); }
			}));

		containerEl.createEl('h3', { text: '其他' });
		new Setting(containerEl)
			.setName('持久化对话历史')
			.setDesc('对话记录落盘 history.json')
			.addToggle((t) => t.setValue(s.persistHistory).onChange(async (v) => {
				s.persistHistory = v; await this.save();
			}));

		containerEl.createEl('p', {
			text: '修改 Embedding 模型后需「Rebuild index」重建向量库；修改 Chat 模型/温度/think 即时生效。设置保存在 data.json。',
			cls: 'setting-item-description',
		});
	}

	/**
	 * 供应商单块卡片：协议 + Base URL + (API Key) + 模型组合框，**整块一个 Apply**。
	 * 切协议 = 切换编辑对象（草稿不丢、不落盘）；Apply = 协议选择 + 当前编辑值统一提交。
	 */
	private renderProviderCard(
		container: HTMLElement,
		cfg: {
			title: string;
			kinds: readonly ProviderKind[];
			currentKind: () => ProviderKind;
			profiles: () => Record<string, ProviderProfile>;
			onApplyProvider: (k: ProviderKind) => void;
			modelHint: string;
			embHint: boolean;
		},
	): void {
		const s = this.plugin.settings;
		const card = container.createDiv({ cls: 'tk-provider-block' });

		// 编辑态草稿（不点 Apply 不落盘）
		let draftKind: ProviderKind = cfg.currentKind();
		let draftUrl = '';
		let draftKey = '';
		let draftModel = '';

		const loadDraft = (): void => {
			const p = cfg.profiles()[draftKind]!;
			draftUrl = p.baseUrl;
			draftKey = p.apiKey;
			draftModel = p.model;
		};
		loadDraft();

		// ── 第一行：协议 + Base URL + 模型（三列） ──
		const gridRow = card.createDiv({ cls: 'tk-pv-grid' });

		// 协议列
		const kindCell = gridRow.createDiv({ cls: 'tk-pv-cell' });
		kindCell.createEl('label', { cls: 'tk-pv-label', text: '协议' });
		const kindSel = kindCell.createEl('select', { cls: 'tk-pv-input dropdown' }) as HTMLSelectElement;
		const kindNames: Record<string, string> = { ollama: 'Ollama', openai: 'OpenAI 兼容', anthropic: 'Anthropic' };
		for (const k of cfg.kinds) kindSel.createEl('option', { value: k, text: kindNames[k] ?? k });
		kindSel.value = draftKind;

		// URL 列
		const urlCell = gridRow.createDiv({ cls: 'tk-pv-cell tk-pv-grow' });
		urlCell.createEl('label', { cls: 'tk-pv-label', text: 'Base URL' });
		const urlInput = urlCell.createEl('input', { type: 'text', cls: 'tk-pv-input' }) as HTMLInputElement;
		urlInput.value = draftUrl;

		// 模型列（组合框 + 获取按钮）
		const modelCell = gridRow.createDiv({ cls: 'tk-pv-cell tk-pv-grow' });
		modelCell.createEl('label', { cls: 'tk-pv-label', text: `模型（${cfg.modelHint}）` });
		const modelRow = modelCell.createDiv({ cls: 'tk-pv-modelrow' });
		const listId = `tk-pv-list-${cfg.title}`;
		const modelInput = modelRow.createEl('input', { type: 'text', cls: 'tk-pv-input' }) as HTMLInputElement;
		modelInput.setAttribute('list', listId);
		modelInput.value = draftModel;
		const datalist = modelRow.createEl('datalist', { attr: { id: listId } });
		datalist.createEl('option', { value: draftModel });
		const fetchBtn = modelRow.createEl('button', { cls: 'tk-pv-fetch', text: '↻' });
		fetchBtn.title = '获取模型列表';

		// API Key 行（非 ollama 显示）
		const keyRow = card.createDiv({ cls: 'tk-pv-grid' });
		const keyCell = keyRow.createDiv({ cls: 'tk-pv-cell tk-pv-grow' });
		keyCell.createEl('label', { cls: 'tk-pv-label', text: 'API Key（仅保存在本机 data.json）' });
		const keyInput = keyCell.createEl('input', { type: 'password', cls: 'tk-pv-input' }) as HTMLInputElement;
		keyInput.value = draftKey;

		// ── 操作行：Apply + 测试连通 ──
		const actionRow = card.createDiv({ cls: 'tk-pv-actions' });
		const applyBtn = actionRow.createEl('button', { cls: 'tk-set-apply', text: 'Apply' });
		const testBtn = actionRow.createEl('button', { cls: 'tk-provider-test', text: '测试连通' });

		const isDirty = (): boolean => {
			const saved = cfg.profiles()[draftKind]!;
			const kindChanged = draftKind !== cfg.currentKind();
			return kindChanged || urlInput.value.trim() !== saved.baseUrl
				|| keyInput.value !== saved.apiKey || modelInput.value.trim() !== saved.model;
		};
		const refreshDirty = (): void => { applyBtn.classList.toggle('is-dirty', isDirty()); };
		const refreshKeyRow = (): void => { keyRow.style.display = draftKind === 'ollama' ? 'none' : ''; };

		// 切协议：加载该协议草稿（覆盖未 Apply 的编辑，提示用 confirm 太重——直接切换，未 Apply 修改丢弃前给 Notice）
		kindSel.addEventListener('change', () => {
			if (isDirty()) new Notice('切换协议：未 Apply 的修改已丢弃', 2500);
			draftKind = kindSel.value as ProviderKind;
			loadDraft();
			urlInput.value = draftUrl;
			keyInput.value = draftKey;
			modelInput.value = draftModel;
			datalist.empty();
			datalist.createEl('option', { value: draftModel });
			refreshKeyRow();
			refreshDirty();
		});
		for (const el of [urlInput, keyInput, modelInput]) el.addEventListener('input', refreshDirty);
		refreshKeyRow();
		refreshDirty();

		// Apply：整块统一提交（协议 + URL + Key + 模型）
		applyBtn.addEventListener('click', async () => {
			const model = modelInput.value.trim();
			if (!model) { new Notice('模型不能为空', 2500); return; }
			const profile = cfg.profiles()[draftKind]!;
			profile.baseUrl = urlInput.value.trim();
			profile.apiKey = keyInput.value;
			profile.model = model;
			cfg.onApplyProvider(draftKind); // 协议选择也在此刻生效
			await this.save();
			refreshDirty();
			applyBtn.setText('✓ 已应用');
			window.setTimeout(() => applyBtn.setText('Apply'), 1400);
		});

		// 获取模型列表：用输入框当前 URL（未 Apply 也可测）
		fetchBtn.addEventListener('click', async () => {
			fetchBtn.setText('…'); fetchBtn.disabled = true;
			try {
				const models = await OllamaClient.fetchModelList(draftKind, urlInput.value.trim(), keyInput.value);
				datalist.empty();
				for (const m of models) datalist.createEl('option', { value: m });
				if (models.length > 0 && !models.includes(modelInput.value)) {
					const saved = cfg.profiles()[draftKind]!;
					modelInput.value = models.includes(saved.model) ? saved.model : models[0]!;
					refreshDirty();
				}
				fetchBtn.setText(`✓${models.length}`);
			} catch (e: any) {
				fetchBtn.setText('✗');
				new Notice(`获取模型列表失败：${e?.message?.slice(0, 60) ?? ''}（可直接手输模型 ID）`, 3500);
			}
			window.setTimeout(() => { fetchBtn.setText('↻'); fetchBtn.disabled = false; }, 2500);
		});

		// 测试连通：用输入框当前值（未 Apply 也可测）
		testBtn.addEventListener('click', async () => {
			testBtn.setText('测试中…'); testBtn.disabled = true;
			try {
				const r = await (this.plugin as any).testProviderRaw(draftKind, urlInput.value.trim(), keyInput.value, modelInput.value.trim());
				testBtn.setText(r.ok ? '✓ 连通' : `✗ ${r.msg}`);
			} catch (e: any) {
				testBtn.setText(`✗ ${e?.message ?? '失败'}`);
			}
			window.setTimeout(() => { testBtn.setText('测试连通'); testBtn.disabled = false; }, 2800);
		});
		void s;
	}

	private async save(): Promise<void> {
		await this.plugin.saveSettings();
		this.plugin.applySettingsToClients();
	}
}
