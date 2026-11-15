import { removeProject } from "@/lib/project-storage";

/**
 * DELETE /api/projects/[id]
 * id 即 runId，删除不存在的项目返回 404。
 */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const removed = await removeProject(id);
  if (!removed) {
    return Response.json({ error: "项目不存在或已删除" }, { status: 404 });
  }
  return Response.json({ ok: true });
}
