/**
 * Markdown 归档轨（双轨存储的"事实源"）。
 *
 * 块格式：
 *   <!-- memoryhybrid:block -->
 *   ## HH:MM 写入 · [type] <完整 l0>
 *   <L1>
 *   <!-- raw:start -->
 *   <L2 原文>
 *   <!-- raw:end -->
 *   source: ...
 *   id: <uuid>
 *
 * 状态变更块：
 *   <!-- memoryhybrid:block -->
 *   ## HH:MM 状态变更 · [type] <l0>
 *   status: forgotten|expired
 *   id: <uuid>
 *
 * 约定：标记本身会被转义（&lt;!--），避免原文把解析器带偏；id/source 从块尾解析。
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getConfig } from "./config-store.ts";
import { getDb } from "./db.ts";
import { reindexRecord } from "./fts.ts";
import { ARCHIVE_DIR, LEGACY_MD, todayStr } from "./paths.ts";
import { normalizeText } from "../domain/normalize.ts";

export const BLOCK_MARK = "<!-- memoryhybrid:block -->";
/** 项目改名前的标记：读取时归一化成新标记，保证老归档仍可重建 */
export const LEGACY_BLOCK_MARK = "<!-- memcore:block -->";
export const RAW_START = "<!-- raw:start -->";
export const RAW_END = "<!-- raw:end -->";

/** 转义会破坏解析的标记（只影响这些注释本身，不影响正文语义） */
export function escapeMarkers(text: string): string {
	return text.replace(/<!--\s*(raw:(?:start|end)|(?:memoryhybrid|memcore):block)\s*-->/gi, (m) => m.replace("<!--", "&lt;!--"));
}

export function unescapeMarkers(text: string): string {
	return text.replace(/&lt;!--\s*(raw:(?:start|end)|(?:memoryhybrid|memcore):block)\s*-->/gi, (m) => m.replace("&lt;!--", "<!--"));
}

export interface ArchiveRecord {
	id: string;
	type: string;
	l0: string;
	l1: string;
	raw?: string | null;
	source?: string | null;
	importance?: number;
	tags?: string;
	expiresAt?: number | null;
}

export function archiveBlock(kind: string, record: ArchiveRecord, hhmm = new Date().toTimeString().slice(0, 5)): string {
	const lines = [BLOCK_MARK, `## ${hhmm} ${kind} · [${record.type}] ${record.l0}`, escapeMarkers(record.l1 || record.l0)];
	const rawText = (record.raw ?? "").trim();
	if (rawText) lines.push(RAW_START, escapeMarkers(rawText), RAW_END);
	// 元数据行：让 archive 成为完整事实源（重建时还原 importance/tags/expires）
	if (record.importance !== undefined) lines.push(`importance: ${record.importance}`);
	if (record.tags) lines.push(`tags: ${escapeMarkers(record.tags)}`);
	if (record.expiresAt !== undefined && record.expiresAt !== null) lines.push(`expires: ${record.expiresAt}`);
	if (record.source) lines.push(`source: ${escapeMarkers(record.source)}`);
	lines.push(`id: ${record.id}`, "");
	return lines.join("\n");
}

/** 读 meta 表的行号计数；没有返回 null */
function readArchiveLineCounter(day: string): number | null {
	const r = getDb().prepare("SELECT v FROM meta WHERE k = ?").get(`archive_lines:${day}`) as { v: string } | undefined;
	return r ? Number(r.v) : null;
}

function writeArchiveLineCounter(day: string, n: number): void {
	getDb().prepare("INSERT OR REPLACE INTO meta (k,v) VALUES (?,?)").run(`archive_lines:${day}`, String(n));
}

function readFileOrEmpty(file: string): string {
	try {
		return fs.readFileSync(file, "utf8");
	} catch (err: any) {
		// ENOENT（文件不存在）是正常情况；其它错误（权限/磁盘/路径损坏）必须暴露，不能静默吞掉
		if (err?.code !== "ENOENT") throw err;
		return "";
	}
}

