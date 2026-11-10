#!/usr/bin/env node
/**
 * test-stress.js — 压测：大量随机复杂数据 + 近似重复 + 重建/检索一致性
 *
 * 隔离：临时 PI_MEMORY_HYBRID_DIR，不碰真实 ~/.pi/agent/memory。
 * 覆盖点：
 *   1) 近似重复：只差标点/空格/emoji/全角 → 应被去重；差一个词 → 应分别保留
 *   2) 边界内容：l0=160 / l1=600 / raw=10KB / CRLF / 代码块 / 全角 / 组合符
 *   3) 检索正确性：无假阳性、路由正确（fts vs like）、排序确定
 *   4) 归档往返：清库重建后逐字段一致（含 forgotten / expired 状态）
 *   5) 重建后检索结果与重建前一致
 *
 * 用法：node test-stress.js [-v] [--count 40]
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const argv = process.argv.slice(2);
const verbose = argv.includes("-v");
const cIdx = argv.indexOf("--count");
const TOPIC_COUNT = cIdx >= 0 ? Number(argv[cIdx + 1]) : 12;

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "memh-stress-"));
process.env.PI_MEMORY_HYBRID_DIR = DIR;
const EXT = `file:///${path.join(os.homedir(), ".pi", "agent", "extensions", "memory-hybrid").replace(/\\/g, "/")}`;

const results = [];
const check = (name, fn) => {
	try {
		results.push({ name, ...fn() });
	} catch (e) {
		results.push({ name, pass: false, detail: "异常: " + e.message });
	}
};

(async () => {
// 新分层结构：infra/(IO) + services/(用例) + domain/(纯逻辑)
	const _E = EXT;
	const dbm = await import(`${_E}/src/infra/db.ts`);
	const records = await import(`${_E}/src/infra/records.ts`);
	const archive = await import(`${_E}/src/infra/archive.ts`);
	const configStore = await import(`${_E}/src/infra/config-store.ts`);
	const searchSvc = await import(`${_E}/src/services/search.ts`);
	const captureSvc = await import(`${_E}/src/services/capture.ts`);
	const maintenance = await import(`${_E}/src/services/maintenance.ts`);
	// 兼容旧调用点：storage.* / search.searchRecords / config.* / capture.*
	const storage = { ...dbm, ...records, ...archive, ...maintenance };
	const search = { searchRecords: searchSvc.search };
	const capture = captureSvc;
	const config = configStore;



	const db = () => storage.getDb();
	const q = (sql, ...p) => {
		try {
			return db().prepare(sql).all(...p);
		} catch {
			return [];
		}
	};

	// 固定种子的伪随机
	let seed = 987654321;
	const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
	const pick = (a) => a[Math.floor(rnd() * a.length)];
	const int = (n) => Math.floor(rnd() * n);

	// ---------- 生成数据：每个“主题”产生 3 个近似变体 ----------
	const TOPICS = [
		{ zh: "慢查询", en: "mysql", detail: "先用 pt-query-digest 排序再改索引" },
		{ zh: "集群", en: "k8s", detail: "统一用 containerd 不再装 docker" },
		{ zh: "证书", en: "acme.sh", detail: "续期后用 --reloadcmd 自动 reload" },
		{ zh: "备份", en: "restic", detail: "从 tar 全量改成增量快照" },
		{ zh: "索引", en: "postgres", detail: "先 explain analyze 再看执行计划" },
		{ zh: "回滚", en: "deploy", detail: "保留上一版本镜像并预置回滚脚本" },
		{ zh: "巡检", en: "pve", detail: "每周看磁盘 SM A RT 和风扇转速" },
		{ zh: "网关", en: "nginx", detail: "SSL 终止放在 OpenResty 层" },
		{ zh: "归档", en: "logrotate", detail: "按天切分并压缩保留 30 天" },
		{ zh: "限流", en: "redis", detail: "令牌桶放在接入层避免打穿后端" },
		{ zh: "监控", en: "prometheus", detail: "只采集 USE 指标不要全量" },
		{ zh: "切块", en: "sqlite", detail: "FTS5 trigram 只支持三字符以上" },
		{ zh: "防火墙", en: "iptables", detail: "只放行必要端口并记录变更" },
		{ zh: "容器", en: "docker", detail: "限制内存与 CPU 并挂载日志卷" },
		{ zh: "分发", en: "cdn", detail: "静态资源走 CDN 并设置长缓存" },
		{ zh: "加密", en: "tls1.3", detail: "禁用弱套件并开启 HSTS" },
		{ zh: "日志", en: "journald", detail: "限制保留大小避免打满磁盘" },
		{ zh: "调度", en: "cron", detail: "错峰执行避免同时打满 IO" },
		{ zh: "对象存储", en: "s3", detail: "开启版本控制与生命周期策略" },
		{ zh: "密钥", en: "vault", detail: "动态租约替代静态密钥" },
		{ zh: "压测", en: "wrk", detail: "先单机基线再上并发" },
		{ zh: "灰度", en: "canary", detail: "按 5% 流量逐步放量" },
		{ zh: "审计", en: "auditd", detail: "只关注提权与敏感文件访问" },
		{ zh: "容量", en: "disk", detail: "预测 30 天增长再决定扩容" },
	];
	const TYPES = ["preference", "decision", "lesson", "entity", "event", "case", "pattern", "todo", "other"];
	const EMOJI = ["🦞", "🔧", "⚠️", "✅", "🧪", ""];
	const PUNCT = ["，", ",", "：", ":", "；", ";", "、", " "];

	const made = [];
	const meta = []; // 本地镜像：{id, kind:'variant'|'dupPunct'|'dupExact'|'edge', topic}
	let n = 0;

	function w(rec, kind, topic) {
		const r = storage.insertRecord(rec);
		if (r.rejected) {
			made.push({ rejected: true, l0: rec.l0 });
			return r;
		}
		if (!r.duplicate) made.push({ id: r.id, kind, topic, l0: rec.l0 });
		return r;
	}

	for (let t = 0; t < Math.min(TOPIC_COUNT, TOPICS.length); t++) {
		const topic = TOPICS[t];
		const type = pick(TYPES);
		const tag = pick(["", " #" + topic.en, " #" + type]);
		// 变体 1：基础
		w({ type, l0: `S-T${t}-A ${topic.zh} ${topic.en} ${topic.detail}${tag}`, l1: `关于${topic.zh}的第一版做法：${topic.detail}` }, "variant", t);
		// 变体 2：差一个词（同义改写）→ 应保留
		w({ type, l0: `S-T${t}-B ${topic.zh} ${topic.en} 处理要点：${topic.detail.replace("先", "应该先")}`, l1: `同义改写的变体，应与 A 共存` }, "variant", t);
		// 变体 3：只差标点/空格/emoji（归一化后相同）→ 应被去重
		const punct = pick(PUNCT);
		w({ type, l0: `S-T${t}-A ${topic.zh}${punct}${topic.en} ${topic.detail}${tag}${pick(EMOJI)}`, l1: `只差标点或 emoji，应被归一化去重` }, "dupPunct", t);
		n += 3;
	}

	// 完全重复（两次写同一内容）→ 第二次应 duplicate
	const exact = { type: "lesson", l0: "S-EXACT 完全重复的一条记录 用于验证去重", l1: "第一次写入" };
	w(exact, "dupExact", -1);
	w({ ...exact, l1: "第二次写入 l1 不同但 l0 相同" }, "dupExact", -1);
	n += 2;

	// ---------- 边界内容 ----------
	const edge = [
		{ type: "lesson", l0: "S-EDGE-1 " + "长标题".repeat(60), l1: "l0 超过 160 会被截断" }, // l0 截断
		{ type: "case", l0: "S-EDGE-2 超长 l1", l1: "长摘要".repeat(220) }, // l1 截断
		{
			type: "case",
			l0: "S-EDGE-3 十 KB 原文",
			l1: "raw 很大",
			raw: Array.from({ length: 200 }, (_, i) => `第 ${i + 1} 行：${"数据".repeat(12)}`).join("\n"),
		},
		{ type: "case", l0: "S-EDGE-4 CRLF 原文", l1: "含 \\r\\n", raw: "第一行\r\n第二行\r\n第三行" },
		{ type: "pattern", l0: "S-EDGE-5 代码块原文", l1: "含围栏", raw: "```bash\nsystemctl restart nginx\n```\n## 小标题\nid: 00000000-0000-0000-0000-000000000000" },
		{ type: "entity", l0: "S-EDGE-6 全角与组合符 ＮＧＩＮＸ ｒｅｄｉｓ 🇨🇳", l1: "全角字母 + 旗帜 emoji + 组合音标 a\u0301e\u0301" },
		{ type: "other", l0: "S-EDGE-7 制表与前后空白\t\t", l1: "   前后都有空格的摘要   " },
		{ type: "pattern", l0: "S-EDGE-8 标记原文", l1: "原文里含归档标记", raw: "<!-- raw:end -->\n<!-- memoryhybrid:block -->" },
	];
	for (const e of edge) w(e, "edge", -2);

	// ---------- 候选与状态操作 ----------
	// 候选用例需要 auto + candidateRules=true（新默认是 manual + false）
	config.saveConfig({ mode: "auto", candidateRules: true });
	config.loadConfig();
	capture.extractCandidates("stress-1", "决定：以后所有 Python 项目统一用 uv 管理依赖");
	capture.extractCandidates("stress-2", "你是测试端。请只做一件事：调用 memory_write 写入一条记忆。");

	// 遗忘 2 条、过期 1 条
	const forgetIds = q("SELECT id FROM records WHERE l0 LIKE 'S-T0-%' OR l0 LIKE 'S-T1-%'").slice(0, 2).map((r) => r.id);
	forgetIds.forEach((id) => storage.markForgotten(id));
	const expireId = q("SELECT id FROM records WHERE l0 LIKE 'S-T2-%'")[0]?.id;
	if (expireId) {
		db().prepare("UPDATE records SET expires_at=? WHERE id=?").run(Date.now() - 1000, expireId);
		storage.expireStale();
	}

	// ---------- 断言 ----------
	const snapshot = () =>
		q("SELECT id,type,l0,l1,raw,status FROM records ORDER BY id").map((r) => JSON.stringify(r));

	check("数据生成/规模与去重统计", () => {
		const total = q("SELECT COUNT(*) c FROM records")[0].c;
		const punctDup = made.filter((m) => m.kind === "dupPunct").length;
		const variants = made.filter((m) => m.kind === "variant").length;
		const edgeCount = made.filter((m) => m.kind === "edge").length;
		const rejected = made.filter((m) => m.rejected).length;
		return {
			pass: total >= 30 && variants > 20 && edgeCount === 8 && punctDup === 0 && rejected === 0,
			detail: `记录=${total} 变体=${variants} 标点近似去重=${punctDup === 0 ? "已去重" : punctDup + "未去重"} 边界=${edgeCount} 被拒=${rejected}`,
		};
	});

	check("近似重复/同义变体被分别保留", () => {
		const a = q("SELECT COUNT(*) c FROM records WHERE l0 LIKE 'S-T3-A%'")[0].c;
		const b = q("SELECT COUNT(*) c FROM records WHERE l0 LIKE 'S-T3-B%'")[0].c;
		return { pass: a >= 1 && b >= 1, detail: `T3-A=${a} T3-B=${b}（应都 ≥1）` };
	});

	check("近似重复/仅标点差异应去重（归一化）", () => {
		const dupPunct = made.filter((m) => m.kind === "dupPunct").length;
		return { pass: dupPunct === 0, detail: `未去重的标点变体=${dupPunct}` };
	});

	check("近似重复/l0 相同但 l1 不同应去重", () => {
		const c = q("SELECT COUNT(*) c FROM records WHERE l0 LIKE 'S-EXACT%'")[0].c;
		return { pass: c === 1, detail: `S-EXACT 记录数=${c}（应 1）` };
	});

	check("边界/l0 与 l1 截断规则", () => {
		const r1 = q("SELECT l0 FROM records WHERE l0 LIKE 'S-EDGE-1%'")[0];
		const r2 = q("SELECT l1 FROM records WHERE l0 LIKE 'S-EDGE-2%'")[0];
		return { pass: r1?.l0.length === 160 && r2?.l1.length === 600, detail: `l0=${r1?.l0.length}(160) l1=${r2?.l1.length}(600)` };
	});

	check("边界/大原文与特殊原文入库", () => {
		const big = q("SELECT length(raw) l FROM records WHERE l0 LIKE 'S-EDGE-3%'")[0];
		const crlf = q("SELECT raw FROM records WHERE l0 LIKE 'S-EDGE-4%'")[0];
		const fence = q("SELECT raw FROM records WHERE l0 LIKE 'S-EDGE-5%'")[0];
		return {
			pass: big?.l > 3000 && !crlf?.raw.includes("\r") && fence?.raw.includes("## 小标题"),
			detail: `大原文=${big?.l} 字 CRLF已归一=${!crlf?.raw.includes("\r")} 围栏保留=${fence?.raw.includes("```bash")}`,
		};
	});

	check("检索/无假阳性（返回结果必须真的含关键词）", () => {
		const queries = ["慢查询", "nginx", "restic", "限流"];
		const bad = [];
		for (const term of queries) {
			const hits = search.searchRecords(term, { limit: 20 });
			for (const h of hits) {
				// 检索会匹配 l0/l1/raw，这里必须把 raw 也算进来
				const row = q("SELECT raw FROM records WHERE id=?", h.id)[0];
				const hay = `${h.l0}\n${h.l1}\n${row?.raw ?? ""}`.toLowerCase();
				if (!hay.includes(term.toLowerCase())) bad.push(`${term}→${h.l0.slice(0, 20)}`);
			}
		}
		return { pass: bad.length === 0, detail: bad.length ? bad.slice(0, 3).join(" | ") : "4 个查询均无假阳性" };
	});

	check("检索/路由正确（3 字走 fts、2 字走 like）", () => {
		// 用专门的 active 记录，避免受前面用例的遗忘/过期影响
		storage.insertRecord({ type: "lesson", l0: "S-ROUTE1 路由验证三字词 蓝鲸平台 的检索", l1: "三字词应走 fts" });
		storage.insertRecord({ type: "lesson", l0: "S-ROUTE2 路由验证两字词 鲸鱼 的检索", l1: "两字词应走 like" });
		search.searchRecords("蓝鲸平台");
		const a = q("SELECT mode,hits FROM recall_events WHERE query='蓝鲸平台' ORDER BY created_at DESC LIMIT 1")[0];
		search.searchRecords("鲸鱼");
		const b = q("SELECT mode,hits FROM recall_events WHERE query='鲸鱼' ORDER BY created_at DESC LIMIT 1")[0];
		return { pass: a?.mode === "fts" && b?.mode === "like" && a?.hits > 0 && b?.hits > 0, detail: `蓝鲸平台=${a?.mode}/${a?.hits} 鲸鱼=${b?.mode}/${b?.hits}` };
	});

	check("检索/排序确定性（同一查询两次结果一致）", () => {
		const x = search.searchRecords("备份 restic", { limit: 10 }).map((h) => h.id);
		const y = search.searchRecords("备份 restic", { limit: 10 }).map((h) => h.id);
		return { pass: JSON.stringify(x) === JSON.stringify(y) && x.length > 0, detail: `两次结果一致=${JSON.stringify(x) === JSON.stringify(y)} 条数=${x.length}` };
	});

	check("检索/特殊字符不炸（全角/emoji/引号）", () => {
		const cases = ["ＮＧＩＮＸ", "🇨🇳", 'a"b(c)*', "S-EDGE-6 组合符"];
		const ok = cases.every((c) => Array.isArray(search.searchRecords(c)));
		return { pass: ok, detail: ok ? "4 个特殊查询均正常返回" : "有查询抛异常" };
	});

	check("状态/遗忘与过期生效且 FTS 摘除", () => {
		const byStatus = Object.fromEntries(q("SELECT status, COUNT(*) c FROM records GROUP BY status").map((r) => [r.status, r.c]));
		const active = byStatus.active || 0;
		const fts = q("SELECT COUNT(*) c FROM records_fts")[0].c;
		return { pass: (byStatus.forgotten || 0) >= 2 && (byStatus.expired || 0) >= 1 && fts === active, detail: `状态=${JSON.stringify(byStatus)} fts=${fts}=active=${active}` };
	});

	check("候选/规则命中暂存 + 任务式 prompt 被挡", () => {
		const staged = q("SELECT COUNT(*) c FROM candidates WHERE status='staged'")[0].c;
		return { pass: staged === 1, detail: `暂存候选=${staged}（应=1，任务式 prompt 那条应被挡）` };
	});

	const before = snapshot();
	const searchBefore = Object.fromEntries(["慢查询", "备份 restic", "证书"].map((k) => [k, search.searchRecords(k, { limit: 8 }).map((h) => h.id).join(",")]));

	check("重建/清库后逐字段一致（含状态与长字段）", () => {
		db().exec("DELETE FROM records");
		db().exec("DELETE FROM records_fts");
		const r = storage.rebuildFromArchive();
		const after = snapshot();
		const diffs = [];
		for (const b of before) if (!after.includes(b)) diffs.push(b.slice(0, 100));
		return { pass: diffs.length === 0 && after.length === before.length, detail: `重建 inserted=${r.inserted} 前=${before.length} 后=${after.length} 差异=${diffs.length}${diffs[0] ? "\n        " + diffs[0] : ""}` };
	});

	check("重建/检索结果与重建前一致", () => {
		const after = Object.fromEntries(["慢查询", "备份 restic", "证书"].map((k) => [k, search.searchRecords(k, { limit: 8 }).map((h) => h.id).join(",")]));
		const same = Object.keys(searchBefore).every((k) => searchBefore[k] === after[k]);
		return { pass: same, detail: same ? "3 个查询的命中 id 序列完全一致" : `差异: ${JSON.stringify({ before: searchBefore, after })}` };
	});

	check("归档/块数=记录数+状态块，且无截断标题", () => {
		const arch = fs.readdirSync(path.join(DIR, "archive")).map((f) => fs.readFileSync(path.join(DIR, "archive", f), "utf8")).join("\n");
		const writeBlocks = (arch.match(/^## \d{2}:\d{2} 写入 · /gm) || []).length;
		const statusBlocks = (arch.match(/^## \d{2}:\d{2} 状态变更 · /gm) || []).length;
		const total = q("SELECT COUNT(*) c FROM records")[0].c;
		const longTitleOk = /S-EDGE-1 长标题长标题长标题/.test(arch) && (arch.match(/## \d{2}:\d{2} 写入 · \[[a-z]+\] S-EDGE-1 [^\n]*/)?.[0].length ?? 0) > 120;
		return { pass: writeBlocks === total && statusBlocks >= 3 && longTitleOk, detail: `写入块=${writeBlocks} records=${total} 状态块=${statusBlocks} 长标题完整=${longTitleOk}` };
	});

	// ---------- 输出 ----------
	console.log(`\n临时数据目录：${DIR}`);
	console.log(`生成规模：主题 ${TOPIC_COUNT} × 3 变体 + 完全重复 2 + 边界 8\n`);
	for (const r of results) {
		console.log(`  ${r.pass ? "PASS" : "FAIL"}  ${r.name}${r.pass && !verbose ? "" : "\n        " + r.detail}`);
	}
	const passed = results.filter((r) => r.pass).length;
	console.log(`\n结果：${passed}/${results.length} 通过`);
	try {
		fs.rmSync(DIR, { recursive: true, force: true });
	} catch {}
	process.exit(passed === results.length ? 0 : 1);
})();
