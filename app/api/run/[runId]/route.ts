import { buildSnapshot, getRun } from "@/lib/orchestrator";
import { loadRunSnapshot } from "@/lib/history";

/**
 * GET /api/run/[runId]
 *
 * 返回该 run 的全量快照（节点状态、执行指标、终态摘要、执行报告），
 * 与 SSE 首次下发的 snapshot 结构完全一致。
 *
 * 先查内存；内存未命中时回退读 data/runs 落盘快照，
 * 这样进程重启后历史任务依然可以完整回看。
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params;

  const run = getRun(runId);
  if (run) {
    return Response.json(buildSnapshot(run), {
      headers: { "Cache-Control": "no-store" },
    });
  }

  const saved = await loadRunSnapshot(runId);
  if (!saved) {
    return Response.json({ error: "run 不存在或已过期" }, { status: 404 });
  }

  return Response.json(saved, {
    headers: { "Cache-Control": "no-store" },
  });
}
