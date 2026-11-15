import { PlannerAgent } from "./agents/planner";
import { LongformAgent } from "./agents/longform";
import { ScriptAgent } from "./agents/script";
import { XhsAgent } from "./agents/xhs";
import { ImageAgent } from "./agents/image";
import type { VariantKey } from "./variants";
import { buildStyleBlock, type StyleChannel, type StyleSnapshot } from "./styles";
import type { TokenUsage } from "./llm";
import { addUsage, buildRunReport, estimateTokens, type RunReport } from "./report";
import { saveRunSnapshot } from "./history";
import { diffOutlineChannels, outlineSection } from "./outline-diff";

/**
 * 编排引擎
 *
 * 流水线：选题 → 策划 Agent → [长文, 脚本, 小红书, 配图] 4 路并行
 *
 * 职责：
 * - 维护 Run 状态（内存态，单机演示够用）
 * - 策划节点做 JSON 语法校验，失败自动重试 1 次
 * - 4 个后置节点并行调度，互相独立
 * - 每个节点独立 AbortController，支持全局中断、单节点中断、单节点重跑
 *
 * 不处理 HTTP 和 SSE 编码，那是接口层的事。这里只管状态和事件回调。
 */

export type NodeId = "planner" | "longform" | "script" | "xhs" | "image";

export type NodeStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type RunStatus = "running" | "completed" | "failed" | "aborted";

export interface AgentNodeState {
  id: NodeId;
  name: string;
  status: NodeStatus;
  /** 流式累积的文本；配图节点这里是扩写出来的提示词 */
  content: string;
  /** 配图节点专用：出图后的图片地址 */
  imageUrl?: string;
  error?: string;
  /** 第几次尝试，策划重试时会变成 2 */
  attempt: number;
  /** 该节点使用的模型，未启动时为空 */
  model?: string;
  /** 该节点采用的文风模板；只有下游三个文本节点会有值 */
  style?: { id: string; name: string };
  /** 执行指标；节点未启动过则为空 */
  metrics?: NodeMetrics;
}

/** 单个节点的执行指标，报告的数据来源 */
export interface NodeMetrics {
  /** 首次开始时间，重试不覆盖 */
  startedAt: number;
  endedAt?: number;
  /** 从首次开始到最终结束的总耗时，包含重试 */
  durationMs?: number;
  /** 该节点所有尝试累加后的 token 用量 */
  usage?: TokenUsage;
  /** true 表示用量是按字符估算的 */
  usageEstimated?: boolean;
  /** 自动重试次数 */
  retries: number;
}

export interface RunSummary {
  completed: number;
  failed: number;
  cancelled: number;
  pending: number;
}

/** 一份提纲版本记录，支持人工编辑与历史回退 */
export interface OutlineVersion {
  id: string;
  /** 展示用标签：策划原始 / 手动编辑 */
  label: string;
  source: "planner" | "manual";
  createdAt: number;
  outline: unknown;
  /** 该版本提交时实际重跑的渠道，用于前端区分多次「手动编辑」；策划原始版本没有 */
  affected?: NodeId[];
}

/**
 * 全量快照。
 *
 * 断线重连时只下发这一个对象就能完全收敛前端状态，
 * 不需要回放历史事件：节点内容、执行指标、终态摘要、报告全在里面。
 */
export interface RunSnapshot {
  runId: string;
  topic: string;
  variant: VariantKey | null;
  /** 本 run 选用的文风模板快照，按渠道存 */
  styles: Partial<Record<StyleChannel, StyleSnapshot>>;
  /** 本次 run 保存的全部提纲版本，按创建顺序排列 */
  outlineVersions: OutlineVersion[];
  /** 当前生效的提纲版本 id；策划未完成时为 null */
  outlineVersionId: string | null;
  status: RunStatus;
  createdAt: number;
  finishedAt: number | null;
  nodes: Record<NodeId, AgentNodeState>;
  /** 终态才有值，运行中为 null */
  summary: RunSummary | null;
  report: RunReport | null;
}

