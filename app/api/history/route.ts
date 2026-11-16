import { deleteHistoryBatch, listHistoryBatches } from "@/lib/history";

/**
 * GET /api/history
 *
 * 返回最近 5 个批次的回看摘要。
 * 多版模式一次并行产出的 3 个 run 属于同一批次，在这里聚合为一个条目，
 * 按批次而不是按 run 限流，避免两批就把名额吃满。
 */
export async function GET() {
  const batches = await listHistoryBatches();
  return Response.json(
    { batches },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * DELETE /api/history?batchId=xxx
 *
 * 手动删除一个历史批次。自动淘汰只按数量来，用户没有主动清理的手段，
 * 所以补一个按批次删除：整批删，不留半批。
 */
export async function DELETE(request: Request) {
  const batchId = new URL(request.url).searchParams.get("batchId") ?? "";
  if (!batchId) {
    return Response.json({ error: "缺少 batchId" }, { status: 400 });
  }
  const deleted = await deleteHistoryBatch(batchId);
  if (deleted === 0) {
    return Response.json({ error: "批次不存在" }, { status: 404 });
  }
  return Response.json({ deleted });
}
