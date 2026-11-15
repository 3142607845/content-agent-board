import type { NodeId } from "./orchestrator";

/**
 * 成品库的数据契约（纯数据，前后端共用）
 *
 * 落盘逻辑在 lib/library.ts，那里依赖 node:fs，不能进客户端包，
 * 所以类型与渠道名单独拆出来。
 */

/** 只有下游内容节点能入库，策划提纲属于过程数据 */
export const SAVABLE_NODE_IDS = ["longform", "script", "xhs", "image"] as const;
export type SavableNodeId = (typeof SAVABLE_NODE_IDS)[number];

/** 成品库容量上限，超出后淘汰最早保存的条目；前端展示同一数字 */
export const LIBRARY_MAX_ITEMS = 200;

export interface SavedItem {
  /** runId:nodeId，重复保存同一张卡时原地更新 */
  id: string;
  runId: string;
  nodeId: SavableNodeId;
  topic: string;
  variant: string | null;
  content: string;
  imageUrl: string | null;
  styleName: string | null;
  model: string | null;
  savedAt: number;
}

export function isSavableNodeId(value: unknown): value is SavableNodeId {
  return (
    typeof value === "string" &&
    (SAVABLE_NODE_IDS as readonly string[]).includes(value)
  );
}

/** 渠道展示名，前端列表与服务端校验共用同一份 */
export const LIBRARY_NODE_NAMES: Record<SavableNodeId, string> = {
  longform: "公众号长文",
  script: "短视频脚本",
  xhs: "小红书笔记",
  image: "配图",
};

/** 确保可保存节点都在 NodeId 范围内，类型层面留一道约束 */
export type LibraryNodeIdCheck = SavableNodeId extends NodeId ? true : never;