export type StreamEvent =
  | { type: "snapshot"; snapshot: RunSnapshot }
  | { type: "node:start"; nodeId: NodeId; name: string; model: string; attempt: number }
  | { type: "node:token"; nodeId: NodeId; text: string }
  | { type: "node:image"; nodeId: NodeId; url: string; prompt: string }
  | { type: "node:done"; nodeId: NodeId }
  | { type: "node:error"; nodeId: NodeId; message: string }
  | { type: "node:cancelled"; nodeId: NodeId }
  | { type: "run:done"; summary: RunSummary; report: RunReport | null }
  | { type: "run:failed"; message: string; summary: RunSummary | null; report: RunReport | null };

export interface RunState {
  id: string;
  topic: string;
  /** 多版模式的创作维度；单次模式不传，策划按通用提纲生成 */
  variant: VariantKey | null;
  /** 下游三个内容 Agent 各自选用的文风模板快照 */
  styles: Partial<Record<StyleChannel, StyleSnapshot>>;
  /** 批次标识：多版模式一次点击产生的多个 run 共享同一批次，用于历史分组 */
  batchId: string;
  status: RunStatus;
  nodes: Record<NodeId, AgentNodeState>;
  /** 策划解析成功后的提纲对象，单节点重跑时复用 */
  outline: unknown | null;
  /** 本次 run 的提纲版本链，人工编辑与回退都在这条链上操作 */
  outlineVersions: OutlineVersion[];
  /** 当前生效的提纲版本 */
  activeOutlineVersionId: string | null;
  subscribers: Set<(event: StreamEvent) => void>;
  /** 每个节点独立的中断控制器 */
  controllers: Map<NodeId, AbortController>;
  createdAt: number;
  /** 进入终态的时间；单节点重跑时清空 */
  finishedAt: number | null;
  /** 终态摘要，写回状态让重连也能拿到 */
  summary: RunSummary | null;
  /** 执行报告，流水线结束时生成；单节点重跑时作废 */
  report: RunReport | null;
}

export const NODE_IDS: NodeId[] = ["planner", "longform", "script", "xhs", "image"];

export const NODE_NAMES: Record<NodeId, string> = {
  planner: "策划 Agent",
  longform: "长文 Agent",
  script: "脚本 Agent",
  xhs: "小红书 Agent",
  image: "配图 Agent",
};

/** 所有节点统一策略：首次 + 自动重试 1 次 */
const MAX_ATTEMPTS = 2;

/**
 * 用 globalThis 存运行态，避免 dev 热更新导致模块重新加载后状态丢失。
 */
const globalStore = globalThis as unknown as {
  __contentAgentRuns?: Map<string, RunState>;
};
const runs: Map<string, RunState> = (globalStore.__contentAgentRuns ??= new Map());

function initNodes(): Record<NodeId, AgentNodeState> {
  const nodes = {} as Record<NodeId, AgentNodeState>;
  for (const id of NODE_IDS) {
    nodes[id] = {
      id,
      name: NODE_NAMES[id],
      status: "pending",
      content: "",
      attempt: 0,
    };
  }
  return nodes;
}

function cloneNodes(run: RunState): Record<NodeId, AgentNodeState> {
  const out = {} as Record<NodeId, AgentNodeState>;
  for (const id of NODE_IDS) {
    out[id] = { ...run.nodes[id] };
  }
  return out;
}

function emit(run: RunState, event: StreamEvent) {
  for (const subscriber of run.subscribers) {
    try {
      subscriber(event);
    } catch {
      // 单个订阅者异常不影响编排
    }
  }
}

