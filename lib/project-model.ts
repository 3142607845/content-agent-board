/**
 * 整批项目的数据契约（纯数据，前后端共用）
 *
 * 与单张卡片成品库分开：一条项目 = 一次流水线的全部产出，
 * 包含选题、提纲与四个渠道的正文/配图，作为一个整体保留。
 */

export type ProjectChannelId = "longform" | "script" | "xhs" | "image";

export const PROJECT_CHANNEL_IDS = [
  "longform",
  "script",
  "xhs",
  "image",
] as const;

export interface ProjectChannel {
  content: string;
  imageUrl: string | null;
  styleName: string | null;
  model: string | null;
}

export interface ProjectItem {
  /** 用 runId 做 id，同一项目重复收藏只更新时间 */
  id: string;
  topic: string;
  variant: string | null;
  /** 当前提纲版本的提纲对象，原样保留，前端不解析其结构 */
  outline: unknown;
  channels: Record<ProjectChannelId, ProjectChannel>;
  savedAt: number;
}

/** 项目体积较大（含长文全文），容量比卡片成品库小很多 */
export const PROJECT_MAX_ITEMS = 50;

export const PROJECT_CHANNEL_NAMES: Record<ProjectChannelId, string> = {
  longform: "公众号长文",
  script: "短视频脚本",
  xhs: "小红书笔记",
  image: "配图",
};
