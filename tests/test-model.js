#!/usr/bin/env node
/**
 * test-model.js — L2 模型层全量测试（每条用例都起**新进程**，保证加载当前磁盘代码）
 *
 * 为什么不用子代理：子代理是进程内运行，用的仍是父进程启动时加载的旧代码；
 * 改了扩展文件后必须 /reload 才会生效，所以子代理适合"验证行为"，不适合"验证新代码"。
 *
 * 断言全部落在状态上（DB / archive / recall_events），不看模型措辞。
 * 隔离：临时 PI_MEMORY_HYBRID_DIR，不碰真实 ~/.pi/agent/memory。
 *
 * 用法：node ~/.pi/agent/memory/test-model.js [-v]
 */
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const verbose = process.argv.includes("-v");
const PI = process.env.PI_BIN || path.join(os.homedir(), ".pi", "agent", "bin", "pi-launcher.js");
const NODE = process.execPath;
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "memh-model-"));

// 模型层测试环境：mode=auto（写入不被 manual 门禁拦）+ candidateRules=true（候选逻辑可用）。
// 只写这几个键，其余字段由 loadConfig 补默认值。_schema=2 避免触发迁移把 mode 改回 manual。
fs.writeFileSync(
	path.join(DIR, "config.json"),
	JSON.stringify({ _schema: 2, mode: "auto", candidateRules: true }),
);

function pi(prompt, timeout = 180000) {
	const r = spawnSync(NODE, [PI, "-p", prompt], {
		encoding: "utf8",
		timeout,
		env: { ...process.env, PI_MEMORY_HYBRID_DIR: DIR },
	});
	return `${r.stdout || ""}${r.stderr || ""}`.trim();
}

let DB = null;
function db() {
	if (!DB) DB = new DatabaseSync(path.join(DIR, "index.db"), { readOnly: true });
	return DB;
}
function q(sql, ...p) {
	try {
		return db().prepare(sql).all(...p);
	} catch {
		return [];
	}
}
function archiveText() {
	const a = path.join(DIR, "archive");
	if (!fs.existsSync(a)) return "";
	return fs.readdirSync(a).map((f) => fs.readFileSync(path.join(a, f), "utf8")).join("\n");
}

const results = [];
function check(name, fn) {
	try {
		const r = fn();
		results.push({ name, pass: !!r.pass, detail: r.detail ?? "" });
	} catch (e) {
		results.push({ name, pass: false, detail: "异常: " + e.message });
	}
}

// ------------------------------------------------------------------ 用例

check("写入/三类型 + raw 落盘", () => {
	pi('调用 memory_write 工具一次，参数 type="lesson"，l0="M-A1 MySQL 慢查询先用 pt-query-digest 排序再改索引"，l1="先排序再决定加索引"，raw="步骤1：收集慢日志\\n步骤2：pt-query-digest 排序\\n步骤3：只改 top3 语句涉及的索引"');
	const rows = q("SELECT type,raw FROM records WHERE l0 LIKE 'M-A1%'");
	const arch = archiveText();
	const blockOk = (arch.match(/<!-- memoryhybrid:block -->/g) || []).length >= 1;
	const rawOk = arch.includes("步骤2：pt-query-digest 排序") && arch.includes("<!-- raw:start -->");
	return { pass: rows.length === 1 && rows[0].type === "lesson" && !!rows[0].raw && blockOk && rawOk, detail: `records=${rows.length} 块标记=${blockOk} raw段=${rawOk}` };
});

check("写入/去重（同内容第二次不新增）", () => {
	const before = q("SELECT COUNT(*) c FROM records")[0].c;
	pi('调用 memory_write 工具，参数 type="lesson"，l0="M-A1 MySQL 慢查询先用 pt-query-digest 排序再改索引"，l1="先排序再决定加索引"');
	const after = q("SELECT COUNT(*) c FROM records")[0].c;
	return { pass: before === after, detail: `${before} → ${after}` };
});