/** 创建一次运行，不启动，由调用方决定何时 startRun */
export function createRun(
  topic: string,
  variant?: VariantKey,
  batchId?: string,
  styles?: Partial<Record<StyleChannel, StyleSnapshot>>,
): RunState {
  const id = crypto.randomUUID();
  const run: RunState = {
    id,
    topic,
    variant: variant ?? null,
    styles: styles ?? {},
    batchId: batchId ?? id,
    status: "running",
    nodes: initNodes(),
    outline: null,
    outlineVersions: [],
    activeOutlineVersionId: null,
    subscribers: new Set(),
    controllers: new Map(),
    createdAt: Date.now(),
    finishedAt: null,
    summary: null,
    report: null,
  };
  runs.set(run.id, run);
  return run;
}

export function getRun(runId: string): RunState | undefined {
  return runs.get(runId);
}

/**
 * 把落盘快照重新装回内存，供「历史批次继续迭代」和刷新后恢复使用。
 *
 * 只回灌状态，不启动任何节点：恢复出来的 run 停留在快照里的终态，
 * 用户编辑提纲后走 regenerateFromOutline 才会真正重跑受影响的渠道。
 * 已在内存里的 run 直接复用，保证重复调用是幂等的。
 */
export function resumeRun(
  snapshot: RunSnapshot & { batchId?: string },
): RunState {
  const existing = runs.get(snapshot.runId);
  if (existing) return existing;

  const versions = snapshot.outlineVersions ?? [];
  const activeVersion =
    versions.find((item) => item.id === snapshot.outlineVersionId) ??
    versions[versions.length - 1];

  const run: RunState = {
    id: snapshot.runId,
    topic: snapshot.topic,
    variant: snapshot.variant,
    styles: snapshot.styles ?? {},
    batchId: snapshot.batchId ?? snapshot.runId,
    status: snapshot.status,
    // 快照里的节点与内存中的运行态不能共用引用，否则后续重跑会改到历史对象
    nodes: structuredClone(snapshot.nodes),
    outline: activeVersion?.outline ?? null,
    outlineVersions: structuredClone(versions),
    activeOutlineVersionId: activeVersion?.id ?? null,
    subscribers: new Set(),
    controllers: new Map(),
    createdAt: snapshot.createdAt,
    finishedAt: snapshot.finishedAt,
    summary: snapshot.summary,
    report: snapshot.report,
  };
  runs.set(run.id, run);
  return run;
}

/**
 * 订阅事件。订阅瞬间先推一个全量 snapshot，
 * 之后只推增量事件。这样前端断线重连不需要回放成千上万个 token 事件。
 */
export function subscribe(
  runId: string,
  onEvent: (event: StreamEvent) => void,
): (() => void) | null {
  const run = runs.get(runId);
  if (!run) return null;

  onEvent({ type: "snapshot", snapshot: buildSnapshot(run) });
  run.subscribers.add(onEvent);

  return () => {
    run.subscribers.delete(onEvent);
  };
}

/** 组装全量快照，供重连和 GET 接口复用 */
export function buildSnapshot(run: RunState): RunSnapshot {
  return {
    runId: run.id,
    topic: run.topic,
    variant: run.variant,
    styles: run.styles,
    outlineVersions: run.outlineVersions,
    outlineVersionId: run.activeOutlineVersionId,
    status: run.status,
    createdAt: run.createdAt,
    finishedAt: run.finishedAt,
    nodes: cloneNodes(run),
    summary: run.summary,
    report: run.report,
  };
}

export function startRun(runId: string): void {
  const run = runs.get(runId);
  if (!run) return;
  void execute(run);
}

function summarize(run: RunState): RunSummary {
  const summary: RunSummary = { completed: 0, failed: 0, cancelled: 0, pending: 0 };
  for (const id of NODE_IDS) {
    const status = run.nodes[id].status;
    if (status === "completed") summary.completed += 1;
    else if (status === "failed") summary.failed += 1;
    else if (status === "cancelled") summary.cancelled += 1;
    else if (status === "pending") summary.pending += 1;
  }
  return summary;
}

async function execute(run: RunState): Promise<void> {
  const plannerOk = await runPlanner(run);

  if (!plannerOk) {
    // 策划失败时已经发过 run:failed；被中断时在这里补收尾
    if (run.status === "aborted") finishRun(run, "aborted");
    return;
  }

  await runDownstream(run, DOWNSTREAM_NODE_IDS);
}

