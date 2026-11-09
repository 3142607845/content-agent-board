import { stopRun, NODE_IDS, type NodeId } from "@/lib/orchestrator";

/**
 * POST /api/stop/[runId]
 * POST /api/stop/[runId]?nodeId=xhs
 *
 * 不带 nodeId 是全局中断；带 nodeId 只中断那一个节点。
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params;
  const nodeIdParam = new URL(req.url).searchParams.get("nodeId");

  if (nodeIdParam && !NODE_IDS.includes(nodeIdParam as NodeId)) {
    return Response.json({ error: `无效的 nodeId: ${nodeIdParam}` }, { status: 400 });
  }

  const ok = stopRun(runId, (nodeIdParam as NodeId | null) ?? undefined);
  if (!ok) {
    return Response.json(
      { error: "run 不存在，或该节点已经结束" },
      { status: 404 },
    );
  }

  return Response.json({ ok: true, runId, nodeId: nodeIdParam ?? "all" });
}
