/**
 * 配置：唯一的配置入口是 <memory>/config.json。
 * 首次加载自动生成（带 _schema/_help 自解释），缺键回退默认，越界 clamp。
 *
 * 原则：用户会想调且不破坏正确性 → 进配置；改了会出错（SQL/归档格式/截断长度）→ 锁在代码里。
 */
import * as fs from "node:fs";
import { CONFIG_PATH } from "./paths.ts";
import type { CaptureRule, Mode } from "../domain/types.ts";

export interface Config {
	mode: Mode;
	candidateRules: boolean;
	promoteThreshold: number;
	injectBudgetChars: number;
	maxInjectItems: number;
	archiveWrite: boolean;
	ttlDaysByType: Record<string, number>;
	vector: { backend: string; model?: string };
	captureRules: CaptureRule[];
	triggerPatterns: string[];
	captureMaxChars: number;
	sqliteSync: "normal" | "full";
}

export const CONFIG_SCHEMA = 1;

export const DEFAULT_CONFIG: Config = {
	mode: "auto",
	candidateRules: true,
	promoteThreshold: 0.45,
	injectBudgetChars: 600,
	maxInjectItems: 20,
	archiveWrite: true,
	ttlDaysByType: { event: 30, todo: 90, case: 180, pattern: 365 },
	vector: { backend: "none" },
	captureRules: [
		{ pattern: "以后都|以后统一|统一用|一律用|别再|不要再|下次不要", kind: "preference", weight: 0.75, reason: "长期偏好措辞" },
		{ pattern: "决定|定下来|就这么定|改成|换成|迁移到|升级到", kind: "decision", weight: 0.7, reason: "决策措辞" },
		{ pattern: "教训|踩坑|坑是|记住|注意以后|别再犯", kind: "lesson", weight: 0.7, reason: "教训措辞" },
		// entity 只认"值特征"（IP/URL/域名/路径/端口/UUID），光有"配置/目录/地址"这种泛词不算
		{ pattern: "\\b\\d{1,3}(\\.\\d{1,3}){3}\\b|https?://|[a-z0-9][a-z0-9-]*\\.(com|cn|net|io|cc|dev|org)\\b|\/(?:[\\w.-]+\/)+|:\\d{2,5}\\b|[0-9a-f]{8}-[0-9a-f]{4}", kind: "entity", weight: 0.5, reason: "含具体值（IP/URL/域名/路径/端口）" },
		{ pattern: "待办|todo|下次要|回头要|记得改", kind: "todo", weight: 0.5, reason: "待办措辞" },
	],
	triggerPatterns: ["记一下|记下来|记住|记到记忆|存进记忆|存到记忆|写进记忆|帮我记|保存到记忆", "以后都|以后统一|别再|不要再|下次不要"],
	captureMaxChars: 800,
	sqliteSync: "normal",
};

export const CONFIG_HELP: Record<string, string> = {
	mode: "写入模式。auto=规则型暂存+阈值晋升；manual=只有用户明说（记一下/记住/别再）才写入",
	candidateRules: "auto 模式下是否用正则捕获候选（纯本地，0 次模型调用）",
	promoteThreshold: "候选晋升阈值 0~1：captureRules 里 weight 低于它的候选永不自动晋升（默认 0.45，与最低权重对齐）",
	injectBudgetChars: "L0 注入系统提示的字符上限，越大越费 token（100~4000）",
	maxInjectItems: "最多注入多少条 L0（1~200）",
	archiveWrite: "是否同时把记忆写入 Markdown 归档 archive/YYYY-MM-DD.md",
	ttlDaysByType: "按类型的自动过期天数，不写=永不过期",
	vector: "向量后端。v1 只支持 none；预留 openai-compatible / local-gguf 等",
	captureRules: "候选捕获规则数组：pattern(正则) / kind(记忆类型) / weight(0~1) / reason(命中原因)",
	triggerPatterns: "manual 模式的放行触发词（正则源码数组，任意一条命中即允许 memory_write）",
	captureMaxChars: "候选捕获的最大字符数（默认 800）：长文本多半是任务 prompt 而不是用户口述，超过就不捕获",
	sqliteSync: "SQLite 落盘策略：normal（默认，WAL 下仍保证崩溃一致，检索快 10 倍）/ full（每次写等 fsync，最严格）",
};

const clamp = (n: unknown, lo: number, hi: number, fallback: number): number => {
	const v = Number(n);
	return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
};

