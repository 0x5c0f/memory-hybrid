# memory-hybrid

> 仓库：<https://github.com/0x5c0f/memory-hybrid>

给 **pi** 用的长期记忆扩展：双轨存储（SQLite + Markdown）、L0/L1/L2 分层、规则型候选捕获。
默认纯 **SQLite（Node 内置 `node:sqlite`）+ Markdown**，零 npm 依赖、零原生扩展；向量后端（含 `sqlite-vec`）作为**可选**预留。

> 这是自建替代品，替换掉官方的 `pi-memory`（原因见文末「为什么不用现成的」）。

---

## 它解决什么

| 问题 | 做法 |
|---|---|
| 跨会话失忆 | 长期记忆落盘，L0 标题注入系统提示 |
| 注入太贵 | 只注入 L0，硬上限 600 字符（≈150 tok）；L1/L2 按需取 |
| 记什么、谁来记 | 默认 `manual`：只有你说“记一下/记住/以后都”才写；`auto` 规则型候选是可选开关（默认关） |
| 中文搜不到 | FTS5 trigram（≥3 字）+ LIKE 兜底（2 字），实测中文两字词可用 |
| 数据被锁死 | Markdown 归档是事实源，`index.db` 可随时丢弃重建 |
| 数据被悄悄弄丢 | 状态变更（遗忘/过期）也落归档；`/mem backfill` 自愈；崩溃恢复有测试 |

---

## 快速开始

```powershell
# 落地：把本目录放到 pi 的用户扩展目录
#   ~/.pi/agent/extensions/memory-hybrid/
pi                                  # 首次启动自动初始化，然后 /reload

/mem stats                          # 看库状态
/mem init                           # 幂等初始化（可选，启动时已自动跑）
/mem search 证书                     # 检索
```

数据目录（默认 `~/.pi/agent/memory/`）：

```
memory/
├── index.db                  SQLite（WAL）：可丢弃的索引
├── config.json               配置（首次自动生成，带 _help 自解释）
├── archive/YYYY-MM-DD.md     Markdown 归档：唯一事实源
└── backup/                   迁移前的旧数据备份
```

运维快照：`node ~/.pi/agent/extensions/memory-hybrid/ops/check.js [-v]`
**判断索引是否健康只看一个信号**：`fts` 条数应等于 `active` 条数。

---

## 架构（分层 + 端口适配器）

不做完整 DDD（聚合根/仓储接口/领域事件对一个 ~2000 行扩展是过度设计），采用朴素的四层：

```
memory-hybrid/
├── index.ts                  扩展入口：只把 src/extension.ts 转发出去（pi 只发现这一层）
├── src/
│   ├── extension.ts          组合根：只装配（ensureInit + 三个 register）
│   ├── domain/               纯逻辑，零 IO、零 pi 依赖（可脱离环境单测）
│   │   ├── types.ts          记忆类型/状态/截断上限/向量端口
│   │   ├── normalize.ts      去重归一化、指令识别、触发词剥离
│   │   ├── ranking.ts        检索打分权重、FTS/LIKE 路由决策
│   │   └── candidates.ts     候选规则匹配
│   ├── infra/                所有 IO
│   │   ├── db.ts             SQLite 连接 + schema + PRAGMA
│   │   ├── records.ts        records 读写（去重/拒绝/遗忘/过期）
│   │   ├── archive.ts        Markdown 归档（块/raw/状态块/回填/重建）
│   │   ├── fts.ts            FTS 索引维护
│   │   ├── config-store.ts   配置读写/校验/clamp
│   │   └── paths.ts          路径常量
│   ├── services/             用例编排（domain + infra）
│   │   ├── search.ts  inject.ts  capture.ts  maintenance.ts
│   ├── interface/            pi 适配层（pi API 只在这里）
│   │   ├── tools.ts  commands.ts  events.ts
│   └── state.ts              进程内共享的注入快照状态
├── ops/                      运维工具：check.js / export-config-doc.js
├── docs/                     文档：config.jsonc / HANDOVER.md / README.md
└── tests/                    开发资产（pi 不加载）：78 用例 + TEST-PLAN
```

> **为什么入口在根、代码在 `src/`**：pi 只发现「根目录文件」与「一层含 `index.ts` 的子目录」，
> 实测 `xxx/src/index.ts`（两层）不会被加载。所以根 `index.ts` 只做转发，工厂放在 `src/extension.ts`；
> 且 `src/` 里不要再出现 `index.ts`，避免将来 pi 支持递归时重复注册。

**依赖方向**：`interface → services → infra → domain`，反向依赖为零（`fts.ts` 独立存在就是为了打断 records ↔ archive 的环）。
pi 升级时只需要看 `src/interface/` 与根 `index.ts`。

---

## 数据模型

三层，同一份记录（`records` 表）：

