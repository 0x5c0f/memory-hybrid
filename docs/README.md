# docs/

扩展的补充文档目录。运行时**不读**这里的任何文件。

> 代码在 `src/`，入口是根 `index.ts`（pi 只发现这一层，`src/index.ts` 实测不会被加载）。

| 文件 | 内容 | 维护方式 |
|---|---|---|
| `config.jsonc` | 全部配置项清单：类型/范围/默认值/示例/生效点/说明，带 `//` 注释 | **自动生成**，勿手改：`node ops/export-config-doc.js` |
| `HANDOVER.md` | 交接文档：已完成 / 设计理由 / 已知限制 / 待讨论计划 | 手工维护，重大改动后更新 |

## 为什么用 JSONC 而不是 JSONL

一开始做过 `config.jsonl`（一行一个 JSON 对象），但两个问题：

1. **JSONL 不能写注释**——注释会让那行不是合法 JSON，任何 JSONL 解析器都会报错
2. 一行塞十个字段，人眼看着很累

所以换成 **JSONC**（JSON with Comments）：支持 `//` 注释 + 缩进，人读舒服，工具侧"剥掉注释再 `JSON.parse`"即可解析。

## 维护约定

- `default` / 说明文案来自源码（`DEFAULT_CONFIG` / `CONFIG_HELP`）→ **不会和代码漂移**
- `type` / `range` / `example` / `effect` 是文档内容，手工维护在 `ops/export-config-doc.js` 的 `META` 里
- 带 **★** 的配置项（`captureRules` / `triggerPatterns` / `ttlDaysByType` / `vector`）命令改不了，必须编辑 `<memory>/config.json` 后 `/reload`
- 改完配置默认值或新增配置项，务必：

```powershell
node ops/export-config-doc.js            # 重新生成
node ops/export-config-doc.js --check    # 校验（不同步 → 退出码 1；单测里也有一条守着）
```
