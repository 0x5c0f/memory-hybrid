/**
 * 检索用例：FTS(trigram) 优先、LIKE 兜底（中文两字词），融合排序后写 recall 审计。
 * 路由策略在 domain/ranking.ts，这里负责 SQL 与审计。
 */
import { getDb } from "../infra/db.ts";
import { expireStale } from "../infra/records.ts";
import { buildFtsQuery, buildLikeTokens, scoreAndSort, type RawHit } from "../domain/ranking.ts";
import { RECORD_STATUSES, type Hit, type SearchOptions, type SearchResult, type VectorBackend } from "../domain/types.ts";
import { randomUUID } from "node:crypto";

let vectorBackend: VectorBackend | null = null;

export function setVectorBackend(backend: VectorBackend | null): void {
	vectorBackend = backend;
}

export function getVectorBackend(): VectorBackend | null {
	return vectorBackend;
}

export function searchRecords(query: string, opts: SearchOptions = {}): SearchResult {
	const d = getDb();
	expireStale();
	const limit = opts.limit ?? 8;
	// status 走白名单，避免把外部字符串直接拼进 SQL
	const status = RECORD_STATUSES.includes(opts.status as any) ? (opts.status as string) : "active";
	const statusClause = (alias: string) =>
		status === "all" ? ` AND ${alias}status != 'forgotten'` : ` AND ${alias}status = '${status}'`;
	const typeSql = opts.type ? " AND type = ?" : "";

	const ftsQuery = buildFtsQuery(query);
	let rows: RawHit[] = [];
	let mode: "fts" | "like" = "fts";

	if (ftsQuery) {
		// 参数顺序必须与占位符一致：MATCH ? 在前，type = ? 在后
		const sql = `SELECT r.id,r.type,r.l0,r.l1,r.content_ref,r.tags,r.importance,r.updated_at,r.last_used_at, (-f.rank) AS rel
			FROM records_fts f JOIN records r ON r.id = f.id
			WHERE records_fts MATCH ?${statusClause("r.")}${typeSql.replace("type", "r.type")}
			ORDER BY rel DESC LIMIT ${limit * 3}`;
		const params: any[] = [ftsQuery];
		if (opts.type) params.push(opts.type);
		try {
			rows = d.prepare(sql).all(...params) as any;
		} catch {
			rows = [];
		}
	}

	if (rows.length === 0) {
		mode = "like";
		const tokens = buildLikeTokens(query);
		if (!tokens.length) return { hits: [], mode };
		const clauses = tokens.map(() => "(l0 LIKE ? OR l1 LIKE ? OR IFNULL(raw,'') LIKE ? OR tags LIKE ?)").join(" OR ");
		const sql = `SELECT id,type,l0,l1,content_ref,tags,importance,updated_at,last_used_at, 0 AS rel
			FROM records WHERE 1=1${statusClause("")}${typeSql}
			AND (${clauses})
			ORDER BY importance DESC, updated_at DESC LIMIT ${limit * 3}`;
		const params: any[] = [];
		if (opts.type) params.push(opts.type); // type 占位符在 LIKE 之前
		for (const t of tokens) {
			const p = `%${t}%`;
			params.push(p, p, p, p);
		}
		const likeRows = d.prepare(sql).all(...params) as any[];
		// 多词查询：命中词数越多相关性越高
		rows = likeRows.map((r) => {
			const hay = `${r.l0}\n${r.l1 ?? ""}\n${r.tags ?? ""}`.toLowerCase();
			const hitCount = tokens.reduce((n, t) => (hay.includes(t.toLowerCase()) ? n + 1 : n), 0);
			return { ...r, rel: hitCount || 1 };
		});
	}

	const now = Date.now();
	const top: Hit[] = scoreAndSort(rows, now).slice(0, limit);

	if (top.length) {
		const ids = top.map((t) => t.id);
		d.prepare("INSERT INTO recall_events (id,query,mode,hits,ids,created_at) VALUES (?,?,?,?,?,?)").run(
			randomUUID(),
			query,
			mode,
			top.length,
			ids.join(","),
			now,
		);
		for (const t of top) d.prepare("UPDATE records SET hits = hits + 1, last_used_at = ? WHERE id = ?").run(now, t.id);
	}

	// 预留：向量检索融合位置（v1 未接实现；接入时在这里合并 vectorBackend.search 的结果）

	return { hits: top, mode };
}

/** 兼容旧调用：只要结果数组 */
export function search(query: string, opts: SearchOptions = {}): Hit[] {
	return searchRecords(query, opts).hits;
}