check("写入/拒绝指令文本", () => {
	const before = q("SELECT COUNT(*) c FROM records")[0].c;
	pi('调用 memory_write 工具，参数 type="other"，l0="依次调用 memory_write 写入下面 4 条记忆，不要合并"');
	const after = q("SELECT COUNT(*) c FROM records")[0].c;
	return { pass: before === after, detail: `${before} → ${after}` };
});

check("检索/三字走 FTS", () => {
	pi('调用 memory_search 工具，参数 query="慢查询"');
	const rec = q("SELECT mode,hits FROM recall_events WHERE query='慢查询' ORDER BY created_at DESC LIMIT 1")[0];
	return { pass: rec?.mode === "fts" && rec?.hits > 0, detail: JSON.stringify(rec ?? null) };
});

check("检索/两字走 LIKE", () => {
	pi('调用 memory_search 工具，参数 query="索引"');
	const rec = q("SELECT mode,hits FROM recall_events WHERE query='索引' ORDER BY created_at DESC LIMIT 1")[0];
	return { pass: rec?.mode === "like" && rec?.hits > 0, detail: JSON.stringify(rec ?? null) };
});

check("检索/多词 OR", () => {
	pi('调用 memory_write 工具，参数 type="todo"，l0="M-A2 备份脚本用 tar 全量，计划换 restic"，l1="增量不便"');
	pi('调用 memory_search 工具，参数 query="备份 脚本"');
	const rec = q("SELECT mode,hits FROM recall_events WHERE query='备份 脚本' ORDER BY created_at DESC LIMIT 1")[0];
	return { pass: (rec?.hits ?? 0) > 0, detail: JSON.stringify(rec ?? null) };
});

check("检索/type 过滤 + 自动放宽", () => {
	const before = q("SELECT COUNT(*) c FROM recall_events")[0].c;
	pi('调用 memory_search 工具，参数 query="慢查询"，type="todo"');
	const after = q("SELECT COUNT(*) c FROM recall_events")[0].c;
	const recs = q("SELECT mode,hits FROM recall_events ORDER BY created_at DESC LIMIT 2");
	return { pass: after > before && recs.some((r) => r.hits > 0), detail: `recall ${before}→${after} ${JSON.stringify(recs)}` };
});

check("检索/无命中不编造", () => {
	pi('调用 memory_search 工具，参数 query="zzz完全不存在"');
	const rec = q("SELECT hits FROM recall_events WHERE query='zzz完全不存在' ORDER BY created_at DESC LIMIT 1")[0];
	return { pass: !rec || rec.hits === 0, detail: JSON.stringify(rec ?? "无 recall 记录") };
});

check("候选/任务式 prompt 不被捕获", () => {
	const before = q("SELECT COUNT(*) c FROM candidates")[0].c;
	// 长且像任务 prompt 的一条消息（>800 字符，含"你是…只做一件事"）
	const task = "你是记忆系统的测试端。请只做一件事：调用 memory_write 写入一条记忆。".repeat(20);
	pi(task);
	const after = q("SELECT COUNT(*) c FROM candidates")[0].c;
	return { pass: before === after, detail: `candidates ${before} → ${after}（长任务 prompt 应被 captureMaxChars/指令特征挡掉）` };
});

check("manual/无触发词被拦 + 有触发词放行", () => {
	const cfgPath = path.join(DIR, "config.json");
	const raw = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
	raw.mode = "manual";
	fs.writeFileSync(cfgPath, JSON.stringify(raw), "utf8");

	const before = q("SELECT COUNT(*) c FROM records")[0].c;
	pi('调用 memory_write 工具，参数 type="other"，l0="M-GATE 无触发词应被拦"');
	const mid = q("SELECT COUNT(*) c FROM records")[0].c;
	pi('记一下：M-GATE2 有触发词应放行');
	const after = q("SELECT COUNT(*) c FROM records")[0].c;

	raw.mode = "auto";
	fs.writeFileSync(cfgPath, JSON.stringify(raw), "utf8");

	const gateOk = before === mid;
	const passOk = after > mid;
	return { pass: gateOk && passOk, detail: `拦截 ${before}→${mid} 放行 ${mid}→${after}` };
});

