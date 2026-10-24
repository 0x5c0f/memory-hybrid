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

/**
 * 识别「提问/请求」：这类句子是用户让我干活，不是可复用的记忆事实。
 * 例："分析下，要不要把代码放到 src 目录？" / "我需要你在插件里加个 docs 目录"
 */
export function looksLikeQuestionOrRequest(s: string): boolean {
	const t = s.trim();
	if (!t) return false;
	// 以问号结尾（中英文）或是明显疑问词开头
	if (/[?？]\s*$/.test(t)) return true;
	if (/^(要不要|是否|能不能|可不可以|怎么|为什么|如何|是不是|有没有|分析下|看一下|帮我看看)/.test(t)) return true;
	// 直接对我下指令的说法
	if (/(我需要你|麻烦你|请你|你帮我|你先把|你现在把|给我写|改一下|加一个|增加一个|优化下|重构下)/.test(t)) return true;
	return false;
}

/** 去掉"记一下："这类触发前缀，避免污染标题 */
export function stripTrigger(s: string): string {
	return s.replace(/^\s*(这个\s*)?(记一下|记住|记下来|帮我记|存一下|保存到记忆)[：:，,\s]*/u, "").trim();
}
