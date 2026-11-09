"use client";

import { useRef, useState } from "react";

type Status = "idle" | "running" | "done" | "error" | "aborted";

const STATUS_TEXT: Record<Status, string> = {
  idle: "等待输入",
  running: "生成中",
  done: "完成",
  error: "失败",
  aborted: "已中断",
};

export default function Home() {
  const [topic, setTopic] = useState("");
  const [output, setOutput] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  async function handleRun() {
    const value = topic.trim();
    if (!value || status === "running") return;

    const controller = new AbortController();
    abortRef.current = controller;

    setStatus("running");
    setOutput("");
    setErrorMsg("");

    try {
      const res = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic: value }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        const detail = await res.text().catch(() => "");
        throw new Error(`请求失败 ${res.status} ${detail.slice(0, 200)}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let nextStatus: Status = "done";

      while (true) {
        const { done, value: chunk } = await reader.read();
        if (done) break;

        buffer += decoder.decode(chunk, { stream: true });

        // SSE 事件之间用空行分隔，最后一段可能不完整，留到下一轮
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() ?? "";

        for (const block of blocks) {
          let event = "message";
          const dataLines: string[] = [];

          for (const line of block.split("\n")) {
            if (line.startsWith("event:")) {
              event = line.slice(6).trim();
            } else if (line.startsWith("data:")) {
              dataLines.push(line.slice(5).trim());
            }
          }

          if (dataLines.length === 0) continue;
          const payload = JSON.parse(dataLines.join("\n")) as {
            text?: string;
            message?: string;
          };

          if (event === "token" && payload.text) {
            setOutput((prev) => prev + payload.text);
          } else if (event === "error") {
            nextStatus = "error";
            setErrorMsg(payload.message ?? "未知错误");
          } else if (event === "aborted") {
            nextStatus = "aborted";
          }
        }
      }

      setStatus(nextStatus);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        setStatus("aborted");
      } else {
        setStatus("error");
        setErrorMsg(err instanceof Error ? err.message : String(err));
      }
    } finally {
      abortRef.current = null;
    }
  }

  function handleAbort() {
    abortRef.current?.abort();
  }

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6 px-6 py-10">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">Content Agent Board</h1>
        <p className="text-sm text-neutral-500">
          阶段 1 验证：只跑策划 Agent，输出四个渠道的提纲 JSON
        </p>
      </header>

      <div className="flex flex-col gap-3 sm:flex-row">
        <input
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleRun();
          }}
          placeholder="输入一个选题，例如：AI 编程会不会取代程序员"
          className="flex-1 rounded-lg border border-neutral-300 bg-white px-4 py-2.5 text-sm outline-none focus:border-neutral-500"
        />
        <button
          onClick={handleRun}
          disabled={status === "running" || !topic.trim()}
          className="rounded-lg bg-neutral-900 px-5 py-2.5 text-sm font-medium text-white disabled:opacity-40"
        >
          {status === "running" ? "生成中…" : "生成提纲"}
        </button>
        <button
          onClick={handleAbort}
          disabled={status !== "running"}
          className="rounded-lg border border-neutral-300 px-5 py-2.5 text-sm font-medium disabled:opacity-40"
        >
          中断
        </button>
      </div>

      <div className="flex items-center gap-3 text-sm">
        <span className="text-neutral-500">状态</span>
        <span
          className={
            status === "error"
              ? "font-medium text-red-600"
              : status === "done"
                ? "font-medium text-green-600"
                : "font-medium"
          }
        >
          {STATUS_TEXT[status]}
        </span>
        {errorMsg && <span className="text-red-600">{errorMsg}</span>}
      </div>

      <pre className="min-h-[320px] flex-1 overflow-auto rounded-lg border border-neutral-200 bg-neutral-50 p-4 text-xs leading-relaxed whitespace-pre-wrap break-words">
        {output || "（策划 Agent 的输出会流式出现在这里）"}
      </pre>
    </main>
  );
}
