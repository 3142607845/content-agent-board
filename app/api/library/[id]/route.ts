import { removeFromLibrary } from "@/lib/library";

/**
 * DELETE /api/library/[id]
 * id 形如 `{runId}:{nodeId}`，删除不存在的条目返回 404。
 */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const removed = await removeFromLibrary(id);
  if (!removed) {
    return Response.json({ error: "成品不存在或已删除" }, { status: 404 });
  }
  return Response.json({ ok: true });
}
