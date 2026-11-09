import { PlannerAgent } from "./agents/planner";
import { LongformAgent } from "./agents/longform";
import { ScriptAgent } from "./agents/script";
import { XhsAgent } from "./agents/xhs";
import { ImageAgent } from "./agents/image";

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
}

export interface RunSummary {
  completed: number;
  failed: number;
  cancelled: number;
  pending: number;
}

export type StreamEvent =
  | { type: "snapshot"; status: RunStatus; nodes: Record<NodeId, AgentNodeState> }
  | { type: "node:start"; nodeId: NodeId; name: string; model: string; attempt: number }
  | { type: "node:token"; nodeId: NodeId; text: string }
  | { type: "node:image"; nodeId: NodeId; url: string; prompt: string }
  | { type: "node:done"; nodeId: NodeId }
  | { type: "node:error"; nodeId: NodeId; message: string }
  | { type: "node:cancelled"; nodeId: NodeId }
  | { type: "run:done"; summary: RunSummary }
  | { type: "run:failed"; message: string };

export interface RunState {
  id: string;
  topic: string;
  status: RunStatus;
  nodes: Record<NodeId, AgentNodeState>;
  /** 策划解析成功后的提纲对象，单节点重跑时复用 */
  outline: unknown | null;
  subscribers: Set<(event: StreamEvent) => void>;
  /** 每个节点独立的中断控制器 */
  controllers: Map<NodeId, AbortController>;
  createdAt: number;
}

export const NODE_IDS: NodeId[] = ["planner", "longform", "script", "xhs", "image"];

export const NODE_NAMES: Record<NodeId, string> = {
  planner: "策划 Agent",
  longform: "长文 Agent",
  script: "脚本 Agent",
  xhs: "小红书 Agent",
  image: "配图 Agent",
};

/** 首次 + 重试 1 次 */
const PLANNER_MAX_ATTEMPTS = 2;

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
export function createRun(topic: string): RunState {
  const run: RunState = {
    id: crypto.randomUUID(),
    topic,
    status: "running",
    nodes: initNodes(),
    outline: null,
    subscribers: new Set(),
    controllers: new Map(),
    createdAt: Date.now(),
  };
  runs.set(run.id, run);
  return run;
}

export function getRun(runId: string): RunState | undefined {
  return runs.get(runId);
}

/**
 * 订阅事件。订阅瞬间先推一个 snapshot（含当前所有节点状态和已累积内容），
 * 之后只推增量事件。这样前端断线重连不需要回放成千上万个 token 事件。
 */
export function subscribe(
  runId: string,
  onEvent: (event: StreamEvent) => void,
): (() => void) | null {
  const run = runs.get(runId);
  if (!run) return null;

  onEvent({ type: "snapshot", status: run.status, nodes: cloneNodes(run) });
  run.subscribers.add(onEvent);

  return () => {
    run.subscribers.delete(onEvent);
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
    // 策划失败时已经发过 run:failed；被中断时补一个 run:done 让前端收尾
    if (run.status === "aborted") {
      emit(run, { type: "run:done", summary: summarize(run) });
    }
    return;
  }

  await runParallel(run);
}

/**
 * 策划节点：执行 → JSON.parse → 失败自动重试 1 次。
 * 返回 true 表示拿到了合法 JSON 提纲，可以启动下游。
 */
async function runPlanner(run: RunState): Promise<boolean> {
  const agent = new PlannerAgent();

  for (let attempt = 1; attempt <= PLANNER_MAX_ATTEMPTS; attempt++) {
    if (run.status === "aborted") return false;

    const node = run.nodes.planner;
    node.status = "running";
    node.content = "";
    node.error = undefined;
    node.attempt = attempt;

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
      text = await agent.run(`选题：${run.topic}`, {
        signal: controller.signal,
        onToken: (token) => {
          node.content += token;
          emit(run, { type: "node:token", nodeId: "planner", text: token });
        },
      });
    } catch (err) {
      run.controllers.delete("planner");

      if (err instanceof Error && err.name === "AbortError") {
        node.status = "cancelled";
        emit(run, { type: "node:cancelled", nodeId: "planner" });
        return false;
      }

      node.status = "failed";
      node.error = err instanceof Error ? err.message : String(err);
      emit(run, { type: "node:error", nodeId: "planner", message: node.error });
      run.status = "failed";
      emit(run, { type: "run:failed", message: "策划 Agent 调用失败，无法继续生成内容" });
      return false;
    }

    run.controllers.delete("planner");

    try {
      run.outline = JSON.parse(text.trim());
      node.status = "completed";
      emit(run, { type: "node:done", nodeId: "planner" });
      return true;
    } catch {
      // 语法非法，进入下一轮重试；已是最后一轮则判定失败
      if (attempt >= PLANNER_MAX_ATTEMPTS) {
        node.status = "failed";
        node.error = "JSON 解析失败（已重试1次）";
        emit(run, { type: "node:error", nodeId: "planner", message: node.error });
        run.status = "failed";
        emit(run, { type: "run:failed", message: "策划提纲生成失败，无法继续生成内容" });
        return false;
      }
    }
  }

  return false;
}

