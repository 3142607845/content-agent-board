import type { NodeId } from "./orchestrator";

/**
 * 提纲渠道 diff。
 *
 * 前端做「提交前影响面预览」、服务端做实际调度都用这里的结果，
 * 保证界面上看到的范围与真正重跑的节点一致，不会各算各的。
 */

/** 提纲渠道字段与下游节点的对应关系，局部重生成按这个粒度做 diff */
export const OUTLINE_CHANNELS: { key: string; nodeId: NodeId }[] = [
  { key: "longForm", nodeId: "longform" },
  { key: "script", nodeId: "script" },
  { key: "xhs", nodeId: "xhs" },
  { key: "image", nodeId: "image" },
];

/** 从提纲里取某个渠道的片段，取不到就返回 null，交给 Agent 自行发挥 */
export function outlineSection(outline: unknown, key: string): unknown {
  const parsed = outline as { outline?: Record<string, unknown> } | null;
  return parsed?.outline?.[key] ?? null;
}

/**
 * 比对两份提纲在四个渠道上的差异，返回需要重跑的下游节点。
 *
 * 顶层 topic 不参与比对：选题变化不影响任何渠道的产出，不触发重生成。
 */
export function diffOutlineChannels(prev: unknown, next: unknown): NodeId[] {
  return OUTLINE_CHANNELS.filter(
    ({ key }) =>
      JSON.stringify(outlineSection(prev, key)) !==
      JSON.stringify(outlineSection(next, key)),
  ).map(({ nodeId }) => nodeId);
}