/**
 * 用函数读取中断状态。
 *
 * 直接写 run.status === "aborted" 会被 TS 控制流收窄：函数开头判过一次之后，
 * 循环里再判就会被认为不可能成立，而实际上中断可能发生在任意 await 之间。
 */
function isAborted(run: RunState): boolean {
  return run.status === "aborted";
}

/** 结束节点计时。重试期间 startedAt 不变，所以耗时可覆盖多次尝试 */
function endMetrics(node: AgentNodeState): void {
  const m = node.metrics;
  if (!m || m.endedAt) return;
  m.endedAt = Date.now();
  m.durationMs = Math.max(0, m.endedAt - m.startedAt);
}

/**
 * 服务端没返回 usage 时按字符估算，并打上 estimated 标记。
 * 只有真正调用过模型（有 metrics）的节点才估，避免给未启动的节点编数字。
 */
function ensureUsage(node: AgentNodeState, input: string): void {
  const m = node.metrics;
  if (!m || m.usage) return;
  const promptTokens = estimateTokens(input);
  const completionTokens = estimateTokens(node.content);
  m.usage = {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
  };
  m.usageEstimated = true;
}

function composeReport(run: RunState): RunReport {
  const finishedAt = run.finishedAt ?? Date.now();
  return buildRunReport({
    runId: run.id,
    topic: run.topic,
    variant: run.variant,
    status: run.status,
    createdAt: run.createdAt,
    finishedAt,
    nodes: NODE_IDS.map((id) => run.nodes[id]),
  });
}

/**
 * 统一收尾：终态写回状态并生成报告，再广播 run:done。
 *
 * 报告必须落在 RunState 上，否则断线期间结束的 run 重连后只剩节点状态，
 * 前端既拿不到 summary 也拿不到报告。
 */
function finishRun(run: RunState, status: RunStatus): void {
  run.status = status;
  run.finishedAt = Date.now();
  run.summary = summarize(run);
  run.report = composeReport(run);
  // 异步落盘，不阻塞 SSE 收尾；写盘失败只记日志。
  // 主动中断的 run 内容不完整，不进历史，避免回看时被半成品误导。
  if (status !== "aborted") {
    void saveRunSnapshot(buildSnapshot(run), run.batchId);
  }
  emit(run, { type: "run:done", summary: run.summary, report: run.report });
}

function failRun(run: RunState, message: string): void {
  run.status = "failed";
  run.finishedAt = Date.now();
  run.summary = summarize(run);
  run.report = composeReport(run);
  void saveRunSnapshot(buildSnapshot(run), run.batchId);
  emit(run, {
    type: "run:failed",
    message,
    summary: run.summary,
    report: run.report,
  });
}

/**
 * 只有网络抖动、超时、限流、服务端 5xx 值得重试。
 * 4xx（除 408/429）说明请求本身有问题，重试只会重复失败。
 */
function isRetryable(err: unknown): boolean {
  if (!(err instanceof Error)) return true;
  if (err.name === "AbortError") return false;
  const match = /模型调用失败 (\d{3})/.exec(err.message);
  if (match) {
    const status = Number(match[1]);
    return status === 408 || status === 429 || status >= 500;
  }
  // 没有状态码说明是网络层异常，重试通常有效
  return true;
}

/**
 * 策划节点：执行 → JSON.parse → 失败自动重试 1 次。
 * 返回 true 表示拿到了合法 JSON 提纲，可以启动下游。
 */
