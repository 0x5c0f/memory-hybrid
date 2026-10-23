/**
 * pi 事件层：注入 / 候选提取 / 晋升 / manual 写入把关。
 * 这一层只做"什么时候触发哪个用例"。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { compileTriggerPatterns, getConfig, loadConfig } from "../infra/config-store.ts";
import { extractCandidates, lastUserText, promoteCandidates } from "../services/capture.ts";
import { ensureSnapshot } from "../services/inject.ts";
import { state } from "../state.ts";

export function registerEvents(pi: ExtensionAPI): void {
	pi.on("session_start", async () => {
		loadConfig();
		state.dirty = true;
		ensureSnapshot();
	});

	// L0 注入（stable 快照，避免每轮击穿缓存）
	pi.on("before_agent_start", async (event: any) => {
		const block = ensureSnapshot();
		if (!block) return;
		const caveat = `\n(快照 ${new Date().toTimeString().slice(0, 5)}；权威状态以 memory_* 工具为准)`;
		return { systemPrompt: `${event.systemPrompt}${block}${caveat}` };
	});

	// auto 模式：规则型候选提取（0 次模型调用）
	pi.on("agent_end", async (_event: any, ctx: any) => {
		if (getConfig().mode !== "auto") return;
		try {
			const text = lastUserText(ctx.sessionManager.getBranch());
			if (text) extractCandidates(String(ctx.sessionManager.getSessionId?.() ?? ""), text);
		} catch {}
	});

	// 会话切换/退出：按阈值晋升
	pi.on("session_shutdown", async () => {
		if (getConfig().mode !== "auto") return;
		try {
			promoteCandidates(false);
		} catch {}
	});

	// manual 模式：写入硬门禁（触发词来自 config.triggerPatterns）
	pi.on("tool_call", async (event: any, ctx: any) => {
		if (event.toolName !== "memory_write") return;
		if (getConfig().mode !== "manual") return;
		const text = lastUserText(ctx.sessionManager.getBranch());
		if (compileTriggerPatterns().some((re) => re.test(text))) return;
		return {
			block: true,
			reason: "当前是 manual 模式，用户本轮没有明确要求记忆。请在回复末尾问一句「要不要记下来？」，用户同意后再写入。",
		};
	});
}