function sanitizeCaptureRules(input: unknown): CaptureRule[] {
	if (!Array.isArray(input) || input.length === 0) return DEFAULT_CONFIG.captureRules;
	const out: CaptureRule[] = [];
	for (const r of input) {
		if (!r || typeof r !== "object") continue;
		const pattern = String((r as any).pattern ?? "").trim();
		if (!pattern) continue;
		try {
			new RegExp(pattern, "i");
		} catch {
			continue;
		}
		out.push({
			pattern,
			kind: String((r as any).kind ?? "other"),
			weight: clamp((r as any).weight, 0, 1, 0.5),
			reason: String((r as any).reason ?? "自定义规则"),
		});
	}
	return out.length ? out : DEFAULT_CONFIG.captureRules;
}

function sanitizeTriggerPatterns(input: unknown): string[] {
	if (!Array.isArray(input)) return DEFAULT_CONFIG.triggerPatterns;
	const out: string[] = [];
	for (const p of input) {
		const s = String(p ?? "").trim();
		if (!s) continue;
		try {
			new RegExp(s, "i");
			out.push(s);
		} catch {}
	}
	return out.length ? out : DEFAULT_CONFIG.triggerPatterns;
}

let cached: Config | null = null;

export function loadConfig(): Config {
	let raw: any = null;
	try {
		raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
	} catch {}
	if (!raw) {
		const cfg = structuredClone(DEFAULT_CONFIG);
		try {
			writeConfigFile(cfg);
		} catch {}
		cached = cfg;
		return cfg;
	}
	cached = {
		mode: raw.mode === "manual" ? "manual" : "auto",
		candidateRules: raw.candidateRules !== false,
		promoteThreshold: clamp(raw.promoteThreshold, 0, 1, DEFAULT_CONFIG.promoteThreshold),
		injectBudgetChars: Math.round(clamp(raw.injectBudgetChars, 100, 4000, DEFAULT_CONFIG.injectBudgetChars)),
		maxInjectItems: Math.round(clamp(raw.maxInjectItems, 1, 200, DEFAULT_CONFIG.maxInjectItems)),
		archiveWrite: raw.archiveWrite !== false,
		ttlDaysByType: { ...DEFAULT_CONFIG.ttlDaysByType, ...(raw.ttlDaysByType ?? {}) },
		vector: { ...DEFAULT_CONFIG.vector, ...(raw.vector ?? {}) },
		captureRules: sanitizeCaptureRules(raw.captureRules),
		triggerPatterns: sanitizeTriggerPatterns(raw.triggerPatterns),
		captureMaxChars: Math.round(clamp(raw.captureMaxChars, 100, 8000, DEFAULT_CONFIG.captureMaxChars)),
		sqliteSync: raw.sqliteSync === "full" ? "full" : "normal",
	};
	// 旧版 config.json 缺新键时补写回盘，让文件始终完整可编辑
	if (
		!("captureRules" in raw) ||
		!("triggerPatterns" in raw) ||
		!("captureMaxChars" in raw) ||
		!("sqliteSync" in raw)
	) {
		try {
			writeConfigFile(cached);
		} catch {}
	}
	return cached;
}

export function getConfig(): Config {
	return cached ?? loadConfig();
}

function writeConfigFile(cfg: Config) {
	fs.mkdirSync(CONFIG_PATH.replace(/[\\/][^\\/]+$/, ""), { recursive: true });
	fs.writeFileSync(CONFIG_PATH, `${JSON.stringify({ _schema: CONFIG_SCHEMA, _help: CONFIG_HELP, ...cfg }, null, 2)}\n`, "utf8");
}

export function saveConfig(patch: Partial<Config>): Config {
	const next = { ...getConfig(), ...patch };
	writeConfigFile(next);
	cached = next;
	return next;
}

export function compileCaptureRules(): Array<{ re: RegExp; kind: string; weight: number; reason: string }> {
	const out: Array<{ re: RegExp; kind: string; weight: number; reason: string }> = [];
	for (const r of getConfig().captureRules) {
		try {
			out.push({ re: new RegExp(r.pattern, "i"), kind: r.kind, weight: r.weight, reason: r.reason });
		} catch {}
	}
	return out;
}

export function compileTriggerPatterns(): RegExp[] {
	const out: RegExp[] = [];
	for (const p of getConfig().triggerPatterns) {
		try {
			out.push(new RegExp(p, "i"));
		} catch {}
	}
	return out;
}