async function runPlanner(run: RunState): Promise<boolean> {
  const node = run.nodes.planner;
  const agent = new PlannerAgent(run.variant ?? undefined);
  const input = `选题：${run.topic}`;

  const metrics: NodeMetrics = { startedAt: Date.now(), retries: 0 };
  node.metrics = metrics;
  node.model = agent.modelId;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (run.status === "aborted") return false;

    node.status = "running";
    node.content = "";
    node.error = undefined;
    node.attempt = attempt;
    metrics.retries = attempt - 1;

    const controller = new AbortController();
    run.controllers.set("planner", controller);
    emit(run, {
      type: "node:start",
      nodeId: "planner",
      name: agent.name,
      model: agent.modelId,
      attempt,
    });

    let text = "";
    try {
      text = await agent.run(input, {
        signal: controller.signal,
        onToken: (token) => {
          node.content += token;
          emit(run, { type: "node:token", nodeId: "planner", text: token });
        },
        onUsage: (usage) => {
          metrics.usage = addUsage(metrics.usage, usage);
        },
      });
    } catch (err) {
      run.controllers.delete("planner");

      if (err instanceof Error && err.name === "AbortError") {
        node.status = "cancelled";
        ensureUsage(node, input);
        endMetrics(node);
        emit(run, { type: "node:cancelled", nodeId: "planner" });
        return false;
      }

      // 可重试的网络类错误，且还有次数：直接进入下一轮
      if (attempt < MAX_ATTEMPTS && isRetryable(err)) continue;

      node.status = "failed";
      node.error = err instanceof Error ? err.message : String(err);
      ensureUsage(node, input);
      endMetrics(node);
      emit(run, { type: "node:error", nodeId: "planner", message: node.error });
      failRun(run, "策划 Agent 调用失败，无法继续生成内容");
      return false;
    }

    run.controllers.delete("planner");

    try {
      const parsedOutline = JSON.parse(text.trim());
      run.outline = parsedOutline;
      // 策划原始提纲作为版本链起点，之后的人工编辑都在这条链上追加
      const version: OutlineVersion = {
        id: "v1",
        label: "策划原始",
        source: "planner",
        createdAt: Date.now(),
        outline: parsedOutline,
      };
      run.outlineVersions = [version];
      run.activeOutlineVersionId = version.id;
      node.status = "completed";
      ensureUsage(node, input);
      endMetrics(node);
      emit(run, { type: "node:done", nodeId: "planner" });
      return true;
    } catch {
      // 语法非法，进入下一轮重试；已是最后一轮则判定失败
      if (attempt >= MAX_ATTEMPTS) {
        node.status = "failed";
        node.error = "JSON 解析失败（已重试1次）";
        ensureUsage(node, input);
        endMetrics(node);
        emit(run, { type: "node:error", nodeId: "planner", message: node.error });
        failRun(run, "策划提纲生成失败，无法继续生成内容");
        return false;
      }
    }
  }

  return false;
}

/** 从策划提纲里取某个渠道的片段，取不到就返回 null，交给 Agent 自行发挥 */
function getSection(run: RunState, key: string): unknown {
  return outlineSection(run.outline, key);
}

function buildSectionInput(
  topic: string,
  section: unknown,
  style?: StyleSnapshot,
): string {
  const body = section
    ? JSON.stringify(section, null, 2)
    : "（策划未提供该渠道的提纲，请根据选题自行发挥）";
  const base = `选题：${topic}\n\n专属提纲：\n${body}`;
  return style ? `${base}${buildStyleBlock(style)}` : base;
}

const DOWNSTREAM_NODE_IDS: NodeId[] = ["longform", "script", "xhs", "image"];

/**
 * 跑指定的下游节点，全部结束后统一收尾。
 *
 * 正常流水线传 4 个节点；基于提纲重生成时只传受影响的渠道，
 * 未传入的节点保持原有产出与指标不动。
 */
