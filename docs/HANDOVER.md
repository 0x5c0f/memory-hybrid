# memory-hybrid 交接文档

> 交接 = 让下一个接手的人（或未来的我）在 5 分钟内知道：**系统现在是什么样、为什么这么设计、哪些是坑、接下来能做什么**。
> 状态基线：2026-10-23。代码在 `~/.pi/agent/extensions/memory-hybrid/`，数据在 `~/.pi/agent/memory/`。

---

## 1. 一句话定位

给 pi 用的长期记忆扩展：**Markdown 归档（事实源）+ SQLite（可重建索引）双轨**，L0/L1/L2 分层注入，写入默认走 **manual（只在你说“记一下/记住”时写）**，全程零 npm 依赖、零原生扩展。

---

## 2. 已完成（可直接用）

### 2.1 功能面

| 能力 | 状态 | 备注 |
|---|---|---|
| 写入 `memory_write` | ✅ | 去重（归一化后比 l0）、拒绝指令载荷、剥触发词前缀、TTL |
| 检索 `memory_search` | ✅ | FTS5 trigram（≥3 字）+ LIKE 兜底（≤2 字）+ 多词 OR；type 过滤无命中自动放宽 |
| 读取 `memory_read` | ✅ | 按 id 读全文（含 L2 与归档行号），或按类型列最近 N 条 |
| 遗忘 `memory_forget` | ✅ | 软删除 + 状态块落归档 |
| L0 注入 | ✅ | stable 快照，`injectBudgetChars` 硬上限，跨天/写入时刷新 |
| 候选捕获（auto） | ⚠️ 可选（默认关） | 纯正则，0 次模型调用；实测 precision≈0，只保留给想试的人 |
| 写入门禁（manual） | ✅ 默认 | `tool_call` 钩子按 `triggerPatterns` 硬拦截 |
| 归档双轨 | ✅ | 块标记 + raw 段 + 元数据（importance/tags/expires）+ 状态块 |
| `/mem` 命令 | ✅ | stats/search/stage/mode/config/init/backfill/rebuild |
| 崩溃自愈 | ✅ | `backfill` 补缺失块 + 修 `content_ref` |
| 批量配置化 | ✅ | 12 个配置项，非法值 clamp/丢弃，旧配置自动补齐新键 |

### 2.2 非功能面

| 项 | 值 |
|---|---|
| 代码规模 | 20 文件 / ~1560 行，四层（domain/infra/services/interface）全在 `src/` |
| 依赖 | 仅 Node 内置（`node:sqlite` / `node:crypto` / `node:fs`）+ pi 自带包 |
| 性能基线 | 2000 条：检索 ~1.4ms（NORMAL）/ 20ms（FULL）、单写 ~12ms、200 条批量 ~2.4s |
| 并发 | WAL + `busy_timeout=5000`；多进程/子代理并发写已验证 |
| 测试 | 76 用例：单元 48 / 压测 15（80+ 条复杂数据）/ 模型层 13，全部在 `tests/` 内 |

### 2.3 测试与运维工具（全部在项目内）

```
memory-hybrid/
├── index.ts                     入口（只转发 src/extension.ts）
├── src/                         全部代码（domain/infra/services/interface + extension.ts）
├── tests/                       开发资产，pi 不会加载（子目录无 index.ts）
│   ├── test-unit.js             48 用例，零 API，3 秒
│   ├── test-stress.js           15 用例，24 主题 × 3 变体 + 边界 ≈80 条数据
│   ├── test-model.js            13 用例，每例一个 pi 一次性任务
│   └── TEST-PLAN.md             测试方案（L1/L2 分层说明）
├── ops/                         运维工具
│   ├── check.js                 运行时状态快照（fts 是否等于 active）
│   └── export-config-doc.js     从代码生成 docs/config.jsonc（--check 校验同步）
└── docs/                        文档
    ├── config.jsonc             全部配置项（生成物，勿手改）
    ├── HANDOVER.md              本文件
    └── README.md                docs 目录说明 + 为什么用 JSONC
```

在扩展目录下直接跑：

```powershell
cd ~/.pi/agent/extensions/memory-hybrid
node tests/test-unit.js
node tests/test-stress.js --count 24
node tests/test-model.js
node ops/check.js -v
node ops/export-config-doc.js --check
```

