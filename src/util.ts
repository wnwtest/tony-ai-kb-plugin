/** 纯工具函数（不依赖 obsidian，便于纯 node 单测）。 */

/** 把任意错误归一成 Error 的 message。 */
export function errMsg(e: unknown): string {
	if (e instanceof Error) return e.message;
	return String(e);
}