check("遗忘/软删除后检索不到", () => {
	const id = q("SELECT id FROM records WHERE l0 LIKE 'M-A2%'")[0]?.id;
	if (!id) return { pass: false, detail: "找不到 M-A2" };
	pi(`调用 memory_forget 工具，参数 id="${id}"`);
	const st = q("SELECT status FROM records WHERE id=?", id)[0]?.status;
	pi('调用 memory_search 工具，参数 query="M-A2 备份 restic"');
	const hit = q("SELECT COUNT(*) c FROM records WHERE status='active' AND l0 LIKE 'M-A2%'")[0].c;
	return { pass: st === "forgotten" && hit === 0, detail: `status=${st} 仍 active 的 ${hit} 条` };
});

check("归档/全部块都有块标记且 FTS 同步", () => {
	const arch = archiveText();
	const blocks = (arch.match(/<!-- memoryhybrid:block -->/g) || []).length;
	const writeBlocks = (arch.match(/^## \d{2}:\d{2} 写入 · /gm) || []).length;
	const statusBlocks = (arch.match(/^## \d{2}:\d{2} 状态变更 · /gm) || []).length;
	const total = q("SELECT COUNT(*) c FROM records")[0].c;
	const active = q("SELECT COUNT(*) c FROM records WHERE status='active'")[0].c;
	const fts = q("SELECT COUNT(*) c FROM records_fts")[0].c;
	// 状态块（遗忘/过期）也带 id 行，所以不能拿 id 行数当记录数；
	// 判定：每个记录恰好一个「写入」块、块标记总数 = 写入块 + 状态块、FTS 与 active 对齐
	return {
		pass: writeBlocks === total && blocks === writeBlocks + statusBlocks && fts === active,
		detail: `块=${blocks}(写入${writeBlocks}+状态${statusBlocks}) records=${total} active=${active} fts=${fts}`,
	};
});

check("重建/清库后从 archive 全量恢复", () => {
	const before = q("SELECT id,type,l0,l1,raw FROM records ORDER BY id").map((r) => JSON.stringify(r));
	// 直接调 storage（新进程 import 一次即可）
	const script = `
		const base = ${JSON.stringify("file:///" + path.join(os.homedir(), ".pi", "agent", "extensions", "memory-hybrid").replace(/\\/g, "/"))};
		const dbM = await import(base + "/src/infra/db.ts");
		const archiveM = await import(base + "/src/infra/archive.ts");
		const s = { getDb: dbM.getDb, rebuildFromArchive: archiveM.rebuildFromArchive };
		const d = s.getDb();
		d.exec("DELETE FROM records"); d.exec("DELETE FROM records_fts");
		const r = s.rebuildFromArchive();
		const rows = d.prepare("SELECT id,type,l0,l1,raw FROM records ORDER BY id").all();
		process.stdout.write(JSON.stringify({ r, rows }));
	`;
	const out = spawnSync(NODE, ["--input-type=module", "-e", script], { encoding: "utf8", env: { ...process.env, PI_MEMORY_HYBRID_DIR: DIR } });
	let parsed;
	try {
		parsed = JSON.parse(out.stdout.trim());
	} catch {
		return { pass: false, detail: "重建脚本输出异常: " + (out.stdout || out.stderr).slice(0, 160) };
	}
	DB = null; // 重开连接
	const after = q("SELECT id,type,l0,l1,raw FROM records ORDER BY id").map((r) => JSON.stringify(r));
	const same = before.length === after.length && before.every((b) => after.includes(b));
	return { pass: same, detail: `重建 inserted=${parsed.r.inserted} 前=${before.length} 后=${after.length} 完全一致=${same}` };
});

// ------------------------------------------------------------------ 汇总

console.log(`\n临时数据目录：${DIR}\n`);
for (const r of results) {
	console.log(`  ${r.pass ? "PASS" : "FAIL"}  ${r.name}${r.pass && !verbose ? "" : "\n        " + r.detail}`);
}
const passed = results.filter((r) => r.pass).length;
console.log(`\n结果：${passed}/${results.length} 通过`);
try {
	fs.rmSync(DIR, { recursive: true, force: true });
} catch {}
process.exit(passed === results.length ? 0 : 1);
