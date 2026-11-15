import { buildSnapshot, getRun } from "@/lib/orchestrator";
import { loadRunSnapshot } from "@/lib/history";
import { isSavableNodeId } from "@/lib/library-model";
import { listLibrary, saveToLibrary } from "@/lib/library";

/**
 * GET /api/library
 * 返回已保存的成品，按保存时间倒序。
 */
export async function GET() {
  const items = await listLibrary();
  return Response.json(
    { items },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * POST /api/library
 * body: { runId, nodeId }
 *
 * 从服务端的 run 快照里取内容入库，不接受前端传正文，
 * 避免界面显示与落盘内容不一致。同一张卡重复保存时原地更新。
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as {
    runId?: unknown;
    nodeId?: unknown;
  } | null;
  if (!body) {
    return Response.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }

  const { runId, nodeId } = body;
  if (typeof runId !== "string" || !runId) {
    return Response.json({ error: "缺少 runId" }, { status: 400 });
  }
  if (!isSavableNodeId(nodeId)) {
    return Response.json({ error: "该节点不支持存入成品库" }, { status: 400 });
  }

  const live = getRun(runId);
  const snapshot = live ? buildSnapshot(live) : await loadRunSnapshot(runId);
  if (!snapshot) {
    return Response.json({ error: "运行快照已不存在" }, { status: 404 });
  }

  const node = snapshot.nodes[nodeId];
  if (!node || node.status !== "completed") {
    return Response.json({ error: "节点尚未完成，无法入库" }, { status: 400 });
  }
  if (nodeId === "image" && !node.imageUrl) {
    return Response.json({ error: "配图尚未生成，无法入库" }, { status: 400 });
  }
  if (nodeId !== "image" && !node.content.trim()) {
    return Response.json({ error: "内容为空，无法入库" }, { status: 400 });
  }

  const { item, updated } = await saveToLibrary(snapshot, nodeId);
  return Response.json({ ok: true, item, updated });
}
