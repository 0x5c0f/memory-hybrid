/**
 * pi 工具注册层：唯一把"用例"暴露给模型的地方。
 * 这一层只做参数校验/文案，业务在 services/。
 */
import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { forgetByMatch, getRecordById, insertRecord, listRecords, markForgotten } from "../infra/records.ts";
import { searchRecords, search } from "../services/search.ts";
import { stripTrigger } from "../domain/normalize.ts";
import { L0_MAX, L1_MAX, MEMORY_TYPES, RECORD_STATUSES } from "../domain/types.ts";

export function registerTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "memory_write",
		label: "Memory Write",
		description: [
			"写入长期记忆（SQLite + Markdown 归档）。",
			"只在用户**明确要求**记忆时调用（说了'记一下 / 记住 / 别再 / 以后都'）。",
			"不要因为讨论出了结论、对话结束、或你觉得重要就主动写；想留存且用户没说时，先问一句再写。",
			"type 取值与语义（按语义选，不要凭手感）：",
			"  preference=长期偏好/风格/红线  decision=做过的技术选型或方案决定  lesson=踩过的坑/教训",
			"  entity=机器/服务/路径/域名/端口等静态事实  event=某次发生的事  case=可复用的排障案例",
			"  pattern=流程/方法论/固定做法  todo=待办  other=不属于以上",
			`l0 是常驻注入的一句话标题（≤${L0_MAX} 字，必须自解释）；l1 摘要（≤${L1_MAX} 字）；raw 原始上下文（可选）。`,
		].join("\n"),
		parameters: Type.Object({
			type: StringEnum(MEMORY_TYPES as unknown as readonly string[]),
			l0: Type.String({ description: `一句话标题，自解释，≤${L0_MAX} 字` }),
			l1: Type.Optional(Type.String({ description: `摘要，≤${L1_MAX} 字` })),
			raw: Type.Optional(Type.String({ description: "原始上下文（可选，会进归档）" })),
			tags: Type.Optional(Type.String({ description: "空格分隔的标签，如 #k8s #upgrade" })),
			importance: Type.Optional(Type.Number({ description: "0-1，默认 0.6" })),
			ttlDays: Type.Optional(Type.Number({ description: "多少天后自动过期；不填按类型默认" })),
		}),
		async execute(_id: string, params: any) {
			const res = insertRecord({
				type: params.type,
				l0: params.l0,
				l1: params.l1,
				raw: params.raw,
				tags: params.tags,
				importance: params.importance,
				ttlDays: params.ttlDays,
			});
			if (res.rejected) return { content: [{ type: "text", text: `未写入：${res.rejected}` }], details: { rejected: true } };
			if (res.duplicate) return { content: [{ type: "text", text: `已存在相同记忆 ${res.id}，未重复写入。` }], details: { id: res.id, duplicate: true } };
			return {
				content: [{ type: "text", text: `已写入记忆 ${res.id}（${params.type}）：${stripTrigger(params.l0)}\n归档：${res.contentRef || "(未归档)"}` }],
				details: { id: res.id, contentRef: res.contentRef },
			};
		},
	});

	pi.registerTool({
		name: "memory_search",
		label: "Memory Search",
		description: [
			"检索长期记忆，返回 L0 标题 + L1 摘要 + id。",
			"中文两字词也能搜（内部自动降级为 LIKE），三字以上走 FTS5 trigram；多词用空格分隔（OR 语义）。",
			"带 type 过滤但没命中时会自动去掉类型限定重试一次，并在结果里说明。",
			"用户提到'之前/上次/我记得/我们决定过'时先搜这里，不要凭印象回答。",
		].join("\n"),
		parameters: Type.Object({
			query: Type.String({ description: "关键词，可以是中文短语；多个词用空格分隔" }),
			type: Type.Optional(StringEnum(MEMORY_TYPES as unknown as readonly string[])),
			status: Type.Optional(StringEnum(RECORD_STATUSES as unknown as readonly string[])),
			limit: Type.Optional(Type.Number({ description: "默认 8" })),
		}),
		async execute(_id: string, params: any) {
			let result = searchRecords(params.query, { type: params.type, status: params.status, limit: params.limit });
			let hits = result.hits;
			let relaxed = false;
			if (hits.length === 0 && params.type) {
				hits = search(params.query, { status: params.status, limit: params.limit });
				relaxed = hits.length > 0;
			}
			if (!hits.length) {
				return {
					content: [{ type: "text", text: `没有匹配「${params.query}」的记忆。可以换说法、去掉限定词，或用 memory_read 按类型列列表。` }],
					details: { count: 0 },
				};
			}
			const note = relaxed ? `（type=${params.type} 无命中，已自动去掉类型限定，以下是全部类型的结果）\n` : "";
			const text = hits
				.map((h) => `- [${h.type}] ${h.l0}\n  ${h.l1 ? h.l1.slice(0, 200) : ""}\n  id=${h.id} score=${h.score.toFixed(2)} ref=${h.content_ref ?? "-"}`)
				.join("\n");
			return { content: [{ type: "text", text: `${note}命中 ${hits.length} 条：\n${text}` }], details: { count: hits.length, relaxed, ids: hits.map((h) => h.id) } };
		},
	});

	pi.registerTool({
		name: "memory_read",
		label: "Memory Read",
		description: "按 id 读取一条记忆的完整内容（含 L2 原文与归档位置）；不带 id 时列出最近的记忆。",
		parameters: Type.Object({
			id: Type.Optional(Type.String()),
			type: Type.Optional(StringEnum(MEMORY_TYPES as unknown as readonly string[])),
			limit: Type.Optional(Type.Number()),
		}),
		async execute(_id: string, params: any) {
			if (params.id) {
				const r = getRecordById(params.id);
				if (!r) return { content: [{ type: "text", text: `没有 id=${params.id} 的记录` }], details: {} };
				const text = [
					`[${r.type}] ${r.l0}`,
					r.l1 ? `摘要：${r.l1}` : "",
					r.raw ? `原文：${r.raw}` : "",
					`状态：${r.status} 重要度：${r.importance} 命中：${r.hits} 归档：${r.content_ref ?? "-"}`,
					`创建：${new Date(r.created_at).toISOString()}  更新：${new Date(r.updated_at).toISOString()}`,
				]
					.filter(Boolean)
					.join("\n");
				return { content: [{ type: "text", text }], details: r };
			}
			const rows = listRecords({ type: params.type, limit: params.limit });
			if (!rows.length) return { content: [{ type: "text", text: "记忆库为空。" }], details: { count: 0 } };
			const text = rows.map((r) => `- [${r.type}/${r.status}] ${r.l0}  (id=${r.id})`).join("\n");
			return { content: [{ type: "text", text }], details: { count: rows.length } };
		},
	});

	pi.registerTool({
		name: "memory_forget",
		label: "Memory Forget",
		description: "把记忆标记为 forgotten（软删除，可恢复）。按 id 删除，或按文本子串批量删除 active 记录。",
		parameters: Type.Object({
			id: Type.Optional(Type.String()),
			match: Type.Optional(Type.String({ description: "文本子串，删除所有匹配的 active 记录" })),
		}),
		async execute(_id: string, params: any) {
			if (params.id) {
				markForgotten(params.id);
				return { content: [{ type: "text", text: `已遗忘 ${params.id}` }], details: { id: params.id } };
			}
			if (!params.match) return { content: [{ type: "text", text: "需要 id 或 match 参数" }], details: {} };
			const ids = forgetByMatch(params.match);
			return { content: [{ type: "text", text: `已遗忘 ${ids.length} 条` }], details: { ids } };
		},
	});
}