async function runDownstream(run: RunState, nodeIds: NodeId[]): Promise<void> {
  const tasks: Promise<void>[] = [];
  for (const nodeId of nodeIds) {
    if (nodeId === "longform") {
      tasks.push(
        runTextNode(
          run,
          "longform",
          new LongformAgent(),
          getSection(run, "longForm"),
          run.styles.longform,
        ),
      );
    } else if (nodeId === "script") {
      tasks.push(
        runTextNode(
          run,
          "script",
          new ScriptAgent(),
          getSection(run, "script"),
          run.styles.script,
        ),
      );
    } else if (nodeId === "xhs") {
      tasks.push(
        runTextNode(run, "xhs", new XhsAgent(), getSection(run, "xhs"), run.styles.xhs),
      );
    } else if (nodeId === "image") {
      tasks.push(runImageNode(run, getSection(run, "image")));
    }
  }

  await Promise.allSettled(tasks);

  const status: RunStatus =
    run.status === "aborted"
      ? "aborted"
      : summarize(run).failed > 0
        ? "failed"
        : "completed";
  finishRun(run, status);
}

interface TextCapableAgent {
  readonly name: string;
  readonly modelId: string;
  run(
    input: string,
    options: {
      signal?: AbortSignal;
      onToken?: (token: string) => void;
      onUsage?: (usage: TokenUsage) => void;
    },
  ): Promise<string>;
}

async function runTextNode(
  run: RunState,
  nodeId: NodeId,
  agent: TextCapableAgent,
  section: unknown,
  style?: StyleSnapshot,
): Promise<void> {
  const node = run.nodes[nodeId];
  const input = buildSectionInput(run.topic, section, style);

  // 用户在调度前已经取消了这个节点（比如策划阶段就中断了 xhs），不再启动
  if (node.status === "cancelled") return;

  // 全局中断发生在调度之前，直接标记为已取消，不发起调用
  if (run.status === "aborted") {
    node.status = "cancelled";
    emit(run, { type: "node:cancelled", nodeId });
    return;
  }

  // 文风快照只用于界面展示与历史回看，真正约束模型的内容在 input 里
  node.style = style ? { id: style.id, name: style.name } : undefined;

  const metrics: NodeMetrics = { startedAt: Date.now(), retries: 0 };
  node.metrics = metrics;
  node.model = agent.modelId;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (isAborted(run)) {
      node.status = "cancelled";
      endMetrics(node);
      emit(run, { type: "node:cancelled", nodeId });
      return;
    }

    node.status = "running";
    node.content = "";
    node.error = undefined;
    node.attempt = attempt;
    metrics.retries = attempt - 1;

    const controller = new AbortController();
    run.controllers.set(nodeId, controller);
    emit(run, {
      type: "node:start",
      nodeId,
      name: agent.name,
      model: agent.modelId,
      attempt,
    });

    try {
      await agent.run(input, {
        signal: controller.signal,
        onToken: (token) => {
          node.content += token;
          emit(run, { type: "node:token", nodeId, text: token });
        },
        onUsage: (usage) => {
          metrics.usage = addUsage(metrics.usage, usage);
        },
      });

      node.status = "completed";
      ensureUsage(node, input);
      endMetrics(node);
      emit(run, { type: "node:done", nodeId });
      return;
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        node.status = "cancelled";
        ensureUsage(node, input);
        endMetrics(node);
        emit(run, { type: "node:cancelled", nodeId });
        return;
      }

      // 网络类错误自动重试一次，失败的那次也算 token 消耗
      if (attempt < MAX_ATTEMPTS && isRetryable(err)) continue;

      node.status = "failed";
      node.error = err instanceof Error ? err.message : String(err);
      ensureUsage(node, input);
      endMetrics(node);
      emit(run, { type: "node:error", nodeId, message: node.error });
      return;
    } finally {
      run.controllers.delete(nodeId);
    }
  }
}

