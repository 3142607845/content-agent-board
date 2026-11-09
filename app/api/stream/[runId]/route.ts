import { subscribe } from "@/lib/orchestrator";

/**
 * GET /api/stream/[runId]
 *
 * SSE 推送。连接建立时先收到一个 snapshot（含所有节点当前状态和已累积内容），
 * 之后只推增量事件。这样前端断线重连不用回放海量 token。
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params;
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;

      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        } catch {
          closed = true;
        }
      };

      const close = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // 已关闭则忽略
        }
      };

      const unsubscribe = subscribe(runId, (e) => {
        switch (e.type) {
          case "snapshot":
            send("snapshot", { status: e.status, nodes: e.nodes });
            break;
          case "node:start":
            send("node:start", {
              nodeId: e.nodeId,
              name: e.name,
              model: e.model,
              attempt: e.attempt,
            });
            break;
          case "node:token":
            send("node:token", { nodeId: e.nodeId, text: e.text });
            break;
          case "node:image":
            send("node:image", { nodeId: e.nodeId, url: e.url, prompt: e.prompt });
            break;
          case "node:done":
            send("node:done", { nodeId: e.nodeId });
            break;
          case "node:error":
            send("node:error", { nodeId: e.nodeId, message: e.message });
            break;
          case "node:cancelled":
            send("node:cancelled", { nodeId: e.nodeId });
            break;
          case "run:done":
            send("run:done", { summary: e.summary });
            break;
          case "run:failed":
            send("run:failed", { message: e.message });
            break;
        }
      });

      if (!unsubscribe) {
        send("error", { message: "run 不存在或已过期" });
        close();
        return;
      }

      req.signal.addEventListener("abort", () => {
        unsubscribe();
        close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