/** 从策划提纲里取某个渠道的片段，取不到就返回 null，交给 Agent 自行发挥 */
function getSection(run: RunState, key: string): unknown {
  const parsed = run.outline as { outline?: Record<string, unknown> } | null;
  return parsed?.outline?.[key] ?? null;
}

function buildSectionInput(topic: string, section: unknown): string {
  const body = section
    ? JSON.stringify(section, null, 2)
    : "（策划未提供该渠道的提纲，请根据选题自行发挥）";
  return `选题：${topic}\n\n专属提纲：\n${body}`;
}

async function runParallel(run: RunState): Promise<void> {
  await Promise.allSettled([
    runTextNode(run, "longform", new LongformAgent(), getSection(run, "longForm")),
    runTextNode(run, "script", new ScriptAgent(), getSection(run, "script")),
    runTextNode(run, "xhs", new XhsAgent(), getSection(run, "xhs")),
    runImageNode(run, getSection(run, "image")),
  ]);

  const summary = summarize(run);
  if (run.status !== "aborted") {
    run.status = summary.failed > 0 ? "failed" : "completed";
  }
  emit(run, { type: "run:done", summary });
}

interface TextCapableAgent {
  readonly name: string;
  readonly modelId: string;
  run(
    input: string,
    options: { signal?: AbortSignal; onToken?: (token: string) => void },
  ): Promise<string>;
}

async function runTextNode(
  run: RunState,
  nodeId: NodeId,
  agent: TextCapableAgent,
  section: unknown,
): Promise<void> {
  const node = run.nodes[nodeId];

  // 用户在调度前已经取消了这个节点（比如策划阶段就中断了 xhs），不再启动
  if (node.status === "cancelled") return;

  // 全局中断发生在调度之前，直接标记为已取消，不发起调用
  if (run.status === "aborted") {
    node.status = "cancelled";
    emit(run, { type: "node:cancelled", nodeId });
    return;
  }

  node.status = "running";
  node.content = "";
  node.error = undefined;
  node.attempt = 1;

  const controller = new AbortController();
  run.controllers.set(nodeId, controller);
  emit(run, {
    type: "node:start",
    nodeId,
    name: agent.name,
    model: agent.modelId,
    attempt: 1,
  });

  try {
    await agent.run(buildSectionInput(run.topic, section), {
      signal: controller.signal,
      onToken: (token) => {
        node.content += token;
        emit(run, { type: "node:token", nodeId, text: token });
      },
    });

    node.status = "completed";
    emit(run, { type: "node:done", nodeId });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      node.status = "cancelled";
      emit(run, { type: "node:cancelled", nodeId });
    } else {
      node.status = "failed";
      node.error = err instanceof Error ? err.message : String(err);
      emit(run, { type: "node:error", nodeId, message: node.error });
    }
  } finally {
    run.controllers.delete(nodeId);
  }
}

async function runImageNode(run: RunState, section: unknown): Promise<void> {
  const nodeId: NodeId = "image";
  const node = run.nodes.image;
  const agent = new ImageAgent();

  // 用户在调度前已经取消了这个节点，不再启动
  if (node.status === "cancelled") return;

  if (run.status === "aborted") {
    node.status = "cancelled";
    emit(run, { type: "node:cancelled", nodeId });
    return;
  }

  node.status = "running";
  node.content = "";
  node.imageUrl = undefined;
  node.error = undefined;
  node.attempt = 1;

  const controller = new AbortController();
  run.controllers.set(nodeId, controller);
  emit(run, {
    type: "node:start",
    nodeId,
    name: agent.name,
    model: agent.modelId,
    attempt: 1,
  });

  try {
    const { prompt, imageUrl } = await agent.generate(
      buildSectionInput(run.topic, section),
      {
        signal: controller.signal,
        onToken: (token) => {
          node.content += token;
          emit(run, { type: "node:token", nodeId, text: token });
        },
      },
    );

    node.imageUrl = imageUrl;
    node.status = "completed";
    emit(run, { type: "node:image", nodeId, url: imageUrl, prompt });
    emit(run, { type: "node:done", nodeId });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      node.status = "cancelled";
      emit(run, { type: "node:cancelled", nodeId });
    } else {
      node.status = "failed";
      node.error = err instanceof Error ? err.message : String(err);
      emit(run, { type: "node:error", nodeId, message: node.error });
    }
  } finally {
    run.controllers.delete(nodeId);
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

  node.status = "pending";
  node.content = "";
  node.imageUrl = undefined;
  node.error = undefined;
  node.attempt = 0;

  if (run.status === "failed" || run.status === "completed" || run.status === "aborted") {
    run.status = "running";
  }

  if (nodeId === "image") {
    void runImageNode(run, getSection(run, "image"));
  } else if (nodeId === "longform") {
    void runTextNode(run, "longform", new LongformAgent(), getSection(run, "longForm"));
  } else if (nodeId === "script") {
    void runTextNode(run, "script", new ScriptAgent(), getSection(run, "script"));
  } else {
    void runTextNode(run, "xhs", new XhsAgent(), getSection(run, "xhs"));
  }

  return true;
}
