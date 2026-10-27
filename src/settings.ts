import { App, PluginSettingTab, Setting } from 'obsidian';
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
		ollama: { baseUrl: 'http://192.168.119.219:11434', apiKey: '', model: 'qwen3.5:9b' },
		openai: { baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-4o-mini' },
		anthropic: { baseUrl: 'https://api.anthropic.com', apiKey: '', model: 'claude-sonnet-4-20250514' },
	},
	embeddingProfiles: {
		ollama: { baseUrl: 'http://192.168.119.219:11434', apiKey: '', model: 'bge-m3' },
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

		// ───── Chat 供应商（协议下拉 + Apply 式编辑；模型=可编辑组合框：输入过滤+下拉选，获取列表失败可直接手输） ─────
		containerEl.createEl('h3', { text: 'Chat 供应商' });

		new Setting(containerEl)
			.setName('协议')
			.setDesc('同一时间只有一个协议生效；各协议配置独立保存，切换不丢失')
			.addDropdown((d) => d
				.addOptions({ ollama: 'Ollama', openai: 'OpenAI 兼容', anthropic: 'Anthropic' })
				.setValue(s.chatProvider)
				.onChange(async (v) => {
					s.chatProvider = v as ProviderKind;
					await this.save();
					this.display(); // 重新渲染显示该协议的字段
				}));

		const chatProfile = s.chatProfiles[s.chatProvider];
		const chatKind = s.chatProvider;

		// Base URL：宽输入 + Apply（未 Apply 时标黄，防止误改半截 URL 就生效）
		const chatUrlRow = containerEl.createDiv({ cls: 'tk-set-row' });
		chatUrlRow.createEl('span', { cls: 'tk-set-name', text: 'Base URL' });
		chatUrlRow.createEl('span', {
			cls: 'setting-item-description',
			text: chatKind === 'ollama' ? 'Ollama 服务地址' : chatKind === 'openai' ? '如 https://api.openai.com/v1 或中转站' : '如 https://api.anthropic.com',
		});
		const chatUrlInput = chatUrlRow.createEl('input', { type: 'text', cls: 'tk-set-input' }) as HTMLInputElement;
		chatUrlInput.value = chatProfile.baseUrl;
		const chatUrlApply = chatUrlRow.createEl('button', { cls: 'tk-set-apply', text: 'Apply' });
		const chatUrlDirty = () => { chatUrlApply.classList.toggle('is-dirty', chatUrlInput.value !== chatProfile.baseUrl); };
		chatUrlInput.addEventListener('input', chatUrlDirty);
		chatUrlApply.addEventListener('click', async () => {
			chatProfile.baseUrl = chatUrlInput.value.trim();
			await this.save();
			chatUrlApply.classList.remove('is-dirty');
			chatUrlApply.setText('✓');
			window.setTimeout(() => chatUrlApply.setText('Apply'), 1200);
		});

		if (chatKind !== 'ollama') {
			const chatKeyRow = containerEl.createDiv({ cls: 'tk-set-row' });
			chatKeyRow.createEl('span', { cls: 'tk-set-name', text: 'API Key' });
			chatKeyRow.createEl('span', { cls: 'setting-item-description', text: '仅保存在本机 data.json' });
			const chatKeyInput = chatKeyRow.createEl('input', { type: 'password', cls: 'tk-set-input' }) as HTMLInputElement;
			chatKeyInput.value = chatProfile.apiKey;
			const chatKeyApply = chatKeyRow.createEl('button', { cls: 'tk-set-apply', text: 'Apply' });
			const chatKeyDirty = () => { chatKeyApply.classList.toggle('is-dirty', chatKeyInput.value !== chatProfile.apiKey); };
			chatKeyInput.addEventListener('input', chatKeyDirty);
			chatKeyApply.addEventListener('click', async () => {
				chatProfile.apiKey = chatKeyInput.value;
				await this.save();
				chatKeyApply.classList.remove('is-dirty');
				chatKeyApply.setText('✓');
				window.setTimeout(() => chatKeyApply.setText('Apply'), 1200);
			});
		}

		// Chat 模型：可编辑组合框（datalist）——列表可下拉选，失败可手输，同一框
		const chatModelRow = containerEl.createDiv({ cls: 'tk-set-row' });
		chatModelRow.createEl('span', { cls: 'tk-set-name', text: 'Chat 模型' });
		chatModelRow.createEl('span', { cls: 'setting-item-description', text: `当前协议 ${chatKind} 的生成模型；可直接输入或从列表选择` });
		const chatModelInput = chatModelRow.createEl('input', { type: 'text', cls: 'tk-set-input' }) as HTMLInputElement;
		chatModelInput.setAttribute('list', 'tk-chat-models');
		chatModelInput.value = chatProfile.model;
		const chatDatalist = chatModelRow.createEl('datalist', { attr: { id: 'tk-chat-models' } });
		chatDatalist.createEl('option', { value: chatProfile.model });
		const chatModelApply = chatModelRow.createEl('button', { cls: 'tk-set-apply', text: 'Apply' });
		const chatModelDirty = () => { chatModelApply.classList.toggle('is-dirty', chatModelInput.value.trim() !== chatProfile.model); };
		chatModelInput.addEventListener('input', chatModelDirty);
		chatModelApply.addEventListener('click', async () => {
			const v = chatModelInput.value.trim();
			if (!v) return;
			chatProfile.model = v;
			await this.save();
			chatModelApply.classList.remove('is-dirty');
			chatModelApply.setText('✓');
			window.setTimeout(() => chatModelApply.setText('Apply'), 1200);
		});
		const chatFetchBtn = chatModelRow.createEl('button', { cls: 'tk-set-fetch', text: '获取模型列表' });
		chatFetchBtn.addEventListener('click', async () => {
			chatFetchBtn.setText('获取中…'); chatFetchBtn.disabled = true;
			try {
				// 优先用输入框当前值（可能已改但未 Apply），失败再退回归档值
				const baseUrl = chatUrlInput.value.trim() || chatProfile.baseUrl;
				const models = await OllamaClient.fetchModelList(chatKind, baseUrl, chatProfile.apiKey);
				chatDatalist.empty();
				for (const m of models) chatDatalist.createEl('option', { value: m });
				if (models.length > 0 && !models.includes(chatModelInput.value)) {
					chatModelInput.value = models.includes(chatProfile.model) ? chatProfile.model : models[0]!;
					chatModelDirty();
				}
				chatFetchBtn.setText(`✓ ${models.length} 个`);
			} catch (e: any) {
				chatFetchBtn.setText(`✗ ${e?.message?.slice(0, 24) ?? '失败'}`);
			}
			window.setTimeout(() => { chatFetchBtn.setText('获取模型列表'); chatFetchBtn.disabled = false; }, 2500);
		});

		// ───── Embedding 供应商（同收敛设计） ─────
		containerEl.createEl('h3', { text: 'Embedding 供应商' });

		new Setting(containerEl)
			.setName('协议')
			.setDesc('anthropic 无 embedding API，仅提供 ollama / openai')
			.addDropdown((d) => d
				.addOptions({ ollama: 'Ollama', openai: 'OpenAI 兼容' })
				.setValue(s.embeddingProvider === 'anthropic' ? 'ollama' : s.embeddingProvider)
				.onChange(async (v) => {
					s.embeddingProvider = v as ProviderKind;
					await this.save();
					this.display();
				}));

		const embKey: 'ollama' | 'openai' = s.embeddingProvider === 'openai' ? 'openai' : 'ollama';
		const embProfile = s.embeddingProfiles[embKey];

		const embUrlRow = containerEl.createDiv({ cls: 'tk-set-row' });
		embUrlRow.createEl('span', { cls: 'tk-set-name', text: 'Base URL' });
		embUrlRow.createEl('span', { cls: 'setting-item-description', text: embKey === 'ollama' ? 'Ollama 服务地址' : '如 https://api.openai.com/v1' });
		const embUrlInput = embUrlRow.createEl('input', { type: 'text', cls: 'tk-set-input' }) as HTMLInputElement;
		embUrlInput.value = embProfile.baseUrl;
		const embUrlApply = embUrlRow.createEl('button', { cls: 'tk-set-apply', text: 'Apply' });
		const embUrlDirty = () => { embUrlApply.classList.toggle('is-dirty', embUrlInput.value !== embProfile.baseUrl); };
		embUrlInput.addEventListener('input', embUrlDirty);
		embUrlApply.addEventListener('click', async () => {
			embProfile.baseUrl = embUrlInput.value.trim();
			await this.save();
			embUrlApply.classList.remove('is-dirty');
			embUrlApply.setText('✓');
			window.setTimeout(() => embUrlApply.setText('Apply'), 1200);
		});

		if (embKey !== 'ollama') {
			const embKeyRow = containerEl.createDiv({ cls: 'tk-set-row' });
			embKeyRow.createEl('span', { cls: 'tk-set-name', text: 'API Key' });
			embKeyRow.createEl('span', { cls: 'setting-item-description', text: '仅保存在本机 data.json' });
			const embKeyInput = embKeyRow.createEl('input', { type: 'password', cls: 'tk-set-input' }) as HTMLInputElement;
			embKeyInput.value = embProfile.apiKey;
			const embKeyApply = embKeyRow.createEl('button', { cls: 'tk-set-apply', text: 'Apply' });
			const embKeyDirty = () => { embKeyApply.classList.toggle('is-dirty', embKeyInput.value !== embProfile.apiKey); };
			embKeyInput.addEventListener('input', embKeyDirty);
			embKeyApply.addEventListener('click', async () => {
				embProfile.apiKey = embKeyInput.value;
				await this.save();
				embKeyApply.classList.remove('is-dirty');
				embKeyApply.setText('✓');
				window.setTimeout(() => embKeyApply.setText('Apply'), 1200);
			});
		}

		// Embedding 模型：同组合框 + Apply + Rebuild 提示
		const embModelRow = containerEl.createDiv({ cls: 'tk-set-row' });
		embModelRow.createEl('span', { cls: 'tk-set-name', text: 'Embedding 模型' });
		embModelRow.createEl('span', { cls: 'setting-item-description', text: '切换并 Apply 后需「Rebuild index」重建向量库' });
		const embModelInput = embModelRow.createEl('input', { type: 'text', cls: 'tk-set-input' }) as HTMLInputElement;
		embModelInput.setAttribute('list', 'tk-emb-models');
		embModelInput.value = embProfile.model;
		const embDatalist = embModelRow.createEl('datalist', { attr: { id: 'tk-emb-models' } });
		embDatalist.createEl('option', { value: embProfile.model });
		const embModelApply = embModelRow.createEl('button', { cls: 'tk-set-apply', text: 'Apply' });
		const embModelDirty = () => { embModelApply.classList.toggle('is-dirty', embModelInput.value.trim() !== embProfile.model); };
		embModelInput.addEventListener('input', embModelDirty);
		embModelApply.addEventListener('click', async () => {
			const v = embModelInput.value.trim();
			if (!v) return;
			embProfile.model = v;
			await this.save();
			embModelApply.classList.remove('is-dirty');
			embModelApply.setText('✓');
			window.setTimeout(() => embModelApply.setText('Apply'), 1200);
		});
		const embFetchBtn = embModelRow.createEl('button', { cls: 'tk-set-fetch', text: '获取模型列表' });
		embFetchBtn.addEventListener('click', async () => {
			embFetchBtn.setText('获取中…'); embFetchBtn.disabled = true;
			try {
				const baseUrl = embUrlInput.value.trim() || embProfile.baseUrl;
				const models = await OllamaClient.fetchModelList(embKey, baseUrl, embProfile.apiKey);
				embDatalist.empty();
				for (const m of models) embDatalist.createEl('option', { value: m });
				if (models.length > 0 && !models.includes(embModelInput.value)) {
					embModelInput.value = models.includes(embProfile.model) ? embProfile.model : models[0]!;
					embModelDirty();
				}
				embFetchBtn.setText(`✓ ${models.length} 个`);
			} catch (e: any) {
				embFetchBtn.setText(`✗ ${e?.message?.slice(0, 24) ?? '失败'}`);
			}
			window.setTimeout(() => { embFetchBtn.setText('获取模型列表'); embFetchBtn.disabled = false; }, 2500);
		});

		containerEl.createEl('p', {
			text: 'URL / Key / 模型修改后需点 Apply 生效（按钮变黄=有未应用修改）。各协议配置独立保存，切换协议不丢失。Chat 即时生效；Embedding 换模型需 Rebuild index。',
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

	private async save(): Promise<void> {
		await this.plugin.saveSettings();
		this.plugin.applySettingsToClients();
	}
}
