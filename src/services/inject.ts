/**
 * 注入用例：把 L0 标题拼成一小段系统提示追加块。
 * - 硬上限 injectBudgetChars，超出截断（宁少不多）
 * - stable 快照：只在 session 开始 / 有写入 / 跨天时重建，避免每轮击穿 prompt cache
 */
import { getConfig } from "../infra/config-store.ts";
import { getDb } from "../infra/db.ts";
import { todayStr } from "../infra/paths.ts";
import { expireStale } from "../infra/records.ts";
import { state } from "../state.ts";

export function buildInjectionBlock(): string {
	const cfg = getConfig();
	const d = getDb();
	expireStale();
	const rows = d
		.prepare(
			`SELECT id,type,l0 FROM records WHERE status='active'
			 ORDER BY importance DESC, updated_at DESC LIMIT ?`,
		)
		.all(cfg.maxInjectItems) as Array<{ id: string; type: string; l0: string }>;
	if (!rows.length) return "";

	const head = ["\n\n## 记忆（长期，L0 索引）", `(${rows.length} 条 active；细节用 memory_search / memory_read 按需取，不要凭印象回答)`];
	const lines: string[] = [];
	let used = head.join("\n").length;
	for (const r of rows) {
		const line = `- [${r.type}] ${r.l0}`;
		if (used + line.length > cfg.injectBudgetChars) break;
		lines.push(line);
		used += line.length;
	}
	if (!lines.length) return "";
	const tail = ['- 写入：只有用户明确说"记一下/记住/别再"才用 memory_write；否则不要主动写。'];
	return [...head, ...lines, ...tail].join("\n");
}

export function refreshSnapshot(): void {
	state.snapshot = buildInjectionBlock();
	state.dirty = false;
	state.day = todayStr();
}

/** 取当前注入块；必要时重建（首轮 / 有写入 / 跨天） */
export function ensureSnapshot(): string | null {
	const today = todayStr();
	if (state.snapshot === null || state.dirty || state.day !== today) refreshSnapshot();
	return state.snapshot;
}
