import { promises as fs } from "node:fs";
import path from "node:path";
import type { RunSnapshot } from "./orchestrator";
import {
  isSavableNodeId,
  LIBRARY_MAX_ITEMS,
  type SavableNodeId,
  type SavedItem,
} from "./library-model";

/**
 * 成品库持久化
 *
 * 历史批次只保留最近 5 批，复制与导出又都是一次性动作，
 * 用户真正想留下的产出需要一个与 run 解耦的长期存放点。
 * 这里按「卡片」保存：同一张卡重复保存时原地更新，不产生重复条目。
 */

const LIBRARY_FILE = path.join(process.cwd(), "data", "library.json");

/** 读取失败（文件不存在、内容损坏）一律当成空库，不让读盘问题冒到接口层 */
async function readAll(): Promise<SavedItem[]> {
  try {
    const raw = await fs.readFile(LIBRARY_FILE, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is SavedItem =>
        !!item &&
        typeof item === "object" &&
        typeof (item as SavedItem).id === "string" &&
        isSavableNodeId((item as SavedItem).nodeId),
    );
  } catch {
    return [];
  }
}

async function writeAll(items: SavedItem[]): Promise<void> {
  await fs.mkdir(path.dirname(LIBRARY_FILE), { recursive: true });
  await fs.writeFile(LIBRARY_FILE, JSON.stringify(items), "utf8");
}

export async function listLibrary(): Promise<SavedItem[]> {
  const items = await readAll();
  return items.sort((a, b) => b.savedAt - a.savedAt);
}

/**
 * 把某次 run 的一张内容卡存进成品库。
 *
 * 内容从服务端快照里取，不信任前端传来的正文，避免界面与落盘数据不一致。
 */
export async function saveToLibrary(
  snapshot: RunSnapshot,
  nodeId: SavableNodeId,
): Promise<{ item: SavedItem; updated: boolean }> {
  const node = snapshot.nodes[nodeId];
  const item: SavedItem = {
    id: `${snapshot.runId}:${nodeId}`,
    runId: snapshot.runId,
    nodeId,
    topic: snapshot.topic,
    variant: snapshot.variant ?? null,
    content: node.content ?? "",
    imageUrl: node.imageUrl ?? null,
    styleName: node.style?.name ?? null,
    model: node.model ?? null,
    savedAt: Date.now(),
  };

  const items = await readAll();
  const updated = items.some((entry) => entry.id === item.id);
  const next = [item, ...items.filter((entry) => entry.id !== item.id)].slice(
    0,
    LIBRARY_MAX_ITEMS,
  );
  await writeAll(next);
  return { item, updated };
}

export async function removeFromLibrary(id: string): Promise<boolean> {
  const items = await readAll();
  const next = items.filter((entry) => entry.id !== id);
  if (next.length === items.length) return false;
  await writeAll(next);
  return true;
}
