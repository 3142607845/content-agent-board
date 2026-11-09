import { rerunNode, NODE_IDS, type NodeId } from "@/lib/orchestrator";

/**
 * POST /api/rerun/[nodeId]
 * body: { "runId": "xxx" }
 *
 * 只支持 4 个后置节点。重跑时复用已经生成好的策划提纲，不重跑策划 Agent。
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ nodeId: string }> },
) {
  const { nodeId } = await params;

  if (!NODE_IDS.includes(nodeId as NodeId)) {
    return Response.json({ error: `无效的 nodeId: ${nodeId}` }, { status: 400 });
  }

  let runId = "";
  try {
    const body = (await req.json()) as { runId?: unknown };
    runId = typeof body.runId === "string" ? body.runId : "";
  } catch {
    return Response.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }

  if (!runId) {
    return Response.json({ error: "缺少 runId" }, { status: 400 });
  }

  const ok = rerunNode(runId, nodeId as NodeId);
  if (!ok) {
    return Response.json(
      { error: "无法重跑：run 不存在、策划未完成，或该节点正在运行" },
      { status: 400 },
    );
  }

  return Response.json({ ok: true, runId, nodeId });
}
