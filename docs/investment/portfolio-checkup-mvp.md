# Investment Portfolio Checkup MVP

## 1. 背景与目标

Sage 需要一个投资研究能力，但第一版不应做成泛金融平台。MVP 选择“持仓追踪 / Portfolio Checkup”，围绕老张真实持仓和观察池，把信息采集、证据留存、事实抽取、信号构建、报告生成这条链路跑通。

正式系统放在 Sage 仓库内，不继续扩展 `/Users/zhangzhiguo/workspace/omni-watch`。`omni-watch` 只作为参考资产：AkShare / Polymarket connector、A 股代码规范、批量 upsert、事件监控和飞书通知思路可以借鉴，但不作为 runtime dependency。

目标：

- 记录持仓和观察池，支持手工录入和 CSV 导入。
- 刷新持仓价格、计算市值、权重、盈亏快照。
- 围绕持仓抓取公告、新闻、RSS、少量公开数据源。
- 将网页、公告、表格转成可追溯的 Evidence / Fact。
- 生成持仓体检报告，说明风险、变化、待复核事项。
- 接入 Sage Scheduler、Operations、Feishu，不另起独立服务。

核心原则：

- 不做荐股机器人，不输出买卖指令。
- 每个结论必须挂证据；无证据的判断标记为 `inferred`。
- 围绕持仓和观察池收敛，全市场扫描放到后续阶段。
- 采集层和分析层之间必须有 Evidence / Fact 中台，报告不直接临时爬网页。

## 2. MVP 范围 / 非目标

MVP 范围：

- 单用户本地持仓台账。
- 股票、ETF、基金、现金类资产的基础记录。
- 手工录入和 CSV 导入，不接券商账户。
- 日频或手动价格刷新。
- 持仓相关公告、新闻、RSS、公开网页的原始归档。
- 基础事实抽取：价格指标、公告事件、财报日期、分红/解禁/回购、重要媒体报道。
- 基础信号：价格异动、集中度过高、持仓相关事件、证据缺失、thesis 需要复核。
- Markdown 持仓体检报告，归档并可通过 Feishu 摘要发送。

非目标：

- 不自动交易，不接券商下单。
- 不做实时行情和高频告警。
- 不做券商级对账、交易流水重建、税务、完整分红复权。
- 不做全市场机会发现和复杂量化选股。
- 不依赖 Wind、Choice、iFinD、TradingView 登录态作为 MVP 必需能力。
- 不把 Python 金融依赖塞进 Sage Bun 主进程。

## 3. 与 Sage 现有架构融合

Sage 当前组织方式：

- `src/apps/{app}/`：产品域，包含 routes、service、repository、types。
- `src/services/tasks/`：Scheduler 内置任务。
- `src/shared/db.ts`：SQLite 连接入口，`getDatabase(name)` 映射到 `data/{name}.db`。
- `data/*.db`：系统持久状态。
- `agent_home/workspace/outputs/`：面向用户的交付物和临时输出。

Investment MVP 应遵循这个模式：

- 产品域放在 `src/apps/investment/`。
- 结构化事实库放在 `data/investment.db`。
- 原始证据归档放在 `data/investment/raw_archive/`。
- 系统报告归档放在 `data/investment/reports/`。
- 需要发给用户的报告副本放在 `agent_home/workspace/outputs/investment/`。
- 定时任务放在 `src/services/tasks/`，只调用 `InvestmentService`，不在 investment app 内部自建调度器。
- Operations 使用 `getOperationsService()` 记录刷新、抽取、报告生成的运行状态。

边界规则：

- Connector 只负责拿原始材料，不写报告。
- Extractor 只负责从材料抽事实，不做投资结论。
- Signal Builder 只负责从事实计算变化、异常、风险提示。
- Report 只负责组织 evidence pack 和叙事，不临时爬网页。

## 4. 目录与模块设计

建议代码目录：

