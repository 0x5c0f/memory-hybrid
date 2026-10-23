/**
 * 路径常量：数据目录、DB、归档、配置。
 * 环境变量入口（重定位数据目录，测试/多实例用）：PI_MEMORY_HYBRID_DIR
 * （兼容旧名 PI_MEMCORE_DIR —— 项目改名前的写法仍然生效）。
 */
import * as os from "node:os";
import * as path from "node:path";

const ENV_DIR = process.env.PI_MEMORY_HYBRID_DIR ?? process.env.PI_MEMCORE_DIR;
export const MEMORY_DIR = ENV_DIR
	? path.resolve(ENV_DIR)
	: path.join(process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent"), "memory");

export const DB_PATH = path.join(MEMORY_DIR, "index.db");
export const ARCHIVE_DIR = path.join(MEMORY_DIR, "archive");
export const CONFIG_PATH = path.join(MEMORY_DIR, "config.json");
export const LEGACY_MD = path.join(MEMORY_DIR, "MEMORY.md");

export function todayStr(d = new Date()): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
