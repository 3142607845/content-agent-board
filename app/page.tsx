"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AgentNodeState,
  NodeId,
  NodeStatus,
  RunSnapshot,
  RunStatus,
} from "@/lib/orchestrator";
import { formatDuration, formatTokens, type RunReport } from "@/lib/report";
import { VARIANTS, type VariantKey } from "@/lib/variants";
import type { HistoryBatch, HistoryRunEntry } from "@/lib/history";
import BackgroundScene from "./background-scene";

const NODE_ORDER: NodeId[] = ["planner", "longform", "script", "xhs", "image"];

const NODE_META: Record<
  NodeId,
  { name: string; desc: string; glyph: string; tint: string }
> = {
  planner: {
    name: "策划 Agent",
    desc: "拆解选题，产出四渠道提纲 JSON",
    glyph: "策",
    tint: "bg-indigo-50 text-indigo-600 ring-indigo-100",
  },
  longform: {
    name: "公众号长文",
    desc: "公众号长文，2000 字以上",
    glyph: "文",
    tint: "bg-sky-50 text-sky-600 ring-sky-100",
  },
  script: {
    name: "短视频脚本",
    desc: "短视频分镜脚本",
    glyph: "稿",
    tint: "bg-violet-50 text-violet-600 ring-violet-100",
  },
  xhs: {
    name: "小红书笔记",
    desc: "小红书笔记正文与标签",
    glyph: "红",
    tint: "bg-rose-50 text-rose-600 ring-rose-100",
  },
  image: {
    name: "配图 Agent",
    desc: "扩写提示词并调用 Seedream 出图",
    glyph: "图",
    tint: "bg-amber-50 text-amber-600 ring-amber-100",
  },
};

/** 首页插图：AI 生成的内容流水线示意图，加载失败时退回纯色块不影响布局 */
const HERO_IMAGE =
  "https://trae-api-cn.mchost.guru/api/ide/v1/text_to_image?prompt=" +
  encodeURIComponent(
    "soft 3D isometric illustration of a content production pipeline, five floating rounded white cards connected by glowing indigo and violet lines, abstract minimal, clean light background, subtle shadows, high quality render",
  ) +
  "&image_size=landscape_4_3";

/** 状态只体现在左色条和小徽标上，卡片底始终中性，避免多卡同时变绿变蓝 */
const STATUS_STYLE: Record<
  NodeStatus,
  { label: string; bar: string; badge: string }
> = {
  pending: {
    label: "等待",
    bar: "bg-neutral-200",
    badge: "bg-neutral-100 text-neutral-500",
  },
  running: {
    label: "生成中",
    bar: "bg-blue-500",
    badge: "bg-blue-50 text-blue-700",
  },
  completed: {
    label: "完成",
    bar: "bg-emerald-500",
    badge: "bg-emerald-50 text-emerald-700",
  },
  failed: {
    label: "失败",
    bar: "bg-red-500",
    badge: "bg-red-50 text-red-700",
  },
  cancelled: {
    label: "已中断",
    bar: "bg-amber-500",
    badge: "bg-amber-50 text-amber-700",
  },
};

/** 卡片面、按钮三档权重，避免每处重写一长串 className */
const CARD = "rounded-xl border border-hairline bg-surface shadow-card";
const BTN_PRIMARY =
  "rounded-lg bg-accent px-5 py-2.5 text-sm font-medium text-white transition hover:bg-accent-strong disabled:opacity-40";
const BTN_GHOST =
  "rounded-lg border border-hairline-strong bg-surface px-4 py-2.5 text-sm font-medium text-ink-2 transition hover:text-ink disabled:opacity-40";
const BTN_QUIET =
  "rounded-md border border-hairline-strong bg-surface px-2.5 py-1 text-xs text-ink-2 transition hover:text-ink disabled:opacity-40";

const RUN_STATUS_TEXT: Record<RunStatus, string> = {
  running: "流水线运行中",
  completed: "全部完成",
  failed: "存在失败节点",
  aborted: "已中断",
};

/** 历史列表用的短时间格式，避免 toLocaleString 在服务端/客户端输出不一致 */
function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

type Mode = "single" | "multi-topic" | "multi-version";

const MODE_TABS: { id: Mode; label: string }[] = [
  { id: "single", label: "单次生成模式" },
  { id: "multi-topic", label: "批量选题模式" },
  { id: "multi-version", label: "多版生成模式" },
];

interface TaskResult {
  id: string;
  topic: string;
  label: string;
  /** 多版模式：该任务对应的创作维度 */
  variant?: VariantKey;
  status: "pending" | "running" | "completed" | "failed" | "aborted";
  nodes: Record<NodeId, AgentNodeState>;
  runId?: string;
  /** 该任务跑完后由服务端下发的执行报告 */
  report?: RunReport | null;
}

/** 历史回看态：只读展示落盘快照，不建立 SSE 连接 */
interface ReviewingState {
  runId: string;
  variantName: string | null;
  finishedAt: number | null;
}

function emptyNodes(): Record<NodeId, AgentNodeState> {
  const nodes = {} as Record<NodeId, AgentNodeState>;
  for (const id of NODE_ORDER) {
    nodes[id] = {
      id,
      name: NODE_META[id].name,
      status: "pending",
      content: "",
      attempt: 0,
    };
  }
  return nodes;
}

const REPORT_STATUS_TEXT: Record<string, string> = {
  completed: "完成",
  running: "生成中",
  failed: "失败",
  cancelled: "已中断",
  pending: "未启动",
};

function variantLabel(key: string | null): string {
  if (!key) return "";
  return VARIANTS.find((v) => v.key === key)?.name ?? key;
}

