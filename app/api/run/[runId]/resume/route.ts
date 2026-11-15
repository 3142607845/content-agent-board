import { buildSnapshot, getRun, resumeRun } from "@/lib/orchestrator";
import { loadRunSnapshot } from "@/lib/history";

/**
 * POST /api/run/[runId]/resume
 *
 * 把一次历史运行重新装回内存，让它从「只读快照」变成可继续编辑的任务。
 * 内存里还有该 run 时直接返回，不重复回灌，所以前端可以放心重试。
 *
 * 恢复本身不触发任何模型调用：用户接着编辑提纲，
 * 走 POST /api/outline/[runId] 时才会重跑受影响的渠道。
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params;

  const live = getRun(runId);
  if (live) {
    return Response.json(buildSnapshot(live), {
      headers: { "Cache-Control": "no-store" },
    });
  }

  const saved = await loadRunSnapshot(runId);
  if (!saved) {
    return Response.json({ error: "历史快照已不存在" }, { status: 404 });
  }

  const run = resumeRun(saved);
  return Response.json(buildSnapshot(run), {
    headers: { "Cache-Control": "no-store" },
  });
}
