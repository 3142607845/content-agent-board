# 系统架构设计

## 产品定位

自媒体内容工厂：用户输入一个选题，策划 Agent 拆解任务，4 个内容 Agent 并行产出公众号长文、短视频脚本、小红书文案和配图，全程在看板上可见、可中断、可重跑。

## Agent 角色与协作模式

采用「策划 + 并行执行」的轻量层级模式（简化版 Supervisor）：

```
选题 → 策划Agent → [长文Agent, 脚本Agent, 小红书Agent, 配图Agent]
```

- **策划 Agent（Planner）**：拿到选题后，为每个平台生成专属写作提纲（角度、结构、侧重点）。它的输出是 4 个内容 Agent 的输入。
- **长文 Agent**：根据提纲生成公众号风格长文（2000字+）。
- **脚本 Agent**：根据提纲生成短视频脚本（分镜+台词）。
- **小红书 Agent**：根据提纲生成小红书图文（标题+正文+标签）。
- **配图 Agent**：分两步，先把提纲里的配图描述扩写成高质量出图提示词（流式可见），再把提示词交给 Seedream 生成真实图片。

4 个内容 Agent 之间无依赖，并行执行；但它们都依赖策划 Agent 的输出，构成真实的上下游协同关系。

下游三个文本 Agent 的入参是「策划提纲 + 运行时选定的风格模板」：提纲决定写什么（角度、结构、侧重点），风格模板决定怎么写（文风、格式、排版、标签），两者互相独立、可自由组合。配图 Agent 只使用提纲里的配图描述，不参与风格模板。

### 失败处理规则

1. **策划节点失败（含自动重试后的失败）**：整个流水线阻塞，后置 4 个节点全部不启动。前端看板提示「策划提纲生成失败，无法继续生成内容」。
2. **后置 4 个节点互相独立**：任意一个失败，另外 3 个继续跑完。
3. **单节点重跑**：支持单独重跑任意一个后置节点。重跑时复用已经生成好的策划提纲，不需要重新跑策划 Agent。

### 策划 Agent 提纲 JSON 强制校验

后置 4 个节点强依赖策划 Agent 输出的**标准 JSON 提纲**。大模型经常额外输出解释文字、前言后记、markdown 代码块标记（```json），导致 JSON 解析失败、下游节点无法启动。因此对策划节点做**唯一**的强校验，其他 Agent 不做此校验。

**1. System Prompt 强制约束（`lib/agents/planner.ts`）**

策划 Agent 的 System Prompt 明确要求：

- 只输出纯 JSON，不输出任何解释、前言、后记
- 禁止使用 markdown 代码块标记（```json / ```）
- 禁止在 JSON 前后添加任何文字
- 输出必须能被 `JSON.parse` 直接解析

约定的提纲 JSON 结构（本轮**不校验**字段与结构，先保留作为后续迭代开发依据）：

```json
{
  "topic": "选题",
  "outline": {
    "longForm": { "angle": "切入角度", "structure": ["段落要点1", "段落要点2"] },
    "script": { "angle": "切入角度", "shots": ["分镜1", "分镜2"] },
    "xhs": { "angle": "切入角度", "headline": "标题", "tags": ["标签1"] },
    "image": { "angle": "切入角度", "prompts": ["配图描述词1"] }
  }
}
```

**2. 编排引擎解析校验（`lib/orchestrator.ts`）**

拿到策划 Agent 的输出后：

- 先去掉首尾空白，再执行 `JSON.parse`
- **本轮只做 JSON 语法解析校验**：`JSON.parse` 成功即放行，不校验字段是否齐全、结构是否正确
- 语法合法 → 策划节点标记 `completed`，启动 4 个并行节点
- 语法非法（`JSON.parse` 抛错）→ 进入自动重试流程
- 字段与结构完整性校验放到后续迭代补充

**3. 自动重试机制**

```
策划 Agent 输出
      │
      ▼
  JSON.parse 校验
      │
  成功 ├──► 策划节点 completed ──► 并行启动 4 个后置节点
      │
  失败 └──► 自动重试 1 次（重新调用策划 Agent）
                 │
             成功 ├──► 策划节点 completed ──► 并行启动 4 个后置节点
                 │
             失败 └──► 策划节点 failed ──► 阻断下游 4 个节点
