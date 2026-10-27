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

		// ───── Chat 供应商（收敛：一个协议下拉，按协议显示字段，模型可从 API 拉列表） ─────
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

		new Setting(containerEl)
			.setName('Base URL')
			.setDesc(chatKind === 'ollama' ? 'Ollama 服务地址' : chatKind === 'openai' ? '如 https://api.openai.com/v1 或中转站' : '如 https://api.anthropic.com')
			.addText((t) => t.setValue(chatProfile.baseUrl).onChange(async (v) => {
				chatProfile.baseUrl = v; await this.save();
			}));

		if (chatKind !== 'ollama') {
			new Setting(containerEl)
				.setName('API Key')
				.setDesc('仅保存在本机 data.json')
				.addText((t) => { t.inputEl.type = 'password'; t.setValue(chatProfile.apiKey).onChange(async (v) => {
					chatProfile.apiKey = v; await this.save();
				}); });
		}

		// Chat 模型：下拉（可从 API 获取列表）+ 手动输入兜底
		const chatModelSetting = new Setting(containerEl)
			.setName('Chat 模型')
			.setDesc(`当前协议 ${chatKind} 的生成模型`);
		const chatSelect = chatModelSetting.controlEl.createEl('select') as HTMLSelectElement;
		chatSelect.className = 'dropdown';
		chatSelect.style.width = '160px';
		// 当前值作为首选项
		chatSelect.createEl('option', { value: chatProfile.model, text: chatProfile.model || '（选择模型）' });
		chatSelect.addEventListener('change', async () => {
			chatProfile.model = chatSelect.value;
			await this.save();
		});
		chatModelSetting.addButton((b) => b.setButtonText('获取模型列表').onClick(async () => {
			b.setButtonText('获取中…'); b.buttonEl.disabled = true;
			try {
				const models = await OllamaClient.fetchModelList(chatKind, chatProfile.baseUrl, chatProfile.apiKey);
				chatSelect.empty();
				if (models.length === 0) {
					chatSelect.createEl('option', { value: '', text: '（无模型）' });
				} else {
					for (const m of models) {
						chatSelect.createEl('option', { value: m, text: m });
					}
					chatSelect.value = models.includes(chatProfile.model) ? chatProfile.model : models[0]!;
					chatProfile.model = chatSelect.value;
					await this.save();
				}
				b.setButtonText(`✓ ${models.length} 个模型`);
			} catch (e: any) {
				b.setButtonText(`✗ ${e?.message?.slice(0, 30) ?? '失败'}`);
			}
			window.setTimeout(() => { b.setButtonText('获取模型列表'); b.buttonEl.disabled = false; }, 2500);
		}));
		// 手动输入兜底（模型列表接口不可用时）
		new Setting(containerEl)
			.setName('（或手动填入模型 ID）')
			.setDesc('获取列表失败时手动填')
			.addText((t) => {
				t.setPlaceholder(chatProfile.model || 'model-id');
				t.setValue(chatProfile.model);
				t.onChange(async (v) => { chatProfile.model = v; await this.save(); });
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

		new Setting(containerEl)
			.setName('Base URL')
			.setDesc(embKey === 'ollama' ? 'Ollama 服务地址' : '如 https://api.openai.com/v1')
			.addText((t) => t.setValue(embProfile.baseUrl).onChange(async (v) => {
				embProfile.baseUrl = v; await this.save();
			}));

		if (embKey !== 'ollama') {
			new Setting(containerEl)
				.setName('API Key')
				.setDesc('仅保存在本机 data.json')
				.addText((t) => { t.inputEl.type = 'password'; t.setValue(embProfile.apiKey).onChange(async (v) => {
					embProfile.apiKey = v; await this.save();
				}); });
		}

		const embModelSetting = new Setting(containerEl)
			.setName('Embedding 模型')
			.setDesc('切换后需「Rebuild index」重建向量库');
		const embSelect = embModelSetting.controlEl.createEl('select') as HTMLSelectElement;
		embSelect.className = 'dropdown';
		embSelect.style.width = '160px';
		embSelect.createEl('option', { value: embProfile.model, text: embProfile.model || '（选择模型）' });
		embSelect.addEventListener('change', async () => {
			embProfile.model = embSelect.value;
			await this.save();
		});
		embModelSetting.addButton((b) => b.setButtonText('获取模型列表').onClick(async () => {
			b.setButtonText('获取中…'); b.buttonEl.disabled = true;
			try {
				const models = await OllamaClient.fetchModelList(embKey, embProfile.baseUrl, embProfile.apiKey);
				embSelect.empty();
				if (models.length === 0) {
					embSelect.createEl('option', { value: '', text: '（无模型）' });
				} else {
					for (const m of models) embSelect.createEl('option', { value: m, text: m });
					embSelect.value = models.includes(embProfile.model) ? embProfile.model : models[0]!;
					embProfile.model = embSelect.value;
					await this.save();
				}
				b.setButtonText(`✓ ${models.length} 个模型`);
			} catch (e: any) {
				b.setButtonText(`✗ ${e?.message?.slice(0, 30) ?? '失败'}`);
			}
			window.setTimeout(() => { b.setButtonText('获取模型列表'); b.buttonEl.disabled = false; }, 2500);
		}));
		new Setting(containerEl)
			.setName('（或手动填入模型 ID）')
			.setDesc('获取列表失败时手动填')
			.addText((t) => {
				t.setPlaceholder(embProfile.model || 'model-id');
				t.setValue(embProfile.model);
				t.onChange(async (v) => { embProfile.model = v; await this.save(); });
			});

		containerEl.createEl('p', {
			text: '各协议配置独立保存，切换协议不丢失。Chat 切换即时生效；Embedding 换模型需「Rebuild index」。',
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