/** 单次运行的执行报告，数据全部来自服务端下发的 RunReport */
function ReportCard({ report, title = "本次流水线执行报告" }: { report: RunReport; title?: string }) {
  return (
    <section className="rounded-xl border border-dashed border-hairline-strong bg-surface/60 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xs font-semibold tracking-wide text-ink-2">{title}</h2>
        <span className="text-xs tabular-nums text-ink-3">
          总耗时 {formatDuration(report.durationMs)}
        </span>
      </div>
      <p className="mt-1 text-xs text-ink-3">
        {report.topic}
        {report.variant ? ` · ${variantLabel(report.variant)}` : ""}
      </p>

      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[620px] text-left text-xs tabular-nums">
          <thead className="text-ink-3">
            <tr>
              <th className="py-1 pr-3 font-normal">节点</th>
              <th className="py-1 pr-3 font-normal">模型</th>
              <th className="py-1 pr-3 font-normal">状态</th>
              <th className="py-1 pr-3 font-normal">耗时</th>
              <th className="py-1 pr-3 font-normal">输入 token</th>
              <th className="py-1 pr-3 font-normal">输出 token</th>
              <th className="py-1 font-normal">重试</th>
            </tr>
          </thead>
          <tbody>
            {report.nodes.map((n) => (
              <tr key={n.nodeId} className="border-t border-hairline">
                <td className="py-1.5 pr-3 font-medium text-ink">{n.name}</td>
                <td className="py-1.5 pr-3 font-mono text-[11px] text-ink-3">
                  {n.model}
                </td>
                <td className="py-1.5 pr-3">
                  {REPORT_STATUS_TEXT[n.status] ?? n.status}
                </td>
                <td className="py-1.5 pr-3">
                  {n.attempts > 0 ? formatDuration(n.durationMs) : "—"}
                </td>
                <td className="py-1.5 pr-3">
                  {n.usage ? formatTokens(n.usage.promptTokens) : "—"}
                </td>
                <td className="py-1.5 pr-3">
                  {n.usage ? formatTokens(n.usage.completionTokens) : "—"}
                </td>
                <td className="py-1.5">
                  {n.retries > 0 ? (
                    <span className="text-amber-600">{n.retries} 次</span>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2">
        <span>模型调用 {report.totals.llmCalls} 次</span>
        <span>token 合计 {formatTokens(report.totals.totalTokens)}</span>
        {report.totals.reasoningTokens > 0 && (
          <span>其中思维链 {formatTokens(report.totals.reasoningTokens)}</span>
        )}
        {report.totals.retries > 0 && (
          <span className="text-amber-600">自动重试 {report.totals.retries} 次</span>
        )}
        {report.parallel?.speedup != null && (
          <span className="text-emerald-600">
            并行加速 {report.parallel.speedup}×（4 路串行需{" "}
            {formatDuration(report.parallel.serialMs)}，实际{" "}
            {formatDuration(report.parallel.wallMs)}）
          </span>
        )}
        {report.hasEstimated && (
          <span className="text-amber-600">含字符估算值，非服务端真实用量</span>
        )}
      </div>
    </section>
  );
}

/** 批量模式全部结束后的横向汇总，用来对比各版本的耗时与成本 */
function BatchSummary({ tasks }: { tasks: TaskResult[] }) {
  const totalTokens = tasks.reduce(
    (sum, t) => sum + (t.report?.totals.totalTokens ?? 0),
    0,
  );
  return (
    <section className="rounded-xl border border-dashed border-hairline-strong bg-surface/60 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xs font-semibold tracking-wide text-ink-2">
          批量执行汇总
        </h2>
        <span className="text-xs tabular-nums text-ink-3">
          token 合计 {formatTokens(totalTokens)}
        </span>
      </div>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[520px] text-left text-xs tabular-nums">
          <thead className="text-ink-3">
            <tr>
              <th className="py-1 pr-3 font-normal">任务</th>
              <th className="py-1 pr-3 font-normal">状态</th>
              <th className="py-1 pr-3 font-normal">总耗时</th>
              <th className="py-1 pr-3 font-normal">token 合计</th>
              <th className="py-1 font-normal">自动重试</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((t) => (
              <tr key={t.id} className="border-t border-hairline">
                <td className="py-1.5 pr-3 font-medium text-ink">
                  {t.label}
                </td>
                <td className="py-1.5 pr-3">
                  {REPORT_STATUS_TEXT[t.status] ?? t.status}
                </td>
                <td className="py-1.5 pr-3">
                  {t.report ? formatDuration(t.report.durationMs) : "—"}
                </td>
                <td className="py-1.5 pr-3">
                  {t.report ? formatTokens(t.report.totals.totalTokens) : "—"}
                </td>
                <td className="py-1.5">
                  {t.report?.totals.retries ? (
                    <span className="text-amber-600">
                      {t.report.totals.retries} 次
                    </span>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default function Home() {
  const [mode, setMode] = useState<Mode>("single");
  const [topic, setTopic] = useState("");
  const [multiTopic, setMultiTopic] = useState("");

  // 单次模式状态
  const [nodes, setNodes] = useState<Record<NodeId, AgentNodeState>>(emptyNodes);
  const [runStatus, setRunStatus] = useState<RunStatus | "idle">("idle");
  const [runId, setRunId] = useState<string | null>(null);

  // 批量模式状态
  const [tasks, setTasks] = useState<TaskResult[]>([]);
  const [activeTaskIndex, setActiveTaskIndex] = useState(0);

  const [notice, setNotice] = useState("");
  /** 单次模式下的执行报告，由 snapshot 或 run:done 下发 */
  const [report, setReport] = useState<RunReport | null>(null);
  /** SSE 断开重连提示，收到新快照自动清除 */
  const [reconnectNotice, setReconnectNotice] = useState("");
  const [copied, setCopied] = useState<Partial<Record<NodeId, boolean>>>({});
  /** 卡片展开态；默认折叠，节点开始运行时自动展开 */
  const [expanded, setExpanded] = useState<Partial<Record<NodeId, boolean>>>({});
  const esRef = useRef<EventSource | null>(null);
  const batchRunningRef = useRef(false);

  // 历史回看：批次列表来自服务端落盘快照，不依赖当前内存态
  const [historyBatches, setHistoryBatches] = useState<HistoryBatch[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [reviewing, setReviewing] = useState<ReviewingState | null>(null);

  const loadHistory = useCallback(async () => {
    try {
      const res = await fetch("/api/history", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { batches?: HistoryBatch[] };
      setHistoryBatches(data.batches ?? []);
    } catch {
      // 历史列表取不到不影响主流程
    }
  }, []);

  // 首次进入拉一次：刷新页面后历史入口仍然有内容
  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  useEffect(
    () => () => {
      esRef.current?.close();
      batchRunningRef.current = false;
    },
    [],
  );

  // 当前展示的数据源
  const currentNodes =
    mode === "single" ? nodes : tasks[activeTaskIndex]?.nodes ?? emptyNodes();
  const currentRunId =
    mode === "single" ? runId : tasks[activeTaskIndex]?.runId ?? null;
  const currentTaskStatus =
    mode === "single" ? runStatus : tasks[activeTaskIndex]?.status ?? "idle";
  const currentTopic =
    mode === "single" ? topic : tasks[activeTaskIndex]?.topic ?? topic;
  const currentReport =
    mode === "single" ? report : tasks[activeTaskIndex]?.report ?? null;
  const isRunning = currentTaskStatus === "running";
  const isCompleted = currentTaskStatus === "completed";

  const patchNodeSingle = useCallback(
    (nodeId: NodeId, patch: Partial<AgentNodeState>) => {
      setNodes((prev) => ({
        ...prev,
        [nodeId]: { ...prev[nodeId], ...patch },
      }));
    },
    [],
  );

  const toggleNode = useCallback((nodeId: NodeId) => {
    setExpanded((prev) => ({ ...prev, [nodeId]: !prev[nodeId] }));
  }, []);

  /** 节点开始运行时自动展开，让流式输出始终可见 */
  const expandNode = useCallback((nodeId: NodeId) => {
    setExpanded((prev) => (prev[nodeId] ? prev : { ...prev, [nodeId]: true }));
  }, []);

  const patchNodeTask = useCallback(
    (taskIndex: number, nodeId: NodeId, patch: Partial<AgentNodeState>) => {
      setTasks((prev) =>
        prev.map((t, idx) =>
          idx === taskIndex
            ? { ...t, nodes: { ...t.nodes, [nodeId]: { ...t.nodes[nodeId], ...patch } } }
            : t,
        ),
      );
    },
    [],
  );

  // 单次模式 SSE
  const connectSingle = useCallback(
    (id: string) => {
      esRef.current?.close();
      const es = new EventSource(`/api/stream/${id}`);
      esRef.current = es;

      es.addEventListener("snapshot", (ev) => {
        // 断线重连时服务端会重新下发全量快照，这里整体替换即可，不需要回放事件
        const snap = JSON.parse((ev as MessageEvent).data) as RunSnapshot;
        setNodes(snap.nodes);
        setRunStatus(snap.status);
        setReport(snap.report);
        setReconnectNotice("");
        if (snap.status !== "running") es.close();
      });

      es.addEventListener("node:start", (ev) => {
        const d = JSON.parse((ev as MessageEvent).data) as {
          nodeId: NodeId;
          attempt: number;
        };
        patchNodeSingle(d.nodeId, {
          status: "running",
          content: "",
          imageUrl: undefined,
          error: undefined,
          attempt: d.attempt,
        });
        expandNode(d.nodeId);
      });

      es.addEventListener("node:token", (ev) => {
        const d = JSON.parse((ev as MessageEvent).data) as {
          nodeId: NodeId;
          text: string;
        };
        setNodes((prev) => ({
          ...prev,
          [d.nodeId]: {
            ...prev[d.nodeId],
            content: prev[d.nodeId].content + d.text,
          },
        }));
      });

      es.addEventListener("node:image", (ev) => {
        const d = JSON.parse((ev as MessageEvent).data) as {
          nodeId: NodeId;
          url: string;
        };
        patchNodeSingle(d.nodeId, { imageUrl: d.url });
      });

      es.addEventListener("node:done", (ev) => {
        const d = JSON.parse((ev as MessageEvent).data) as { nodeId: NodeId };
        patchNodeSingle(d.nodeId, { status: "completed" });
      });

      es.addEventListener("node:error", (ev) => {
        const d = JSON.parse((ev as MessageEvent).data) as {
          nodeId: NodeId;
          message: string;
        };
        patchNodeSingle(d.nodeId, { status: "failed", error: d.message });
      });

      es.addEventListener("node:cancelled", (ev) => {
        const d = JSON.parse((ev as MessageEvent).data) as { nodeId: NodeId };
        patchNodeSingle(d.nodeId, { status: "cancelled" });
      });

      es.addEventListener("run:done", (ev) => {
        const d = JSON.parse((ev as MessageEvent).data) as {
          report: RunReport | null;
        };
        setRunStatus((prev) => (prev === "aborted" ? prev : "completed"));
        setReport(d.report);
        // run 已落盘，刷新历史列表
        void loadHistory();
        es.close();
      });

      es.addEventListener("run:failed", (ev) => {
        const d = JSON.parse((ev as MessageEvent).data) as {
          message: string;
          report: RunReport | null;
        };
        setRunStatus("failed");
        setNotice(d.message);
        setReport(d.report);
        void loadHistory();
        es.close();
      });

      es.onerror = () => {
        // EventSource 自带重连，服务端重连后立刻补发全量快照，这里只做可见提示
        if (es.readyState !== EventSource.CLOSED) {
          setReconnectNotice("连接中断，正在重连…");
        }
      };
    },
    [patchNodeSingle, expandNode, loadHistory],
  );

  // 批量模式 SSE，返回 Promise 在 run 结束时 resolve
  function connectTask(runId: string, taskIndex: number): Promise<void> {
    return new Promise((resolve) => {
      esRef.current?.close();
      const es = new EventSource(`/api/stream/${runId}`);
      esRef.current = es;

      es.addEventListener("snapshot", (ev) => {
        // 断线重连后服务端补发全量快照；如果 run 已经结束，这里必须直接收尾，
        // 否则错过 run:done 会让整个批量队列永远卡住
        const snap = JSON.parse((ev as MessageEvent).data) as RunSnapshot;
        setTasks((prev) =>
          prev.map((t, idx) =>
            idx === taskIndex
              ? { ...t, nodes: snap.nodes, status: snap.status, report: snap.report }
              : t,
          ),
        );
        setReconnectNotice("");
        if (snap.status !== "running") {
          es.close();
          resolve();
        }
      });

      es.addEventListener("node:start", (ev) => {
        const d = JSON.parse((ev as MessageEvent).data) as {
          nodeId: NodeId;
          attempt: number;
        };
        patchNodeTask(taskIndex, d.nodeId, {
          status: "running",
          content: "",
          imageUrl: undefined,
          error: undefined,
          attempt: d.attempt,
        });
        expandNode(d.nodeId);
      });

      es.addEventListener("node:token", (ev) => {
        const d = JSON.parse((ev as MessageEvent).data) as {
          nodeId: NodeId;
          text: string;
        };
        setTasks((prev) =>
          prev.map((t, idx) =>
            idx === taskIndex
              ? {
                  ...t,
                  nodes: {
                    ...t.nodes,
                    [d.nodeId]: {
                      ...t.nodes[d.nodeId],
                      content: t.nodes[d.nodeId].content + d.text,
                    },
                  },
                }
              : t,
          ),
        );
      });

      es.addEventListener("node:image", (ev) => {
        const d = JSON.parse((ev as MessageEvent).data) as {
          nodeId: NodeId;
          url: string;
        };
        patchNodeTask(taskIndex, d.nodeId, { imageUrl: d.url });
      });

      es.addEventListener("node:done", (ev) => {
        const d = JSON.parse((ev as MessageEvent).data) as { nodeId: NodeId };
        patchNodeTask(taskIndex, d.nodeId, { status: "completed" });
      });

      es.addEventListener("node:error", (ev) => {
        const d = JSON.parse((ev as MessageEvent).data) as {
          nodeId: NodeId;
          message: string;
        };
        patchNodeTask(taskIndex, d.nodeId, { status: "failed", error: d.message });
      });

      es.addEventListener("node:cancelled", (ev) => {
        const d = JSON.parse((ev as MessageEvent).data) as { nodeId: NodeId };
        patchNodeTask(taskIndex, d.nodeId, { status: "cancelled" });
      });

      es.addEventListener("run:done", (ev) => {
        const d = JSON.parse((ev as MessageEvent).data) as {
          report: RunReport | null;
        };
        setTasks((prev) =>
          prev.map((t, idx) =>
            idx === taskIndex
              ? { ...t, status: "completed", report: d.report }
              : t,
          ),
        );
        // 本批完成一个 run，历史列表同步刷新
        void loadHistory();
        es.close();
        resolve();
      });

      es.addEventListener("run:failed", (ev) => {
        const d = JSON.parse((ev as MessageEvent).data) as {
          message: string;
          report: RunReport | null;
        };
        setTasks((prev) =>
          prev.map((t, idx) =>
            idx === taskIndex
              ? { ...t, status: "failed", report: d.report }
              : t,
          ),
        );
        setNotice(d.message);
        void loadHistory();
        es.close();
        resolve();
      });

      es.onerror = () => {
        if (es.readyState !== EventSource.CLOSED) {
          setReconnectNotice("连接中断，正在重连…");
        }
      };
    });
  }

  // 单次：开始
  async function handleStartSingle() {
    const value = topic.trim();
    if (!value) return;
    esRef.current?.close();
    setReviewing(null);
    setNodes(emptyNodes());
    setRunStatus("running");
    setNotice("");
    setReport(null);
    setReconnectNotice("");
    setCopied({});
    setExpanded({});
    try {
      const res = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic: value }),
      });
      const data = (await res.json()) as { runId?: string; error?: string };
      if (!res.ok || !data.runId) throw new Error(data.error ?? `启动失败 ${res.status}`);
      setRunId(data.runId);
      connectSingle(data.runId);
    } catch (err) {
      setRunStatus("failed");
      setNotice(err instanceof Error ? err.message : String(err));
    }
  }

  // 批量：开始
  async function handleStartBatch() {
    let taskList: { topic: string; label: string; variant?: VariantKey }[] = [];
    if (mode === "multi-topic") {
      const topics = multiTopic
        .split("\n")
        .map((t) => t.trim())
        .filter(Boolean)
        .slice(0, 3);
      if (topics.length === 0) return;
      taskList = topics.map((t, i) => ({ topic: t, label: `选题 ${i + 1}` }));
    } else {
      const t = topic.trim();
      if (!t) return;
      // 多版模式固定三个创作维度，不再让用户选数量
      taskList = VARIANTS.map((v) => ({
        topic: t,
        label: v.name,
        variant: v.key,
      }));
    }

    const initial: TaskResult[] = taskList.map((t, i) => ({
      id: `${Date.now()}-${i}`,
      topic: t.topic,
      label: t.label,
      variant: t.variant,
      status: "pending",
      nodes: emptyNodes(),
    }));

    setTasks(initial);
    setActiveTaskIndex(0);
    setNotice("");
    setReconnectNotice("");
    setCopied({});
    setExpanded({});
    batchRunningRef.current = true;

    // 同一批任务共享 batchId，历史回看时聚合为一个批次
    const batchUuid = crypto.randomUUID();

    for (let i = 0; i < initial.length; i++) {
      if (!batchRunningRef.current) {
        setTasks((prev) =>
          prev.map((t, idx) => (idx >= i ? { ...t, status: "aborted" } : t)),
        );
        break;
      }
      setActiveTaskIndex(i);
      setTasks((prev) =>
        prev.map((t, idx) => (idx === i ? { ...t, status: "running" } : t)),
      );
      try {
        const res = await fetch("/api/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            topic: initial[i].topic,
            ...(initial[i].variant ? { variant: initial[i].variant } : {}),
            batchId: batchUuid,
          }),
        });
        const data = (await res.json()) as { runId?: string; error?: string };
        if (!res.ok || !data.runId) throw new Error(data.error ?? `启动失败 ${res.status}`);
        setTasks((prev) =>
          prev.map((t, idx) => (idx === i ? { ...t, runId: data.runId } : t)),
        );
        await connectTask(data.runId, i);
      } catch (err) {
        setTasks((prev) =>
          prev.map((t, idx) => (idx === i ? { ...t, status: "failed" } : t)),
        );
        setNotice(err instanceof Error ? err.message : String(err));
      }
    }
    batchRunningRef.current = false;
  }

  function handleStopAll() {
    if (mode === "single") {
      if (!runId) return;
      fetch(`/api/stop/${runId}`, { method: "POST" });
      setRunStatus("aborted");
    } else {
      batchRunningRef.current = false;
      esRef.current?.close();
      setTasks((prev) =>
        prev.map((t) =>
          t.status === "running" || t.status === "pending"
            ? { ...t, status: "aborted" }
            : t,
        ),
      );
    }
  }

  async function handleStopNode(nodeId: NodeId) {
    if (!currentRunId) return;
    await fetch(`/api/stop/${currentRunId}?nodeId=${nodeId}`, { method: "POST" });
  }

  async function handleRerun(nodeId: NodeId) {
    if (!currentRunId) return;
    setNotice("");
    const res = await fetch(`/api/rerun/${nodeId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId: currentRunId }),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setNotice(data.error ?? `重跑失败 ${res.status}`);
      return;
    }
    setCopied((prev) => {
      const next = { ...prev };
      delete next[nodeId];
      return next;
    });
    // 重跑后重新连接 SSE
    if (mode === "single") {
      setRunStatus("running");
      // 重跑会让服务端作废旧报告，前端同步清空
      setReport(null);
      connectSingle(currentRunId);
    } else {
      const idx = activeTaskIndex;
      setTasks((prev) =>
        prev.map((t, i) =>
          i === idx ? { ...t, status: "running", report: null } : t,
        ),
      );
      connectTask(currentRunId, idx);
    }
  }

  async function handleCopy(nodeId: NodeId) {
    const text = currentNodes[nodeId].content;
    if (!text || copied[nodeId]) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied((prev) => ({ ...prev, [nodeId]: true }));
    } catch {
      setNotice("复制失败，请手动选择文本复制");
    }
  }

  function handleDownloadImage() {
    const url = currentNodes.image.imageUrl;
    if (!url) return;
    const a = document.createElement("a");
    a.href = url;
    a.download = `${currentTopic || "image"}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  function handleExportAll() {
    const lf = currentNodes.longform.content;
    const sc = currentNodes.script.content;
    const xhs = currentNodes.xhs.content;
    const img = currentNodes.image.imageUrl || "";
    const md = `# 选题：${currentTopic}\n\n## 公众号长文\n\n${lf}\n\n## 短视频脚本\n\n${sc}\n\n## 小红书笔记\n\n${xhs}\n\n## 配图\n\n![配图](${img})\n`;
    const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${currentTopic || "content"}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // 打开一条历史任务：用落盘快照回填结果区，进入只读回看，不建立 SSE
  async function openHistoryRun(entry: HistoryRunEntry) {
    esRef.current?.close();
    try {
      const res = await fetch(`/api/run/${entry.runId}`, { cache: "no-store" });
      if (!res.ok) throw new Error("历史快照已不存在");
      const snap = (await res.json()) as RunSnapshot;
      setMode("single");
      setTopic(snap.topic);
      setNodes(snap.nodes);
      setRunStatus(snap.status);
      setRunId(snap.runId);
      setReport(snap.report);
      setExpanded({});
      setCopied({});
      setNotice("");
      setReconnectNotice("");
      setReviewing({
        runId: snap.runId,
        variantName: entry.variantName,
        finishedAt: snap.finishedAt,
      });
      setHistoryOpen(false);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    }
  }

  function exitReview() {
    setReviewing(null);
    setRunId(null);
    setNodes(emptyNodes());
    setRunStatus("idle");
    setReport(null);
    setCopied({});
    setExpanded({});
    setNotice("");
  }

  function switchMode(next: Mode) {
    if (isRunning) return;
    // 回看态下切模式视为离开回看，避免历史内容与新模式的空态混在一起
    if (reviewing) exitReview();
    setMode(next);
    setNotice("");
    setTasks([]);
    setActiveTaskIndex(0);
  }

  const showBatchInput = mode === "multi-topic" || mode === "multi-version";
  const allExpanded = NODE_ORDER.every((id) => expanded[id]);

  // 批量模式全局进度：只把 completed 计入已完成，失败/中断单独统计
  const batchTotal = tasks.length;
  const batchCompleted = tasks.filter((t) => t.status === "completed").length;
  const batchFailed = tasks.filter((t) => t.status === "failed").length;
  const batchAborted = tasks.filter((t) => t.status === "aborted").length;
  const batchRunning = tasks.find((t) => t.status === "running");
  const batchPercent = batchTotal > 0 ? Math.round((batchCompleted / batchTotal) * 100) : 0;
  const batchUnit = mode === "multi-version" ? "版" : "选题";

  const statusText =
    currentTaskStatus === "idle"
      ? "未开始"
      : currentTaskStatus in RUN_STATUS_TEXT
        ? RUN_STATUS_TEXT[currentTaskStatus as RunStatus]
        : currentTaskStatus;
  const statusDotClass =
    currentTaskStatus === "failed"
      ? "bg-red-500"
      : currentTaskStatus === "completed"
        ? "bg-emerald-500"
        : currentTaskStatus === "aborted"
          ? "bg-amber-500"
          : currentTaskStatus === "running"
            ? "bg-blue-500 animate-pulse"
            : "bg-neutral-300";

  function toggleAll() {
    if (allExpanded) {
      setExpanded({});
      return;
    }
    setExpanded(
      NODE_ORDER.reduce(
        (acc, id) => {
          acc[id] = true;
          return acc;
        },
        {} as Partial<Record<NodeId, boolean>>,
      ),
    );
  }

  return (
    <>
      {/* 3D 氛围背景：最底层装饰，指针事件穿透，不参与任何交互 */}
      <BackgroundScene active={isRunning} />

      <header className="sticky top-0 z-20 border-b border-hairline bg-surface/85 backdrop-blur">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-3 px-6 py-3">
          <div className="flex items-center gap-3">
            <span className="grid h-9 w-9 place-items-center rounded-lg bg-accent text-[13px] font-bold text-white">
              CA
            </span>
            <div className="flex flex-col">
              <h1 className="text-base font-semibold leading-tight text-ink">
                Content Agent Board
              </h1>
              <p className="text-xs text-ink-3">
                选题 → 策划拆解 → 长文 / 脚本 / 小红书 / 配图 四路并行
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1.5 rounded-full border border-hairline bg-canvas px-2.5 py-1 text-xs text-ink-2">
              <span className={`h-1.5 w-1.5 rounded-full ${statusDotClass}`} />
              {statusText}
            </span>
            <button
              onClick={() => {
                setHistoryOpen((prev) => !prev);
                if (!historyOpen) void loadHistory();
              }}
              className={`${BTN_QUIET} px-3 py-1.5`}
            >
              历史记录
              {historyBatches.length > 0 ? ` (${historyBatches.length})` : ""}
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-5 px-6 py-6">
      {/* 首屏说明区：产品定位 + 流水线示意图 */}
      <section className="relative overflow-hidden rounded-2xl border border-hairline bg-surface shadow-card">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(36rem_20rem_at_100%_0%,#eef0ff_0%,transparent_70%)]" />
        <div className="relative flex flex-col gap-6 p-6 md:flex-row md:items-center md:p-7">
          <div className="flex-1">
            <span className="inline-flex items-center rounded-full border border-indigo-100 bg-indigo-50/70 px-2.5 py-1 text-[11px] font-medium text-indigo-600">
              多 Agent 协同 · 内容生产流水线
            </span>
            <h2 className="mt-3 text-xl font-semibold tracking-tight text-ink md:text-2xl">
              一个选题，五个 Agent，四路产出
            </h2>
            <p className="mt-2 max-w-xl text-sm leading-relaxed text-ink-2">
              策划 Agent 先把选题拆成结构化提纲，长文、脚本、小红书、配图并行开工；
              每个节点的耗时、token 与重试都会记进执行报告，历史批次随时可回看。
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              {["5 个 Agent 节点", "4 路并行生成", "全过程可回看"].map(
                (item) => (
                  <span
                    key={item}
                    className="rounded-md border border-hairline bg-canvas px-2 py-1 text-[11px] text-ink-2"
                  >
                    {item}
                  </span>
                ),
              )}
            </div>
          </div>

          <div className="hidden w-[300px] shrink-0 md:block">
            <div className="overflow-hidden rounded-xl border border-hairline bg-gradient-to-br from-indigo-50 via-white to-violet-50">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={HERO_IMAGE}
                alt="多 Agent 内容流水线示意图"
                className="h-[168px] w-full object-cover"
                onError={(e) => {
                  e.currentTarget.style.display = "none";
                }}
              />
            </div>
          </div>
        </div>
      </section>

      {/* 历史批次列表：按批次聚合，点某个版本进入只读回看 */}
      {historyOpen && (
        <section className={`${CARD} flex flex-col gap-3 p-4`}>
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-ink">最近 5 个批次</h2>
            <button
              onClick={() => void loadHistory()}
              className="text-xs text-ink-3 transition hover:text-ink"
            >
              刷新
            </button>
          </div>
          {historyBatches.length === 0 ? (
            <p className="text-xs text-ink-3">
              暂无历史任务，跑完一次流水线后会自动保存。
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {historyBatches.map((batch) => (
                <li
                  key={batch.batchId}
                  className="overflow-hidden rounded-lg border border-hairline"
                >
                  <div className="flex flex-wrap items-center gap-2 border-b border-hairline bg-canvas/60 px-3 py-2 text-xs">
                    <span
                      className="font-medium text-ink"
                      title={batch.topics.join("\n")}
                    >
                      {batch.topics.length > 1
                        ? `${batch.topics.length} 个选题`
                        : batch.topics[0]}
                    </span>
                    <span className="tabular-nums text-ink-3">
                      {formatTime(batch.createdAt)}
                    </span>
                    <span
                      className={
                        batch.status === "completed"
                          ? "text-emerald-600"
                          : batch.status === "partial"
                            ? "text-amber-600"
                            : "text-red-600"
                      }
                    >
                      {batch.status === "completed"
                        ? "全部完成"
                        : batch.status === "partial"
                          ? "部分失败"
                          : "全部失败"}
                    </span>
                    <span className="text-ink-3">
                      {batch.runs.length} 个版本
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-2 px-3 py-2">
                    {batch.runs.map((run) => (
                      <button
                        key={run.runId}
                        onClick={() => void openHistoryRun(run)}
                        className={`max-w-[16rem] truncate rounded-md border px-2.5 py-1 text-xs transition ${
                          reviewing?.runId === run.runId
                            ? "border-accent bg-accent text-white"
                            : "border-hairline-strong bg-surface text-ink-2 hover:border-ink-3 hover:text-ink"
                        }`}
                        title={run.topic}
                      >
                        {run.variantName ??
                          (batch.runs.length === 1 ? "单次生成" : run.topic)}
                        {run.durationMs !== null
                          ? ` · ${formatDuration(run.durationMs)}`
                          : ""}
                      </button>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {/* 回看态提示：只读展示，不建立 SSE */}
      {reviewing && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-blue-200 bg-blue-50/70 px-4 py-2.5 text-sm">
          <span className="font-medium text-blue-800">历史回看</span>
          <span className="text-blue-700">
            {reviewing.variantName ? `${reviewing.variantName} · ` : ""}
            {reviewing.finishedAt ? formatTime(reviewing.finishedAt) : ""}
          </span>
          <span className="text-xs text-blue-600">
            只读快照，没有实时流；重新生成会创建新任务
          </span>
          <button
            onClick={exitReview}
            className="ml-auto rounded-md border border-blue-300 bg-white px-2.5 py-1 text-xs text-blue-700"
          >
            退出回看
          </button>
        </div>
      )}

      {/* 运行控制台：模式切换 + 输入 + 动作收进一张卡，按钮按权重分主次 */}
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-[11px] tabular-nums text-ink-3">01</span>
        <h2 className="text-sm font-semibold text-ink">运行控制台</h2>
        <span className="text-xs text-ink-3">选择模式、输入选题、启动流水线</span>
      </div>

      <section className={`${CARD} overflow-hidden`}>
        <div className="flex gap-1 border-b border-hairline bg-canvas/70 p-2">
          {MODE_TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => switchMode(tab.id)}
              disabled={isRunning}
              className={`flex-1 rounded-md px-4 py-2 text-sm font-medium transition disabled:opacity-40 ${
                mode === tab.id
                  ? "bg-surface text-ink shadow-card"
                  : "text-ink-2 hover:text-ink"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="flex flex-col gap-3 p-4">
          {mode === "single" && (
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !isRunning) handleStartSingle();
                }}
                placeholder="输入一个选题，例如：AI 编程会不会取代程序员"
                className="flex-1 rounded-lg border border-hairline-strong bg-surface px-3.5 py-2.5 text-sm text-ink outline-none transition placeholder:text-ink-3 focus:border-accent focus:ring-4 focus:ring-accent/10"
              />
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={handleStartSingle}
                  disabled={isRunning || !topic.trim()}
                  className={BTN_PRIMARY}
                >
                  {isRunning ? "运行中…" : "开始生成"}
                </button>
                <button
                  onClick={handleStopAll}
                  disabled={!isRunning}
                  className={BTN_GHOST}
                >
                  全部中断
                </button>
                <button
                  onClick={handleExportAll}
                  disabled={!isCompleted}
                  className={BTN_GHOST}
                >
                  导出全部
                </button>
              </div>
            </div>
          )}

          {showBatchInput && (
            <div className="flex flex-col gap-3">
              {mode === "multi-topic" ? (
                <textarea
                  value={multiTopic}
                  onChange={(e) => setMultiTopic(e.target.value)}
                  placeholder={"每行一个选题，最多 3 个，例如：\nAI 编程会不会取代程序员\n远程办公的利与弊\n如何培养专注力"}
                  rows={4}
                  className="w-full rounded-lg border border-hairline-strong bg-surface px-3.5 py-3 text-sm text-ink outline-none transition placeholder:text-ink-3 focus:border-accent focus:ring-4 focus:ring-accent/10"
                />
              ) : (
                <div className="flex flex-col gap-3">
                  <input
                    value={topic}
                    onChange={(e) => setTopic(e.target.value)}
                    placeholder="输入一个选题，将按三个维度各生成一版"
                    className="w-full rounded-lg border border-hairline-strong bg-surface px-3.5 py-2.5 text-sm text-ink outline-none transition placeholder:text-ink-3 focus:border-accent focus:ring-4 focus:ring-accent/10"
                  />
                  <div className="flex flex-wrap gap-2">
                    {VARIANTS.map((v) => (
                      <div
                        key={v.key}
                        className="flex flex-col gap-0.5 rounded-lg border border-hairline bg-canvas/60 px-3 py-2"
                      >
                        <span className="text-xs font-medium text-ink">{v.name}</span>
                        <span className="text-[11px] text-ink-3">{v.angle}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={handleStartBatch}
                  disabled={
                    isRunning ||
                    (mode === "multi-topic"
                      ? !multiTopic.trim()
                      : !topic.trim())
                  }
                  className={BTN_PRIMARY}
                >
                  {isRunning ? "运行中…" : "开始批量生成"}
                </button>
                <button
                  onClick={handleStopAll}
                  disabled={!isRunning}
                  className={BTN_GHOST}
                >
                  全部中断
                </button>
                <button
                  onClick={handleExportAll}
                  disabled={!isCompleted}
                  className={BTN_GHOST}
                >
                  导出当前套
                </button>
              </div>
            </div>
          )}
        </div>

        {/* 运行状态条：常驻在控制台底部 */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-hairline bg-canvas/50 px-4 py-2 text-xs">
          <span className="text-ink-3">流水线状态</span>
          <span className="flex items-center gap-1.5 font-medium text-ink">
            <span className={`h-1.5 w-1.5 rounded-full ${statusDotClass}`} />
            {statusText}
          </span>
          {currentRunId && (
            <span className="font-mono text-[11px] text-ink-3">
              runId {currentRunId.slice(0, 8)}
            </span>
          )}
          {notice && <span className="text-red-600">{notice}</span>}
          {reconnectNotice && (
            <span className="text-amber-600">{reconnectNotice}</span>
          )}
        </div>
      </section>

      {/* 批量模式全局进度 */}
      {mode !== "single" && batchTotal > 0 && (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <span className="font-medium text-ink">
              批量 {batchTotal} {batchUnit}：已完成 {batchCompleted}/{batchTotal}
              {batchRunning
                ? `，当前运行 ${batchRunning.label}`
                : batchCompleted === batchTotal
                  ? "，全部完成"
                  : ""}
            </span>
            {batchFailed > 0 && (
              <span className="text-red-600">失败 {batchFailed}</span>
            )}
            {batchAborted > 0 && (
              <span className="text-amber-600">已中断 {batchAborted}</span>
            )}
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-200">
            <div
              className="h-full rounded-full bg-accent transition-all"
              style={{ width: `${batchPercent}%` }}
            />
          </div>
        </div>
      )}

      {/* 批量模式 tabs */}
      {mode !== "single" && tasks.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {tasks.map((t, idx) => (
            <button
              key={t.id}
              onClick={() => setActiveTaskIndex(idx)}
              className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs transition ${
                idx === activeTaskIndex
                  ? "border-accent bg-accent text-white"
                  : "border-hairline bg-surface text-ink-2 hover:text-ink"
              }`}
            >
              <span
                className={`h-2 w-2 rounded-full ${
                  t.status === "completed"
                    ? "bg-green-500"
                    : t.status === "running"
                      ? "bg-blue-500 animate-pulse"
                      : t.status === "failed"
                        ? "bg-red-500"
                        : t.status === "aborted"
                          ? "bg-amber-500"
                          : "bg-neutral-300"
                }`}
              />
              {t.label}
            </button>
          ))}
        </div>
      )}

      {/* 执行监视 */}
      <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-[11px] tabular-nums text-ink-3">02</span>
          <h2 className="text-sm font-semibold text-ink">执行监视</h2>
          <span className="text-xs text-ink-3">5 个 Agent 节点</span>
        </div>
        <button onClick={toggleAll} className={BTN_QUIET}>
          {allExpanded ? "全部收起" : "全部展开"}
        </button>
      </div>

      {/* 卡片区 */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 md:items-start xl:grid-cols-4">
        {NODE_ORDER.map((nodeId) => {
          const node = currentNodes[nodeId];
          const style = STATUS_STYLE[node.status];
          const isPlanner = nodeId === "planner";
          const isExpanded = !!expanded[nodeId];
          const canStop = node.status === "running" || node.status === "pending";
          const canRerun =
            !isPlanner &&
            !reviewing &&
            currentNodes.planner.status === "completed" &&
            (node.status === "failed" ||
              node.status === "cancelled" ||
              node.status === "completed");

          return (
            <section
              key={nodeId}
              className={`relative flex flex-col gap-3 overflow-hidden rounded-xl border border-hairline bg-surface p-4 shadow-card transition duration-200 hover:-translate-y-0.5 hover:shadow-pop ${
                isPlanner ? "md:col-span-2 xl:col-span-4" : ""
              }`}
            >
              {/* 状态用左色条表达，卡片底始终中性 */}
              <span
                className={`absolute inset-y-0 left-0 w-[3px] ${style.bar}`}
                aria-hidden
              />
              <button
                type="button"
                onClick={() => toggleNode(nodeId)}
                className="flex w-full items-start justify-between gap-2 text-left"
              >
                <span className="flex items-center gap-2.5">
                  <span
                    className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg text-[13px] font-semibold ring-1 ${NODE_META[nodeId].tint}`}
                  >
                    {NODE_META[nodeId].glyph}
                  </span>
                  <span className="text-sm font-semibold text-ink">
                    {NODE_META[nodeId].name}
                  </span>
                  {isPlanner && (
                    <span className="rounded border border-hairline bg-canvas px-1.5 py-0.5 text-[10px] text-ink-3">
                      结构化提纲
                    </span>
                  )}
                </span>
                <span className="flex items-center gap-2">
                  <span className={`rounded-full px-2 py-0.5 text-xs ${style.badge}`}>
                    {style.label}
                    {node.attempt > 1 ? ` · 第${node.attempt}次` : ""}
                  </span>
                  <span className="text-xs text-ink-3">
                    {isExpanded ? "收起" : "展开"}
                  </span>
                </span>
              </button>

              <p className="text-xs text-ink-3">{NODE_META[nodeId].desc}</p>

              {/* 执行指标：耗时 / token / 重试，折叠态也展示 */}
              {node.metrics && (
                <div className="flex flex-wrap items-center gap-1.5 text-[11px] tabular-nums">
                  <span className="rounded border border-hairline bg-canvas px-1.5 py-0.5 text-ink-2">
                    {node.metrics.durationMs !== undefined
                      ? formatDuration(node.metrics.durationMs)
                      : "计时中"}
                  </span>
                  {node.metrics.usage && (
                    <span className="rounded border border-hairline bg-canvas px-1.5 py-0.5 text-ink-2">
                      {formatTokens(node.metrics.usage.totalTokens)} tokens
                      {node.metrics.usageEstimated ? "（估算）" : ""}
                    </span>
                  )}
                  {node.metrics.retries > 0 && (
                    <span className="rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-amber-700">
                      重试 {node.metrics.retries} 次
                    </span>
                  )}
                </div>
              )}

              {node.error && (
                <p className="rounded-md border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-700">
                  {node.error}
                </p>
              )}

              {/* 折叠态：只给状态和内容预览 */}
              {!isExpanded && (
                <div className="flex flex-col gap-2">
                  {nodeId === "image" && node.imageUrl && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={node.imageUrl}
                      alt="配图结果"
                      className="w-full rounded-lg border border-hairline object-cover"
                    />
                  )}
                  {node.content ? (
                    <>
                      <p className="truncate text-xs text-ink-2">
                        {node.content.trim().split("\n")[0]}
                      </p>
                      <span className="text-[11px] text-ink-3">
                        已生成 {node.content.length} 字
                      </span>
                    </>
                  ) : (
                    <span className="text-[11px] text-ink-3">（暂无内容）</span>
                  )}
                </div>
              )}

              {isExpanded && (
                <>
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => handleStopNode(nodeId)}
                      disabled={!isRunning || !canStop}
                      className={BTN_QUIET}
                    >
                      中断
                    </button>
                    {!isPlanner && (
                      <button
                        onClick={() => handleRerun(nodeId)}
                        disabled={!canRerun}
                        className={BTN_QUIET}
                      >
                        重跑
                      </button>
                    )}
                    {!isPlanner && nodeId !== "image" && node.status === "completed" && (
                      <button
                        onClick={() => handleCopy(nodeId)}
                        disabled={!!copied[nodeId]}
                        className={`rounded-md border px-2.5 py-1 text-xs transition ${
                          copied[nodeId]
                            ? "border-hairline bg-canvas text-ink-3"
                            : "border-hairline-strong bg-surface text-ink-2 hover:text-ink"
                        }`}
                      >
                        {copied[nodeId] ? "已复制" : "复制"}
                      </button>
                    )}
                  </div>

                  {nodeId === "image" && node.imageUrl && (
                    <>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={node.imageUrl}
                        alt="配图结果"
                        className="w-full rounded-lg border border-hairline object-cover"
                      />
                      <button onClick={handleDownloadImage} className={BTN_QUIET}>
                        下载图片
                      </button>
                    </>
                  )}

                  {nodeId === "image" &&
                    node.status === "running" &&
                    !node.imageUrl &&
                    node.content && (
                      <p className="rounded-md border border-blue-200 bg-blue-50 px-2 py-1 text-xs text-blue-700">
                        提示词已生成，正在调用 Seedream 出图…
                      </p>
                    )}

                  <pre
                    className={`overflow-auto whitespace-pre-wrap break-words rounded-lg border border-hairline bg-canvas p-3 text-xs leading-relaxed text-ink-2 ${
                      isPlanner ? "max-h-64 font-mono text-[11px]" : "max-h-80"
                    }`}
                  >
                    {node.content || "（暂无内容）"}
                  </pre>
                </>
              )}
            </section>
          );
        })}
      </div>

      {/* 空态提示：还没跑过任何任务时告诉用户下一步做什么 */}
      {!isRunning &&
        !reviewing &&
        currentNodes.planner.status === "pending" && (
          <p className="text-center text-xs text-ink-3">
            在上面输入一个选题并点击「开始生成」，五个 Agent 会依次亮起
          </p>
        )}

      {/* 执行报告：单次模式看整条流水线，批量模式看当前选中任务 */}
      {currentReport && (
        <ReportCard
          report={currentReport}
          title={
            mode === "single"
              ? "本次流水线执行报告"
              : `${tasks[activeTaskIndex]?.label ?? ""} 执行报告`
          }
        />
      )}

      {/* 批量任务全部结束后给出横向汇总 */}
      {mode !== "single" &&
        batchTotal > 1 &&
        tasks.every((t) => t.status !== "running" && t.status !== "pending") && (
          <BatchSummary tasks={tasks} />
        )}
      </main>
    </>
  );
}