```text
src/apps/investment/
  routes.ts
  service.ts
  repository.ts
  types.ts
  prices.ts

  connectors/
    csv.ts
    web.ts
    rss.ts
    sina.ts
    eastmoney.ts
    exchange.ts
    akshare.ts
    polymarket.ts

  extractors/
    article-extractor.ts
    table-extractor.ts
    metric-extractor.ts
    event-extractor.ts

  signals/
    portfolio-signals.ts
    price-signals.ts
    event-signals.ts
    evidence-signals.ts

  reports/
    portfolio-checkup.ts
    evidence-pack.ts
```

建议数据目录：

```text
data/
  investment.db
  investment/
    raw_archive/
      yyyy/mm/dd/{source_document_id}/
    reports/
      portfolio-checkup/

agent_home/workspace/outputs/investment/
```

Python CLI 建议目录：

```text
scripts/investment/
  akshare_fetch.py
```

`akshare.ts` 只通过子进程调用窄 CLI，读取 JSON 输出。CLI 负责 Python 依赖和 AkShare 细节，Sage 主进程只消费稳定 JSON schema。CLI 必须有超时、stderr 捕获、退出码检查、schema 校验和低并发限制，失败只能形成 warning 或缺失证据，不能卡住 Sage 主进程。

当前实现状态：

- `src/apps/investment/` 已提供持仓导入、组合 overview、A 股价格刷新基础能力。
- `prices.ts` 先用新浪行情接口实现 A 股股票 / ETF 价格刷新，不引入 AkShare runtime dependency。
- `POST /apps/investment/portfolios/:id/prices/refresh` 基于最新持仓生成新的价格快照；A 股更新价格，暂不支持的资产 carry forward。
- 行情接口失败时当前采用 all-or-nothing：中止刷新，不写半截快照。
- `agent_home/.claude/skills/investment-portfolio/` 已提供 Agent-facing Skill，通过 wrapper 脚本调用本地 Sage API；当前还没有 Feishu slash command 或前端页面。

## 5. 数据模型

第一版使用 SQLite。字段命名以稳定查询为优先，复杂结构可放 JSON，但核心索引字段必须独立列出。

### Instrument

资产主数据。

- `id`
- `symbol`：如 `600519.SH`、`AAPL.US`、`510300.SH`。
- `name`
- `market`：`cn_a`、`hk`、`us`、`fund`、`cash`。
- `asset_type`：`stock`、`etf`、`fund`、`cash`、`crypto`。
- `industry`
- `themes_json`：如 `["AI infra", "红利", "电力设备"]`。
- `metadata_json`
- `created_at`
- `updated_at`

唯一约束：`market + symbol`。

### Portfolio

组合或账户分组。

- `id`
- `name`
- `base_currency`
- `description`
- `created_at`
- `updated_at`

第一版可以只有一个默认组合。

### HoldingSnapshot

某日持仓快照。

- `id`
- `portfolio_id`
- `instrument_id`
- `snapshot_date`
- `snapshot_run_id`：同一次导入或刷新生成的快照批次。
- `quantity`
- `cost_basis`：总成本，不是单位成本。
- `cost_currency`
- `last_price`
- `price_currency`
- `market_value`
- `market_value_base`
- `unrealized_pnl`
- `unrealized_pnl_pct`
- `weight`
- `source`：`manual`、`csv`、`computed`、`price_refresh`、`carry_forward`。
- `created_at`

索引：`portfolio_id + snapshot_date`，`portfolio_id + snapshot_run_id`，`instrument_id + snapshot_date`。

MVP 不从交易流水重建成本。`quantity`、`cost_basis` 以用户手工录入或 CSV 导入为准，系统只做快照级市值、权重、浮盈亏估算。交易流水、现金流、分红复权放到后续阶段。跨币种第一版只允许手工或固定汇率输入；如果缺少汇率，报告必须标记权重/总市值为不完整。

### PositionNote

持仓 thesis 和复核条件。