```

- 最多自动重试 **1 次**，重试依然失败才判定策划节点 `failed`
- 判定失败后，后置 4 个节点保持 `pending`，一律不启动

**4. SSE 事件协议**

所有事件都按 `id: <自增序号>` + `event: <名称>` + `data: <JSON>` 推送。完整清单：

| 事件 | 时机 | data 结构 |
|---|---|---|
| `snapshot` | 连接建立时（含断线重连）先推一次全量 | 见下方「全量快照」 |
| `node:start` | 节点开始（自动重试会再发一次，attempt 递增） | `{ nodeId, name, model, attempt }` |
| `node:token` | 收到一个 token | `{ nodeId, text }` |
| `node:image` | 配图出图成功 | `{ nodeId, url, prompt }` |
| `node:done` | 节点完成 | `{ nodeId }` |
| `node:error` | 节点失败 | `{ nodeId, message }` |
| `node:cancelled` | 节点被中断 | `{ nodeId }` |
| `run:done` | 流水线结束（含中断收尾） | `{ summary, report }` |
| `run:failed` | 策划失败导致流水线终止 | `{ message, summary, report }` |

另外每 15 秒推送一行 SSE 注释 `: ping <时间戳>` 做保活，防止反向代理按空闲时间切断长连接；注释行不产生业务事件。

**全量快照**

`snapshot` 是唯一能让前端收敛状态的事件，结构：

```ts
{
  runId: string;
  topic: string;
  variant: "analysis" | "story" | "beginner" | null;
  styles: { longform?: StyleSnapshot; script?: StyleSnapshot; xhs?: StyleSnapshot };
  status: "running" | "completed" | "failed" | "aborted";
  createdAt: number;
  finishedAt: number | null;
  nodes: Record<NodeId, AgentNodeState>; // 含 content / imageUrl / error / attempt / model / style / metrics
  summary: RunSummary | null;            // 终态才有值
  report: RunReport | null;              // 终态才有值
}
```

**断线重连策略**

浏览器 `EventSource` 自动重连，服务端在每次连接建立时立即下发全量快照。

- 节点已累积内容、耗时、token 用量全在快照里，重连后整体替换，不丢状态
- 终态写回 `RunState`，连到已经结束的 run 也能立刻拿到 `summary` 与 `report`
- **不做事件重放**：全量快照已能收敛状态，再维护事件日志表属于过度设计
- 事件带自增 `id` 仅用于排查时序，服务端不处理 `Last-Event-ID`

前端据此做了两处必要处理：

1. 快照 `status !== "running"` 时直接结束当前任务。批量模式原来只等 `run:done` 才 resolve，断线期间 run 结束会让整个队列永久卡住，这是本轮修掉的真实 bug
2. `onerror` 时显示「连接中断，正在重连」，收到新快照自动清除

策划节点失败时推送：

```
event: node:error
data: {"nodeId":"planner","message":"JSON 解析失败（已重试1次）"}
```

随后推送 `run:failed`，前端提示「策划提纲生成失败，无法继续生成内容」。

**5. 执行日志与报告**

每个节点在 `AgentNodeState.metrics` 上记录执行指标：

| 字段 | 含义 |
|---|---|
| `startedAt` / `endedAt` / `durationMs` | 首次开始到最终结束的总耗时，策划重试不重置起点 |
| `usage` | 该节点所有尝试累加后的 token 用量，含 prompt / completion / reasoning / cached |
| `usageEstimated` | true 表示服务端未返回 usage，按字符估算 |
| `retries` | 自动重试次数 = 尝试次数 - 1 |

token 来源：请求体带 `stream_options: { include_usage: true }`，方舟在流末尾补一片 usage。中间分片的该字段是 `null`，且解析必须放在 `choices` 判空之前，否则会漏掉。`completionTokens` **包含思维链 token**，所以「输出 token」可能远大于正文字数，报告里单独列出 `reasoningTokens` 说明差异。

流水线进入终态时由 `buildRunReport` 生成 `RunReport`，写回 `RunState.report` 并随 `run:done` 下发；也可以 `GET /api/run/[runId]` 一次性取全量快照与报告。

报告内容：

- 节点明细：模型、状态、尝试次数、耗时、输入/输出 token、重试次数
- 汇总：模型调用次数、token 合计、失败与中断数
- 并行加速比：4 个后置节点耗时之和 ÷ 并行阶段实际墙钟时间
- `hasEstimated`：任一节点用了估算值就置 true，前端明确标注

自动重试已下沉到 4 个后置节点：仅对网络异常、408、429、5xx 重试，`AbortError` 与其他 4xx 不重试。

## 模型分工（差异化）

不同平台使用擅长该文体的模型：

| Agent | 实际模型 id | 原因 |
|---|---|---|
| 策划 Agent | `deepseek-v4-1-flash-261017` | 结构化拆解和 JSON 输出稳定 |
| 长文 Agent | `deepseek-v4-1-flash-261017` | 擅长长文逻辑结构 |
| 脚本 Agent | `deepseek-v4-1-flash-261017` | 擅长分镜格式输出 |
| 小红书 Agent | `glm-5-3-flash-260828` | 与长文/脚本同速度量级，避免看板上显得没同步启动 |
| 配图 Agent（扩写） | `doubao-seed-2-1-pro-260915` | 中文视觉描述能力强 |
| 配图 Agent（出图） | `doubao-seedream-5-0-flash-260915` | 文生图专用，出图质量好 |

所有模型共用同一个方舟 API Key，仅通过 `model_id` 切换，不需要对接多个服务商。

## 三种运行模式

一次 run 始终是「1 个选题 → 1 条流水线」。批量能力由前端串行拉起多次 run 实现，每个 run 独立连一条 SSE。

| 模式 | 行为 | 请求差异 |
|---|---|---|
| 单次生成 | 一个选题跑一条流水线 | 只传 `topic`（可带 `styles`） |
| 批量选题 | 多行输入（最多 3 个）逐条跑 | 每条 run 传 `topic`（可带 `styles`） |
| 多版生成 | 同一选题跑 3 次，每次注入一个创作维度 | 额外传 `variant`（可带 `styles`） |

三种模式都可以额外传 `styles: { longform?, script?, xhs? }`，值为风格模板 id。风格模板与创作维度是两个正交维度：维度只影响策划提纲的结构，风格只影响下游三个文本 Agent 的写法，可以任意组合。

前端用 `tasks[]` 维护批量结果，每个元素含自己的 `nodes` 与 `runId`，tab 切换时只切展示数据源，不重连。

### 多版生成的差异化提纲

多版不是「同一份 prompt 跑三次」，而是**定向生成三种结构不同的提纲**。三个维度定义在 `lib/variants.ts`（纯数据，前后端共用）：

| 变体 | 定位 | 长文骨架 |
|---|---|---|
| 深度分析版 | 靠逻辑与证据说服 | 矛盾现象切入 → 论点+论据 → 反面观点与回应 → 可执行建议 |
| 故事化叙述版 | 靠人物与冲突代入 | 具体人物场景 → 冲突困境 → 转变过程 → 一句短观点 |
| 科普入门版 | 零基础，用类比降门槛 | 生活类比 → 分步拆解 → 常见误区 → 一句话总结 |

变体注入路径：

```
page.tsx (variant)
  → POST /api/run（isVariantKey 校验，非法返回 400）
  → createRun(topic, variant) 存入 RunState.variant
  → runPlanner 构造 new PlannerAgent(run.variant)
  → 构造函数把 promptBlock 追加到 system prompt
