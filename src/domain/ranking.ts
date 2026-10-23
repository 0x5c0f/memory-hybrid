/**
 * 纯函数：检索打分与排序。把"相关性 / 重要度 / 新鲜度"的权重集中在一处，
 * 调排序手感只改这个文件，不碰 SQL。
 */
import type { Hit } from "./types.ts";

export interface RawHit {
	id: string;
	type: string;
	l0: string;
	l1: string;
	content_ref: string | null;
	tags: string;
	importance: number | string;
	updated_at: number | string;
	last_used_at?: number | string | null;
	rel: number | string;
}

/** 相关性 1.0 / 重要度 0.4 / 新鲜度 0.2；60 天半衰 */
export const WEIGHTS = { relevance: 1.0, importance: 0.4, freshness: 0.2, freshnessHalfLifeDays: 60 };

export function scoreAndSort(rows: RawHit[], now = Date.now()): Hit[] {
	const scored = rows.map((r) => {
		const rel = Math.max(0, Number(r.rel) || 0);
		// 新鲜度看"最近被写入或最近被命中"，取较大者：
		// 只用 updated_at 会让"常被搜到但很久没改"的记忆永远沉底；
		// 只用 hits（累计次数）会被单次批量命中污染，所以这里用 last_used_at。
		const lastActive = Math.max(Number(r.updated_at) || 0, Number(r.last_used_at) || 0);
		const ageDays = Math.max(0, (now - lastActive) / 86400_000);
		const freshness = 1 / (1 + ageDays / WEIGHTS.freshnessHalfLifeDays);
		return {
			...r,
			importance: Number(r.importance),
			score: rel * WEIGHTS.relevance + Number(r.importance) * WEIGHTS.importance + freshness * WEIGHTS.freshness,
		};
	});
	scored.sort((a, b) => b.score - a.score);
	return scored as Hit[];
}

/**
 * 决定走 FTS 还是 LIKE：trigram 至少要 3 个字符，中文两字词必须降级。
 * 返回 null 表示"不要走 FTS"。
 */
export function buildFtsQuery(q: string): string | null {
	const cleaned = q.replace(/["'()*:^\-{}[\]]/g, " ").replace(/\s+/g, " ").trim();
	if (!cleaned) return null;
	const tokens = cleaned.split(" ").filter((t) => t.length >= 2);
	if (!tokens.length) return null;
	if (!tokens.some((t) => t.length >= 3)) return null;
	return tokens.map((t) => `"${t}"`).join(" OR ");
}

/** LIKE 兜底用的分词（去特殊字符、拆空格） */
export function buildLikeTokens(q: string): string[] {
	return q
		.split(/\s+/)
		.map((t) => t.replace(/[%_'\"()*:\-{}[\]]/g, "").trim())
		.filter(Boolean);
}
