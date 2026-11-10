/**
 * 运维用例：初始化 / 回填 / 重建 / 状态统计。
 * 不做业务写入，只做"把系统拉回一致状态"的动作。
 */
import * as fs from "node:fs";
import { getConfig } from "../infra/config-store.ts";
import { getDb } from "../infra/db.ts";
import { ARCHIVE_DIR, CONFIG_PATH, DB_PATH, LEGACY_MD, MEMORY_DIR } from "../infra/paths.ts";
import { backfillArchive, migrateLegacyMarkdown, rebuildFromArchive } from "../infra/archive.ts";
import { expireStale } from "../infra/records.ts";
import { state } from "../state.ts";

/** 首次安装初始化（幂等）：目录 / 配置 / 库 / 旧 MEMORY.md 迁移 */
export function ensureInit(): string[] {
	const created: string[] = [];
	if (!fs.existsSync(MEMORY_DIR)) {
		fs.mkdirSync(MEMORY_DIR, { recursive: true });
		created.push(`目录 ${MEMORY_DIR}`);
	}
	if (!fs.existsSync(ARCHIVE_DIR)) {
		fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
		created.push(`目录 ${ARCHIVE_DIR}`);
	}
	if (!fs.existsSync(CONFIG_PATH)) {
		getConfig(); // 会落盘默认配置
		created.push(`配置 ${CONFIG_PATH}`);
	}
	const dbExisted = fs.existsSync(DB_PATH);
	getDb();
	if (!dbExisted) created.push(`数据库 ${DB_PATH}`);
	if (migrateLegacyMarkdown() > 0) created.push("迁移了旧 MEMORY.md");
	if (fs.existsSync(LEGACY_MD)) created.push("旧 MEMORY.md 已存在但库非空，未迁移");
	return created;
}

export function runBackfill(): { appended: number; refsRepaired: number } {
	return backfillArchive();
}

export function runRebuild(): { inserted: number; updated: number } {
	const r = rebuildFromArchive();
	state.dirty = true;
	return r;
}

export function runExpire(): number {
	return expireStale();
}

/** 状态统计（供 /mem stats 与 ops/check.js 复用语义） */
export function stats() {
	const d = getDb();
	expireStale();
	const byStatus = d.prepare("SELECT status, COUNT(*) c FROM records GROUP BY status").all() as any[];
	const byType = d.prepare("SELECT type, COUNT(*) c FROM records WHERE status='active' GROUP BY type ORDER BY c DESC").all() as any[];
	const staged = d.prepare("SELECT COUNT(*) c FROM candidates WHERE status='staged'").get() as any;
	const recalls = d.prepare("SELECT COUNT(*) c FROM recall_events").get() as any;
	const fts = d.prepare("SELECT COUNT(*) c FROM records_fts").get() as any;
	const cfg = getConfig();
	const eligible = d.prepare("SELECT COUNT(*) c FROM candidates WHERE status='staged' AND score >= ?").get(cfg.promoteThreshold) as any;
	return {
		config: cfg,
		byStatus,
		byType,
		staged: staged.c,
		eligible: eligible.c,
		recalls: recalls.c,
		fts: fts.c,
		dbPath: DB_PATH,
		configPath: CONFIG_PATH,
	};
}