/** 追加一个块，返回它在文件里的行号区间（供 content_ref 使用） */
export function appendArchiveFile(day: string, block: string): { startLine: number; endLine: number } {
	fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
	const file = path.join(ARCHIVE_DIR, `${day}.md`);

	// 行号从 meta 表读（首次初始化时读文件算一次）；append 是追加不覆盖，避免多进程互相覆盖
	let counter = readArchiveLineCounter(day);
	if (counter === null) {
		let existing = readFileOrEmpty(file);
		if (!existing) {
			// 首次创建：写标题行，下一行号从 2 开始
			fs.writeFileSync(file, `# ${day} 记忆归档\n`, "utf8");
			counter = 2;
		} else {
			// 文件已存在（可能是旧版生成的、或手动建的）：若末尾无换行，先补一个，
			// 否则 append 会把新块粘到最后一行的尾部
			if (!existing.endsWith("\n")) {
				fs.appendFileSync(file, "\n", "utf8");
				existing += "\n";
			}
			// 按当前行数定位下一行号
			counter = existing.split("\n").length;
		}
	}

	const startLine = counter;
	const endLine = startLine + block.split("\n").length - 2;

	// 追加（原子追加，不读回整个文件、不覆盖已有内容）
	fs.appendFileSync(file, block, "utf8");
	writeArchiveLineCounter(day, endLine + 1);

	return { startLine, endLine };
}

/** 写一条记录的归档块（受 config.archiveWrite 控制），返回 content_ref */
export function appendRecordArchive(record: ArchiveRecord): string {
	if (!getConfig().archiveWrite) return "";
	const day = todayStr();
	const { startLine, endLine } = appendArchiveFile(day, archiveBlock("写入", record));
	return `archive/${day}.md#L${startLine}-L${endLine}`;
}

/** 状态变更落归档，保证重建后状态不丢 */
export function appendStatusBlock(id: string, type: string, l0: string, status: string): void {
	if (!getConfig().archiveWrite) return;
	const day = todayStr();
	const block = [`## ${new Date().toTimeString().slice(0, 5)} 状态变更 · [${type}] ${l0}`, `status: ${status}`, `id: ${id}`, ""].join("\n");
	appendArchiveFile(day, [BLOCK_MARK, block].join("\n"));
}

/**
 * 把 DB 里有、归档里没有的记录回填成 Markdown；
 * 同时修复 content_ref 为空的记录（崩溃在 appendRecordArchive 之后、UPDATE 之前的情形）。
 */
export function backfillArchive(): { appended: number; refsRepaired: number } {
	const d = getDb();
	const rows = d.prepare(
		"SELECT id,type,l0,l1,source,created_at,content_ref,importance,tags,expires_at FROM records ORDER BY created_at ASC",
	).all() as any[];

	const refById = new Map<string, string>();
	const archived = new Set<string>();
	try {
		for (const f of fs.readdirSync(ARCHIVE_DIR)) {
			if (!f.endsWith(".md")) continue;
			const lines = fs.readFileSync(path.join(ARCHIVE_DIR, f), "utf8").split(/\r?\n/);
			let blockStart = 0;
			for (let i = 0; i < lines.length; i++) {
				if (lines[i].trim() === BLOCK_MARK || lines[i].trim() === LEGACY_BLOCK_MARK) blockStart = i + 1;
				const m = lines[i].match(/^id: ([0-9a-f-]{36})$/);
				if (m) {
					archived.add(m[1]);
					if (blockStart > 0) refById.set(m[1], `archive/${f}#L${blockStart}-L${i + 1}`);
				}
			}
		}
	} catch {}

	let appended = 0;
	let refsRepaired = 0;
	for (const r of rows) {
		if (!archived.has(r.id)) {
			// 用本地日期（与写入侧 todayStr() 一致），不能用 toISOString —— 那会得到 UTC 日期，
			// GMT+8 时区凌晨 0-8 点写入的记录会被回填到前一天的归档文件
			const day = todayStr(new Date(r.created_at));
			const { startLine, endLine } = appendArchiveFile(
				day,
				archiveBlock(
					"回填",
					{ id: r.id, type: r.type, l0: r.l0, l1: r.l1 || r.l0, source: r.source, importance: r.importance, tags: r.tags, expiresAt: r.expires_at },
					"00:00",
				),
			);
			d.prepare("UPDATE records SET content_ref = ? WHERE id = ?").run(`archive/${day}.md#L${startLine}-L${endLine}`, r.id);
			appended++;
			continue;
		}
		if ((!r.content_ref || r.content_ref === "") && refById.has(r.id)) {
			d.prepare("UPDATE records SET content_ref = ? WHERE id = ?").run(refById.get(r.id), r.id);
			refsRepaired++;
		}
	}
	return { appended, refsRepaired };
}