| 层 | 字段 | 用途 | 常驻注入 | 落归档 |
|---|---|---|---|---|
| L0 | `l0` | 一句话标题（≤160 字，超长静默截断） | ✅ 受 `injectBudgetChars` 限制 | ✅ 块标题（完整，不截断） |
| L1 | `l1` | 摘要（≤600 字） | ❌ 检索/读取时返回 | ✅ 块正文 |
| L2 | `raw` | 原始上下文 | ❌ `memory_read` 才看 | ✅ `<!-- raw:start/end -->` 段 |

记忆类型：`preference` `decision` `lesson` `entity` `event` `case` `pattern` `todo` `other`
状态机：`active` → `forgotten` / `expired`；重建后可回到 `active`

---

## 归档块格式

```markdown
# 2026-10-23 记忆归档
<!-- memoryhybrid:block -->
## 23:04 写入 · [case] L0 标题（完整）
L1 摘要
<!-- raw:start -->
L2 原文（可含 ## 标题、``` 围栏、emoji、甚至 id: uuid 伪行）
<!-- raw:end -->
importance: 0.9
tags: #pve #巡检
expires: 1795363036705
source: candidate:xxx session:yyy
id: 0ad7ea41-…
```

```markdown
<!-- memoryhybrid:block -->
## 23:10 状态变更 · [case] L0 标题
status: forgotten
id: 0ad7ea41-…
```

**为什么这么设计**（每条都是踩出来的）：

| 设计 | 原因 |
|---|---|
| `<!-- memoryhybrid:block -->` 分隔块 | 不能按 `## ` 切块——运维笔记里全是 `## 小标题` |
| `<!-- raw:start/end -->` 包原文 | 否则 L2 只在 SQLite 里，重建后原文全丢 |
| 原文里的同形标记转义成 `&lt;!--` | 否则原文写个 `raw:end` 就能把解析器带偏 |
| `id`/`source` 从**块尾**解析 | 否则原文里的 `id: <uuid>` 会被当成记录的 id 吃掉（真出过） |
| 写入侧归一化（每行去尾空白+trim） | Markdown 顶不住行尾空白，否则往返不一致（真出过） |
| 状态变更单独一块 | 否则遗忘的记录重建后复活（真出过） |
| 块里带 `importance` / `tags` / `expires` | 否则重建后重要度回退 0.6、tags 变成 `#type`、TTL 丢失（真出过） |

---

## 工具

| 工具 | 说明 |
|---|---|
| `memory_write` | `type` + `l0` + 可选 `l1`/`raw`/`tags`/`importance`/`ttlDays`。内置去重（归一化后比 l0）、拒绝指令载荷、剥触发词前缀 |
| `memory_search` | FTS5 trigram（≥3 字）+ LIKE 兜底（≤2 字）+ 多词 OR；`type` 过滤无命中时自动放宽并说明 |
| `memory_read` | 按 id 读全文（含 L2 与归档位置），或按类型列最近 N 条 |
| `memory_forget` | 软删除（`status=forgotten` + 落状态块），按 id 或文本子串 |

## 命令

```
/mem stats                     状态概览（含 fts 与 active 对齐情况）
/mem search <词>               快速检索
/mem stage list|commit|drop    候选暂存区
/mem mode auto|manual          切换写入模式
/mem config [set <k> <v>]      查看/修改配置
/mem init                      幂等初始化
/mem backfill                  DB → archive（补缺失块 + 修行号）
/mem rebuild                   archive → DB（跳机器/重建索引）
```

---

## 配置（`<memory>/config.json`）

首次加载自动生成，带 `_schema` + `_help` 自解释段。缺键回退默认，越界 clamp，非法正则丢弃。

> **配置迁移**：`_schema` 版本升级时，旧文件里已知的坏默认值（阈值 0.6、entity 泛词规则、`mode=auto`）会自动迁移到新语义。注意 `candidateRules` **不迁移**——它无法区分「旧默认 true」和「用户手动开的 true」，且 mode 改 manual 后本就不生效。

| 键 | 含义 | 默认 |
|---|---|---|
| `mode` | `manual`=只有触发词命中才写（默认）；`auto`=额外用正则抓候选 | `manual` |
| `candidateRules` | auto 下是否正则捕获候选（默认关——真实语料里正则把任务/提问误记为记忆的比例太高） | `false` |
| `promoteThreshold` | 候选晋升阈值 0~1（权重低于它的候选永不自动晋升） | `0.45` |
| `injectBudgetChars` | L0 注入字符上限（100~4000） | `600` |
| `maxInjectItems` | 最多注入条数（1~200） | `20` |
| `archiveWrite` | 是否写 Markdown 归档 | `true` |
| `ttlDaysByType` | 按类型过期天数 | event 30 / todo 90 / case 180 / pattern 365 |
| `captureRules` | 候选规则数组（pattern/kind/weight/reason） | 5 条（preference .75 / decision .7 / lesson .7 / entity .5 / todo .5） |
| `triggerPatterns` | manual 放行触发词（正则数组） | 2 条 |
| `captureMaxChars` | 候选捕获最大字符数（长文本多半是任务 prompt） | `800` |
| `sqliteSync` | `normal`（快）/ `full`（每次 fsync） | `normal` |
| `vector` | 向量后端，v1 仅 `none` | `{backend:"none"}` |