- `id`
- `portfolio_id`
- `instrument_id`
- `status`：`holding`、`watching`、`closed`。
- `conviction`：`low`、`medium`、`high`。
- `thesis`
- `buy_reason`
- `risk_notes`
- `invalidation_condition`
- `review_cadence`：`weekly`、`monthly`、`event_driven`。
- `next_review_at`
- `created_at`
- `updated_at`

### SourceDocument

原始资料索引。

- `id`
- `url`
- `title`
- `publisher`
- `author`
- `published_at`
- `fetched_at`
- `source_type`：`official`、`exchange`、`data_vendor_public`、`media`、`social`、`manual`。
- `content_type`：`html`、`pdf`、`json`、`csv`、`text`、`screenshot`。
- `raw_path`
- `text_path`
- `hash`
- `status`：`fetched`、`parsed`、`failed`。
- `metadata_json`

唯一约束可先用 `url + hash`，避免同一网页反复抓取造成重复证据。

### EvidenceItem

从资料中抽出的证据片段或摘要。

- `id`
- `source_document_id`
- `evidence_type`：`metric`、`event`、`opinion`、`claim`、`risk`。
- `entity_type`：`instrument`、`theme`、`market`、`portfolio`。
- `entity_id`
- `summary`
- `quote`
- `period`
- `confidence`：`high`、`medium`、`low`。
- `extraction_method`：`api`、`table_parse`、`llm_extract`、`manual`。
- `metadata_json`
- `created_at`

规则：`quote` 只保存必要短片段；长正文看 `SourceDocument.text_path`。

### MetricObservation

结构化指标观测。

- `id`
- `metric_key`：如 `last_price`、`market_value`、`margin_balance`、`etf_net_flow`。
- `entity_type`
- `entity_id`
- `period`
- `as_of_date`
- `value`
- `unit`
- `currency`
- `source_document_id`
- `evidence_item_id`
- `source_quality`：`official`、`media_confirmed`、`vendor_public`、`social`、`inferred`。
- `extraction_method`
- `created_at`

### Signal

从事实生成的分析信号。

- `id`
- `portfolio_id`
- `entity_type`
- `entity_id`
- `signal_type`：`price_move`、`event_alert`、`concentration_risk`、`thesis_review`、`missing_evidence`。
- `direction`：`positive`、`negative`、`neutral`、`risk`。
- `strength`：`low`、`medium`、`high`。
- `summary`
- `explanation`
- `evidence_ids_json`
- `generated_at`
- `expires_at`
- `status`：`open`、`acknowledged`、`closed`。

### ReportRun

报告生成记录。

- `id`
- `report_type`：`portfolio_checkup_daily`、`portfolio_checkup_weekly`。
- `portfolio_id`
- `period_start`
- `period_end`
- `status`：`running`、`success`、`warning`、`failed`。
- `operation_run_id`：对应 Operations ledger 的运行记录，可为空。
- `output_path`
- `workspace_output_path`
- `summary`
- `metrics_json`
- `created_at`
- `finished_at`

`ReportRun` 是投资域产物索引，记录报告文件、覆盖周期和业务摘要；Operations 是运行账本，记录任务状态、耗时、错误和告警。两者不要互相替代，必要时通过 `operation_run_id` 关联。

## 6. 数据流

MVP 主链路：

```text
手工/CSV 持仓
  -> upsert Instrument / Portfolio / HoldingSnapshot / PositionNote
  -> 价格刷新
  -> 持仓相关证据抓取
  -> SourceDocument raw_archive
  -> Extractor 抽 EvidenceItem / MetricObservation
  -> Signal Builder 生成 Signal
  -> Evidence Pack
  -> Portfolio Checkup Report
  -> data/investment/reports + workspace/outputs/investment
  -> Feishu 摘要或问答响应
```

Evidence Pack 是报告输入，不是报告输出。它应包含：

- 当前持仓快照。
- 与持仓相关的 SourceDocument 列表。
- 抽取出的 EvidenceItem 和 MetricObservation。
- 当前 open Signals。
- 缺失证据和低置信度事项。
- 报告生成时的 freshness 信息。
- 报告覆盖的 `snapshot_run_id`，保证后续复核时看到的是同一批持仓和价格。

