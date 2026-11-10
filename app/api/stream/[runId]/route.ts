import { subscribe } from "@/lib/orchestrator";

/**
 * GET /api/stream/[runId]
 *
 * SSE 推送。连接建立时先收到一个全量 snapshot（含节点内容、执行指标、终态摘要与报告），
 * 之后只推增量事件。前端断线重连时浏览器会自动重连，服务端重新下发 snapshot，
 * 一次传输即可收敛全部状态，不需要回放历史 token 事件。
 *
 * 保活：每 15s 推一行 SSE 注释，防止反向代理按空闲时间切断长连接。
 */

const HEARTBEAT_MS = 15_000;

export async function GET(
  req: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params;
  const encoder = new TextEncoder();

  let cleanup: (() => void) | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let seq = 0;
      let heartbeat: ReturnType<typeof setInterval> | null = null;

      const send = (event: string, data: unknown) => {
        if (closed) return;
        seq += 1;
        try {
          controller.enqueue(
            encoder.encode(
              `id: ${seq}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
            ),
          );
        } catch {
          closed = true;
        }
      };

      const close = () => {
        if (closed) return;
        closed = true;
        if (heartbeat) {
          clearInterval(heartbeat);
          heartbeat = null;
        }
        try {
          controller.close();
        } catch {
          // 已关闭则忽略
        }
      };

      const unsubscribe = subscribe(runId, (e) => {
        switch (e.type) {
          case "snapshot":
            send("snapshot", e.snapshot);
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
            send("run:done", { summary: e.summary, report: e.report });
            break;
          case "run:failed":
            send("run:failed", {
              message: e.message,
              summary: e.summary,
              report: e.report,
            });
            break;
        }
      });

      if (!unsubscribe) {
        send("error", { message: "run 不存在或已过期" });
        close();
        return;
      }

      heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`: ping ${Date.now()}\n\n`));
        } catch {
          closed = true;
        }
      }, HEARTBEAT_MS);

      cleanup = () => {
        unsubscribe();
        close();
      };

      req.signal.addEventListener("abort", cleanup);
    },
    cancel() {
      cleanup?.();
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