改法：`/mem config set <k> <v>`（标量）、或直接编辑文件后 `/reload`（`captureRules`/`triggerPatterns` 只能这样改）。

---

## 检索原理

- Node 24 内置 `node:sqlite`（SQLite 3.53），**零依赖、不编译**
- **坑**：FTS5 默认 `unicode61` 对中文完全失效；`tokenize='trigram'` 能搜 ≥3 字，但**两字词失败** → 短查询自动降级 `LIKE`
- 排序：`相关性 1.0 + 重要度 0.4 + 新鲜度 0.2`（60 天半衰），权重在 `src/domain/ranking.ts`
  - 相关性：FTS 的 `-rank`（BM25）；LIKE 兜底时为命中词数
  - 新鲜度：`max(updated_at, last_used_at)` 的指数衰减 —— 用 `last_used_at` 而非 `hits`，因为累计命中次数会被单次批量命中污染
  - **`hits` 不参与打分**，纯观测（`memory_read` 里可见）
- 向量：`VectorBackend` 端口已预留，v1 不接（实测中文子串检索对运维类记忆够用）

## 接入向量库时的设计约束

`VectorBackend` 端口已在 `src/domain/types.ts` 定义，v1 未接实现。真要接入时，有 4 个决定必须做（都不是阻塞性冲突，但会改接口）：

| # | 决定 | 说明 |
|---|---|---|
| 1 | **分数融合策略** | FTS 的 `-rank`（BM25，量级不固定）和向量 cosine（0~1）不能直接相加，需要归一化或 RRF（倒数排名融合）。建议 RRF：`1/(k+rankFts) + 1/(k+rankVec)` |
| 2 | **检索改异步** | 本地/远程 embedding 都是异步的 → `searchRecords` 要变 `async`，波及 `interface/tools.ts`（`execute` 已 async，OK）与 `/mem command`（handler 已 async，OK） |
| 3 | **索引同步钩子** | 需要在 `infra/records.ts` 的写入/遗忘/过期三处埋 `upsert`/`remove`；`/mem rebuild` 后要能整库重算（archive 有全文，可重算） |
| 4 | **模型版本** | 换 embedding 模型必须整库重算，所以记录里要存 `embeddingVersion`（否则新旧向量混在一个索引里，相似度不可比） |

### 关于 `sqlite-vec`（实测可用，但默认不开）

早前本文写的"Node 内置 sqlite 不支持加载扩展"是**错的**，已实测修正。Node 24 的 `node:sqlite` 支持原生扩展：

```js
const db = new DatabaseSync(path, { allowExtension: true }); // 必须在构造时开启
db.loadExtension(require('sqlite-vec').getLoadablePath());
// vec0 虚表可用；注意主键要传 BigInt（node:sqlite 默认把 number 绑成 REAL，会报 "Only integers are allowed for primary key"）
```

实测 `sqlite-vec@0.1.9` + `node:sqlite` + 预编译包 `sqlite-vec-windows-x64`：`vec_version()=v0.1.9`，`vec0` 建表/插入/KNN 全部正常（KNN 返回 `id=1 d=0.141, id=3 d=0.632, id=2 d=1.273`，距离排序正确）。

**为何不作为默认**：

| 理由 | 说明 |
|---|---|
| 它不产向量 | `sqlite-vec` 只做存储与近邻检索；向量仍要靠 embedding 模型（本地 GGUF ~300MB，或调 API） |
| 破坏零依赖 | 需要平台相关原生二进制（`sqlite-vec-windows-x64` / `darwin-*` / `linux-*`），扩展不再"拷个目录就能跑" |
| 安全面变大 | `allowExtension: true` 允许进程加载任意原生库；默认关闭是有意的 |
| 当前不是瓶颈 | 中文子串检索（trigram + LIKE）已够用；向量解决的是"同义改写/跨语言"，不是眼前的失败模式 |

落地建议（二选一）：

- **想零依赖**：向量存 SQLite BLOB（`records_vector(record_id, embedding)`），JS 算 cosine，万级记录几 ms 够用
- **想更快/更大**：接 `sqlite-vec`，代价是平台二进制与 `allowExtension`

## 写入纪律

