import { ItemView, MarkdownRenderer, MarkdownView, Notice, WorkspaceLeaf } from 'obsidian';
import { errMsg, OllamaClient, type ChatMessage } from './ollama';
import { search, type SearchHit } from './search';
import { VectorStore } from './store';
import { Rag } from './rag';
import { DEFAULT_SKILLS, type Skill } from './skills';
import type TonyAIKBPlugin from './main';

export const TONY_AI_KB_VIEW_TYPE = 'tony-ai-kb';

type Mode = 'search' | 'chat';

/**
 * ChatGPT 式统一界面：一个内容区 + 一个输入框 + 模式开关 + 技能选择。
 * 检索：query → Top-K 卡片（快，不调 LLM）
 * 问答：query → RAG 流水线 → LLM 流式回答 + 引用
 */
export class TonyAIKBView extends ItemView {
	private contentArea!: HTMLElement;
	private welcomeEl!: HTMLElement;
	private statusEl!: HTMLElement;
	private inputEl!: HTMLTextAreaElement;
	private actionBtn!: HTMLButtonElement; // 合并的发送/停止按钮
	private skillSelect!: HTMLSelectElement;
	private thinkBtn!: HTMLButtonElement;
	private modeCheckbox!: HTMLInputElement;

	private mode: Mode = 'chat';
	private skills: Skill[] = DEFAULT_SKILLS;
	private chatHistory: ChatMessage[] = [];
	private chatAbort: AbortController | null = null;
	private fastMode = true; // true=快速模式(think关), false=思考模式(think开)
	private isStreaming = false;

	constructor(
		leaf: WorkspaceLeaf,
		private readonly ollama: OllamaClient,
		private readonly store: VectorStore,
		private readonly rag: Rag,
		private readonly plugin: TonyAIKBPlugin,
	) {
		super(leaf);
	}

	getViewType(): string { return TONY_AI_KB_VIEW_TYPE; }
	getDisplayText(): string { return 'Tony AI KB'; }
	getIcon(): string { return 'search'; }

	async onOpen(): Promise<void> {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass('tk-view');
		containerEl.addClass('is-empty'); // 初始状态：输入框居中

		// 顶栏
		const topbar = containerEl.createDiv({ cls: 'tk-topbar' });
		topbar.createEl('span', { cls: 'tk-topbar-title', text: 'Tony AI KB' });
		const gear = topbar.createEl('button', { cls: 'tk-topbar-btn', text: '⚙' });
		gear.title = '流水线配置';
		gear.addEventListener('click', () => { void this.plugin.editPipeline(); });
		const rebuild = topbar.createEl('button', { cls: 'tk-topbar-btn', text: '⟳' });
		rebuild.title = '重建索引';
		rebuild.addEventListener('click', () => {
			(this.app as any).commands?.runCommandById?.('tony-ai-kb-plugin:rebuild-index');
		});

		// body wrapper：content + composer（is-empty 时居中 composer）
		const body = containerEl.createDiv({ cls: 'tk-body' });

		// 内容区（检索结果 / 对话气泡）——空状态隐藏
		this.contentArea = body.createDiv({ cls: 'tk-content' });
		this.statusEl = body.createDiv({ cls: 'tk-status' });

		// 欢迎文案（仅空状态显示，与 composer 一起居中）
		this.welcomeEl = body.createDiv({ cls: 'tk-welcome-wrap' });

		// 底部 composer
		const composer = body.createDiv({ cls: 'tk-composer' });
		this.buildComposer(composer);

		// 先渲染 UI（即时显示），store 后台加载——store.json 298MB 的 JSON.parse 不阻塞 view 显示。
		// load() 自带缓存（已加载直接返回）+ 去重（与后台增量共用同一 promise）。
		this.setStatus('加载知识库…');
		this.showHint();
		window.setTimeout(() => {
			void this.store.load().then((s) => {
				this.setStatus(s && s.complete
					? `${s.chunks.length} 片段 · dim ${s.dim}`
					: '库未就绪，请先重建索引');
			});
		}, 0);
	}

	async onClose(): Promise<void> {
		this.chatAbort?.abort();
		this.containerEl.empty();
	}

	// ───────── 底部 composer ─────────

