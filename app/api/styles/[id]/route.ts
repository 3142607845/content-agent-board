import { deleteStyle, updateStyle } from "@/lib/style-store";

/**
 * PUT    /api/styles/[id]  编辑自定义模板
 * DELETE /api/styles/[id]  删除自定义模板
 *
 * 内置模板只读：编辑返回 403，删除返回 403，
 * 想改内置模板只能先「复制为自定义模板」。
 */
export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }

  const result = await updateStyle(id, body);
  if (!result.ok) {
    return Response.json({ error: result.error }, { status: result.status });
  }

  return Response.json({ template: result.template });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const result = await deleteStyle(id);
  if (!result.ok) {
    return Response.json({ error: result.error }, { status: result.status });
  }
  return Response.json({ ok: true, id });
}
