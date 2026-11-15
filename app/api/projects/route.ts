import { buildSnapshot, getRun } from "@/lib/orchestrator";
import { loadRunSnapshot } from "@/lib/history";
import {
  PROJECT_CHANNEL_IDS,
  type ProjectChannelId,
} from "@/lib/project-model";
import { listProjects, saveProject } from "@/lib/project-storage";

/**
 * GET /api/projects
 * 按保存时间倒序返回整批项目列表。
 */
export async function GET() {
  const items = await listProjects();
  return Response.json(
    { items },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * POST /api/projects
 * body: { runId }
 *
 * 要求四个内容渠道都已完成：文本节点正文非空，配图节点已出图。
 * 正文与提纲一律从服务端快照取，不信任前端回传。
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as {
    runId?: unknown;
  } | null;
  if (!body) {
    return Response.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }
  const { runId } = body;
  if (typeof runId !== "string" || !runId) {
    return Response.json({ error: "缺少 runId" }, { status: 400 });
  }

  const live = getRun(runId);
  const snapshot = live ? buildSnapshot(live) : await loadRunSnapshot(runId);
  if (!snapshot) {
    return Response.json({ error: "运行快照已不存在" }, { status: 404 });
  }

  // 四个渠道必须全部完成并产出实际内容
  for (const id of PROJECT_CHANNEL_IDS) {
    const node = snapshot.nodes[id as ProjectChannelId];
    if (!node || node.status !== "completed") {
      return Response.json(
        { error: "四路产出尚未全部完成，无法收藏整个项目" },
        { status: 400 },
      );
    }
    if (id === "image") {
      if (!node.imageUrl) {
        return Response.json(
          { error: "配图尚未生成，无法收藏整个项目" },
          { status: 400 },
        );
      }
    } else if (!node.content?.trim()) {
      return Response.json(
        { error: "部分渠道正文为空，无法收藏整个项目" },
        { status: 400 },
      );
    }
  }

  const { item, updated } = await saveProject(snapshot);
  return Response.json({ ok: true, item, updated });
}
