import { createRun, startRun } from "@/lib/orchestrator";
import { resolveStyles } from "@/lib/style-store";
import { isVariantKey, type VariantKey } from "@/lib/variants";

/**
 * POST /api/run
 *
 * 只负责创建运行并立即返回 runId，真正的编排在后台异步跑。
 * 前端拿到 runId 后去连 /api/stream/[runId] 看实时状态。
 *
 * variant 可选：多版模式传入创作维度，单次模式不传。
 * styles 可选：下游三个内容 Agent 各选一套风格模板，按「渠道 → 模板 id」传。
 */
export async function POST(req: Request) {
  let topic = "";
  let variantKey: VariantKey | undefined;
  let batchId: string | undefined;
  let styleSelection: unknown;
  try {
    const body = (await req.json()) as {
      topic?: unknown;
      variant?: unknown;
      batchId?: unknown;
      styles?: unknown;
    };
    topic = typeof body.topic === "string" ? body.topic.trim() : "";
    styleSelection = body.styles;
    if (isVariantKey(body.variant)) variantKey = body.variant;
    else if (body.variant !== undefined) {
      return Response.json({ error: "未知的创作维度 variant" }, { status: 400 });
    }
    // 批量模式下一次点击创建的多个 run 共用同一个 batchId，历史回看按批次聚合
    if (typeof body.batchId === "string" && /^[a-zA-Z0-9-]{1,64}$/.test(body.batchId)) {
      batchId = body.batchId;
    }
  } catch {
    return Response.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }

  if (!topic) {
    return Response.json({ error: "缺少选题 topic" }, { status: 400 });
  }

  // 创建 run 时把模板解析成快照存进 RunState：
  // 之后模板被编辑或删除，本次产出与历史回看都不受影响。
  const resolved = await resolveStyles(styleSelection);
  if (!resolved.ok) {
    return Response.json({ error: resolved.error }, { status: 400 });
  }

  const run = createRun(topic, variantKey, batchId, resolved.styles);
  startRun(run.id);

  return Response.json({ runId: run.id });
}
