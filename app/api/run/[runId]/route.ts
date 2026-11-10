import { buildSnapshot, getRun } from "@/lib/orchestrator";

/**
 * GET /api/run/[runId]
 *
 * 返回该 run 的全量快照（节点状态、执行指标、终态摘要、执行报告），
 * 与 SSE 首次下发的 snapshot 结构完全一致。
 *
 * SSE 是流式的、断了就没了；这个接口用于调试、演示和任何需要一次性取全量的场景。
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params;
  const run = getRun(runId);
  if (!run) {
    return Response.json({ error: "run 不存在或已过期" }, { status: 404 });
  }

  return Response.json(buildSnapshot(run), {
    headers: { "Cache-Control": "no-store" },
  });
}
