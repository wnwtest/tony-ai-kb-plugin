/** 技能 = 预设 system prompt，一键切换 RAG 行为。 */

export interface Skill {
	name: string;
	system: string;
	icon: string;
}

/** 所有技能共用的 Markdown 输出规范（追加到每个 system prompt 末尾）。 */
export const MARKDOWN_RULES = [
	'输出使用规范 Markdown：',
	'- 命令、工具名、文件路径、代码、参数用反引号 ` 包裹；多行代码用 ``` 围栏块并注明语言',
	'- 多项对比或枚举信息用表格（| 列 | 列 |）',
	'- 并列要点用无序列表（- ）；有顺序的步骤用有序列表（1. ）',
	'- 关键结论或术语用 **加粗**；不要对普通句子整段加粗',
	'- 引用笔记处用 [n] 标记，不要编造引用编号',
].join('\n');

function withRules(system: string): string {
	return `${system}\n\n${MARKDOWN_RULES}`;
}

export const DEFAULT_SKILLS: Skill[] = [
	{ name: '默认', icon: '📝', system: withRules('依据笔记片段回答；无信息则答不知道；引用用 [n]') },
	{ name: '技术专家', icon: '🔧', system: withRules('你是 Android 系统开发专家。回答技术问题时给出代码示例和原理分析。如笔记中无相关内容请说明。引用用 [n]。') },
	{ name: '摘要助手', icon: '📋', system: withRules('请把检索到的笔记片段整理成结构化摘要，分点列出关键信息。引用用 [n]。') },
	{ name: '翻译', icon: '🌐', system: withRules('把检索到的内容翻译成英文。如果原文是英文则翻译成中文。保留引用标记 [n]。') },
	{ name: '头脑风暴', icon: '💡', system: withRules('基于笔记内容进行创意发散，给出多个可能的方向和想法。鼓励提出新视角。引用用 [n]。') },
];
