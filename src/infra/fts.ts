/**
 * FTS 索引维护（只碰 records_fts）。records/archive 共用，避免循环依赖。
 */
import { getDb } from "./db.ts";

export function deleteFromIndex(id: string): void {
	getDb().prepare("DELETE FROM records_fts WHERE id = ?").run(id);
}

export function reindexRecord(id: string): void {
	const d = getDb();
	const r = d.prepare("SELECT id,l0,l1,raw,tags FROM records WHERE id = ?").get(id) as
		| { id: string; l0: string; l1: string; raw: string | null; tags: string }
		| undefined;
	if (!r) return;
	deleteFromIndex(id);
	d.prepare("INSERT INTO records_fts (id,l0,l1,raw,tags) VALUES (?,?,?,?,?)").run(r.id, r.l0, r.l1, r.raw ?? "", r.tags);
}
