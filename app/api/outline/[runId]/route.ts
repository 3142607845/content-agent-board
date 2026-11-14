import { regenerateFromOutline } from "@/lib/orchestrator";

/**
 * POST /api/outline/[runId]
 * body: { "outline": { "topic": "...", "outline": { ... } } }
 *
 * 人工编辑提纲后，只重跑提纲有变化的下游渠道，不重新执行策划 Agent。
 * 提交内容会作为新版本追加进版本链；与历史版本一致时直接激活该版本。
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params;

  let outline: unknown;
  try {
    const body = (await req.json()) as { outline?: unknown };
    outline = body.outline;
  } catch {
    return Response.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }

  if (outline === undefined) {
    return Response.json({ error: "缺少 outline 字段" }, { status: 400 });
  }

  const result = regenerateFromOutline(runId, outline);
  if (!result.ok) {
    const status =
      result.code === "not_found" ? 404 : result.code === "busy" ? 409 : 400;
    return Response.json({ error: result.error }, { status });
  }

  return Response.json({
    ok: true,
    version: result.version,
    versions: result.versions,
    affected: result.affected,
  });
}