async function runImageNode(run: RunState, section: unknown): Promise<void> {
  const nodeId: NodeId = "image";
  const node = run.nodes.image;
  const agent = new ImageAgent();
  const input = buildSectionInput(run.topic, section);

  // 用户在调度前已经取消了这个节点，不再启动
  if (node.status === "cancelled") return;

  if (run.status === "aborted") {
    node.status = "cancelled";
    emit(run, { type: "node:cancelled", nodeId });
    return;
  }

  const metrics: NodeMetrics = { startedAt: Date.now(), retries: 0 };
  node.metrics = metrics;
  node.model = agent.modelId;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (isAborted(run)) {
      node.status = "cancelled";
      endMetrics(node);
      emit(run, { type: "node:cancelled", nodeId });
      return;
    }

    node.status = "running";
    node.content = "";
    node.imageUrl = undefined;
    node.error = undefined;
    node.attempt = attempt;
    metrics.retries = attempt - 1;

    const controller = new AbortController();
    run.controllers.set(nodeId, controller);
    emit(run, {
      type: "node:start",
      nodeId,
      name: agent.name,
      model: agent.modelId,
      attempt,
    });

    try {
      const { prompt, imageUrl } = await agent.generate(input, {
        signal: controller.signal,
        onToken: (token) => {
          node.content += token;
          emit(run, { type: "node:token", nodeId, text: token });
        },
        onUsage: (usage) => {
          metrics.usage = addUsage(metrics.usage, usage);
        },
      });

      node.imageUrl = imageUrl;
      node.status = "completed";
      ensureUsage(node, input);
      endMetrics(node);
      emit(run, { type: "node:image", nodeId, url: imageUrl, prompt });
      emit(run, { type: "node:done", nodeId });
      return;
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        node.status = "cancelled";
        ensureUsage(node, input);
        endMetrics(node);
        emit(run, { type: "node:cancelled", nodeId });
        return;
      }

      if (attempt < MAX_ATTEMPTS && isRetryable(err)) continue;

      node.status = "failed";
      node.error = err instanceof Error ? err.message : String(err);
      ensureUsage(node, input);
      endMetrics(node);
      emit(run, { type: "node:error", nodeId, message: node.error });
      return;
    } finally {
      run.controllers.delete(nodeId);
    }
  }
}

/**
 * 中断。
 * - 传 nodeId：只中断该节点。running 的切断流式请求，pending 的直接标 cancelled。
 * - 不传 nodeId：全局中断。running 的全部切断，pending 的全部标 cancelled。
 *
 * abort 只切断 LLM 请求，不清空已生成的 content。
 */
export function stopRun(runId: string, nodeId?: NodeId): boolean {
  const run = runs.get(runId);
  if (!run) return false;

  if (nodeId) {
    const node = run.nodes[nodeId];
    if (!node) return false;
    if (node.status === "completed" || node.status === "failed" || node.status === "cancelled") {
      return false;
    }

    if (node.status === "running") {
      run.controllers.get(nodeId)?.abort();
    } else {
      node.status = "cancelled";
      emit(run, { type: "node:cancelled", nodeId });
    }
    return true;
  }

  if (run.status === "running") {
    run.status = "aborted";
  }

  for (const id of NODE_IDS) {
    const node = run.nodes[id];
    if (node.status === "running") {
      run.controllers.get(id)?.abort();
    } else if (node.status === "pending") {
      node.status = "cancelled";
      emit(run, { type: "node:cancelled", nodeId: id });
    }
  }

  return true;
}

/** 把节点重置成待跑状态；旧的耗时与用量属于上一轮，重跑要清掉 */
function resetNode(node: AgentNodeState): void {
  node.status = "pending";
  node.content = "";
  node.imageUrl = undefined;
  node.error = undefined;
  node.attempt = 0;
  node.metrics = undefined;
}

/**
 * 单节点重跑。
 *
 * 只支持 4 个后置节点；策划不支持重跑。
 * 重跑复用 run.outline，不重新调用策划 Agent。
 */
