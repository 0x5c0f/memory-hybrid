/**
 * SQLite 连接与 schema。整层只负责"把库建出来"，业务读写不在这里。
 */
import * as fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { getConfig } from "./config-store.ts";
import { ARCHIVE_DIR, DB_PATH, MEMORY_DIR } from "./paths.ts";

let db: DatabaseSync | null = null;

/**
 * WAL 下 synchronous=NORMAL 仍保证崩溃一致性（断电最多丢最后几个事务），
 * 但每次写不再等 fsync —— 实测检索快 10 倍（14.5ms → 1.35ms）。
 */
export function applySqlitePragmas(d: DatabaseSync = getDb()): string {
	const mode = (getConfig().sqliteSync ?? "normal").toLowerCase() === "full" ? "FULL" : "NORMAL";
	d.exec(`PRAGMA synchronous = ${mode}`);
	return mode;
}

export function getDb(): DatabaseSync {
	if (db) return db;
	fs.mkdirSync(MEMORY_DIR, { recursive: true });
	fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
	const d = new DatabaseSync(DB_PATH);
	d.exec("PRAGMA journal_mode = WAL");
	// 多进程/子代理并发写入时不要直接抛 SQLITE_BUSY，等锁最多 5s
	d.exec("PRAGMA busy_timeout = 5000");
	applySqlitePragmas(d);
	d.exec(`
		CREATE TABLE IF NOT EXISTS records (
			id TEXT PRIMARY KEY,
			type TEXT NOT NULL,
			scope TEXT NOT NULL DEFAULT 'user',
			l0 TEXT NOT NULL,
			l1 TEXT NOT NULL DEFAULT '',
			raw TEXT,
			content_ref TEXT,
			tags TEXT NOT NULL DEFAULT '',
			importance REAL NOT NULL DEFAULT 0.6,
			status TEXT NOT NULL DEFAULT 'active',
			hits INTEGER NOT NULL DEFAULT 0,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			last_used_at INTEGER,
			expires_at INTEGER,
			source TEXT
		);
		CREATE INDEX IF NOT EXISTS idx_rec_status ON records(status, type);
		CREATE INDEX IF NOT EXISTS idx_rec_updated ON records(updated_at DESC);
		-- expireStale() 每次检索/注入都会跑，按 (status, expires_at) 走索引避免全表扫
		CREATE INDEX IF NOT EXISTS idx_rec_expires ON records(status, expires_at);
		CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5(
			id UNINDEXED, l0, l1, raw, tags, tokenize='trigram'
		);
		CREATE TABLE IF NOT EXISTS candidates (
			id TEXT PRIMARY KEY,
			session_id TEXT,
			kind TEXT,
			text TEXT NOT NULL,
			score REAL NOT NULL DEFAULT 0,
			reason TEXT,
			status TEXT NOT NULL DEFAULT 'staged',
			created_at INTEGER NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_cand_status ON candidates(status, created_at DESC);
		CREATE TABLE IF NOT EXISTS recall_events (
			id TEXT PRIMARY KEY,
			query TEXT NOT NULL,
			mode TEXT NOT NULL,
			hits INTEGER NOT NULL DEFAULT 0,
			ids TEXT NOT NULL DEFAULT '',
			created_at INTEGER NOT NULL
		);
		CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
	`);
	db = d;
	return d;
}

/** 供测试关闭连接（生产不用） */
export function _closeDb(): void {
	try {
		db?.close();
	} catch {}
	db = null;
}
