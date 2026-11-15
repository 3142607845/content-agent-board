import { promises as fs } from "node:fs";
import path from "node:path";
import type { RunSnapshot } from "./orchestrator";
import {
  PROJECT_CHANNEL_IDS,
  PROJECT_MAX_ITEMS,
  type ProjectChannelId,
  type ProjectItem,
} from "./project-model";

/**
 * 整批项目持久化
 *
 * 与卡片成品库独立落盘：项目是「一整条流水线的整体产出」，
 * 卡片是「某一路被单独认可的产出」，两者生命周期与淘汰策略不同。
 */

const PROJECT_FILE = path.join(process.cwd(), "data", "projects.json");

async function readAll(): Promise<ProjectItem[]> {
  try {
    const raw = await fs.readFile(PROJECT_FILE, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is ProjectItem =>
        !!item &&
        typeof item === "object" &&
        typeof (item as ProjectItem).id === "string" &&
        typeof (item as ProjectItem).topic === "string" &&
        !!(item as ProjectItem).channels,
    );
  } catch {
    return [];
  }
}

async function writeAll(items: ProjectItem[]): Promise<void> {
  await fs.mkdir(path.dirname(PROJECT_FILE), { recursive: true });
  await fs.writeFile(PROJECT_FILE, JSON.stringify(items), "utf8");
}

export async function listProjects(): Promise<ProjectItem[]> {
  const items = await readAll();
  return items.sort((a, b) => b.savedAt - a.savedAt);
}

/**
 * 把一次完整流水线快照存成项目。
 * 要求四个内容渠道都已完成并产出内容/配图，否则不存。
 */
export async function saveProject(snapshot: RunSnapshot): Promise<{
  item: ProjectItem;
  updated: boolean;
}> {
  const channels = {} as Record<ProjectChannelId, ProjectItem["channels"][ProjectChannelId]>;
  for (const id of PROJECT_CHANNEL_IDS) {
    const node = snapshot.nodes[id];
    channels[id] = {
      content: node.content ?? "",
      imageUrl: node.imageUrl ?? null,
      styleName: node.style?.name ?? null,
      model: node.model ?? null,
    };
  }

  const versions = snapshot.outlineVersions ?? [];
  const activeVersion =
    versions.find((v) => v.id === snapshot.outlineVersionId) ??
    versions[versions.length - 1];

  const item: ProjectItem = {
    id: snapshot.runId,
    topic: snapshot.topic,
    variant: snapshot.variant ?? null,
    outline: activeVersion?.outline ?? null,
    channels,
    savedAt: Date.now(),
  };

  const items = await readAll();
  const updated = items.some((entry) => entry.id === item.id);
  const next = [item, ...items.filter((entry) => entry.id !== item.id)].slice(
    0,
    PROJECT_MAX_ITEMS,
  );
  await writeAll(next);
  return { item, updated };
}

export async function removeProject(id: string): Promise<boolean> {
  const items = await readAll();
  const next = items.filter((entry) => entry.id !== id);
  if (next.length === items.length) return false;
  await writeAll(next);
  return true;
}
