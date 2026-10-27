#!/usr/bin/env node
// 一键部署：esbuild production build + 复制 main.js/manifest.json/styles.css 进 vault 插件目录。
// 用法：node scripts/deploy.mjs [--vault <path>]  默认 vault = D:\obsidian
import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

// vault 路径：命令行 --vault 或默认 D:\obsidian
let vault = 'D:\\obsidian';
const args = process.argv.slice(2);
const vaultIdx = args.indexOf('--vault');
if (vaultIdx >= 0 && args[vaultIdx + 1]) vault = args[vaultIdx + 1];

const dest = join(vault, '.obsidian', 'plugins', 'tony-ai-kb-plugin');

console.log('[deploy] building...');
execSync('node esbuild.config.mjs production', { cwd: root, stdio: 'inherit' });

console.log('[deploy] copying to', dest);
if (!existsSync(dest)) mkdirSync(dest, { recursive: true });
for (const f of ['main.js', 'manifest.json', 'styles.css']) {
	const src = join(root, f);
	if (!existsSync(src)) { console.error(`[deploy] ${f} not found`); process.exit(1); }
	copyFileSync(src, join(dest, f));
	console.log(`  ✓ ${f}`);
}
console.log('[deploy] done. Reload plugin in Obsidian to apply.');
