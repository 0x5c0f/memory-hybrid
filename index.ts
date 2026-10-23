/**
 * memory-hybrid — 扩展入口（pi 只发现这一层）。
 *
 * 为什么这个文件只有转发：pi 的扩展发现规则是「加载根目录下的 .ts/.js」+「一层含 index.ts 的子目录」，
 * 实测 `xxx/src/index.ts`（两层）**不会**被加载。所以代码都放在 src/，这里只做入口转发。
 *
 * ⚠️ src/ 里不要再出现 index.ts——万一将来 pi 支持递归发现，会造成重复注册。
 */
export { default } from "./src/extension.ts";
export { setVectorBackend } from "./src/extension.ts";
export type { VectorBackend } from "./src/extension.ts";
