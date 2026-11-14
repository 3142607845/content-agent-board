import { createStyle, listStyles } from "@/lib/style-store";

/**
 * GET  /api/styles  内置模板 + 自定义模板全量列表
 * POST /api/styles  新建自定义模板
 *
 * 模板库按渠道（公众号 / 短视频 / 小红书）在返回结果里区分，
 * 前端只做过滤，不需要再发三次请求。
 */
export async function GET() {
  const templates = await listStyles();
  return Response.json(
    { templates },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }

  const result = await createStyle(body);
  if (!result.ok) {
    return Response.json({ error: result.error }, { status: result.status });
  }

  return Response.json({ template: result.template }, { status: 201 });
}
