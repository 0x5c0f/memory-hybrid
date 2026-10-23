/**
 * 纯函数：文本归一化 / 指令识别 / 触发词剥离。无 IO、无状态。
 */
import { HASH_MAX } from "./types.ts";

/**
 * 去重用的归一化：剥掉空白、标点(P)、符号(S)、组合符(M，如 emoji 变体选择符 U+FE0F)、
 * 格式符(Cf，如零宽连接符)，再小写。
 * 所以「网关 ⚠️」与「网关：⚠」会被判定为同一条。
 */
export function normalizeForHash(s: string): string {
	return s
		.replace(/[\s\p{P}\p{S}\p{M}\p{Cf}]/gu, "")
		.toLowerCase()
		.slice(0, HASH_MAX);
}

/** 归档是 Markdown，行尾空白无法可靠往返 → 写入时统一归一化 */
export function normalizeText(s: string): string {
	return s
		.replace(/\r\n/g, "\n")
		.split("\n")
		.map((l) => l.replace(/\s+$/, ""))
		.join("\n")
		.trim();
}

/**
 * 识别"看起来是提示词/指令而不是记忆内容"的文本。
 * 用于两处：① memory_write 拒绝指令载荷；② 候选捕获跳过任务式 prompt。
 */
export function looksLikeInstruction(s: string): boolean {
	if (!s) return false;
	return (
		// 元指令 / 工具调用说明
		/(调用[\s`'"]*memory_?(write|search|read)|调用[\s`'"]*[a-z_]+[\s`'"]*工具|写入下面|依次调用|不要合并|不要省略|只报|原样输出|不要总结|格式[:：]\s*RESULT)/i.test(
			s,
		) ||
		// 任务式 prompt
		/(你是一个?|你是记忆|你的任务|只做一件事|测试的一环|并发测试)/.test(s) ||
		/^(请|帮我|你去|现在把|把下面)/.test(s.trim())
	);
}

/** 去掉"记一下："这类触发前缀，避免污染标题 */
export function stripTrigger(s: string): string {
	return s.replace(/^\s*(这个\s*)?(记一下|记住|记下来|帮我记|存一下|保存到记忆)[：:，,\s]*/u, "").trim();
}
