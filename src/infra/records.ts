/**
 * records 表读写：插入（含去重/拒绝）、遗忘、过期、查询。
 * 归档与 FTS 分别由 archive.ts / fts.ts 负责，这里只编排它们的调用。
 */
import { randomUUID } from "node:crypto";
import { getConfig } from "./config-store.ts";
import { getDb } from "./db.ts";
import { deleteFromIndex, reindexRecord } from "./fts.ts";
import { appendRecordArchive, appendStatusBlock } from "./archive.ts";
import { looksLikeInstruction, normalizeForHash, normalizeText, stripTrigger } from "../domain/normalize.ts";
import { L0_MAX, L1_MAX, type WriteInput, type WriteResult } from "../domain/types.ts";
import { state } from "../state.ts";

export function insertRecord(input: WriteInput, allowDuplicate = false): WriteResult {
	const d = getDb();
	const l0 = stripTrigger(input.l0.trim()).slice(0, L0_MAX);

	// 拒绝把提示词/指令当记忆存进来
	if (looksLikeInstruction(l0) || looksLikeInstruction(input.l1 ?? "")) {
		return { id: "", contentRef: "", rejected: "内容看起来是提示词/指令，不是可复用的记忆；请只写事实、决定、结论本身。" };
	}

	// 去重：标题归一化后比较（标点/空白/符号/组合符都剥掉）
	if (!allowDuplicate) {
		const key = normalizeForHash(l0);
		const existing = d.prepare("SELECT id,l0 FROM records WHERE status='active'").all() as Array<{ id: string; l0: string }>;
		const dup = existing.find((e) => normalizeForHash(e.l0) === key);
		if (dup) return { id: dup.id, contentRef: "", duplicate: true };
	}

	const id = randomUUID();
	const now = Date.now();
	const l1 = normalizeText(input.l1 ?? "").slice(0, L1_MAX);
	const raw = input.raw ? normalizeText(input.raw) || null : null;
	const tags = input.tags?.trim() ?? `#${input.type}`;
	const ttl = input.ttlDays ?? getConfig().ttlDaysByType[input.type];
	const expires = ttl ? now + ttl * 86400_000 : null;

	d.prepare(
		"INSERT INTO records (id,type,scope,l0,l1,raw,tags,importance,status,created_at,updated_at,expires_at,source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
	).run(id, input.type, "user", l0, l1, raw, tags, input.importance ?? 0.6, "active", now, now, expires, input.source ?? null);
	d.prepare("INSERT INTO records_fts (id,l0,l1,raw,tags) VALUES (?,?,?,?,?)").run(id, l0, l1, raw ?? "", tags);

	const contentRef = appendRecordArchive({
		id,
		type: input.type,
		l0,
		l1: l1 || l0,
		raw,
		source: input.source,
		importance: input.importance ?? 0.6,
		tags,
		expiresAt: expires,
	});
	if (contentRef) d.prepare("UPDATE records SET content_ref = ? WHERE id = ?").run(contentRef, id);

	state.dirty = true;
	return { id, contentRef };
}

export function markForgotten(id: string): void {
	const d = getDb();
	const row = d.prepare("SELECT type,l0 FROM records WHERE id=?").get(id) as { type: string; l0: string } | undefined;
	d.prepare("UPDATE records SET status='forgotten', updated_at=? WHERE id=?").run(Date.now(), id);
	deleteFromIndex(id);
	if (row) appendStatusBlock(id, row.type, row.l0, "forgotten");
	state.dirty = true;
}

/** 按文本子串软删除，返回受影响 id */
export function forgetByMatch(match: string): string[] {
	const d = getDb();
	const rows = d.prepare("SELECT id FROM records WHERE status='active' AND (l0 LIKE ? OR l1 LIKE ?)").all(`%${match}%`, `%${match}%`) as Array<{
		id: string;
	}>;
	for (const r of rows) markForgotten(r.id);
	return rows.map((r) => r.id);
}

/** 过期清理（按 expires_at），返回过期条数 */
export function expireStale(): number {
	const d = getDb();
	const now = Date.now();
	const stale = d.prepare("SELECT id FROM records WHERE status='active' AND expires_at IS NOT NULL AND expires_at < ?").all(now) as Array<{
		id: string;
	}>;
	for (const s of stale) {
		const row = d.prepare("SELECT type,l0 FROM records WHERE id=?").get(s.id) as { type: string; l0: string } | undefined;
		d.prepare("UPDATE records SET status='expired', updated_at=? WHERE id=?").run(now, s.id);
		deleteFromIndex(s.id);
		if (row) appendStatusBlock(s.id, row.type, row.l0, "expired");
	}
	if (stale.length) state.dirty = true;
	return stale.length;
}

export function getRecordById(id: string): any {
	return getDb().prepare("SELECT * FROM records WHERE id = ?").get(id);
}

export function listRecords(opts: { type?: string; limit?: number } = {}): any[] {
	const d = getDb();
	const limit = opts.limit ?? 15;
	return opts.type
		? (d.prepare("SELECT id,type,l0,status,updated_at FROM records WHERE type=? ORDER BY updated_at DESC LIMIT ?").all(opts.type, limit) as any[])
		: (d.prepare("SELECT id,type,l0,status,updated_at FROM records ORDER BY updated_at DESC LIMIT ?").all(limit) as any[]);
}

export { reindexRecord };
