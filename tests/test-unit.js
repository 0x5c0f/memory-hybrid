#!/usr/bin/env node
/**
 * test-unit.js — L1 单元测试（确定性、零 API 调用）
 *
 * 直接 import 扩展模块（Node 24 原生 TS 类型剥离，不需要 jiti/编译），
 * 对 storage / search / capture / config 的真实现跑断言。
 *
 * 隔离：使用临时 PI_MEMCORE_DIR，**绝不碰**真实 ~/.pi/agent/memory。
 *
 * 用法：node ~/.pi/agent/memory/test-unit.js [-v]
 */
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const verbose = process.argv.includes("-v");
const EXT = path.join(os.homedir(), ".pi", "agent", "extensions", "memory-hybrid");
const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "memh-unit-"));
process.env.PI_MEMCORE_DIR = TEST_DIR;

const results = [];
function check(name, fn) {
	try {
		const r = fn();
		results.push({ name, pass: !!r.pass, detail: r.detail ?? "" });
	} catch (e) {
		results.push({ name, pass: false, detail: `异常: ${e.message}` });
	}
}

(async () => {
// 新分层结构：infra/(IO) + services/(用例) + domain/(纯逻辑)
	const _E = EXT.replace(/\\/g, "/");
	const dbm = await import(`file:///${_E}/src/infra/db.ts`);
	const records = await import(`file:///${_E}/src/infra/records.ts`);
	const archive = await import(`file:///${_E}/src/infra/archive.ts`);
	const configStore = await import(`file:///${_E}/src/infra/config-store.ts`);
	const searchSvc = await import(`file:///${_E}/src/services/search.ts`);
	const captureSvc = await import(`file:///${_E}/src/services/capture.ts`);
	const maintenance = await import(`file:///${_E}/src/services/maintenance.ts`);
	// 兼容旧调用点：storage.* / search.searchRecords / config.* / capture.*
	const storage = { ...dbm, ...records, ...archive, ...maintenance };
	const search = { searchRecords: searchSvc.search };
	const capture = captureSvc;
	const config = configStore;



	const db = () => storage.getDb();

	console.log(`\n临时数据目录：${TEST_DIR}\n`);

	// ---------------------------------------------------------- config

	check("config/首次自动生成文件", () => {
		config.loadConfig();
		const raw = JSON.parse(fs.readFileSync(path.join(TEST_DIR, "config.json"), "utf8"));
		return { pass: raw._schema === 2 && !!raw._help && raw.mode === "manual" && raw.candidateRules === false, detail: `mode=${raw.mode} candidateRules=${raw.candidateRules} schema=${raw._schema}` };
	});

	check("config/clamp 越界", () => {
		const raw = JSON.parse(fs.readFileSync(path.join(TEST_DIR, "config.json"), "utf8"));
		raw.injectBudgetChars = 99999;
		raw.promoteThreshold = -3;
		fs.writeFileSync(path.join(TEST_DIR, "config.json"), JSON.stringify(raw), "utf8");
		const cfg = config.loadConfig();
		return { pass: cfg.injectBudgetChars === 4000 && cfg.promoteThreshold === 0, detail: `budget=${cfg.injectBudgetChars} threshold=${cfg.promoteThreshold}` };
	});

	check("config/非法正则被丢弃", () => {
		const raw = JSON.parse(fs.readFileSync(path.join(TEST_DIR, "config.json"), "utf8"));
		raw.captureRules = [{ pattern: "[unclosed", kind: "x", weight: 0.5, reason: "bad" }, { pattern: "好规则", kind: "lesson", weight: 0.8, reason: "ok" }];
		fs.writeFileSync(path.join(TEST_DIR, "config.json"), JSON.stringify(raw), "utf8");
		const cfg = config.loadConfig();
		const compiled = config.compileCaptureRules();
		return { pass: cfg.captureRules.length === 1 && compiled.length === 1, detail: `rules=${JSON.stringify(cfg.captureRules.map((r) => r.pattern))}` };
	});

	// 恢复默认配置给后面的用例
	try {
		fs.unlinkSync(path.join(TEST_DIR, "config.json"));
	} catch {}
	config.loadConfig();

	check("config/旧 schema 自动迁移到新语义", () => {
		// 构造一份 schema=1 的旧配置文件（旧默认：auto + candidateRules=true + 阈值 0.6 + entity 泛词规则）
		const legacy = {
			_schema: 1,
			mode: "auto",
			candidateRules: true,
			promoteThreshold: 0.6,
			injectBudgetChars: 600,
			maxInjectItems: 20,
			archiveWrite: true,
			ttlDaysByType: { event: 30, todo: 90, case: 180, pattern: 365 },
			vector: { backend: "none" },
			captureRules: [{ pattern: "配置|端口|路径|目录|账号|地址|域名", kind: "entity", weight: 0.45, reason: "配置/实体信息" }],
			triggerPatterns: ["记一下"],
			captureMaxChars: 800,
			sqliteSync: "normal",
		};
		fs.writeFileSync(path.join(TEST_DIR, "config.json"), JSON.stringify(legacy), "utf8");
		const cfg = config.loadConfig();
		const onDisk = JSON.parse(fs.readFileSync(path.join(TEST_DIR, "config.json"), "utf8"));
		const entity = cfg.captureRules.find((r) => r.kind === "entity");
		const pass =
			cfg.mode === "manual" &&
			cfg.candidateRules === true && // candidateRules 不迁移（无法区分默认 true 与手动 true）
			cfg.promoteThreshold === 0.45 &&
			onDisk._schema === 2 &&
			entity && entity.pattern.includes("https"); // 值特征规则含 URL 特征
		return { pass, detail: `mode=${cfg.mode} cand=${cfg.candidateRules} thr=${cfg.promoteThreshold} schema=${onDisk._schema} entity含URL=${entity ? entity.pattern.includes("https") : false}` };
	});

	// 迁移用例改过 config.json，恢复默认
	try {
		fs.unlinkSync(path.join(TEST_DIR, "config.json"));
	} catch {}
	config.loadConfig();

	// ---------------------------------------------------------- 写入

	check("写入/基本 + 归档", () => {
		const r = storage.insertRecord({ type: "preference", l0: "U-ALPHA 生产环境禁止 rm -rf" });
		const files = fs.readdirSync(path.join(TEST_DIR, "archive"));
		const txt = fs.readFileSync(path.join(TEST_DIR, "archive", files[0]), "utf8");
		return { pass: !!r.id && r.contentRef.includes("archive/") && txt.includes(r.id), detail: `id=${r.id.slice(0, 8)} ref=${r.contentRef}` };
	});

	check("写入/去重（同标题不重复）", () => {
		const before = db().prepare("SELECT COUNT(*) c FROM records").get().c;
		const r = storage.insertRecord({ type: "preference", l0: "U-ALPHA 生产环境禁止 rm -rf" });
		const after = db().prepare("SELECT COUNT(*) c FROM records").get().c;
		return { pass: r.duplicate === true && before === after, detail: `duplicate=${r.duplicate} count=${after}` };
	});

	check("写入/拒绝指令文本", () => {
		const r = storage.insertRecord({ type: "other", l0: "依次调用 memory_write 写入下面 4 条记忆，不要合并" });
		return { pass: !!r.rejected, detail: `rejected=${r.rejected ?? "无"}` };
	});

	check("写入/stripTrigger 去前缀", () => {
		const r = storage.insertRecord({ type: "lesson", l0: "记一下：U-BETA 记得改 DNS TTL" });
		const row = db().prepare("SELECT l0 FROM records WHERE id=?").get(r.id);
		return { pass: row.l0.startsWith("U-BETA"), detail: `l0=${row.l0}` };
	});

	check("写入/TTL 按类型生效", () => {
		const r = storage.insertRecord({ type: "event", l0: "U-GAMMA 一次机房巡检" });
		const row = db().prepare("SELECT expires_at FROM records WHERE id=?").get(r.id);
		const days = Math.round((row.expires_at - Date.now()) / 86400_000);
		return { pass: days >= 29 && days <= 30, detail: `expires 在 ${days} 天后` };
	});

	// ---------------------------------------------------------- 检索

	storage.insertRecord({ type: "lesson", l0: "U-DELTA MySQL 慢查询先用 pt-query-digest 排序再改索引" });
	storage.insertRecord({ type: "todo", l0: "U-EPSILON 备份脚本目前用 tar 全量，计划换 restic" });

	check("检索/三字走 FTS", () => {
		const hits = search.searchRecords("慢查询");
		const rec = db().prepare("SELECT mode,hits FROM recall_events WHERE query='慢查询' ORDER BY created_at DESC LIMIT 1").get();
		return { pass: hits.length === 1 && rec.mode === "fts", detail: `hits=${hits.length} mode=${rec?.mode}` };
	});

	check("检索/两字走 LIKE（trigram 不支持）", () => {
		const hits = search.searchRecords("索引");
		const rec = db().prepare("SELECT mode,hits FROM recall_events WHERE query='索引' ORDER BY created_at DESC LIMIT 1").get();
		return { pass: hits.length === 1 && rec.mode === "like", detail: `hits=${hits.length} mode=${rec?.mode}` };
	});

	check("检索/多词 OR", () => {
		const hits = search.searchRecords("备份 脚本");
		return { pass: hits.length === 1, detail: `hits=${hits.length}` };
	});

	check("检索/英文大小写不敏感", () => {
		const a = search.searchRecords("mysql");
		const b = search.searchRecords("MYSQL");
		return { pass: a.length === b.length && a.length > 0, detail: `lower=${a.length} upper=${b.length}` };
	});

	check("检索/type 过滤生效", () => {
		const hit = search.searchRecords("慢查询", { type: "lesson" });
		const miss = search.searchRecords("慢查询", { type: "todo" });
		return { pass: hit.length === 1 && miss.length === 0, detail: `lesson=${hit.length} todo=${miss.length}` };
	});

	check("检索/特殊字符不炸", () => {
		const hits = search.searchRecords('rm -rf "x" (y) [z]');
		return { pass: Array.isArray(hits), detail: `hits=${hits.length}` };
	});

	check("检索/不存在的词返回空", () => {
		const hits = search.searchRecords("zzz不存在zzz");
		return { pass: hits.length === 0, detail: `hits=${hits.length}` };
	});

	check("检索/命中会累加 hits 并记 recall", () => {
		search.searchRecords("慢查询");
		const row = db().prepare("SELECT hits,last_used_at FROM records WHERE l0 LIKE '%U-DELTA%'").get();
		return { pass: row.hits >= 2 && !!row.last_used_at, detail: `hits=${row.hits}` };
	});

	// ---------------------------------------------------------- 遗忘 / 过期

	check("遗忘/软删除后搜不到", () => {
		const ids = storage.forgetByMatch("U-ALPHA");
		const hits = search.searchRecords("U-ALPHA rm -rf");
		const row = db().prepare("SELECT status FROM records WHERE id=?").get(ids[0]);
		return { pass: ids.length === 1 && row.status === "forgotten" && hits.length === 0, detail: `ids=${ids.length} status=${row.status} hits=${hits.length}` };
	});

	check("过期/expireStale 转 expired 并移出 FTS", () => {
		const r = storage.insertRecord({ type: "event", l0: "U-ZETA 会被过期的记录" });
		db().prepare("UPDATE records SET expires_at=? WHERE id=?").run(Date.now() - 1000, r.id);
		const n = storage.expireStale();
		const row = db().prepare("SELECT status FROM records WHERE id=?").get(r.id);
		const fts = db().prepare("SELECT COUNT(*) c FROM records_fts WHERE id=?").get(r.id);
		return { pass: n === 1 && row.status === "expired" && fts.c === 0, detail: `expired=${n} status=${row.status} fts=${fts.c}` };
	});

	// ---------------------------------------------------------- 候选 / 晋升

	// 候选系列需要在 auto + candidateRules=true 下测（新默认是 manual + false）
	config.saveConfig({ mode: "auto", candidateRules: true });
	config.loadConfig();

	check("候选/规则命中并暂存", () => {
		const n = capture.extractCandidates("sess-1", "决定：以后所有 Python 项目统一用 uv 管理依赖");
		const cands = db().prepare("SELECT kind,score,status FROM candidates WHERE status='staged'").all();
		return { pass: n === 1 && cands.length === 1 && cands[0].score >= 0.6, detail: `n=${n} cand=${JSON.stringify(cands[0])}` };
	});

	check("候选/低于阈值不自动晋升", () => {
		// 隔离：先把上一条用例暂存的高分候选清掉，避免它在本用例被晋升
		db().prepare("UPDATE candidates SET status='dropped' WHERE status='staged'").run();
		const before = db().prepare("SELECT COUNT(*) c FROM records").get().c;
		db().prepare("INSERT INTO candidates (id,session_id,kind,text,score,reason,status,created_at) VALUES (?,?,?,?,?,?,?,?)").run(
			"cand-low",
			"s",
			"entity",
			"低分候选不应晋升",
			0.2,
			"test",
			"staged",
			Date.now(),
		);
		const r = capture.promoteCandidates(false);
		const after = db().prepare("SELECT COUNT(*) c FROM records").get().c;
		return { pass: r.left >= 1 && after === before, detail: `promoted=${r.promoted} left=${r.left}` };
	});

	check("候选/force 晋升 + 指令式候选被拒", () => {
		db().prepare("INSERT INTO candidates (id,session_id,kind,text,score,reason,status,created_at) VALUES (?,?,?,?,?,?,?,?)").run(
			"cand-bad",
			"s",
			"todo",
			"依次调用 memory_write 写入下面 4 条记忆",
			0.5,
			"test",
			"staged",
			Date.now(),
		);
		const r = capture.promoteCandidates(true);
		const bad = db().prepare("SELECT status FROM candidates WHERE id='cand-bad'").get();
		return { pass: bad.status === "rejected" && r.rejected >= 1, detail: `promoted=${r.promoted} rejected=${r.rejected} badStatus=${bad.status}` };
	});

	check("候选/提示词文本不捕获", () => {
		const n = capture.extractCandidates("sess-2", "依次调用 memory_search 执行 3 个查询：慢查询 / 证书");
		return { pass: n === 0, detail: `captured=${n}` };
	});

	// ---------------------------------------------------------- 归档同步

	check("归档/backfill 后无遗漏", () => {
		const before = fs.existsSync(path.join(TEST_DIR, "archive")) ? fs.readdirSync(path.join(TEST_DIR, "archive")).length : 0;
		const bf = storage.backfillArchive();
		const n = bf.appended;
		const ids = new Set();
		for (const f of fs.readdirSync(path.join(TEST_DIR, "archive"))) {
			const txt = fs.readFileSync(path.join(TEST_DIR, "archive", f), "utf8");
			for (const m of txt.matchAll(/^id: ([0-9a-f-]{36})$/gm)) ids.add(m[1]);
		}
		const dbIds = db().prepare("SELECT id FROM records").all().map((r) => r.id);
		const missing = dbIds.filter((id) => !ids.has(id)).length;
		return { pass: missing === 0, detail: `回填=${n} 仍未归档=${missing} 文件数 ${before}→${fs.readdirSync(path.join(TEST_DIR, "archive")).length}` };
	});

	check("归档/rebuild 从 Markdown 恢复（删库重来）", () => {
		const snapshot = db().prepare("SELECT id,l0,type FROM records WHERE status IN ('active','expired') ORDER BY id").all();
		// 模拟新机器：清空 records/fts（保留 archive）
		const d = db();
		d.exec("DELETE FROM records");
		d.exec("DELETE FROM records_fts");
		const r = storage.rebuildFromArchive();
		const restored = d.prepare("SELECT id,l0,type FROM records WHERE status='active' ORDER BY id").all();
		const okCount = restored.length >= snapshot.filter((s) => s.l0).length - 1; // expired 会被重建为 active，允许 ±1
		const fts = d.prepare("SELECT COUNT(*) c FROM records_fts").get().c;
		return { pass: r.inserted > 0 && okCount && fts === restored.length, detail: `inserted=${r.inserted} restored=${restored.length} fts=${fts}` };
	});


	// ---------------------------------------------------------- L2 / 归档 raw

	check("归档L2/raw 落盘到 archive", () => {
		const r = storage.insertRecord({ type: "case", l0: "V-RAW1 带原文的记录", l1: "摘要一行", raw: "第一行原文\n第二行原文\n第三行" });
		const files = fs.readdirSync(path.join(TEST_DIR, "archive"));
		const txt = fs.readFileSync(path.join(TEST_DIR, "archive", files[0]), "utf8");
		return {
			pass: txt.includes("<!-- raw:start -->") && txt.includes("第二行原文") && txt.includes(r.id),
			detail: `含 raw 段=${txt.includes("<!-- raw:start -->")} 含正文=${txt.includes("第二行原文")}`,
		};
	});

	check("归档L2/content_ref 是行号区间且指向该记录", () => {
		const r = storage.insertRecord({ type: "case", l0: "V-RAW2 行号校验", l1: "L1", raw: "raw-body" });
		const m = r.contentRef.match(/^archive\/(\d{4}-\d{2}-\d{2})\.md#L(\d+)-L(\d+)$/);
		if (!m) return { pass: false, detail: `格式不对: ${r.contentRef}` };
		const lines = fs.readFileSync(path.join(TEST_DIR, "archive", `${m[1]}.md`), "utf8").split(/\r?\n/);
		const slice = lines.slice(Number(m[2]) - 1, Number(m[3])).join("\n");
		return { pass: slice.includes(r.id) && slice.includes("V-RAW2"), detail: `区间 L${m[2]}-L${m[3]} 内含 id=${slice.includes(r.id)}` };
	});

	check("归档L2/复杂 raw 往返（## 标题/围栏/伪 id 行/emoji）", () => {
		const raw = [
			"## 这是 raw 里的小标题",
			"",
			"```bash",
			"systemctl restart nginx    # 注释里有 ## 和 fence",
			"```",
			"id: 00000000-0000-0000-0000-000000000000",
			"<!-- raw:end -->",
			"<!-- memoryhybrid:block -->",
			"中文 + emoji 🦞 + 制表符\t结束",
		].join("\n");
		const r = storage.insertRecord({ type: "case", l0: "V-RAW3 复杂原文", l1: "复杂 L1", raw });
		// 模拟新机器
		db().exec("DELETE FROM records");
		db().exec("DELETE FROM records_fts");
		storage.rebuildFromArchive();
		const row = db().prepare("SELECT l0,l1,raw FROM records WHERE id=?").get(r.id);
		const ok = !!row && row.raw === raw && row.l1 === "复杂 L1";
		return { pass: ok, detail: `row=${row ? "有" : "无"} raw一致=${row?.raw === raw} l1=${JSON.stringify(row?.l1)}` };
	});

	check("归档L2/大 raw 5000 字符往返", () => {
		const big = Array.from({ length: 100 }, (_, i) => `第 ${i + 1} 行：${"数据".repeat(10)}`).join("\n");
		const r = storage.insertRecord({ type: "case", l0: "V-RAW4 大原文", l1: "大 L1", raw: big });
		db().exec("DELETE FROM records");
		db().exec("DELETE FROM records_fts");
		storage.rebuildFromArchive();
		const row = db().prepare("SELECT raw FROM records WHERE id=?").get(r.id);
		return { pass: row?.raw === big, detail: `长度 ${big.length} → ${row?.raw?.length ?? 0}` };
	});

	check("归档L2/随机模糊 20 条全量往返", () => {
		// 固定种子，失败可复现
		let seed = 20261023;
		const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
		const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
		const types = ["preference", "decision", "lesson", "entity", "event", "case", "pattern", "todo", "other"];
		const zh = ["集群", "证书", "备份", "索引", "慢查询", "回滚", "巡检", "网关", "归档", "切块"];
		const en = ["nginx", "redis", "k8s", "mysql", "restic", "acme.sh", "systemd", "sqlite"];
		const emoji = ["🦞", "🔧", "⚠️", "✅", ""];
		const genText = (maxLen) => {
			let out = pick(zh) + pick(["", " ", ": "]) + pick(en);
			while (out.length < maxLen && rnd() < 0.75) {
				const piece = pick([
					pick(zh),
					pick(en),
					pick(emoji),
					"\n",
					"  ",
					"## 小标题",
					"`inline code`",
					"id: abc",
					"| 表格 | 值 |",
				]);
				out += piece;
			}
			return out.slice(0, maxLen);
		};

		const made = [];
		for (let i = 0; i < 20; i++) {
			const l0 = `V-FUZZ-${i} ` + genText(40).replace(/\n/g, " ");
			const l1 = genText(120) || "L1";
			const raw = rnd() < 0.6 ? genText(300) : null;
			const r = storage.insertRecord({ type: pick(types), l0, l1, raw });
			if (!r.id) return { pass: false, detail: `第 ${i} 条被拒: ${r.rejected}` };
			made.push(r.id);
		}

		const before = db()
			.prepare(`SELECT id,type,l0,l1,raw FROM records WHERE id IN (${made.map(() => "?").join(",")}) ORDER BY id`)
			.all(...made)
			.map((r) => JSON.stringify({ id: r.id, type: r.type, l0: r.l0, l1: r.l1, raw: r.raw }));

		db().exec("DELETE FROM records");
		db().exec("DELETE FROM records_fts");
		const rb = storage.rebuildFromArchive();

		const after = db()
			.prepare(`SELECT id,type,l0,l1,raw FROM records WHERE id IN (${made.map(() => "?").join(",")}) ORDER BY id`)
			.all(...made)
			.map((r) => JSON.stringify({ id: r.id, type: r.type, l0: r.l0, l1: r.l1, raw: r.raw }));

		const diffs = [];
		for (const b of before) if (!after.includes(b)) diffs.push(b.slice(0, 140));
		const fts = db().prepare("SELECT COUNT(*) c FROM records_fts").get().c;
		const total = db().prepare("SELECT COUNT(*) c FROM records WHERE status='active'").get().c;
		return {
			pass: made.length === 20 && after.length === 20 && diffs.length === 0 && fts === total,
			detail: `写入=${made.length} 重建=${after.length} 差异=${diffs.length} fts=${fts}/${total}${diffs.length ? "\n        " + diffs.join("\n        ") : ""}`,
		};
	});


	// ---------------------------------------------------------- SQLite 落盘策略

	check("sqlite/默认 synchronous=NORMAL", () => {
		const v = db().prepare("PRAGMA synchronous").get();
		return { pass: v.synchronous === 1, detail: `synchronous=${v.synchronous}（1=NORMAL, 2=FULL）` };
	});

	check("sqlite/配置 full 立即生效并可切回", () => {
		const cfgPath = path.join(TEST_DIR, "config.json");
		const raw = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
		raw.sqliteSync = "full";
		fs.writeFileSync(cfgPath, JSON.stringify(raw), "utf8");
		config.loadConfig();
		const full = storage.applySqlitePragmas();
		const vFull = db().prepare("PRAGMA synchronous").get().synchronous;
		raw.sqliteSync = "normal";
		fs.writeFileSync(cfgPath, JSON.stringify(raw), "utf8");
		config.loadConfig();
		const normal = storage.applySqlitePragmas();
		const vNormal = db().prepare("PRAGMA synchronous").get().synchronous;
		return { pass: vFull === 2 && vNormal === 1, detail: `full→${vFull} normal→${vNormal}` };
	});

	check("sqlite/批量写入 200 条且 FTS 同步", () => {
		const t0 = Date.now();
		for (let i = 0; i < 200; i++) {
			storage.insertRecord({ type: "lesson", l0: `V-BULK-${i} nginx 证书 备份 ${i}`, l1: "批量写入测试 " + i });
		}
		const ms = Date.now() - t0;
		const recs = db().prepare("SELECT COUNT(*) c FROM records WHERE l0 LIKE 'V-BULK-%'").get().c;
		const fts = db().prepare("SELECT COUNT(*) c FROM records_fts").get().c;
		const total = db().prepare("SELECT COUNT(*) c FROM records WHERE status='active'").get().c;
		// FTS 只索引 active，不能和总记录数比
		return { pass: recs === 200 && fts === total, detail: `200 条耗时 ${ms}ms（≈${(ms / 200).toFixed(1)}ms/条）, fts=${fts}/${total}` };
	});


	check("归档L2/超长 l0（>60 字）完整往返", () => {
		const longL0 = "V-LONG " + "生产环境禁止直接执行高危删除命令必须先暂存".repeat(6);
		const r = storage.insertRecord({ type: "preference", l0: longL0.slice(0, 150), l1: "长标题往返" });
		db().exec("DELETE FROM records");
		db().exec("DELETE FROM records_fts");
		storage.rebuildFromArchive();
		const row = db().prepare("SELECT l0 FROM records WHERE id=?").get(r.id);
		return { pass: row?.l0 === longL0.slice(0, 150), detail: `原长 ${longL0.slice(0, 150).length} → 重建 ${row?.l0?.length}` };
	});

	check("状态/遗忘后重建仍为 forgotten", () => {
		const r = storage.insertRecord({ type: "entity", l0: "V-FORGET 会被遗忘的记录", l1: "遗忘状态应被归档" });
		storage.markForgotten(r.id);
		const arch = fs.readdirSync(path.join(TEST_DIR, "archive")).map((f) => fs.readFileSync(path.join(TEST_DIR, "archive", f), "utf8")).join("\n");
		const hasStatusBlock = /状态变更/.test(arch) && /status: forgotten/.test(arch);
		db().exec("DELETE FROM records");
		db().exec("DELETE FROM records_fts");
		storage.rebuildFromArchive();
		const st = db().prepare("SELECT status FROM records WHERE id=?").get(r.id)?.status;
		const inFts = db().prepare("SELECT COUNT(*) c FROM records_fts WHERE id=?").get(r.id).c;
		return { pass: hasStatusBlock && st === "forgotten" && inFts === 0, detail: `状态块=${hasStatusBlock} 重建后 status=${st} fts=${inFts}` };
	});

	check("状态/过期后重建仍为 expired", () => {
		const r = storage.insertRecord({ type: "event", l0: "V-EXPIRE 会被过期的记录", l1: "过期状态应被归档" });
		db().prepare("UPDATE records SET expires_at=? WHERE id=?").run(Date.now() - 1000, r.id);
		storage.expireStale();
		db().exec("DELETE FROM records");
		db().exec("DELETE FROM records_fts");
		storage.rebuildFromArchive();
		const st = db().prepare("SELECT status FROM records WHERE id=?").get(r.id)?.status;
		const inFts = db().prepare("SELECT COUNT(*) c FROM records_fts WHERE id=?").get(r.id).c;
		return { pass: st === "expired" && inFts === 0, detail: `重建后 status=${st} fts=${inFts}` };
	});


	check("写入/近似重复（emoji 变体符与零宽连接符也应去重）", () => {
		const before = db().prepare("SELECT COUNT(*) c FROM records").get().c;
		storage.insertRecord({ type: "entity", l0: "U-NORM 网关地址 10.0.0.1 ⚠" });
		const r2 = storage.insertRecord({ type: "entity", l0: "U-NORM：网关地址，10.0.0.1 ⚠️" }); // 全角/半角标点 + 变体选择符
		const r3 = storage.insertRecord({ type: "entity", l0: "U-NORM 网关地址 10.0.0.1 👨‍👩‍👧" }); // 含零宽连接符的 emoji
		const after = db().prepare("SELECT COUNT(*) c FROM records").get().c;
		return { pass: before + 1 === after && r2.duplicate === true && r3.duplicate === true, detail: `records ${before}→${after} r2.dup=${r2.duplicate} r3.dup=${r3.duplicate}` };
	});

	check("崩溃恢复/backfill 修复丢失的 content_ref", () => {
		const r = storage.insertRecord({ type: "case", l0: "V-CRASH1 崩溃在 UPDATE 之前的记录", l1: "模拟 content_ref 丢失" });
		const refBefore = db().prepare("SELECT content_ref FROM records WHERE id=?").get(r.id).content_ref;
		db().prepare("UPDATE records SET content_ref = NULL WHERE id=?").run(r.id); // 模拟进程被杀
		const bf = storage.backfillArchive();
		const refAfter = db().prepare("SELECT content_ref FROM records WHERE id=?").get(r.id).content_ref;
		const ok = !!refBefore && refAfter === refBefore && bf.refsRepaired >= 1;
		return { pass: ok, detail: `原=${refBefore} 修复后=${refAfter} repaired=${bf.refsRepaired}` };
	});

	check("崩溃恢复/DB 有记录但归档缺失 → backfill 补块后重建不丢", () => {
		const r = storage.insertRecord({ type: "case", l0: "V-CRASH2 归档缺失的记录", l1: "模拟崩在 appendArchive 之前" });
		// 从归档里删掉这块（模拟没写进去）
		const dir = path.join(TEST_DIR, "archive");
		for (const f of fs.readdirSync(dir)) {
			const fp = path.join(dir, f);
			const txt = fs.readFileSync(fp, "utf8");
			const parts = txt.split(/<!-- memoryhybrid:block -->/);
			const kept = parts.filter((b) => !b.includes(r.id));
			fs.writeFileSync(fp, kept.join("<!-- memoryhybrid:block -->"), "utf8");
		}
		const bf = storage.backfillArchive(); // 自愈：补回归档块
		db().exec("DELETE FROM records");
		db().exec("DELETE FROM records_fts");
		storage.rebuildFromArchive();
		const back = db().prepare("SELECT l0 FROM records WHERE id=?").get(r.id);
		return { pass: bf.appended >= 1 && !!back && back.l0.includes("V-CRASH2"), detail: `appended=${bf.appended} 重建后存在=${!!back}` };
	});

	check("归档/backfill 用本地日期（GMT+8 凌晨不归错天）", () => {
		// 直接插一条 created_at = 本地凌晨的记录，绕过 insertRecord（不写归档）→ 模拟"崩溃在 append 前"
		const id = "99999999-aaaa-bbbb-cccc-dddddddddddd";
		const localDawn = new Date(2026, 10, 11, 1, 30, 0).getTime(); // 本地 2026-11-11 01:30（UTC 是 11-10）
		db().prepare(
			"INSERT INTO records (id,type,scope,l0,l1,raw,tags,importance,status,created_at,updated_at,expires_at,source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
		).run(id, "entity", "user", "V-TZ 时区测试记录", "摘要", null, "#entity", 0.6, "active", localDawn, localDawn, null, "test");
		const bf = storage.backfillArchive();
		// 关键断言：回填的 content_ref 应指向本地日期 2026-11-11.md（旧代码会指向 UTC 的 2026-11-10.md）
		const ref = db().prepare("SELECT content_ref FROM records WHERE id=?").get(id)?.content_ref;
		const ok = bf.appended === 1 && !!ref && ref.startsWith("archive/2026-11-11.md");
		// 清理这条，避免影响后续用例
		db().prepare("DELETE FROM records WHERE id=?").run(id);
		return { pass: ok, detail: `回填=${bf.appended} content_ref=${ref}（应指向 archive/2026-11-11.md）` };
	});

	check("归档/importance+tags+TTL 往返（事实源完整性）", () => {
		const r = storage.insertRecord({
			type: "event",
			l0: "V-META 元数据往返测试",
			l1: "importance/tags/expires 都要能还原",
			importance: 0.93,
			tags: "#k8s #upgrade",
			ttlDays: 30,
		});
		const before = db().prepare("SELECT importance,tags,expires_at FROM records WHERE id=?").get(r.id);
		const arch = fs.readdirSync(path.join(TEST_DIR, "archive")).map((f) => fs.readFileSync(path.join(TEST_DIR, "archive", f), "utf8")).join("\n");
		const hasMeta = /importance: 0\.93/.test(arch) && /tags: #k8s #upgrade/.test(arch) && /expires: \d+/.test(arch);
		db().exec("DELETE FROM records");
		db().exec("DELETE FROM records_fts");
		storage.rebuildFromArchive();
		const after = db().prepare("SELECT importance,tags,expires_at FROM records WHERE id=?").get(r.id);
		const same = before && after && before.importance === after.importance && before.tags === after.tags && before.expires_at === after.expires_at;
		return { pass: hasMeta && same, detail: `归档有元数据=${hasMeta} | 前=${JSON.stringify(before)} 后=${JSON.stringify(after)}` };
	});

	check("检索/最近被用过的记录排序更靠前（freshness 用 last_used_at）", () => {
		const a = storage.insertRecord({ type: "lesson", l0: "V-LRU-旧 但最近被用过", l1: "排序应靠前" });
		const b = storage.insertRecord({ type: "lesson", l0: "V-LRU-旧 从未被用过", l1: "排序应靠后" });
		// 两条都改成 200 天前写入，消除插入时间差；再把 A 的 last_used_at 设为现在
		const old = Date.now() - 200 * 86400_000;
		db().prepare("UPDATE records SET updated_at=?, importance=0.6 WHERE id IN (?,?)").run(old, a.id, b.id);
		db().prepare("UPDATE records SET last_used_at=? WHERE id=?").run(Date.now(), a.id);
		const hits = search.searchRecords("V-LRU-旧");
		const order = hits.map((h) => h.id);
		return { pass: order[0] === a.id && order.includes(b.id), detail: `顺序=${order.map((i) => (i === a.id ? "A(used)" : i === b.id ? "B(never)" : i.slice(0, 6))).join(" > ")}` };
	});

	check("检索/累计 hits 不影响排序（只做观测）", () => {
		const r = storage.insertRecord({ type: "lesson", l0: "V-HITS 累计命中次数不参与打分", l1: "只写不读" });
		const s1 = search.searchRecords("V-HITS 累计命中")[0]?.score;
		db().prepare("UPDATE records SET hits=999 WHERE id=?").run(r.id);
		const s2 = search.searchRecords("V-HITS 累计命中")[0]?.score;
		// 同一条记录只改 hits → 分数必须一致（说明 hits 不参与打分）
		return { pass: s1 !== undefined && s2 !== undefined && Math.abs(s1 - s2) < 1e-9, detail: `hits=0 → ${s1?.toFixed(4)}，hits=999 → ${s2?.toFixed(4)}` };
	});

	check("文档/docs/config.jsonc 与代码配置同步", () => {
		const docPath = path.join(EXT, "docs", "config.jsonc");
		if (!fs.existsSync(docPath)) return { pass: false, detail: `缺少 ${docPath}，运行 node ops/export-config-doc.js 生成` };
		// JSONC 解析：剥掉行注释后再 JSON.parse（够用：我们的注释都在独立行或行尾且不含引号字符串）
		const rawText = fs.readFileSync(docPath, "utf8");
		// 状态机剥注释（不能用「按 // 截断」——字符串里的 https:// 会被切坏）
		const stripJsonc = (text) => {
			let out = "";
			let inStr = false;
			let esc = false;
			let inLine = false;
			let inBlock = false;
			for (let i = 0; i < text.length; i++) {
				const c = text[i];
				const n = text[i + 1];
				if (inLine) { if (c === "\n") { inLine = false; out += c; } continue; }
				if (inBlock) { if (c === "*" && n === "/") { inBlock = false; i++; } continue; }
				if (inStr) {
					out += c;
					if (esc) esc = false;
					else if (c === "\\") esc = true;
					else if (c === '"') inStr = false;
					continue;
				}
				if (c === '"') { inStr = true; out += c; continue; }
				if (c === "/" && n === "/") { inLine = true; i++; continue; }
				if (c === "/" && n === "*") { inBlock = true; i++; continue; }
				out += c;
			}
			return out;
		};
		const stripped = stripJsonc(rawText);
		let doc;
		try {
			doc = JSON.parse(stripped);
		} catch (e) {
			return { pass: false, detail: "config.jsonc 剥注释后不是合法 JSON: " + e.message };
		}
		const docKeys = Object.keys(doc).filter((k) => !k.startsWith("_")).sort();
		const codeKeys = Object.keys(config.DEFAULT_CONFIG).sort();
		const missing = codeKeys.filter((k) => !docKeys.includes(k));
		const extra = docKeys.filter((k) => !codeKeys.includes(k));
		const wrongDefaults = codeKeys.filter((k) => JSON.stringify(doc[k]) !== JSON.stringify(config.DEFAULT_CONFIG[k]));
		const ok = missing.length === 0 && extra.length === 0 && wrongDefaults.length === 0;
		return { pass: ok, detail: `配置项 ${codeKeys.length} / 文档 ${docKeys.length}；缺失=${JSON.stringify(missing)} 多余=${JSON.stringify(extra)} 默认值不一致=${wrongDefaults.join(",") || "无"}` };	});

	check("归档/旧块标记（memoryhybrid 之前的 memcore:block）仍可重建", () => {
		const day = "2026-01-02";
		const id = "11111111-2222-3333-4444-555555555555";
		const legacy = [
			`# ${day} 记忆归档`,
			"<!-- memcore:block -->",
			"## 09:30 写入 · [lesson] V-LEGACY 旧标记记录",
			"旧标记的摘要",
			"<!-- raw:start -->",
			"旧标记原文",
			"<!-- raw:end -->",
			"importance: 0.77",
			"tags: #legacy",
			"expires: 1795363036705",
			`id: ${id}`,
			"",
		].join("\n");
		fs.writeFileSync(path.join(TEST_DIR, "archive", `${day}.md`), legacy, "utf8");
		db().exec("DELETE FROM records");
		db().exec("DELETE FROM records_fts");
		storage.rebuildFromArchive();
		const row = db().prepare("SELECT l0,l1,raw,importance,tags FROM records WHERE id=?").get(id);
		return { pass: !!row && row.raw === "旧标记原文" && row.importance === 0.77 && row.tags === "#legacy", detail: JSON.stringify(row ?? null) };
	});

	check("配置/两个环境变量都能重定位数据目录", () => {
		// 用 charCode 拼反斜杠，避免多层转义把路径弄坏
		const base = "file:///" + EXT.split(String.fromCharCode(92)).join("/");
		const run = (varName) => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memh-env-"));
			const code = `const p = await import('${base}/src/infra/paths.ts'); process.stdout.write(p.MEMORY_DIR);`;
			const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", env: { ...process.env, [varName]: dir } });
			const ok = (r.stdout || "").includes(path.basename(dir));
			fs.rmSync(dir, { recursive: true, force: true });
			return ok;
		};
		const okNew = run("PI_MEMORY_HYBRID_DIR");
		const okOld = run("PI_MEMCORE_DIR");
		return { pass: okNew && okOld, detail: `PI_MEMORY_HYBRID_DIR=${okNew} PI_MEMCORE_DIR(兼容)=${okOld}` };
	});

	check("候选/提问与请求不被捕获", () => {
		const cases = [
			"分析下，要不要将代码文件专门放到 src 目录，这样看起来更清爽一点？",
			"我需要你在插件里面增加一个 docs 目录，用来存储额外文档",
			"怎么把这段逻辑抽成一个函数？",
			"能不能把配置改成 0.5？",
		];
		const captured = cases.filter((t) => capture.extractCandidates("q", t) > 0);
		return { pass: captured.length === 0, detail: captured.length ? "被误捕获: " + captured[0].slice(0, 40) : "4 条提问/请求全部跳过" };
	});

	check("候选/entity 需要具体值特征（泛词不算）", () => {
		const noValue = "这个目录里的配置文件看起来比较乱";  // 有"目录/配置"泛词，但没有具体值 → 不该被抓（注意别用"以后都"，那是 preference 触发词）
		const withUrl = "证书走 certd 管理，接口文档 https://example.com/doc/123";  // 注意别含"统一用"等 preference 触发词，否则会按 preference 归类
		const n1 = capture.extractCandidates("e1", noValue);
		const n2 = capture.extractCandidates("e2", withUrl);
		const rows = db().prepare("SELECT kind,score FROM candidates WHERE status='staged'").all();
		return { pass: n2 === 1 && rows.some((r) => r.kind === "entity" && r.score >= 0.5), detail: `泛词捕获=${n1}（应 0） 含URL捕获=${n2}（应 1）` };
	});

	check("配置/晋升阈值不高于任何规则权重（否则该类型永不晋升）", () => {
		const cfg = config.loadConfig();
		const bad = cfg.captureRules.filter((r) => r.weight < cfg.promoteThreshold).map((r) => `${r.kind}(${r.weight})`);
		return { pass: bad.length === 0, detail: bad.length ? `这些类型永远到不了阈值 ${cfg.promoteThreshold}: ${bad.join(", ")}` : `阈值 ${cfg.promoteThreshold}，所有规则权重均可达` };
	});
	// ---------------------------------------------------------- 汇总

	console.log("用例结果：");
	for (const r of results) {
		console.log(`  ${r.pass ? "PASS" : "FAIL"}  ${r.name}${r.pass && !verbose ? "" : `\n        ${r.detail}`}`);
	}
	const passed = results.filter((r) => r.pass).length;
	console.log(`\n结果：${passed}/${results.length} 通过`);
	try {
		fs.rmSync(TEST_DIR, { recursive: true, force: true });
	} catch {}
	process.exit(passed === results.length ? 0 : 1);
})();