/** 从 archive/*.md 重建/补齐 records（跳机器时只带 Markdown 就够） */
export function rebuildFromArchive(): { inserted: number; updated: number } {
	const d = getDb();
	let inserted = 0;
	let updated = 0;
	const statusOps: Array<{ id: string; status: string }> = [];
	const files = fs.existsSync(ARCHIVE_DIR) ? fs.readdirSync(ARCHIVE_DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)) : [];

	for (const f of files) {
		const day = f.replace(/\.md$/, "");
		// 旧归档用 memcore:block，读入时统一成新标记，后续只认 BLOCK_MARK
		const text = fs.readFileSync(path.join(ARCHIVE_DIR, f), "utf8").split(LEGACY_BLOCK_MARK).join(BLOCK_MARK);
		const blocks = text.includes(BLOCK_MARK)
			? text.split(BLOCK_MARK).slice(1)
			: text.split(/^## /m).slice(1).map((b) => "## " + b); // 旧文件退回按 `## ` 切

		for (const rawBlock of blocks) {
			const lines = rawBlock.replace(/^\s*\n/, "").split(/\r?\n/).map((l) => l.trimEnd());
			const head = lines.shift() ?? "";

			// 状态变更块：只记 id + status，最后统一应用
			if (/^## \d{2}:\d{2} 状态变更/.test(head)) {
				const sid = lines.find((l) => /^id: [0-9a-f-]{36}$/.test(l))?.slice(4).trim();
				const st = lines.find((l) => l.startsWith("status: "))?.slice(8).trim();
				if (sid && st) statusOps.push({ id: sid, status: st });
				continue;
			}

			const m = head.match(/^## (\d{2}:\d{2})\s+(\S+)\s+·\s+\[(\w+)\]\s+(.+)$/);
			if (!m) continue;
			const [, hhmm, , type, l0] = m;

			// 元数据只认块尾：最后一行是 id，再往上一行可能是 source
			const body = lines.slice();
			while (body.length && body[body.length - 1] === "") body.pop();
			const tail = body[body.length - 1] ?? "";
			if (!/^id: [0-9a-f-]{36}$/.test(tail)) continue;
			const id = tail.slice(4).trim();
			body.pop();
			let source: string | null = null;
			if ((body[body.length - 1] ?? "").startsWith("source: ")) {
				source = unescapeMarkers(body[body.length - 1].slice(8).trim());
				body.pop();
			}
			// 元数据行（可选，旧块没有）：expires → tags → importance 逆序弹出
			let metaExpires: number | null = null;
			let metaTags: string | null = null;
			let metaImportance: number | null = null;
			if ((body[body.length - 1] ?? "").startsWith("expires: ")) {
				const v = Number(body[body.length - 1].slice(9).trim());
				metaExpires = Number.isFinite(v) ? v : null;
				body.pop();
			}
			if ((body[body.length - 1] ?? "").startsWith("tags: ")) {
				metaTags = unescapeMarkers(body[body.length - 1].slice(6).trim());
				body.pop();
			}
			if ((body[body.length - 1] ?? "").startsWith("importance: ")) {
				const v = Number(body[body.length - 1].slice(12).trim());
				metaImportance = Number.isFinite(v) ? v : null;
				body.pop();
			}

			const bodyText = body.join("\n").trim();
			const rawMatch = bodyText.match(/<!-- raw:start -->\n([\s\S]*?)\n<!-- raw:end -->/);
			const rawText = rawMatch ? unescapeMarkers(rawMatch[1]) : null;
			const l1 = unescapeMarkers((rawMatch ? bodyText.replace(rawMatch[0], "") : bodyText).trim());

			const [Y, M, D] = day.split("-").map(Number);
			const [h, mi] = hhmm.split(":").map(Number);
			const created = new Date(Y, M - 1, D, h, mi).getTime();

			if (d.prepare("SELECT id FROM records WHERE id=?").get(id)) {
				d.prepare("UPDATE records SET l0=?, l1=?, raw=?, importance=COALESCE(?, importance), tags=COALESCE(?, tags), expires_at=COALESCE(?, expires_at), updated_at=? WHERE id=?").run(
					l0.slice(0, 160),
					l1.slice(0, 600),
					rawText,
					metaImportance,
					metaTags,
					metaExpires,
					Date.now(),
					id,
				);
				updated++;
			} else {
				d.prepare(
					"INSERT INTO records (id,type,scope,l0,l1,raw,tags,importance,status,created_at,updated_at,expires_at,source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
				).run(
					id,
					type,
					"user",
					l0.slice(0, 160),
					l1.slice(0, 600),
					rawText,
					metaTags ?? `#${type}`,
					metaImportance ?? 0.6,
					"active",
					created,
					created,
					metaExpires,
					source,
				);
				inserted++;
			}
			reindexRecord(id);
		}
	}

	// 应用状态变更（遗忘/过期）：非 active 的从 FTS 摘除
	for (const op of statusOps) {
		if (!d.prepare("SELECT id FROM records WHERE id=?").get(op.id)) continue;
		d.prepare("UPDATE records SET status=?, updated_at=? WHERE id=?").run(op.status, Date.now(), op.id);
		if (op.status !== "active") d.prepare("DELETE FROM records_fts WHERE id=?").run(op.id);
		else reindexRecord(op.id);
	}
	return { inserted, updated };
}

/** 一次性迁移旧 pi-memory 的 MEMORY.md（幂等：库里已有记录则跳过） */
export function migrateLegacyMarkdown(): number {
	const d = getDb();
	if (!fs.existsSync(LEGACY_MD)) return 0;
	const count = d.prepare("SELECT COUNT(*) AS c FROM records").get() as { c: number };
	if (count.c > 0) return 0;
	const text = fs.readFileSync(LEGACY_MD, "utf8");
	const now = Date.now();
	let imported = 0;
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		const m = line.match(/^[-*]\s*(?:#(decision|lesson|preference|event|case|pattern|todo|entity)\s*)?(.+)$/);
		if (!m) continue;
		const body = m[2].trim();
		if (!body || body.length < 6) continue;
		const type = m[1] ?? "other";
		const id = randomUUID();
		d.prepare(
			"INSERT INTO records (id,type,scope,l0,l1,raw,tags,importance,status,created_at,updated_at,source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
		).run(id, type, "user", body.slice(0, 120), body, null, `#${type}`, 0.7, "active", now, now, "migrated:MEMORY.md");
		d.prepare("INSERT INTO records_fts (id,l0,l1,raw,tags) VALUES (?,?,?,?,?)").run(id, body.slice(0, 120), body, "", `#${type}`);
		imported++;
	}
	if (imported > 0) fs.renameSync(LEGACY_MD, `${LEGACY_MD}.migrated-${now}`);
	return imported;
}

/** normalizeText 由 domain 提供，这里导出便于测试与调用方复用 */
export { normalizeText };
