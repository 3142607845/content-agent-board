import { createRun, startRun } from "@/lib/orchestrator";
import { isVariantKey, type VariantKey } from "@/lib/variants";

/**
 * POST /api/run
 *
 * 只负责创建运行并立即返回 runId，真正的编排在后台异步跑。
 * 前端拿到 runId 后去连 /api/stream/[runId] 看实时状态。
 *
 * variant 可选：多版模式传入创作维度，单次模式不传。
 */
export async function POST(req: Request) {
  let topic = "";
  let variantKey: VariantKey | undefined;
  try {
    const body = (await req.json()) as { topic?: unknown; variant?: unknown };
    topic = typeof body.topic === "string" ? body.topic.trim() : "";
    if (isVariantKey(body.variant)) variantKey = body.variant;
    else if (body.variant !== undefined) {
      return Response.json({ error: "未知的创作维度 variant" }, { status: 400 });
    }
  } catch {
    return Response.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }

  if (!topic) {
    return Response.json({ error: "缺少选题 topic" }, { status: 400 });
  }

  const run = createRun(topic, variantKey);
  startRun(run.id);

  return Response.json({ runId: run.id });
}
