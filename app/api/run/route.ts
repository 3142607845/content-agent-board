import { PlannerAgent } from "@/lib/agents/planner";

/**
 * POST /api/run
 *
 * 阶段 1 只跑策划 Agent：收选题，流式返回提纲 JSON。
 * 阶段 2 会拆成「启动 run」和「订阅 stream/:runId」两个接口。
 */
export async function POST(req: Request) {
  let topic = "";
  try {
    const body = (await req.json()) as { topic?: unknown };
    topic = typeof body.topic === "string" ? body.topic.trim() : "";
  } catch {
    return Response.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }

  if (!topic) {
    return Response.json({ error: "缺少选题 topic" }, { status: 400 });
  }

  const planner = new PlannerAgent();
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;

      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        } catch {
          // 前端已断开，忽略后续写入
          closed = true;
        }
      };

      try {
        send("start", { nodeId: planner.id, model: planner.modelId });

        await planner.run(topic, {
          signal: req.signal,
          onToken: (text) => send("token", { text }),
        });

        send("done", { nodeId: planner.id });
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          send("aborted", { nodeId: planner.id });
        } else {
          send("error", {
            nodeId: planner.id,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      } finally {
        if (!closed) {
          closed = true;
          try {
            controller.close();
          } catch {
            // 已关闭则忽略
          }
        }
      }
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