---

## 3. 设计决策与理由（都是踩出来的，别轻易回退）

| 决策 | 理由 |
|---|---|
| archive 是事实源，`index.db` 可重建 | DB 坏了能救；跨机只传 Markdown |
| 块标记 `<!-- memoryhybrid:block -->` | 不能按 `## ` 切块——运维笔记里全是 `## 小标题` |
| 原文放 `raw:start/end` 并转义同形标记 | 否则 L2 只在 SQLite；原文写个 `raw:end` 就能带偏解析器 |
| `id`/`source`/元数据从**块尾**解析 | 否则原文里的 `id: <uuid>` 会被当记录 id 吃掉 |
| 写入侧归一化（去行尾空白 + trim） | Markdown 顶不住行尾空白，往返会不一致 |
| 状态变更单独成块 | 否则遗忘/过期的记录重建后复活 |
| 元数据（importance/tags/expires）落归档 | 否则重建后重要度回退 0.6、tags 变 `#type`、TTL 丢失 |
| 去重只比归一化后的 l0（含剥 `\p{M}`/`\p{Cf}`） | emoji 变体选择符/零宽连接符不剥会导致近似重复漏判 |
| 新鲜度用 `max(updated_at, last_used_at)`，不用 `hits` | `hits` 会被单次批量命污染；`last_used_at` 语义干净 |
| `synchronous=NORMAL` | WAL 下仍保证崩溃一致，检索快 10 倍 |
| **晋升阈值必须 ≤ 所有规则权重** | 阈值 0.6 而 entity=0.45/todo=0.5 时，这两类**永远不会晋升**（真出过：一天 5 条候选全是 entity，全部滞留暂存区）。单测里有一条守着这个不变量 |
| 服务层做路由决策（FTS vs LIKE） | trigram 只支持 ≥3 字符，中文两字词必须降级 |

---

## 4. 已知限制（接受，不修）

| 限制 | 影响 | 为什么接受 |
|---|---|---|
| `hits`/`last_used_at` 不落归档 | 重建后检索热度归零，排序回退到「重要度+新鲜度」 | 每次检索都变，写归档等于每次重写文件 |
| `candidates` 不落归档 | 重建后未晋升草稿丢失 | 草稿是临时缓冲 |
| 当日归档文件整文件重写 | 同一天 2000 条时单写 ~12ms | 日常几条无感；按月切分能缓解但增加复杂度 |
| l0 截断 160 / l1 截断 600 | 超长静默截断 | 常驻注入必须控长 |
| 只比 l0 去重 | 同 l0 不同 l1 会判重复 | 简化；l1 是摘要不是事实 |
| 候选是**原话整条**，不是提炼后的结论 | 自动入库的条目读起来像用户的原话 | 纯正则是 0 成本方案的先天上限；要提炼只能上 LLM（与"零调用"目标冲突） |
| **auto 候选在真实语料下 precision ≈ 0** | 三周 18 条候选/记录全是任务指令和提问，没有一条真记忆 | 已把默认切 manual；auto 只作为可选项保留；LLM 提炼放后期 |
| **配置迁移靠 `_schema` 版本** | 改了代码默认值后，已存在的 config.json 不会自动更新 | loadConfig 里 migrateConfig 只对旧默认值动手；升版本必须同步写迁移 + 测试 |
| 多条规则同时命中时取**权重最高**的 | 句子可能被归到意料之外的类型（含 URL 的句子若写了"统一用"会被归成 preference） | 权重即优先级；想精确控制就自定义 `captureRules` |
| 没有关系表 / 向量 | 无法做"相关知识""同义改写"检索 | 见第 5 节，触发条件明确 |
| 去重是 O(n) 内存扫描 | 每次写入把 active 的 l0 全读出来比归一化键；2000 条约 12ms | 当前量级无感；上万条时应加 `l0_hash` 列 + 唯一索引 |

---

## 5. 待讨论的后续计划（**需要和你逐个定**）

按"价值 × 成本"排列，**每项都有触发条件，不是想做就做**：

### P1 观测期必备（0 代码，只需养成习惯）

