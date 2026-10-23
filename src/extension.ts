/**
 * memory-hybrid — 组合根（放在 src/ 里，因为 pi 只把「根目录文件」和「一层含 index.ts 的子目录」
 * 当扩展入口；若把本文件命名成 src/index.ts，实测不会被加载）。
 *
 * 只做装配：初始化数据目录 → 注册事件 → 注册工具 → 注册命令。
 * 业务逻辑不在这里（分层说明见 ../README.md）：
 *   domain/     纯逻辑（归一化 / 打分 / 候选匹配），零 IO
 *   infra/      SQLite / Markdown 归档 / 配置读写
 *   services/   用例编排（检索 / 注入 / 候选 / 运维）
 *   interface/  pi 适配层（工具 / 命令 / 事件）
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ensureInit } from "./services/maintenance.ts";
import { registerEvents } from "./interface/events.ts";
import { registerTools } from "./interface/tools.ts";
import { registerCommands } from "./interface/commands.ts";

export { setVectorBackend } from "./services/search.ts";
export type { VectorBackend } from "./domain/types.ts";

export default function memoryHybrid(pi: ExtensionAPI) {
	ensureInit();
	registerEvents(pi);
	registerTools(pi);
	registerCommands(pi);
}