```

约束：**差异化必须落在结构骨架上**（段落推进步骤、论据类型、配图风格），只换形容词模型仍会输出同质提纲。下游 4 个 Agent 不额外感知变体，提纲已携带角度与结构。`variant` 为可选参数，不传时行为与单次模式一致；`rerunNode` 复用 `run.outline`，变体信息天然保留。

## 历史任务回看

流水线到达终态后，整份 `RunSnapshot` 落盘到 `data/runs/{runId}.json`，进程重启后仍可完整回看。

**批次模型**

- 多版模式一次点击创建的 3 个 run 共用同一个 `batchId`（前端生成）；单次模式的 `batchId` 等于 `runId`
- `GET /api/history` 读目录、按 `batchId` 聚合，按批次创建时间倒序返回最近 5 个批次
- 超出时整批淘汰，不会出现同一批次只剩部分版本
- 批次标题按选题是否相同区分：多版模式同一选题显示选题本身，批量选题模式显示「N 个选题」，版本按钮各自显示所属选题（悬停可看完整列表）

**为什么不用 localStorage**

前端存 runId 只能救「刷新页面」，救不了「进程重启」——`globalThis` 上的 Map 会清空。实际使用中主要场景恰恰是隔天再打开，所以必须服务端落盘。

**只记终态**

| 状态 | 是否落盘 | 原因 |
|---|---|---|
| `completed` / `failed` | 是 | 完整产出或完整失败报告都有复盘价值 |
| `aborted` | 否 | 内容不完整，进历史会误导 |
| `running` | 否 | 尚未收敛 |

**接口**

| 接口 | 说明 |
|---|---|
| `GET /api/history` | 最近 5 个批次的回看摘要（批次 → 版本列表） |
| `GET /api/run/[runId]` | 先查内存，未命中回退读 `data/runs/`，返回结构不变 |

**前端回看态**

点击历史版本后回填结果区，顶部显示「历史回看」横幅；隐藏单节点重跑入口，不建立 SSE 连接。点「退出回看」或切换模式恢复到空态。

**边界**

- 写盘失败只 `console.error`，不影响流水线结果
- 部署到 Vercel 等只读环境时该功能自动降级为不可用
- 落盘内容是完整文本，单条约 10–40 KB，5 批上限下磁盘占用可忽略

## 平台风格模板库

原先三个渠道的写作风格硬编码在各自 Agent 的 system prompt 里，用户想换文风只能改代码。本轮把「文风」抽成可管理的运行时输入：提纲决定写什么，风格模板决定怎么写。

**数据模型（`lib/styles.ts`）**

- `StyleChannel = "longform" | "script" | "xhs"`，一个渠道对应一个下游文本节点
- `StyleTemplate { id, channel, name, summary, prompt, builtin, createdAt, updatedAt }`
- `prompt` 是「文风 / 格式 / 排版 / 标签」的自然语言描述，只作为提示词内容，不参与任何逻辑判断
- 内置 6 套模板（每渠道 2 套）写在代码里，永远可用；`builtin: true` 只读，可「复制为自定义模板」后再改

**存储与接口**

自定义模板落盘 `data/styles.json`，与历史快照同一套容错思路：写盘失败只记日志，不影响流水线。

| 接口 | 说明 |
|---|---|
| `GET /api/styles` | 内置 + 自定义全量列表，前端按渠道过滤 |
| `POST /api/styles` | 新建自定义模板 |
| `PUT /api/styles/[id]` | 编辑自定义模板，内置模板返回 403 |
| `DELETE /api/styles/[id]` | 删除自定义模板，内置模板返回 403 |

校验规则：名称 ≤ 24 字、说明 ≤ 60 字、内容 ≤ 2000 字、渠道必须合法、同渠道不允许重名、自定义模板上限 30 套。

**注入路径**

```
page.tsx (styles: { channel: templateId })
  → POST /api/run（resolveStyles 解析成快照，模板不存在或渠道不符返回 400）
  → createRun(topic, variant, batchId, styles) 存入 RunState.styles
  → runTextNode(..., styles[channel])
  → buildSectionInput：选题 + 专属提纲 + 风格块
