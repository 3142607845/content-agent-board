"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AgentNodeState,
  NodeId,
  NodeStatus,
  RunStatus,
} from "@/lib/orchestrator";

/**
 * 阶段 2 简易看板：5 个 Agent 分区平铺，先跑通状态流转、中断和重跑。
 * 阶段 3 会换成 React Flow 画布。
 */

const NODE_ORDER: NodeId[] = ["planner", "longform", "script", "xhs", "image"];

const NODE_META: Record<NodeId, { desc: string }> = {
  planner: { desc: "拆解选题，产出四渠道提纲 JSON" },
  longform: { desc: "公众号长文，2000 字以上" },
  script: { desc: "短视频分镜脚本" },
  xhs: { desc: "小红书笔记正文与标签" },
  image: { desc: "扩写提示词并调用 Seedream 出图" },
};

const STATUS_STYLE: Record<
  NodeStatus,
  { label: string; card: string; dot: string }
> = {
  pending: {
    label: "等待",
    card: "border-neutral-200 bg-neutral-50",
    dot: "bg-neutral-300",
  },
  running: {
    label: "生成中",
    card: "border-blue-300 bg-blue-50",
    dot: "bg-blue-500 animate-pulse",
  },
  completed: {
    label: "完成",
    card: "border-green-300 bg-green-50",
    dot: "bg-green-500",
  },
  failed: {
    label: "失败",
    card: "border-red-300 bg-red-50",
    dot: "bg-red-500",
  },
  cancelled: {
    label: "已中断",
    card: "border-amber-300 bg-amber-50",
    dot: "bg-amber-500",
  },
};

const RUN_STATUS_TEXT: Record<RunStatus, string> = {
  running: "流水线运行中",
  completed: "全部完成",
  failed: "存在失败节点",
  aborted: "已中断",
};

function emptyNodes(): Record<NodeId, AgentNodeState> {
  const nodes = {} as Record<NodeId, AgentNodeState>;
  for (const id of NODE_ORDER) {
    nodes[id] = {
      id,
      name: "",
      status: "pending",
      content: "",
      attempt: 0,
    };
  }
  return nodes;
}

