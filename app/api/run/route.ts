import { createRun, startRun } from "@/lib/orchestrator";

/**
 * POST /api/run
 *
 * 只负责创建运行并立即返回 runId，真正的编排在后台异步跑。
 * 前端拿到 runId 后去连 /api/stream/[runId] 看实时状态。
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

  const run = createRun(topic);
  startRun(run.id);

  return Response.json({ runId: run.id });
}