```

风格块放在入参末尾，并明确「与默认写作习惯冲突时以模板为准」，避免 Agent 自身的 system prompt 与模板各说各话。

**为什么存快照而不是存 id**

模板随时可能被编辑或删除，但已经跑完的任务必须能解释「当时用的哪套文风」。所以 `RunState.styles` 存 `{ id, name, prompt }` 快照，节点上再存 `{ id, name }` 供卡片徽标与报告展示；历史回看读的是落盘快照，不受模板后续变动影响。单节点重跑复用同一份快照。

**前端**

- header「风格模板」按钮 → 三栏面板（公众号 / 短视频 / 小红书），支持新建、编辑、删除、复制
- 运行控制台三个下拉，分别对应三个下游 Agent；运行中锁定，随 run 快照落盘
- 卡片标题下显示「风格 · xxx」徽标，执行报告新增「文风」列

## 技术架构

```
┌─────────────────────────────────────────────────────┐
│ 前端看板 (Next.js + React，卡片网格)                  │
│ - 模式切换：单次 / 批量选题 / 多版生成                 │
│ - 卡片区：策划卡（整行）+ 4 张内容卡（一行四列）        │
│ - 状态：pending / running / completed / failed        │
│ - 控制：开始、全部中断、单节点中断/重跑、折叠展开       │
│ - 批量：进度条 + 任务 tabs                            │
└──────────────────────┬──────────────────────────────┘
                       │ SSE 单向流式推送
                       ▼