报告生成规则：

- 报告不得直接调用 connector。
- 报告只能消费 repository 查询结果和 evidence pack。
- 报告中每条关键结论必须引用 evidence id 或标记 `inferred`。
- `reports/` 是产物归档，不作为事实源头。

## 7. 数据源与 Connector 策略

第一版数据源保持克制：

- 持仓：手工录入 / CSV。
- 价格：当前实现先用新浪行情接口；后续可补 AkShare Python CLI 或东方财富公开接口；失败时允许手工价格。
- 公告：交易所公告页、巨潮资讯，先支持链接归档和基础正文抽取。
- 新闻/RSS：复用 Sage RSS 能力或固定源搜索结果，不另建 RSS 系统。
- 网页：通用 `web.ts` 抓取 HTML、正文、hash、metadata。
- Polymarket：非持仓核心，可后续作为事件概率补充。

Connector 输出分两类：

- `RawDataset`：结构化 API/CLI 数据，如价格表。
- `SourceDocument`：网页、PDF、公告、新闻、RSS 原文。

AkShare 策略：

- 不把 `akshare` 作为 Bun 依赖。
- `scripts/investment/akshare_fetch.py` 封装明确命令，如 `quote`、`daily`、`instrument_meta`。
- `src/apps/investment/connectors/akshare.ts` 调 CLI，校验 JSON schema 后只返回 `RawDataset`。
- `InvestmentService` 或专门的 normalizer 将 `RawDataset` 写入 `MetricObservation`。
- CLI 失败时记录 Operations warning，不阻塞整个报告。

`omni-watch` 策略：

- 参考 AkShare / Polymarket client 和 A 股 symbol 规范。
- 可复制小段成熟逻辑，但要按 Sage 风格重写接口。
- 不引入它的 Mongo schema。
- 不把它作为常驻服务或子模块。

## 8. Scheduler / Operations / Feishu 交互

Scheduler 任务建议：

- `investment-price-refresh`：刷新持仓价格，日频或手动触发。
- `investment-evidence-refresh`：抓取持仓相关新闻、公告、RSS，日频。
- `investment-portfolio-checkup`：生成持仓体检报告，周频优先。

任务放在：

```text
src/services/tasks/investment-price-refresh.ts
src/services/tasks/investment-evidence-refresh.ts
src/services/tasks/investment-portfolio-checkup.ts
```

Operations 类型：

- `investment.price.refresh`
- `investment.evidence.refresh`
- `investment.report.portfolio_checkup`

关键 metrics：

- `holding_count`
- `instrument_count`
- `price_success`
- `price_failed`
- `documents_fetched`
- `documents_failed`
- `evidence_extracted`
- `metrics_observed`
- `signals_open`
- `signals_high`
- `report_generated`

Feishu 交互：

- 用户可问：“我的持仓今天有什么变化？”
- 用户可问：“生成本周持仓体检。”
- 用户可上传 CSV，触发持仓导入草稿和确认。
- 定时任务只推摘要：高风险信号、需要复核的 thesis、报告链接。
- 不在 Feishu 中给出买卖建议；表达为“风险提示 / 需要复核 / 证据变化”。
- 发送本地报告时必须是明确的附件/文件消息或受控摘要，不把内部 `data/` 路径裸露给用户可点击链接。

## 9. MVP 里程碑和验收标准

### Milestone 1：持仓台账和导入

交付：

- `InvestmentRepository` 创建核心表。
- 支持手工或 CSV 导入 Instrument、Portfolio、HoldingSnapshot、PositionNote。
- 支持查询当前持仓和观察池。

验收：

- 能导入一个 5-20 个标的的组合。
- 能查询每个标的的名称、市场、资产类型、成本、数量、备注。
- 导入重复数据不会产生重复 Instrument。

### Milestone 2：价格刷新和快照

