import { listHistoryBatches } from "@/lib/history";

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