┌─────────────────────────────────────────────────────┐
│ 后端 API (Next.js API Routes)                        │
│ POST /api/run            启动流水线，返回 runId        │
│ POST /api/stop/:runId    中断全部；?nodeId= 单节点中断 │
│ POST /api/rerun/:nodeId  重跑单个节点                  │
│ GET  /api/stream/:runId  SSE：全量快照 + 增量事件       │
│ GET  /api/run/:runId     一次性取快照与执行报告          │
│ GET  /api/styles         风格模板列表；POST/PUT/DELETE 管理 │
└──────────────────────┬──────────────────────────────┘
                       ▼
┌─────────────────────────────────────────────────────┐
│ 编排引擎（自研，不依赖 LangGraph）                     │
│ Run 状态机：                                          │
│   1. 执行策划 Agent                                   │
│   2. 策划完成后，并行启动 4 个内容 Agent                │
│   3. 每个 Agent 流式推送内容到前端                      │
│   4. 支持中断（AbortController）和单节点重跑            │
│   5. 节点级指标采集 + 终态生成执行报告                  │
└──────────────────────┬──────────────────────────────┘
                       ▼
┌─────────────────────────────────────────────────────┐
│ Agent 层（共享基类，不同 prompt + 模型）               │
│ base.ts → 通用调用逻辑、流式、AbortSignal              │
│ planner.ts / longform.ts / script.ts / xhs.ts / image.ts│
└─────────────────────────────────────────────────────┘
```

## 关键设计决策

1. **编排引擎自研**：场景是固定的「策划 → 4 路并行」，不需要 LangGraph 的条件分支能力，自研状态机更轻量、更易讲解。
2. **SSE 而非 WebSocket**：只需要后端向前端单向推送状态和内容，SSE 足够且更简单。断连重连用「全量快照收敛」而不是事件重放：服务端在每次连接建立时下发 snapshot，终态写回 `RunState`，所以连到已结束的 run 也能立刻拿到 summary 和 report；事件带自增 id 仅用于排查时序，不处理 `Last-Event-ID`。
3. **看板用卡片网格，不用节点画布**：曾尝试 React Flow 做节点画布，实测否决——4 个内容节点摆成 2×2 会暗示「长文 → 脚本 → 小红书 → 配图」的先后顺序，而它们实际完全并行，布局在误导架构；拖拽时画布平移还会抢走节点拖拽事件。改为「策划卡整行 + 4 张内容卡一行四列」，同样表达 1 上游 + 4 并行，且更省空间。
4. **结果卡片默认折叠，运行时自动展开**：默认折叠让看板紧凑，但节点开始运行时必须自动展开——否则 4 个 Agent 并行流式吐字这个核心能力在界面上看不见。展开态内容区固定 `max-h` + `overflow-auto`，滚动限制在卡片内，不让页面高度暴涨。
5. **中断逻辑**：每个 Node 单独持有独立的 AbortController，不共用全局 signal；abort 只切断 LLM 流式请求，不清空 node.content。具体规则：
   - **全局中断（策划阶段）**：策划节点停止生成，已输出内容保留并标记为 `cancelled`；4 个后置节点状态标记为 `cancelled`，不再启动。
   - **全局中断（并行阶段）**：策划节点已完成保持不动；已完成的节点内容保留不动；正在流式输出的节点立刻停止拉取新 token、已生成文字保留；还没启动的 pending 节点标记为 cancelled，不再启动。
   - **单节点中断**：仅指定节点停止生成、已有内容保留；策划及其他所有节点不受影响，正常跑、内容保留；其他 pending 节点继续正常调度执行。
6. **执行报告随快照落盘**：报告由 `buildRunReport` 在内存中生成，写回 `RunState.report`，随 `run:done` 下发，并可通过 `GET /api/run/[runId]` 取。最初只在内存保留、不写文件；新增历史回看后改为随快照落到 `data/runs/`——内存态在进程重启后必然丢失，而「隔天打开看上一轮结果」正是回看的主要场景。该目录已加入 `.gitignore`，不污染仓库；写盘失败只记日志，不影响流水线。报告里刻意保留 `hasEstimated` 标记：服务端没返回 usage 时宁可标注「估算」，也不把估算值当真实值展示。
7. **并行加速比作为架构价值的量化指标**：报告不只列各节点耗时，还计算「4 路串行耗时之和 ÷ 实际墙钟时间」。这是唯一能用一个数字说明「多 Agent 并行」比单线程串行快多少的地方。
8. **历史记录按批次限流，而不是按 run**：多版模式一次点击产出的 3 个 run 属于同一个 `batchId`。若按 run 限 5 条，两批就把名额吃光；按批次限 5 个，回看时也正好是「一批 3 个版本」的对比单元。淘汰时整批删除，不会出现同批只剩一半版本。
9. **风格模板按 run 存快照，而不是只存模板 id**：模板可编辑可删除，历史任务却需要长期可解释。存 `{ id, name, prompt }` 后，模板后续怎么变都不影响已完成的 run，回看时能还原当时的完整入参。代价是快照体积增加约 1 KB/渠道，相对于正文可忽略。
10. **内置模板只读，改内置走「复制」**：允许直接编辑内置模板会导致演示环境的默认文风被改坏且无法回到初始状态。只读 + 复制既保证默认可用，又保留了自定义空间；存储层同时兜底，即使手改 `data/styles.json` 把 `builtin` 改成 true 也会被强制改回 false。

## 模块职责

| 模块 | 文件 | 职责 |
|---|---|---|
| 看板页面 | app/page.tsx | 三种模式、卡片网格、SSE 接入与重连、折叠/进度条、导出、执行报告展示 |
| 创作维度定义 | lib/variants.ts | 三个变体的名称、定位、结构骨架（纯数据，前后端共用） |
| 启动接口 | app/api/run/route.ts | 创建 run（可选 variant / batchId），启动编排 |
| 流接口 | app/api/stream/[runId]/route.ts | SSE：连接即下发全量快照，之后推增量事件，15s 心跳保活 |
| 快照接口 | app/api/run/[runId]/route.ts | 一次性返回全量快照与执行报告；内存未命中时回退读落盘文件 |
| 历史列表 | app/api/history/route.ts | 返回最近 5 个批次的回看摘要 |
| 中断接口 | app/api/stop/[runId]/route.ts | 中断全部；带 nodeId 则只中断指定节点 |
| 重跑接口 | app/api/rerun/[nodeId]/route.ts | 重跑单节点 |
| 编排引擎 | lib/orchestrator.ts | 状态机、并行调度、中断/重跑、节点指标采集、终态收尾 |
| 执行报告 | lib/report.ts | 报告模型与生成逻辑（耗时、token、重试、并行加速比），纯函数无副作用 |
| Agent 基类 | lib/agents/base.ts | 模型调用、流式、AbortSignal、usage 回调透传 |
| 各 Agent | lib/agents/*.ts | 各自 prompt + 模型配置 |
| 模型封装 | lib/llm.ts | 统一 API 调用，解析 usage |
| 图像封装 | lib/image.ts | 文生图接口调用（Seedream），返回 base64 后落地到 `public/generated/` |
| 图片存储 | public/generated/ | 出图产物本地持久化，前端以 `/generated/xxx.png` 引用（仅本地可用，Vercel 只读环境不可写） |
| 历史快照 | lib/history.ts | 终态快照落盘、按批次聚合、保留最近 5 批并整批淘汰 |
| 历史数据目录 | data/runs/ | 终态 run 的完整快照，已加入 `.gitignore` |
| 风格模板定义 | lib/styles.ts | 渠道定义、6 套内置模板、入参校验、风格块拼装（纯数据，前后端共用） |
| 风格模板存储 | lib/style-store.ts | 自定义模板读写 `data/styles.json`，内置只读保护，run 创建时解析快照 |
| 风格模板接口 | app/api/styles/ | 模板列表、新建、编辑、删除；内置模板 403 |
| 自定义模板目录 | data/styles.json | 用户保存的文风模板，已加入 `.gitignore` |