export function rerunNode(runId: string, nodeId: NodeId): boolean {
  const run = runs.get(runId);
  if (!run) return false;

  if (nodeId === "planner") return false;
  if (run.nodes.planner.status !== "completed" || !run.outline) return false;

  const node = run.nodes[nodeId];
  if (!node || node.status === "running") return false;

  resetNode(node);

  if (run.status === "failed" || run.status === "completed" || run.status === "aborted") {
    run.status = "running";
  }

  // 报告基于旧指标，重跑后整体作废，等下次收尾重新生成
  run.finishedAt = null;
  run.summary = null;
  run.report = null;

  if (nodeId === "image") {
    void runImageNode(run, getSection(run, "image"));
  } else if (nodeId === "longform") {
    void runTextNode(
      run,
      "longform",
      new LongformAgent(),
      getSection(run, "longForm"),
      run.styles.longform,
    );
  } else if (nodeId === "script") {
    void runTextNode(
      run,
      "script",
      new ScriptAgent(),
      getSection(run, "script"),
      run.styles.script,
    );
  } else {
    void runTextNode(
      run,
      "xhs",
      new XhsAgent(),
      getSection(run, "xhs"),
      run.styles.xhs,
    );
  }

  return true;
}

/** 人工提交的提纲长度上限，防止误粘贴超长内容 */
export const OUTLINE_MAX_CHARS = 20_000;

export interface OutlineApplyResult {
  ok: boolean;
  error?: string;
  /** 失败原因分类，接口层据此映射 HTTP 状态码 */
  code?: "not_found" | "busy" | "invalid";
  version?: OutlineVersion;
  versions?: OutlineVersion[];
  affected?: NodeId[];
}

/**
 * 基于人工编辑的提纲重生成下游。
 *
 * - 不重新执行策划 Agent，直接把提交内容换成当前生效提纲
 * - 按渠道 diff 只重置受影响的节点，其余节点产出与指标原样保留
 * - 提交内容与某个历史版本一致时直接激活该版本，回退不会产生重复版本
 */
export function regenerateFromOutline(
  runId: string,
  outline: unknown,
): OutlineApplyResult {
  const run = runs.get(runId);
  if (!run) return { ok: false, code: "not_found", error: "run 不存在或已过期" };

  if (run.nodes.planner.status !== "completed" || !run.outline) {
    return { ok: false, code: "invalid", error: "策划提纲尚未生成，无法重生成下游" };
  }

  if (
    run.status === "running" ||
    NODE_IDS.some((id) => run.nodes[id].status === "running")
  ) {
    return { ok: false, code: "busy", error: "流水线运行中，请等待当前节点结束" };
  }

  if (!outline || typeof outline !== "object" || Array.isArray(outline)) {
    return { ok: false, code: "invalid", error: "提纲必须是 JSON 对象" };
  }
  const section = (outline as { outline?: unknown }).outline;
  if (!section || typeof section !== "object" || Array.isArray(section)) {
    return { ok: false, code: "invalid", error: "提纲缺少 outline 对象" };
  }

  const serialized = JSON.stringify(outline);
  if (serialized.length > OUTLINE_MAX_CHARS) {
    return {
      ok: false,
      code: "invalid",
      error: `提纲过长（上限 ${OUTLINE_MAX_CHARS} 字符）`,
    };
  }

  const affected = diffOutlineChannels(run.outline, outline);

  if (affected.length === 0) {
    return {
      ok: false,
      code: "invalid",
      error:
        JSON.stringify(run.outline) === serialized
          ? "提纲没有变化，无需重生成下游"
          : "只改了选题：选题变化不影响四个渠道，请修改至少一个渠道的内容",
    };
  }

  let version = run.outlineVersions.find(
    (item) => JSON.stringify(item.outline) === serialized,
  );
  if (!version) {
    version = {
      id: `v${run.outlineVersions.length + 1}`,
      label: "手动编辑",
      source: "manual",
      createdAt: Date.now(),
      outline,
      affected,
    };
    run.outlineVersions.push(version);
  }

  run.outline = outline;
  run.activeOutlineVersionId = version.id;

  for (const nodeId of affected) {
    resetNode(run.nodes[nodeId]);
  }

  run.status = "running";
  run.finishedAt = null;
  run.summary = null;
  run.report = null;

  void runDownstream(run, affected);

  return {
    ok: true,
    version,
    versions: [...run.outlineVersions],
    affected,
  };
}