交付：

- AkShare CLI 或公开源 connector。
- 写入 `MetricObservation` 和最新 `HoldingSnapshot`。
- 失败记录 Operations warning。

验收：

- 至少支持 A 股股票 / ETF 的日频价格刷新。
- 价格源失败时报告明确列出失败标的。
- 市值、权重、浮盈亏计算可复核。

### Milestone 3：证据抓取和事实抽取

交付：

- `SourceDocument` raw archive。
- 通用网页 / RSS / 公告链接抓取。
- 基础 `EvidenceItem` 和 `MetricObservation` 抽取。

验收：

- 对已配置 source 的持仓，至少能关联最近若干条资料或明确标记无资料；未配置 source 的持仓只标记为 coverage gap。
- 原始资料可从 `raw_path` 复核。
- 报告中引用的证据能回到 `SourceDocument`。

### Milestone 4：信号和持仓体检报告

交付：

- 基础 `Signal` 生成。
- `portfolio-checkup` report。
- 输出到 `data/investment/reports/` 和 `agent_home/workspace/outputs/investment/`。

验收：

- 报告包含组合概览、权重集中度、主要变化、持仓事件、待复核 thesis、证据缺口。
- 每条关键结论都有 evidence id 或 `inferred` 标记。
- Feishu 能返回报告摘要，并以受控附件或输出引用提供报告。

### Milestone 5：定时运行和可观察性

交付：

- Scheduler 任务接入。
- Operations run 记录和失败告警。

验收：

- 手动触发和定时触发都能跑通。
- Operations 页面能看到运行状态、耗时、关键 metrics。
- 单个 connector 失败不会导致整个周报不可生成；报告降级并说明缺失。

## 10. 风险与开放问题

风险：

- 公开数据源不稳定。新浪行情、东方财富、交易所、媒体页面可能变更结构，connector 需要降级路径。
- AkShare 依赖较重。必须隔离在 Python CLI，避免污染 Bun 主服务和部署环境。
- 证据抽取容易混淆事实、观点、推断。数据模型必须强制 `source_type`、`confidence`、`extraction_method`。
- 持仓 CSV 格式不统一。第一版应定义 Sage 自己的模板，不承诺兼容所有券商导出。
- 报告可能滑向荐股。文案和接口层都应限制为证据变化、风险提示、复核建议。
- 原始网页归档可能带来版权和隐私风险。只保存必要资料，避免公开暴露 `data/investment/raw_archive/`。
- 缺少交易流水模型会限制精确收益归因。MVP 接受这个限制，只做研究决策够用的快照级分析。
- 报告文件和原始归档可能被误发。默认只发送 `agent_home/workspace/outputs/investment/` 下的报告副本，`data/investment/raw_archive/` 永远不作为 Feishu 附件发送。
- `SourceDocument.quote` 必须短摘录；长正文只保存在本地归档，用于复核，不在报告中大段复制。

开放问题：

- 第一版持仓是否只支持 A 股和 ETF，还是同时支持美股/港股。
- 是否需要把 `PositionNote` 和 Sage memory/decision journal 打通。
- 是否要为投资报告单独做 dashboard，还是先只走 Feishu + Markdown。
- 价格源失败时，是否允许用户在 Feishu 中补录价格。
- 观察池和真实持仓是否共用 `Portfolio`，还是单独建 `Watchlist`。
- 财报、解禁、分红日历第一版使用公开网页抓取，还是先手工维护。
- `investment.db` 初期是否需要显式 migration 目录，还是先在 repository init 中维护 schema。

## 主 Agent Review 重点

需要重点 review 的 3 个风险点：

1. 快照级持仓模型是否足够支撑 MVP，是否明确接受“不做交易流水和精确成本归因”的限制。
2. AkShare Python CLI 的边界是否足够窄，是否会引入部署和运行时维护成本。
3. `SourceDocument` 原始归档的保存范围、版权风险、隐私暴露风险是否需要更严格策略。
