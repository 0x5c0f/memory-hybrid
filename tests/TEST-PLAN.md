# memory-hybrid 测试方案（v2，分层）

> **v1 方案已作废**，原因写在最后「为什么改」。

## 0. 两层测试，别混着做

| 层 | 测什么 | 怎么跑 | 成本 | 可判定性 |
|---|---|---|---|---|
| **L1 单元（主机）** | 插件逻辑本身：写入/去重/检索路由/候选/归档/重建/配置 | `node tests/test-unit.js`（在扩展目录下） | **零 API**，约 3 秒 | ✅ 完全确定 |
| **L2 行为（TUI）** | 模型会不会正确使用工具、会不会编造 | 手工 6 个场景 | 少量 API | ⚠️ 概率性，只断言"底线" |

**铁律：不要在 L2 用自然语言去断言工具细节**（比如"说'索引'就应该走 LIKE"）——模型有裁量权，可能不调工具、可能转述输出、可能换参数，测出来的结果跟插件对错无关。

---

## L1：单元测试（先跑这个）

```powershell
node tests\test-unit.js        # 概览（在扩展目录下执行）
node tests\test-unit.js -v     # 带每个用例的细节
```

- 直接 `import` 扩展模块（`src/` 下的 .ts，Node 24 原生 TS 类型剥离，不需要编译）
- 全程使用**临时数据目录**（`PI_MEMORY_HYBRID_DIR`，旧名 `PI_MEMCORE_DIR` 兼容），**不碰** `~/.pi/agent/memory`
- 退出码 0 = 全通过

覆盖的 24 个用例：

| 分组 | 用例 |
|---|---|
| 配置 | 首次自动生成 config.json / clamp 越界 / 非法正则被丢弃 |
| 写入 | 基本+归档、去重、拒绝指令文本、stripTrigger 去前缀、TTL 按类型生效 |
| 检索 | 三字走 FTS、两字走 LIKE、多词 OR、英文大小写、type 过滤、特殊字符、空结果、hits 累加 |
| 遗忘/过期 | 软删除后搜不到、expireStale 转 expired 并移出 FTS |
| 候选 | 规则命中暂存、低于阈值不晋升、force 晋升+指令候选被拒、提示词不捕获 |
| 归档 | backfill 无遗漏、删库后 rebuild 恢复（含 FTS 重建） |

当前基线：**24/24 通过**。

---

## L2：模型行为烟测（TUI 里手工做）

**每条只断言"库状态"或"底线行为"，不要求措辞。** 用 `check.js` 看状态。

### L2-1 写入与去重

```
记一下：生产环境禁止直接 rm -rf，先 mv 到 /tmp/trash 再定时清理
```
- 期望：`check.js` 记录 +1
- 再说**完全相同的一句**
- 期望：记录数**不变**（模型可能自己判断重复而不调工具，也可能调了被工具去重——两者都可接受）

### L2-2 自然语言检索（真实场景）

```
之前 MySQL 慢查询是怎么处理的？
```
- 期望：回答里出现 `pt-query-digest`（说明确实读了记忆），且不是编造的
- 追加：`check.js -v` 能看到最新的检索记录

### L2-3 不编造（关键底线）

```
上次说的证书方案是什么？
```
（前提：库里确实没有证书相关记录）
- 期望：明确说"记忆里没有"，**不允许**编出一套方案
- 如果它编了 → 这是必须修的问题，记下来

### L2-4 单词查询的路由（验证提示词是否生效）

```
索引
```
- 期望：优先调用 `memory_search`（而不是 `memory_read` 列全表）
- 这条专门验证 `APPEND_SYSTEM.md` 里「只发一个词且像问历史 → 先 memory_search」是否起作用
- 若它仍然列全表 → 提示词需要再强化

### L2-5 manual 模式门禁

```
/mem mode manual
```
1. 说：`把这条写入记忆：测试门禁 ABC` → 期望：记录数**不变**，模型说明被拦
2. 说：`记一下：门禁测试 DEF` → 期望：记录数 +1
3. 收尾：`/mem mode auto`

### L2-6 候选机制（auto）

```
决定：以后所有 Python 项目统一用 uv 管理依赖
```
- 期望：`/mem stage list` 能看到 `[decision 0.70 …]`
- `/mem stage commit` 后 `check.js` 出现该记录，`source=candidate:…`
- 注意：候选由**正则**产生，0 次模型调用

---

## 证据收集（出问题抓这些）

```powershell
node ops\check.js -v

node -e "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.env.USERPROFILE+'/.pi/agent/memory/index.db',{readOnly:true});console.log(d.prepare('SELECT type,status,substr(l0,1,40) l0 FROM records ORDER BY updated_at DESC LIMIT 10').all());console.log(d.prepare('SELECT query,mode,hits FROM recall_events ORDER BY created_at DESC LIMIT 10').all())"

type %USERPROFILE%\.pi\agent\memory\archive\<日期>.md
type %USERPROFILE%\.pi\agent\memory\config.json
```

**唯一判定"索引不同步"的信号**：`check.js` 里 `fts` 条数 ≠ `active` 条数。

---

## 测完清理

```powershell
/mem mode auto
/mem config set injectBudgetChars 600

node -e "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.env.USERPROFILE+'/.pi/agent/memory/index.db');d.exec('DELETE FROM records');d.exec('DELETE FROM records_fts');d.exec('DELETE FROM candidates');d.exec('DELETE FROM recall_events');d.exec('PRAGMA wal_checkpoint(TRUNCATE)');console.log('已清空')"
del %USERPROFILE%\.pi\agent\memory\archive\*.md
```

---

## 为什么作废 v1

v1 用自然语言驱动"工具级断言"，实测有四个用例"失败"，但**全都是测试本身的问题**：

| v1 用例 | 断言 | 实际 |
|---|---|---|
| 两字检索 | 说"索引"→ 应走 LIKE | 模型调的是 `memory_read`，压根没跑 `memory_search` |
| 无命中 | 说"完全不存在zzz"→ 0 条 | 模型没调工具，直接聊天 |
| 去重 | 再说一遍 → "已存在相同记忆" | 模型自己判断重复，没调 `memory_write` |
| type 放宽 | 断言返回含"已自动去掉类型限定" | 模型转述成"自动降级为全类型后命中 1 条" |

教训：**断言状态，不断言措辞；测逻辑用单元测试，测行为只用底线断言。**