export default function Home() {
  const [topic, setTopic] = useState("");
  const [nodes, setNodes] = useState<Record<NodeId, AgentNodeState>>(emptyNodes);
  const [runStatus, setRunStatus] = useState<RunStatus | "idle">("idle");
  const [runId, setRunId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const esRef = useRef<EventSource | null>(null);

  // 卸载时关闭 SSE
  useEffect(() => () => esRef.current?.close(), []);

  const patchNode = useCallback(
    (nodeId: NodeId, patch: Partial<AgentNodeState>) => {
      setNodes((prev) => ({ ...prev, [nodeId]: { ...prev[nodeId], ...patch } }));
    },
    [],
  );

  const connect = useCallback((id: string) => {
    esRef.current?.close();

    const es = new EventSource(`/api/stream/${id}`);
    esRef.current = es;

    es.addEventListener("snapshot", (ev) => {
      const data = JSON.parse((ev as MessageEvent).data) as {
        status: RunStatus;
        nodes: Record<NodeId, AgentNodeState>;
      };
      setNodes(data.nodes);
      setRunStatus(data.status);
    });

    // 收到 start 就清空该节点文本，策划自动重试时会带上 attempt=2
    es.addEventListener("node:start", (ev) => {
      const d = JSON.parse((ev as MessageEvent).data) as {
        nodeId: NodeId;
        attempt: number;
      };
      patchNode(d.nodeId, {
        status: "running",
        content: "",
        imageUrl: undefined,
        error: undefined,
        attempt: d.attempt,
      });
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
      patchNode(d.nodeId, { imageUrl: d.url });
    });

    es.addEventListener("node:done", (ev) => {
      const d = JSON.parse((ev as MessageEvent).data) as { nodeId: NodeId };
      patchNode(d.nodeId, { status: "completed" });
    });

    es.addEventListener("node:error", (ev) => {
      const d = JSON.parse((ev as MessageEvent).data) as {
        nodeId: NodeId;
        message: string;
      };
      patchNode(d.nodeId, { status: "failed", error: d.message });
    });

    es.addEventListener("node:cancelled", (ev) => {
      const d = JSON.parse((ev as MessageEvent).data) as { nodeId: NodeId };
      patchNode(d.nodeId, { status: "cancelled" });
    });

    es.addEventListener("run:done", () => {
      setRunStatus((prev) => (prev === "aborted" ? prev : "completed"));
    });

    es.addEventListener("run:failed", (ev) => {
      const d = JSON.parse((ev as MessageEvent).data) as { message: string };
      setRunStatus("failed");
      setNotice(d.message);
    });

    es.onerror = () => {
      // EventSource 会自动重连，重连后服务端会重发 snapshot
    };
  }, [patchNode]);

  async function handleStart() {
    const value = topic.trim();
    if (!value) return;

    esRef.current?.close();
    setNodes(emptyNodes());
    setRunStatus("running");
    setNotice("");

    try {
      const res = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic: value }),
      });
      const data = (await res.json()) as { runId?: string; error?: string };
      if (!res.ok || !data.runId) {
        throw new Error(data.error ?? `启动失败 ${res.status}`);
      }
      setRunId(data.runId);
      connect(data.runId);
    } catch (err) {
      setRunStatus("failed");
      setNotice(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleStopAll() {
    if (!runId) return;
    await fetch(`/api/stop/${runId}`, { method: "POST" });
    setRunStatus("aborted");
  }

  async function handleStopNode(nodeId: NodeId) {
    if (!runId) return;
    await fetch(`/api/stop/${runId}?nodeId=${nodeId}`, { method: "POST" });
  }

  async function handleRerun(nodeId: NodeId) {
    if (!runId) return;
    setNotice("");
    const res = await fetch(`/api/rerun/${nodeId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId }),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setNotice(data.error ?? `重跑失败 ${res.status}`);
      return;
    }
    setRunStatus("running");
  }

  const running = runStatus === "running";

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 px-6 py-10">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">Content Agent Board</h1>
        <p className="text-sm text-neutral-500">
          输入选题 → 策划 Agent 拆解提纲 → 长文 / 脚本 / 小红书 / 配图 四路并行
        </p>
      </header>

      <div className="flex flex-col gap-3 sm:flex-row">
        <input
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !running) handleStart();
          }}
          placeholder="输入一个选题，例如：AI 编程会不会取代程序员"
          className="flex-1 rounded-lg border border-neutral-300 bg-white px-4 py-2.5 text-sm outline-none focus:border-neutral-500"
        />
        <button
          onClick={handleStart}
          disabled={running || !topic.trim()}
          className="rounded-lg bg-neutral-900 px-5 py-2.5 text-sm font-medium text-white disabled:opacity-40"
        >
          {running ? "运行中…" : "开始生成"}
        </button>
        <button
          onClick={handleStopAll}
          disabled={!running}
          className="rounded-lg border border-neutral-300 px-5 py-2.5 text-sm font-medium disabled:opacity-40"
        >
          全部中断
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="text-neutral-500">流水线状态</span>
        <span
          className={
            runStatus === "failed"
              ? "font-medium text-red-600"
              : runStatus === "completed"
                ? "font-medium text-green-600"
                : runStatus === "aborted"
                  ? "font-medium text-amber-600"
                  : "font-medium"
          }
        >
          {runStatus === "idle" ? "未开始" : RUN_STATUS_TEXT[runStatus]}
        </span>
        {runId && (
          <span className="text-xs text-neutral-400">runId: {runId.slice(0, 8)}</span>
        )}
        {notice && <span className="text-red-600">{notice}</span>}
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
        {NODE_ORDER.map((nodeId) => {
          const node = nodes[nodeId];
          const style = STATUS_STYLE[node.status];
          const isPlanner = nodeId === "planner";
          const canStop = node.status === "running" || node.status === "pending";
          const canRerun =
            !isPlanner &&
            nodes.planner.status === "completed" &&
            (node.status === "failed" ||
              node.status === "cancelled" ||
              node.status === "completed");

          return (
            <section
              key={nodeId}
              className={`flex flex-col gap-3 rounded-xl border p-4 ${style.card} ${
                isPlanner ? "md:col-span-4" : ""
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className={`h-2 w-2 rounded-full ${style.dot}`} />
                  <h2 className="text-sm font-semibold">{node.name || nodeId}</h2>
                </div>
                <span className="rounded-full bg-white/70 px-2 py-0.5 text-xs text-neutral-600">
                  {style.label}
                  {node.attempt > 1 ? ` · 第${node.attempt}次` : ""}
                </span>
              </div>

              <p className="text-xs text-neutral-500">{NODE_META[nodeId].desc}</p>

              <div className="flex gap-2">
                <button
                  onClick={() => handleStopNode(nodeId)}
                  disabled={!running || !canStop}
                  className="rounded-md border border-neutral-300 bg-white px-2.5 py-1 text-xs disabled:opacity-40"
                >
                  中断
                </button>
                {!isPlanner && (
                  <button
                    onClick={() => handleRerun(nodeId)}
                    disabled={!canRerun}
                    className="rounded-md border border-neutral-300 bg-white px-2.5 py-1 text-xs disabled:opacity-40"
                  >
                    重跑
                  </button>
                )}
              </div>

              {node.error && (
                <p className="rounded-md bg-red-100 px-2 py-1 text-xs text-red-700">
                  {node.error}
                </p>
              )}

              {nodeId === "image" && node.imageUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={node.imageUrl}
                  alt="配图结果"
                  className="w-full rounded-lg border border-neutral-200 object-cover"
                />
              )}

              <pre
                className={`overflow-auto whitespace-pre-wrap break-words rounded-lg bg-white/70 p-3 text-xs leading-relaxed text-neutral-700 ${
                  isPlanner ? "max-h-64" : "max-h-80 min-h-32"
                }`}
              >
                {node.content || "（暂无内容）"}
              </pre>
            </section>
          );
        })}
      </div>
    </main>
  );
}
