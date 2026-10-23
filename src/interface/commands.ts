/**
 * /mem 命令：运维与查看。业务全在 services/，这里只解析参数与排版输出。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getConfig, loadConfig, saveConfig } from "../infra/config-store.ts";
import { applySqlitePragmas, getDb } from "../infra/db.ts";
import { CONFIG_PATH, DB_PATH } from "../infra/paths.ts";
import { search } from "../services/search.ts";
import { promoteCandidates } from "../services/capture.ts";
import { ensureInit, runBackfill, runRebuild, stats } from "../services/maintenance.ts";
import { state } from "../state.ts";

const USAGE = "用法：/mem stats | search <词> | stage list|commit|drop | mode auto|manual | config [set k v] | init | backfill | rebuild";

export function registerCommands(pi: ExtensionAPI): void {
	pi.registerCommand("mem", {
		description: "记忆库管理：stats | search <词> | stage list|commit|drop | mode auto|manual | config [set k v] | init | backfill | rebuild",
		handler: async (args: string, ctx: any) => {
			const d = getDb();
			const cfg = getConfig();
			const [cmd, ...rest] = args.trim().split(/\s+/);
			const out = (msg: string) => ctx.ui.notify(msg, "info");

			if (!cmd || cmd === "stats") {
				const s = stats();
				out(
					[
						`模式：${s.config.mode}  晋升阈值：${s.config.promoteThreshold}  注入预算：${s.config.injectBudgetChars} 字符  最多 ${s.config.maxInjectItems} 条`,
						`记录：${s.byStatus.map((r: any) => `${r.status}=${r.c}`).join(" ") || "空"}`,
						`按类型：${s.byType.map((r: any) => `${r.type}=${r.c}`).join(" ") || "-"}`,
						`候选暂存：${s.staged}    检索次数：${s.recalls}    FTS：${s.fts}`,
						`配置：${s.configPath}`,
						`数据库：${s.dbPath}`,
					].join("\n"),
				);
				return;
			}

			if (cmd === "search") {
				const hits = search(rest.join(" "), { limit: 10 });
				out(hits.length ? hits.map((h) => `[${h.type}] ${h.l0} (${h.id})`).join("\n") : "无命中");
				return;
			}

			if (cmd === "mode") {
				const m = rest[0];
				if (m !== "auto" && m !== "manual") return out("用法：/mem mode auto|manual");
				saveConfig({ mode: m });
				return out(`模式已切换为 ${m}（写入 ${CONFIG_PATH}）`);
			}

			if (cmd === "config") {
				const sub = rest[0];
				if (sub === "set") {
					const key = rest[1];
					const value = rest[2];
					if (!key || value === undefined)
						return out(
							"用法：/mem config set <key> <value>；可改 mode / candidateRules / promoteThreshold / injectBudgetChars / maxInjectItems / archiveWrite / sqliteSync（captureRules/triggerPatterns 请直接编辑文件）",
						);
					const patch: any = {};
					if (key === "mode") {
						if (value !== "auto" && value !== "manual") return out("mode 只能是 auto 或 manual");
						patch.mode = value;
					} else if (key === "candidateRules" || key === "archiveWrite") {
						patch[key] = /^(1|true|yes|on)$/i.test(value);
					} else if (key === "sqliteSync") {
						if (value !== "normal" && value !== "full") return out("sqliteSync 只能是 normal 或 full");
						patch.sqliteSync = value;
					} else if (["promoteThreshold", "injectBudgetChars", "maxInjectItems"].includes(key)) {
						const n = Number(value);
						if (!Number.isFinite(n)) return out(`${key} 需要数字`);
						patch[key] = n;
					} else {
						return out(`未知或不可命令修改的配置项：${key}`);
					}
					const next = loadConfig(); // 先读盘，避免覆盖外部编辑
					Object.assign(next, patch);
					const saved = saveConfig(next);
					loadConfig();
					state.dirty = true;
					if (key === "sqliteSync") applySqlitePragmas(); // 立即生效
					return out(`已更新 ${key} = ${JSON.stringify((saved as any)[key])}（${CONFIG_PATH}）`);
				}
				out(`${JSON.stringify(cfg, null, 2)}\n\n配置文件：${CONFIG_PATH}\n可改：/mem config set <key> <value>，或直接编辑后 /reload`);
				return;
			}

			if (cmd === "init") {
				const created = ensureInit();
				loadConfig();
				return out(created.length ? `初始化完成：\n- ${created.join("\n- ")}` : `已初始化过，无需操作。\n配置：${CONFIG_PATH}\n数据库：${DB_PATH}`);
			}

			if (cmd === "backfill") {
				const r = runBackfill();
				return out(`回填 ${r.appended} 条缺失归档，修复 ${r.refsRepaired} 条 content_ref（Markdown 现在是完整事实源）`);
			}

			if (cmd === "rebuild") {
				const r = runRebuild();
				return out(`从 archive/ 重建索引：新增 ${r.inserted} 条，更新 ${r.updated} 条`);
			}

			if (cmd === "stage") {
				const sub = rest[0] ?? "list";
				if (sub === "list") {
					const rows = d.prepare("SELECT id,kind,score,reason,text FROM candidates WHERE status='staged' ORDER BY score DESC LIMIT 20").all() as any[];
					out(rows.length ? rows.map((r) => `[${r.kind} ${r.score.toFixed(2)} ${r.reason}] ${r.text.slice(0, 70)} (${r.id})`).join("\n") : "暂存区为空");
					return;
				}
				if (sub === "commit") {
					const r = promoteCandidates(true);
					return out(`已晋升 ${r.promoted} 条候选${r.rejected ? `，拒绝 ${r.rejected} 条` : ""}`);
				}
				if (sub === "drop") {
					const r = d.prepare("UPDATE candidates SET status='dropped' WHERE status='staged'").run();
					return out(`已丢弃 ${Number(r.changes)} 条候选`);
				}
				return out("用法：/mem stage list|commit|drop");
			}

			out(USAGE);
		},
	});
}