| 项 | 做法 | 触发条件 |
|---|---|---|
| 一致性巡检 | 每周 `node ops/check.js`，看 `fts == active` 且"未归档 0 条" | 现在是空的，无从验证；用 1~2 周攒真实数据 |
| 真实语料盲测 | 隔几天问"之前 X 是怎么定的" | 攒到 30+ 条记忆后再看召回率 |

### P2 低风险增强（1~2 小时/项）

| 项 | 收益 | 代价 | 我的建议 |
|---|---|---|---|
| **`/mem export` / `/mem import`（JSON）** | 备份、迁移、手工修 | ~80 行 + 测试 | 可用，但 archive + rebuild 已覆盖 90% 场景，优先级低 |
| **按类型统计/按需 TTL 策略可视化**（`/mem breakdown`） | 运维可观测 | ~50 行 | 等库大了再说 |
| **`memory_link`（`[[wiki-link]]` 关系，只存不展开）** | 埋点，为将来关系查询铺路 | ~40 行（仅存 `links` 字段 + LIKE 查） | 可做可不做 |
| **按月切归档文件**（`archive/2026-10/2026-10-23.md`） | 当日文件不会无限长大 | ~30 行（影响 backfill/rebuild 的目录遍历） | 等单日写入 >200 条再说 |

### P3 中等改动（需要先定接口）

| 项 | 收益 | 代价/风险 |
|---|---|---|
| **向量检索（语义/同义）** | 解决"同义改写搜不到" | `search` 变异步、融合策略（建议 RRF）、索引同步钩子、模型版本管理；见 README「接入向量库时的设计约束」 |
| **`scope`（user/project 作用域）** | 不同项目隔离记忆 | 需要"如何识别当前项目"的策略（git root？cwd？），且注入要按 scope 过滤 |
| **关系表 + 双向关联查询** | "哪些决策涉及 X" | 链接解析歧义（`[[nginx]]` 指哪条）+ 悬空链接清理；**触发条件：记忆 >300 条且真有跨记录查询需求** |
| **LLM 提取候选**（替代纯正则） | 候选质量更高 | 每次 `agent_end` 多一次模型调用 = 持续成本，与"零成本"设计目标冲突 |

### P4 明确不做（避免以后再讨论）

| 项 | 为什么不做 |
|---|---|
| 多 agent 隔离（OpenClaw 那套 `agent_id`） | 单机单用户 |
| 索引队列 / `ann-local` / LSH | 万级记录 SQLite 足够 |
| `dreaming`（light/REM 自动蒸馏） | 上一个项目实测 `Promoted 0 candidate`，纯装饰 |
| 定期把 `hits` 刷进归档 | 写入成本 >> 热度价值 |

---

## 6. 讨论清单（我需要你回答的）

1. **观测期怎么跑？** 你愿意用 1~2 周正常记东西吗？还是希望我直接造一批"看起来真实"的语料来提前暴露问题？
2. **`scope`（项目/用户作用域）你需不需要？** 如果你只在个人机器上用、不区分项目，就直接砍掉这个方向。
3. **向量检索的真实痛点在哪？** 你希望"答得更准"，还是"换个说法也能搜到"？前者靠更大的模型，后者才需要向量。
4. **P2 里有没有你现在就想要的？**（导出/导入、按月归档、`links` 埋点）
5. **这个扩展要不要包成 pi package 做版本管理**（方便跨机器 `pi install`）？还是继续"拷目录"？

---

## 7. 交接时的三件事（给接手的人）

```powershell
# 1) 确认代码是最新的（改过 .ts 必须 reload，否则子代理/当前会话跑的是旧代码）
pi config     # 应显示 memory-hybrid/index.ts
/reload

# 2) 确认环境健康
node ops\check.js -v
node %USERPROFILE%\.pi\agent\extensions\memory-hybrid\ops\export-config-doc.js --check

# 3) 改完代码跑三套测试（断言只看状态，不看模型措辞）
node tests\test-unit.js
node tests\test-stress.js --count 24
node tests\test-model.js
```

⚠️ 三条血泪教训：

1. **子代理不能验证刚改的代码**（同进程，用父会话加载的版本）；验证代码用 `pi -p` 或 `/reload`
2. **永远断言状态（DB/archive/recall_events），不要断言模型措辞**——模型会转述，测试会假失败
3. **改归档格式前先想清楚重建**：块标记/raw/元数据/状态的顺序与转义规则一动，`rebuild` 就会静默丢数据
