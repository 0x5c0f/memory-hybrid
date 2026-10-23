#!/usr/bin/env node
/**
 * check.js — 人工测试用的状态快照工具（只读，不改数据）
 *
 *   node ~/.pi/agent/memory/check.js           # 概览
 *   node ~/.pi/agent/memory/check.js -v        # 附带每条记录
 *   node ~/.pi/agent/memory/check.js --db <path>  # 指定库路径（测试多实例时）
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const argv = process.argv.slice(2);
const verbose = argv.includes("-v");
const dbIdx = argv.indexOf("--db");
const MEM_DIR = process.env.PI_MEMCORE_DIR
	? path.resolve(process.env.PI_MEMCORE_DIR)
	: path.join(process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent"), "memory");
const DB = dbIdx >= 0 ? argv[dbIdx + 1] : path.join(MEM_DIR, "index.db");

if (!fs.existsSync(DB)) {
	console.log(`❌ 数据库不存在：${DB}\n（扩展还没加载过，或 PI_MEMCORE_DIR 指向别处）`);
	process.exit(1);
}

const d = new DatabaseSync(DB, { readOnly: true });
const one = (sql, ...p) => d.prepare(sql).get(...p);
const all = (sql, ...p) => d.prepare(sql).all(...p);

const cfgPath = path.join(path.dirname(DB), "config.json");
let cfg = {};
try {
	cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
} catch {}

console.log(`\n数据库: ${DB}`);
console.log(`配置  : mode=${cfg.mode ?? "?"} budget=${cfg.injectBudgetChars ?? "?"} threshold=${cfg.promoteThreshold ?? "?"} captureRules=${(cfg.captureRules || []).length} triggers=${(cfg.triggerPatterns || []).length}`);

const byStatus = all("SELECT status, COUNT(*) c FROM records GROUP BY status");
const byType = all("SELECT type, COUNT(*) c FROM records WHERE status='active' GROUP BY type ORDER BY c DESC");
const cands = all("SELECT status, COUNT(*) c FROM candidates GROUP BY status");
const recalls = all("SELECT mode, COUNT(*) c FROM recall_events GROUP BY mode");
const fts = one("SELECT COUNT(*) c FROM records_fts").c;

console.log(`\nrecords: ${byStatus.map((r) => `${r.status}=${r.c}`).join(" ") || "空"}`);
console.log(`fts    : ${fts} 条（应与 active 数一致，否则索引不同步）`);
console.log(`类型   : ${byType.map((r) => `${r.type}=${r.c}`).join(" ") || "-"}`);
console.log(`候选   : ${cands.map((c) => `${c.status}=${c.c}`).join(" ") || "空"}`);
console.log(`检索   : ${recalls.map((r) => `${r.mode}=${r.c}`).join(" ") || "空"}`);

// 归档一致性
const archiveDir = path.join(path.dirname(DB), "archive");
if (fs.existsSync(archiveDir)) {
	const files = fs.readdirSync(archiveDir).filter((f) => f.endsWith(".md"));
	const ids = new Set();
	for (const f of files) {
		const txt = fs.readFileSync(path.join(archiveDir, f), "utf8");
		for (const m of txt.matchAll(/^id: ([0-9a-f-]{36})$/gm)) ids.add(m[1]);
	}
	const dbIds = new Set(all("SELECT id FROM records").map((r) => r.id));
	const missing = [...dbIds].filter((id) => !ids.has(id)).length;
	console.log(`归档   : ${files.length} 个文件 / ${ids.size} 个 id；DB 中未归档的 ${missing} 条（应手动跑 /mem backfill）`);
}

if (verbose) {
	console.log("\n最近 20 条：");
	for (const r of all("SELECT type,status,importance,hits,substr(l0,1,60) l0 FROM records ORDER BY updated_at DESC LIMIT 20")) {
		console.log(`  [${r.type}/${r.status}] imp=${r.importance} hits=${r.hits} ${r.l0}`);
	}
	const q = all("SELECT query,mode,hits FROM recall_events ORDER BY created_at DESC LIMIT 10");
	if (q.length) {
		console.log("\n最近查询：");
		for (const r of q) console.log(`  ${r.query} → ${r.mode} / ${r.hits} 条`);
	}
}
console.log("");
