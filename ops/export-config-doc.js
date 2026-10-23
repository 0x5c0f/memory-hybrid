#!/usr/bin/env node
/**
 * export-config-doc.js — 从代码里的 DEFAULT_CONFIG + CONFIG_HELP 生成 docs/config.jsonc
 *
 * 为什么是 JSONC 而不是 JSONL：
 *   JSONL 要求"一行一个合法 JSON"，加 // 注释会让整行非法；
 *   JSONC（JSON with Comments）支持 // 注释 + 缩进，既能人读，也能被工具用"剥注释后 JSON.parse"解析。
 *
 * 产出：docs/config.jsonc（缩进 + // 注释；默认值/说明从源码读，不会漂移）
 *
 * 用法：
 *   node ops/export-config-doc.js            # 重写文档
 *   node ops/export-config-doc.js --check    # 只校验是否同步（不同步退出码 1）
 */
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "src");
const EXT = `file:///${SRC.replace(/\\/g, "/")}`;
const OUT = path.join(ROOT, "docs", "config.jsonc");

/** 每个配置项的类型/范围/示例（人工维护的"文档内容"） */
const META = {
	mode: { type: "enum", values: ["auto", "manual"], example: "auto", effect: "决定 memory_write 与候选晋升的行为" },
	candidateRules: { type: "boolean", example: true, effect: "关掉后 auto 模式不再抓候选" },
	promoteThreshold: { type: "number", range: "0 ~ 1", example: 0.6, effect: "大于等于该分数的候选才会自动晋升" },
	injectBudgetChars: { type: "integer", range: "100 ~ 4000", example: 600, effect: "L0 注入系统提示的字符上限，直接决定每轮 token" },
	maxInjectItems: { type: "integer", range: "1 ~ 200", example: 20, effect: "最多注入多少条 L0" },
	archiveWrite: { type: "boolean", example: true, effect: "关掉后不写 Markdown 归档（不推荐，会丢事实源）" },
	ttlDaysByType: {
		type: "object<string,integer>",
		example: { event: 30, todo: 90, case: 180, pattern: 365 },
		effect: "按类型自动过期天数；不列出的类型永不过期",
	},
	vector: {
		type: "object",
		shape: '{ backend: "none" | "sqlite-vec" | "openai-compatible", model?: string }',
		example: { backend: "none" },
		effect: "向量后端；v1 仅 none 生效",
	},
	captureRules: {
		type: "array<object>",
		shape: "{ pattern: 正则源码, kind: 记忆类型, weight: 0~1, reason: 命中原因 }",
		example: [{ pattern: "以后都|别再", kind: "preference", weight: 0.75, reason: "长期偏好措辞" }],
		effect: "auto 模式的候选捕获规则；非法正则会被丢弃",
	},
	triggerPatterns: {
		type: "array<string>",
		shape: "正则源码数组",
		example: ["记一下|记下来|记住", "别再|以后都"],
		effect: "manual 模式放行 memory_write 的触发词，命中任一即允许",
	},
	captureMaxChars: { type: "integer", range: "100 ~ 8000", example: 800, effect: "超过该长度的消息不参与候选捕获（长文本多半是任务 prompt）" },
	sqliteSync: { type: "enum", values: ["normal", "full"], example: "normal", effect: "SQLite 落盘策略；normal 在 WAL 下仍保证崩溃一致，检索快约 10 倍" },
};

const CMD_EDITABLE = ["mode", "candidateRules", "promoteThreshold", "injectBudgetChars", "maxInjectItems", "archiveWrite", "sqliteSync"];

function buildJsonc(keys, defaults, help, schema) {
	const out = [
		"// memory-hybrid 配置项参考（自动生成，勿手改）",
		"//  生成：node ops/export-config-doc.js     校验：node ops/export-config-doc.js --check",
		"//  注意：本文件只是「清单」；真正生效的配置文件是 <memory>/config.json",
		"//  可命令修改：/mem config set <key> <value>",
		"//  带 ★ 的项命令改不了，必须直接编辑 config.json 后 /reload",
		"{",
		`  "_schema": ${schema},`,
	];

	keys.forEach((key, i) => {
		const m = META[key] ?? { type: typeof defaults[key], example: defaults[key] };
		const star = CMD_EDITABLE.includes(key) ? "" : "★ ";
		const spec = [
			`type=${m.type}`,
			m.values ? `values=${m.values.join("|")}` : "",
			m.range ? `range=${m.range}` : "",
			m.shape ? `shape=${m.shape}` : "",
		]
			.filter(Boolean)
			.join("  ");

		out.push("");
		out.push(`  // ── ${star}${key} ${"─".repeat(Math.max(4, 60 - key.length))}`);
		out.push(`  // ${help[key] ?? ""}`);
		out.push(`  // ${spec}`);
		out.push(`  // 生效点：${m.effect ?? ""}`);
		out.push(`  // 示例：${JSON.stringify(m.example)}`);
		const body = JSON.stringify(defaults[key], null, 2).replace(/\n/g, "\n  ");
		out.push(`  ${JSON.stringify(key)}: ${body}${i === keys.length - 1 ? "" : ","}`);
	});

	out.push("}");
	return out.join("\n") + "\n";
}

(async () => {
	const cfg = await import(`${EXT}/infra/config-store.ts`);
	const keys = Object.keys(cfg.DEFAULT_CONFIG);
	const text = buildJsonc(keys, cfg.DEFAULT_CONFIG, cfg.CONFIG_HELP, cfg.CONFIG_SCHEMA);

	if (process.argv.includes("--check")) {
		const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : "";
		if (current !== text) {
			console.error("❌ docs/config.jsonc 与代码不同步，请运行：node ops/export-config-doc.js");
			process.exit(1);
		}
		console.log("✅ docs/config.jsonc 与代码同步");
		return;
	}

	fs.mkdirSync(path.dirname(OUT), { recursive: true });
	fs.writeFileSync(OUT, text, "utf8");
	console.log(`✅ 已生成 ${OUT}（${keys.length} 个配置项）`);
})();
