/**
 * 领域类型与常量：不依赖 pi、不依赖文件系统/SQLite。
 * 这里是"记忆是什么"的定义，其它层都依赖它，它不依赖任何东西。
 */

/** 记忆类型（按语义选，不做自由文本） */
export type MemoryType = "preference" | "decision" | "lesson" | "entity" | "event" | "case" | "pattern" | "todo" | "other";

export const MEMORY_TYPES: MemoryType[] = ["preference", "decision", "lesson", "entity", "event", "case", "pattern", "todo", "other"];

/** 记录状态机：active → forgotten / expired；重建时可回到 active */
export type RecordStatus = "active" | "forgotten" | "expired" | "superseded";
export const RECORD_STATUSES: RecordStatus[] = ["active", "expired", "forgotten", "superseded", "all"];

/** 写入模式：auto=规则型候选+阈值晋升；manual=只有用户明说才写 */
export type Mode = "auto" | "manual";

/** 截断上限：L0 常驻注入，L1 检索展示，raw 不设上限 */
export const L0_MAX = 160;
export const L1_MAX = 600;
export const HASH_MAX = 200;

/** 候选捕获规则 */
export interface CaptureRule {
	pattern: string;
	kind: string;
	weight: number;
	reason: string;
}

export interface WriteInput {
	type: string;
	l0: string;
	l1?: string;
	raw?: string;
	tags?: string;
	importance?: number;
	ttlDays?: number;
	source?: string;
}

export interface WriteResult {
	id: string;
	contentRef: string;
	duplicate?: boolean;
	rejected?: string;
}

export interface Hit {
	id: string;
	type: string;
	l0: string;
	l1: string;
	content_ref: string | null;
	tags: string;
	importance: number;
	score: number;
	updated_at: number;
}

export interface SearchOptions {
	type?: string;
	status?: string;
	limit?: number;
}

export interface SearchResult {
	hits: Hit[];
	mode: "fts" | "like";
}

/** 向量检索端口（v1 不接实现，接入时实现它并注入） */
export interface VectorBackend {
	name: string;
	upsert(records: Array<{ id: string; text: string }>): Promise<void>;
	remove(ids: string[]): Promise<void>;
	search(query: string, limit: number): Promise<Array<{ id: string; score: number }>>;
}