- **manual（默认）**：`tool_call` 钩子拦截 `memory_write`，最近一条用户消息里没有触发词（“记一下/记住/以后都/别再”）就直接 block。只有你明说才写。
- **auto（可选，`/mem mode auto` 且 `candidateRules=true`）**：`agent_end` 用正则抓候选（0 次模型调用）→ 进 `candidates` → `session_shutdown` 按阈值晋升；若上次会话异常退出（关窗口/被杀），下次 `session_start` 会**补一次晋升**
- **捕获质量护栏**（auto 下）：提问句（`？`/“要不要/怎么/分析下”）与请求句（“我需要你/帮我/加一个”）不捕获；`entity` 只认具体值（IP / URL / 域名 / 路径 / 端口 / UUID），光有“配置/目录/地址”这类泛词不算
- 模型侧规则另写在 `~/.pi/agent/APPEND_SYSTEM.md`（只维护追加提示词，不改 pi 基础提示）

> 真实使用教训：auto 的规则型候选在运维语料下 precision ≈ 0——三周里 18 条候选/记录全是任务指令和提问，没有一条真记忆。所以默认切 manual。LLM 提炼放到后期版本。

---

## 崩溃一致性与恢复

`insertRecord` 顺序：`INSERT records` → `appendRecordArchive` → `UPDATE content_ref`

| 崩在哪 | 后果 | 恢复 |
|---|---|---|
| appendArchive 之前 | DB 有、归档无 → 重建后丢失 | `/mem backfill` 补块 |
| UPDATE 之前 | `content_ref` 为 null | `/mem backfill` 扫归档修回行号 |
| 归档写完、DB 未提交 | 归档多一块 | 无害，重建时按新记录恢复 |

**恢复动作永远是 `/mem backfill` →（必要时）`/mem rebuild`。**

## 跳机器 / 备份

- **只带 Markdown**：拷 `archive/*.md` + `config.json` → 目标机 `/mem rebuild`
- **不要**把 `index.db` 放网盘双写（WAL 多机并发写会损坏）
- `.gitignore` 建议：`index.db*`、`archive/` 视需要

## 测试

测试脚本在扩展内的 `tests/` 目录。pi **不会**把它当扩展加载（只加载根目录的 `.ts`/`.js` 与含 `index.ts` 的子目录），所以放在项目里不占运行时：

```powershell
node .\tests\test-unit.js              # 50 用例，零 API，3 秒
node .\tests\test-stress.js --count 24 # 15 用例，24 主题 ≈80 条复杂数据
node .\tests\test-model.js             # 13 用例，每次一个 pi 一次性任务
```

⚠️ **子代理（Agent 工具）不能验证刚改的代码**：它与主进程同进程，用的是父会话启动时加载的版本。验证代码改动用 `pi -p`（新进程）或 `/reload`。

## 分发（可选）

自用不需要安装步骤（放进 `extensions/` 即生效）。要跨机器分发时：

```powershell
# 克隆到本地，再拷到 ~/.pi/agent/extensions/
git clone https://github.com/0x5c0f/memory-hybrid.git

# 或 pi 直接安装（URL 源会当 git 源处理）
pi install https://github.com/0x5c0f/memory-hybrid
```

仓库：<https://github.com/0x5c0f/memory-hybrid>

---

## 已知取舍

1. **archive 是事实源，`index.db` 可重建**——但有代价：`hits`/`last_used_at`（检索热度）与 `candidates`（未晋升草稿）不落归档，重建后归零/丢失，排序会回退到「重要度+新鲜度」
2. **当日归档是追加写入**（`fs.appendFileSync` + meta 表行号计数），不再读整个文件写回：单写从 O(n) 降到 O(1)。副作用：手动编辑归档文件后行号可能不准（只影响 content_ref 定位，不影响 rebuild，它按块标记切）
3. **L0 截断 160 字、L1 截断 600 字**：超长静默截断
4. **FTS 只索引 active**，遗忘/过期会摘除
5. **去重只比归一化后的 l0**（标点/空白/符号/组合符/零宽字符都剥掉），l1 不同也算重复
6. **不做关系表**（`[[wiki-link]]`）：关系展开只占检索 1~2% 成本，真正成本是链接语义与腐烂；触发条件是记忆 >300 条且出现跨记录查询需求

## 为什么不用现成的（pi-memory）

| 项 | pi-memory | memory-hybrid |
|---|---|---|
| 每轮注入 | 最多 16K 字符（≈4k tok） | **600 字符（≈150 tok）** |
| 额外模型调用 | 每次会话结束一次摘要 | **0**（候选纯正则） |
| 检索 | 依赖外部 `qmd`（未装则不可用） | 内置 SQLite FTS5 |
| 写入时机 | 模型自行决定 | `manual` 模式硬门禁 / `auto` 只暂存 |
| Markdown 轨 | `MEMORY.md` + daily，重建会丢 raw 与状态 | 完整（L0+L1+L2+状态块） |
