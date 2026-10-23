/**
 * 候选用例（auto 模式）：从用户原话里按规则挑出"可能值得记住"的片段。
 * 全程 0 次模型调用；暂存到 candidates，按 promoteThreshold 晋升进 records。
 */
import { randomUUID } from "node:crypto";
import { compileCaptureRules, getConfig } from "../infra/config-store.ts";
import { getDb } from "../infra/db.ts";
import { insertRecord } from "../infra/records.ts";
import { importanceFromScore, matchCandidate } from "../domain/candidates.ts";
import { looksLikeInstruction, stripTrigger } from "../domain/normalize.ts";
import { L0_MAX, L1_MAX } from "../domain/types.ts";

/** 从一条用户消息里提取候选，返回新增条数 */
export function extractCandidates(sessionId: string, text: string): number {
	const cfg = getConfig();
	if (!cfg.candidateRules) return 0;

	const d = getDb();
	const trimmed = text.trim();
	if (trimmed.length < 8 || trimmed.length > cfg.captureMaxChars) return 0;
	// 忽略代码块 / JSON / 第三方元信息
	if (/^```|^\s*[{[]/.test(trimmed)) return 0;
	if (/Conversation info \(untrusted metadata\)/.test(trimmed)) return 0;
	// 提示词/指令本身不是记忆（例：用户让模型"依次调用 memory_search…"）
	if (looksLikeInstruction(trimmed)) return 0;

	const best = matchCandidate(trimmed, compileCaptureRules());
	if (!best) return 0;

	const dup = d.prepare("SELECT id FROM candidates WHERE text = ? AND status = 'staged'").get(trimmed) as { id: string } | undefined;
	if (dup) return 0;

	d.prepare("INSERT INTO candidates (id,session_id,kind,text,score,reason,status,created_at) VALUES (?,?,?,?,?,?,?,?)").run(
		randomUUID(),
		sessionId,
		best.kind,
		trimmed,
		best.score,
		best.reason,
		"staged",
		Date.now(),
	);
	return 1;
}

/** 把暂存候选晋升进 records；force=true 时忽略阈值（手动 /mem stage commit） */
export function promoteCandidates(force = false): { promoted: number; left: number; rejected: number } {
	const cfg = getConfig();
	const d = getDb();
	const rows = d
		.prepare("SELECT id,session_id,kind,text,score FROM candidates WHERE status='staged' ORDER BY score DESC, created_at ASC")
		.all() as Array<{ id: string; session_id: string; kind: string; text: string; score: number }>;

	let promoted = 0;
	let left = 0;
	let rejected = 0;
	for (const c of rows) {
		if (!force && c.score < cfg.promoteThreshold) {
			left++;
			continue;
		}
		const type = c.kind || "other";
		const text = stripTrigger(c.text);
		const res = insertRecord({
			type,
			l0: text.replace(/\s+/g, " ").slice(0, L0_MAX),
			l1: text.slice(0, L1_MAX),
			tags: `#${type}`,
			importance: importanceFromScore(c.score),
			source: `candidate:${c.id} session:${c.session_id ?? "-"}`,
		});
		d.prepare("UPDATE candidates SET status=? WHERE id=?").run(res.rejected ? "rejected" : "promoted", c.id);
		if (res.rejected) rejected++;
		else promoted++;
	}
	return { promoted, left, rejected };
}

/** 从 session 分支取最近一条 user 消息的纯文本 */
export function lastUserText(branch: any[]): string {
	for (let i = branch.length - 1; i >= 0; i--) {
		const e = branch[i];
		if (e?.type === "message" && e?.message?.role === "user") {
			const c = e.message.content;
			if (typeof c === "string") return c;
			if (Array.isArray(c)) return c.map((b: any) => (typeof b?.text === "string" ? b.text : "")).join("\n");
		}
	}
	return "";
}