	private buildComposer(composer: HTMLElement): void {
		// 第一行：textarea + 合并按钮（发送/停止同一按钮）
		const inputRow = composer.createDiv({ cls: 'tk-input-row' });
		this.inputEl = inputRow.createEl('textarea', { cls: 'tk-textarea', attr: { rows: '1', placeholder: '输入问题…（Enter 发送 / Shift+Enter 换行）' } }) as HTMLTextAreaElement;
		this.inputEl.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
				e.preventDefault();
				void this.onAction();
			}
		});
		this.inputEl.addEventListener('input', () => this.autoResize());

		this.actionBtn = inputRow.createEl('button', { cls: 'tk-send', text: '➤' });
		this.actionBtn.title = '发送';
		this.actionBtn.addEventListener('click', () => { void this.onAction(); });

		// 第二行（textarea 下方）：技能 + 思考开关 + 模式开关
		const toolbar = composer.createDiv({ cls: 'tk-toolbar' });

		// 技能下拉
		const skillWrap = toolbar.createDiv({ cls: 'tk-skill-wrap' });
		this.skillSelect = skillWrap.createEl('select', { cls: 'tk-skill-select' });
		this.skills.forEach((s, i) => {
			const opt = this.skillSelect.createEl('option', { value: String(i), text: `${s.icon} ${s.name}` });
			void opt;
		});
		this.skillSelect.value = String(this.plugin.settings.skillIndex ?? 0);
		this.skillSelect.addEventListener('change', async () => {
			this.plugin.settings.skillIndex = parseInt(this.skillSelect.value);
			await this.plugin.saveSettings();
		});

		// 思考模式开关：默认 ON=快速(think关)，OFF=思考(think开)
		const thinkWrap = toolbar.createDiv({ cls: 'tk-think-wrap' });
		this.thinkBtn = thinkWrap.createEl('button', { cls: 'tk-think-btn is-active', text: '⚡ 快速' });
		this.thinkBtn.title = '开启=关闭思考（快速回答）；关闭=允许思考（详细推理）';
		this.thinkBtn.addEventListener('click', async () => {
			this.fastMode = !this.fastMode;
			this.thinkBtn.classList.toggle('is-active', this.fastMode);
			this.thinkBtn.setText(this.fastMode ? '⚡ 快速' : '🧠 思考');
			await this.plugin.saveSettings();
		});

		// 模式开关（默认=问答）
		const switchWrap = toolbar.createDiv({ cls: 'tk-switch-wrap' });
		switchWrap.createEl('span', { cls: 'tk-switch-label', text: '检索' });
		const switchLabel = switchWrap.createEl('label', { cls: 'tk-switch' });
		this.modeCheckbox = switchLabel.createEl('input', { type: 'checkbox' }) as HTMLInputElement;
		switchLabel.createEl('span', { cls: 'tk-switch-slider' });
		switchWrap.createEl('span', { cls: 'tk-switch-label', text: '问答' });
		this.modeCheckbox.checked = true; // 默认问答
		this.modeCheckbox.addEventListener('change', () => {
			this.mode = this.modeCheckbox.checked ? 'chat' : 'search';
			this.contentArea.empty();
			this.chatHistory = [];
			this.containerEl.addClass('is-empty');
			this.showHint();
		});
	}

	/** 合并按钮的统一处理：流式中=停止，空闲=发送。 */
	private async onAction(): Promise<void> {
		if (this.isStreaming) {
			this.chatAbort?.abort();
			return;
		}
		await this.onSend();
	}

	private autoResize(): void {
		const el = this.inputEl;
		el.style.height = 'auto';
		const max = 120;
		el.style.height = `${Math.min(el.scrollHeight, max)}px`;
	}

	// ───────── 发送 ─────────

	private async onSend(): Promise<void> {
		const q = this.inputEl.value.trim();
		if (!q) return;
		this.inputEl.value = '';
		this.autoResize();
		this.containerEl.removeClass('is-empty'); // 发送后：composer 移到底部
		if (this.mode === 'search') await this.runSearch(q);
		else await this.runChat(q);
	}

	// ───────── 检索 ─────────

	private async runSearch(q: string): Promise<void> {
		if (!await this.ensureStore()) return;
		this.contentArea.empty();
		this.setStatus('向量化查询…');
		this.contentArea.createEl('div', { cls: 'tk-loading', text: '检索中' });
		try {
			const qv = await this.ollama.getEmbedding(q);
			const t0 = Date.now();
			const hits = search(qv, q, this.store.store!.chunks, 10);
			const ms = Date.now() - t0;
			this.renderSearchResults(q, hits, ms);
		} catch (e) {
			this.contentArea.empty();
			this.setStatus(`检索失败：${errMsg(e)}`);
		}
	}

	private renderSearchResults(q: string, hits: SearchHit[], ms: number): void {
		this.contentArea.empty();
		this.setStatus(`"${q}" — ${hits.length} 命中 / ${ms}ms`);
		if (hits.length === 0) {
			this.contentArea.createEl('div', { cls: 'tk-hint', text: '无结果，换个说法试试。' });
			return;
		}
		for (const hit of hits) {
			const card = this.contentArea.createDiv({ cls: 'tk-card' });
			const head = card.createDiv({ cls: 'tk-card-head' });
			head.createEl('span', { cls: 'tk-card-file', text: hit.chunk.file });
			const pct = Math.max(4, Math.min(100, Math.round((hit.score - 0.4) / 0.35 * 100)));
			const bar = head.createDiv({ cls: 'tk-scorebar' });
			const fill = bar.createDiv({ cls: 'tk-scorebar-fill' });
			fill.style.width = `${pct}%`;
			fill.style.background = this.scoreColor(hit.score);
			head.createEl('span', { cls: 'tk-card-score', text: hit.score.toFixed(3) });
			card.createEl('div', { cls: 'tk-card-header', text: hit.chunk.header });
			card.createEl('div', { cls: 'tk-card-preview', text: hit.chunk.content.replace(/\n/g, ' ').slice(0, 140) });
			card.addEventListener('click', () => { void this.openChunk(hit); });
		}
	}

	private scoreColor(score: number): string {
		if (score >= 0.65) return '#10B981';
		if (score >= 0.5) return '#F59E0B';
		return '#EF4444';
	}

	// ───────── 问答 ─────────

	private async runChat(q: string): Promise<void> {
		if (!await this.ensureStore()) return;
		this.appendBubble('user', q);
		this.setStreaming(true);
		this.setStatus('检索笔记并生成中…');
		this.chatAbort = new AbortController();
		const aiBubble = this.appendBubble('assistant', '');
		aiBubble.addClass('is-streaming');
		const skill = this.skills[parseInt(this.skillSelect.value)] ?? this.skills[0]!;
		// 流式期间累积原文；节流重渲染 Markdown；结束后最终渲染。
		// 容错：MarkdownRenderer.render 失败（DOM 销毁/内部异常/超长文本）时降级为纯文本，
		// 保证内容永远可见——渲染器坏了也不能吞掉模型输出。
		let acc = '';
		let lastRender = 0;
		let renderSeq = 0;
		const RENDER_THROTTLE = 400;
		const renderMd = async (final: boolean): Promise<void> => {
			const seq = ++renderSeq;
			const text = acc || '（无内容）';
			const holder = aiBubble;
			holder.empty();
			try {
				await MarkdownRenderer.render(this.app, text, holder, '', this);
				this.enhanceCodeBlocks(holder);
			} catch (err) {
				console.warn('[tony-ai-kb] markdown render 失败，降级纯文本', err);
				holder.setText(text);
			}
			if (seq !== renderSeq) return; // 已被更新的渲染取代，丢弃
			holder.toggleClass('is-streaming', !final);
			this.contentArea.scrollTop = this.contentArea.scrollHeight;
		};
		try {
			const r = await this.rag.runStream(q, this.chatHistory.slice(), (token) => {
				acc += token;
				const now = Date.now();
				if (now - lastRender > RENDER_THROTTLE) {
					lastRender = now;
					void renderMd(false);
				}
			}, this.chatAbort.signal, skill.system, !this.fastMode);
			acc = r.answer;
			this.chatHistory.push({ role: 'user', content: q }, { role: 'assistant', content: r.answer });
			if (this.chatHistory.length > 12) this.chatHistory = this.chatHistory.slice(-12);
			await renderMd(true);
			if (r.citationList) this.renderCitations(aiBubble, r.citationList);
			this.setStatus(`完成 · ${r.model ?? ''}`);
		} catch (e) {
			const msg = errMsg(e);
			if (msg.includes('已中止') || msg.includes('AbortError')) {
				this.setStatus('已停止');
			} else {
				acc += `\n\n[失败：${msg}]`;
				await renderMd(true);
				this.setStatus(`失败：${msg}`);
			}
		} finally {
			aiBubble.removeClass('is-streaming');
			this.setStreaming(false);
			this.chatAbort = null;
		}
	}

	private appendBubble(role: 'user' | 'assistant', text: string): HTMLElement {
		const row = this.contentArea.createDiv({ cls: `tk-msg tk-${role}` });
		row.createEl('div', { cls: 'tk-avatar', text: role === 'user' ? '🧑' : '🤖' });
		const bubble = row.createDiv({ cls: 'tk-bubble' });
		if (text) bubble.appendText(text);
		this.contentArea.scrollTop = this.contentArea.scrollHeight;
		return bubble;
	}

	private renderCitations(bubble: HTMLElement, list: string): void {
		if (!list) return;
		const cite = bubble.createDiv({ cls: 'tk-citations' });
		cite.createEl('div', { cls: 'tk-citations-title', text: '引用：' });
		cite.createEl('div', { cls: 'tk-citations-list', text: list });
		this.contentArea.scrollTop = this.contentArea.scrollHeight;
	}

	/** 增强代码块：每个 pre 外包一层容器，右上角加「复制」按钮 + 语言标签。 */
	private enhanceCodeBlocks(holder: HTMLElement): void {
		const pres = holder.querySelectorAll('pre');
		pres.forEach((pre) => {
			const preEl = pre as HTMLElement;
			if (preEl.parentElement?.classList.contains('tk-codeblock')) return; // 已增强
			const wrapper = preEl.ownerDocument.createElement('div');
			wrapper.className = 'tk-codeblock';
			preEl.parentElement?.insertBefore(wrapper, preEl);
			wrapper.appendChild(preEl);
			const bar = wrapper.createDiv({ cls: 'tk-codeblock-bar' });
			const lang = preEl.querySelector('code')?.className?.match(/language-(\w+)/)?.[1] ?? 'code';
			bar.createEl('span', { cls: 'tk-codeblock-lang', text: lang });
			const btn = bar.createEl('button', { cls: 'tk-codeblock-copy', text: '复制' });
			btn.addEventListener('click', async () => {
				const code = preEl.textContent ?? '';
				try {
					await navigator.clipboard.writeText(code);
					btn.setText('✓ 已复制');
				} catch {
					// clipboard API 不可用时降级 execCommand
					const ta = document.createElement('textarea');
					ta.value = code;
					document.body.appendChild(ta);
					ta.select();
					document.execCommand('copy');
					ta.remove();
					btn.setText('✓ 已复制');
				}
				window.setTimeout(() => btn.setText('复制'), 1600);
			});
		});
	}

	// ───────── 工具 ─────────

	private async ensureStore(): Promise<boolean> {
		if (!this.store.store || !this.store.store.complete) await this.store.load();
		if (!this.store.store || !this.store.store.complete) {
			new Notice('库未就绪，请先重建索引', 4000);
			return false;
		}
		return true;
	}

	private setStreaming(on: boolean): void {
		this.isStreaming = on;
		this.inputEl.disabled = on;
		if (on) {
			this.actionBtn.setText('■');
			this.actionBtn.className = 'tk-stop';
			this.actionBtn.title = '停止';
		} else {
			this.actionBtn.setText('➤');
			this.actionBtn.className = 'tk-send';
			this.actionBtn.title = '发送';
		}
	}

	private setStatus(t: string): void { this.statusEl.setText(t); }

	private showHint(): void {
		this.contentArea.empty();
		this.welcomeEl.empty();
		if (this.mode === 'search') {
			this.welcomeEl.createEl('div', { cls: 'tk-welcome', text: '🔍\n输入关键词，搜索 vault 笔记' });
		} else {
			this.welcomeEl.createEl('div', { cls: 'tk-welcome', text: '💬\n输入问题，AI 基于笔记回答' });
		}
	}

	private async openChunk(hit: SearchHit): Promise<void> {
		const { app } = this;
		if (!app.vault.getAbstractFileByPath(hit.chunk.file)) {
			new Notice(`找不到文件：${hit.chunk.file}`, 4000);
			return;
		}
		app.workspace.openLinkText(hit.chunk.file, '', true);
		const line = Math.max(0, hit.chunk.lineStart - 1);
		setTimeout(() => {
			const v = app.workspace.getActiveViewOfType(MarkdownView);
			v?.editor?.setCursor({ line, ch: 0 });
			v?.editor?.scrollIntoView({ from: { line, ch: 0 }, to: { line, ch: 0 } }, true);
		}, 60);
	}
}
