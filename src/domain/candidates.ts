/**
 * 纯函数：从用户原话里匹配候选规则（来自 config.captureRules）。
 * 只做匹配与打分，不写库、不调模型。
 */

export type { CaptureRule } from "./types.ts";


export interface CandidateMatch {
	kind: string;
	score: number;
	reason: string;
}

/**
 * 返回命中的最高权重规则；没有命中返回 null。
 * rules 需要先经 compileRules 编译（非法正则已过滤）。
 */
export function matchCandidate(text: string, rules: Array<{ re: RegExp; kind: string; weight: number; reason: string }>): CandidateMatch | null {
	let best: CandidateMatch | null = null;
	for (const rule of rules) {
		if (rule.re.test(text) && (!best || rule.weight > best.score)) {
			best = { kind: rule.kind, score: rule.weight, reason: rule.reason };
		}
	}
	return best;
}

/** 候选晋升成记录时的初始重要度：分数越高越重要，封顶 0.95 */
export function importanceFromScore(score: number): number {
	return Math.min(0.95, 0.5 + score / 2);
}
