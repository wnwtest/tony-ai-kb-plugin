# Tony AI KB — Obsidian 插件

ChatGPT 式统一界面的 Obsidian 本地知识库插件：向量检索 + RAG 流式问答，支持 Ollama / OpenAI 兼容 / Anthropic 三协议一键切换，流水线可图形化配置（Dify 风格节点 + 条件分支）。

## 功能

- **统一界面（ChatGPT 式）**：一个输入框 + 检索/问答模式开关 + 技能选择 + ⚡快速/🧠思考切换；空状态输入框居中，发送后移到底部
- **向量检索**：vault 全量 md 按 `##` 标题切片 → embedding（1024 维，L2 归一化）→ 余弦 Top-K → 卡片列表（评分色条）→ 点击跳转笔记对应行
- **RAG 问答**：检索片段作上下文 → LLM 流式生成 → Markdown 渲染（表格/代码块带复制按钮/列表/引用）→ `[n]` 引用回链
- **多轮对话**：追问时上一轮问题拼进检索 query 保持上下文；历史滑窗（最近 12 条）
- **多协议供应商**：chat 三协议（ollama / openai 兼容含中转站 / anthropic）+ embedding 两协议；各协议配置独立保存，切换不丢；「获取模型列表」直接从 API 拉模型 ID 下拉选择
- **图形化流水线**：节点卡片（彩色边框 + 流动连线 + 阶梯动画）+ 参数表单；支持增删/上下移/条件分支（IF/ELSE 双列子流）；⚙ 按钮直达
- **技能系统**：5 个预设（默认/技术专家/摘要/翻译/头脑风暴），内置 Markdown 输出规范
- **增量更新**：笔记修改/创建/删除后自动增量重嵌（mtime 比对，可关）
- **代码块增强**：深色卡片 + 语言标签 + 一键复制

## 快速开始

1. 确保 Ollama 服务可用（默认 `http://192.168.119.219:11434`，模型 `bge-m3` + `qwen3.5:9b`）
2. 安装依赖：
   ```bash
   npm install
   ```
3. 构建 + 部署到 vault：
   ```bash
   node scripts/deploy.mjs
   # 或指定 vault 路径
   node scripts/deploy.mjs --vault "D:\obsidian"
   # 或 npm run deploy
   ```
4. Obsidian 设置 → 第三方插件 → 启用 **Tony AI KB**
5. 点左侧 🔍 图标打开侧栏 → `Rebuild index` 建库（首次约 2 分钟）→ 直接问答（默认模式）

## 命令

| 命令 | 用途 |
|------|------|
| Open Tony AI KB view | 打开/收起侧边栏（toggle） |
| Rebuild index | 全量重建向量库 |
| Incremental update (scan) | 手动增量扫描 |
| Re-index current file | 重嵌当前文件 |
| Ping Ollama | 测试连通 |
| Edit pipeline.json | 图形化流水线编辑器 |

## 设置

设置面板（Settings → Tony AI KB）：
- **Chat 供应商**：协议下拉（ollama/openai/anthropic）+ Base URL + API Key + 模型下拉（获取模型列表 / 手动填）
- **Embedding 供应商**：同上（ollama/openai）
- RAG：think / 温度 / Top-K / 上下文上限
- 切片与增量：最小片段长度 / 自动增量开关 + 延迟

Chat 切换即时生效；Embedding 换模型需 Rebuild index。

## 架构

```
src/
├── main.ts            # 入口、命令注册、设置、供应商测试
├── ollama.ts          # LLM 客户端（ollama/openai/anthropic 三协议 chat+embedding，SSE/NDJSON 流式）
├── chunker.ts         # Chunker 类（TFile → 切片）
├── chunk-text.ts      # 纯切片逻辑（可单测）
├── store.ts           # 向量库（落盘 + mtime 增量）
├── search.ts          # 余弦相似度检索
├── nodes.ts           # 流水线节点实现
├── pipeline.ts        # 流水线引擎（拓扑排序 + 模板取值 + 分支递归）
├── pipeline-editor.ts # 图形化流水线编辑器（增删/排序/分支）
├── rag.ts             # RAG 薄壳（run + runStream，system/think 覆盖）
├── view.ts            # ChatGPT 式侧栏视图（Markdown 渲染 + 代码块复制）
├── skills.ts          # 技能预设 + Markdown 输出规范
└── settings.ts        # 收敛式设置面板（协议下拉 + 模型列表获取）
```

## 测试

```bash
# 切片逻辑单元测试（13 项）
npx esbuild tests/chunk-text.test.ts --bundle --format=esm --platform=node --outfile=.tmp/test.mjs
node .tmp/test.mjs
```

## 技术栈

TypeScript 5 + esbuild + Obsidian Plugin API。零运行时依赖——供应商协议全部原生 fetch 实现。
