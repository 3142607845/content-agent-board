import type { TokenUsage } from "./llm";

/**
 * 执行报告
 *
 * 流水线跑完后由编排层生成，随 run:done 下发、随 snapshot 补发。
 *
 * 这里刻意只用结构化入参，不 import orchestrator 的类型，
 * 避免 report ← orchestrator ← report 的循环依赖；
 * 同时也让前端能直接 import 本文件的纯函数做格式化。
 */

export interface NodeReportItem {
  nodeId: string;
  name: string;
  model: string;
  status: string;
  /** 总尝试次数 */
  attempts: number;
  /** 自动重试次数 = attempts - 1 */
  retries: number;
  durationMs: number;
  usage: TokenUsage | null;
  /** true 表示 token 是按字符估算的，不是服务端真实值 */
  usageEstimated: boolean;
  /** 正文字数，用于和 token 数对照 */
  contentChars: number;
  error?: string;
}

export interface RunReportTotals {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reasoningTokens: number;
  /** 实际发生的模型调用次数（含重试） */
  llmCalls: number;
  retries: number;
  completed: number;
  failed: number;
  cancelled: number;
}

/** 并行阶段的实际收益：4 个后置节点如果串行要多久，实际只花了多久 */
export interface ParallelStats {
  serialMs: number;
  wallMs: number;
  /** 加速比，保留两位小数；wallMs 为 0 时给 null */
  speedup: number | null;
}

export interface RunReport {
  runId: string;
  topic: string;
  variant: string | null;
  status: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  nodes: NodeReportItem[];
  totals: RunReportTotals;
  parallel: ParallelStats | null;
  /** 任意一个节点用了估算值，报告整体就需要标注 */
  hasEstimated: boolean;
}

export interface ReportNodeMetrics {
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  usage?: TokenUsage;
  usageEstimated?: boolean;
  retries: number;
}

export interface ReportNodeInput {
  id: string;
  name: string;
  /** 节点未启动时可能没有 model */
  model?: string;
  status: string;
  content: string;
  error?: string;
  metrics?: ReportNodeMetrics;
}

export interface ReportInput {
  runId: string;
  topic: string;
  variant: string | null;
  status: string;
  createdAt: number;
  finishedAt: number;
  nodes: ReportNodeInput[];
}

/** 规划节点不参与并行加速比计算 */
const PLANNER_ID = "planner";

/**
 * 按字符数粗估 token。
 *
 * 只服务端没给 usage 时兜底：中文约 1.5 字符 / token，
 * 结果一定不够准，所以调用方必须把它标记成 estimated。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 1.5);
}

export function emptyUsage(): TokenUsage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

/** 累加两次调用的用量，用于策划重试这类一个节点多次调用的情况 */
export function addUsage(base: TokenUsage | undefined, next: TokenUsage): TokenUsage {
  const prev = base ?? emptyUsage();
  const reasoning = (prev.reasoningTokens ?? 0) + (next.reasoningTokens ?? 0);
  const cached = (prev.cachedTokens ?? 0) + (next.cachedTokens ?? 0);
  return {
    promptTokens: prev.promptTokens + next.promptTokens,
    completionTokens: prev.completionTokens + next.completionTokens,
    totalTokens: prev.totalTokens + next.totalTokens,
    ...(reasoning > 0 ? { reasoningTokens: reasoning } : {}),
    ...(cached > 0 ? { cachedTokens: cached } : {}),
  };
}

function durationOf(node: ReportNodeInput): number {
  const m = node.metrics;
  if (!m) return 0;
  if (typeof m.durationMs === "number") return m.durationMs;
  if (m.endedAt) return Math.max(0, m.endedAt - m.startedAt);
  return 0;
}

export function buildRunReport(input: ReportInput): RunReport {
  const nodes: NodeReportItem[] = input.nodes.map((node) => {
    const usage = node.metrics?.usage ?? null;
    return {
      nodeId: node.id,
      name: node.name,
      model: node.model ?? "未启动",
      status: node.status,
      attempts: node.metrics ? node.metrics.retries + 1 : 0,
      retries: node.metrics?.retries ?? 0,
      durationMs: durationOf(node),
      usage,
      usageEstimated: Boolean(node.metrics?.usageEstimated),
      contentChars: node.content.length,
      ...(node.error ? { error: node.error } : {}),
    };
  });

  const totals: RunReportTotals = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    reasoningTokens: 0,
    llmCalls: 0,
    retries: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
  };

  for (const node of nodes) {
    if (node.usage) {
      totals.promptTokens += node.usage.promptTokens;
      totals.completionTokens += node.usage.completionTokens;
      totals.totalTokens += node.usage.totalTokens;
      totals.reasoningTokens += node.usage.reasoningTokens ?? 0;
    }
    // 有 metrics 说明这个节点真的调用过模型（配图含着扩写那一次）
    if (node.attempts > 0) totals.llmCalls += node.attempts;
    totals.retries += node.retries;
    if (node.status === "completed") totals.completed += 1;
    else if (node.status === "failed") totals.failed += 1;
    else if (node.status === "cancelled") totals.cancelled += 1;
  }

  return {
    runId: input.runId,
    topic: input.topic,
    variant: input.variant,
    status: input.status,
    startedAt: input.createdAt,
    endedAt: input.finishedAt,
    durationMs: Math.max(0, input.finishedAt - input.createdAt),
    nodes,
    totals,
    parallel: buildParallelStats(input.nodes),
    hasEstimated: nodes.some((n) => n.usageEstimated),
  };
}

/**
 * 并行加速比：4 个后置节点耗时之和 ÷ 并行阶段实际墙钟时间。
 * 只统计真正跑过的节点，被中断/未启动的不参与，避免把加速比算虚高。
 */
function buildParallelStats(nodes: ReportNodeInput[]): ParallelStats | null {
  const parallelNodes = nodes.filter(
    (n) => n.id !== PLANNER_ID && n.metrics && n.metrics.endedAt,
  );
  if (parallelNodes.length < 2) return null;

  const serialMs = parallelNodes.reduce((sum, n) => sum + durationOf(n), 0);
  const start = Math.min(...parallelNodes.map((n) => n.metrics!.startedAt));
  const end = Math.max(...parallelNodes.map((n) => n.metrics!.endedAt!));
  const wallMs = end - start;
  if (wallMs <= 0) return null;

  return {
    serialMs,
    wallMs,
    speedup: Math.round((serialMs / wallMs) * 100) / 100,
  };
}

/** 前端展示用：毫秒转「1.2s」/「45.3s」/「1m 12s」 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m ${rest}s`;
}

export function formatTokens(value: number): string {
  return value.toLocaleString("en-US");
}
