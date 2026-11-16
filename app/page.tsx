"use client";

import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import type {
  AgentNodeState,
  NodeId,
  NodeStatus,
  OutlineVersion,
  RunSnapshot,
  RunStatus,
} from "@/lib/orchestrator";
import { formatDuration, formatTokens, type RunReport } from "@/lib/report";
import { VARIANTS, type VariantKey } from "@/lib/variants";
import {
  DEFAULT_STYLE_BY_CHANNEL,
  STYLE_CHANNELS,
  STYLE_NAME_MAX,
  STYLE_PROMPT_MAX,
  STYLE_SUMMARY_MAX,
  type StyleChannel,
  type StyleTemplate,
} from "@/lib/styles";
import type { HistoryBatch, HistoryRunEntry } from "@/lib/history";
import { diffOutlineChannels } from "@/lib/outline-diff";
import {
  isSavableNodeId,
  LIBRARY_MAX_ITEMS,
  LIBRARY_NODE_NAMES,
  type SavedItem,
} from "@/lib/library-model";
import {
  PROJECT_CHANNEL_IDS,
  PROJECT_CHANNEL_NAMES,
  PROJECT_MAX_ITEMS,
  type ProjectItem,
} from "@/lib/project-model";
import BackgroundScene from "./background-scene";

const NODE_ORDER: NodeId[] = ["planner", "longform", "script", "xhs", "image"];

const NODE_META: Record<
  NodeId,
  { name: string; desc: string; glyph: string; tint: string }
> = {
  planner: {
    name: "策划 Agent",
    desc: "拆解选题，产出四渠道提纲 JSON",
    glyph: "策",
    tint: "bg-indigo-50 text-indigo-600 ring-indigo-100",
  },
  longform: {
    name: "公众号长文",
    desc: "公众号长文，2000 字以上",
    glyph: "文",
    tint: "bg-sky-50 text-sky-600 ring-sky-100",
  },
  script: {
    name: "短视频脚本",
    desc: "短视频分镜脚本",
    glyph: "稿",
    tint: "bg-violet-50 text-violet-600 ring-violet-100",
  },
  xhs: {
    name: "小红书笔记",
    desc: "小红书笔记正文与标签",
    glyph: "红",
    tint: "bg-rose-50 text-rose-600 ring-rose-100",
  },
  image: {
    name: "配图 Agent",
    desc: "扩写提示词并调用 Seedream 出图",
    glyph: "图",
    tint: "bg-amber-50 text-amber-600 ring-amber-100",
  },
};

/** 版本 chip 上的渠道短名，避免 chip 过长把整行撑开 */
const CHANNEL_SHORT: Record<NodeId, string> = {
  planner: "策划",
  longform: "长文",
  script: "脚本",
  xhs: "小红书",
  image: "配图",
};

/** 首页插图：AI 生成的内容流水线示意图，加载失败时退回纯色块不影响布局 */
const HERO_IMAGE =
  "https://trae-api-cn.mchost.guru/api/ide/v1/text_to_image?prompt=" +
  encodeURIComponent(
    "soft 3D isometric illustration of a content production pipeline, five floating rounded white cards connected by glowing indigo and violet lines, abstract minimal, clean light background, subtle shadows, high quality render",
  ) +
  "&image_size=landscape_4_3";

/** 状态只体现在左色条和小徽标上，卡片底始终中性，避免多卡同时变绿变蓝 */
const STATUS_STYLE: Record<
  NodeStatus,
  { label: string; bar: string; badge: string }
> = {
  pending: {
    label: "等待",
    bar: "bg-neutral-200",
    badge: "bg-neutral-100 text-neutral-500",
  },
  running: {
    label: "生成中",
    bar: "bg-blue-500",
    badge: "bg-blue-50 text-blue-700",
  },
  completed: {
    label: "完成",
    bar: "bg-emerald-500",
    badge: "bg-emerald-50 text-emerald-700",
  },
  failed: {
    label: "失败",
    bar: "bg-red-500",
    badge: "bg-red-50 text-red-700",
  },
  cancelled: {
    label: "已中断",
    bar: "bg-amber-500",
    badge: "bg-amber-50 text-amber-700",
  },
};

/** 卡片面、按钮三档权重，避免每处重写一长串 className */
const CARD = "rounded-xl border border-hairline bg-surface shadow-card";
const BTN_PRIMARY =
  "rounded-lg bg-accent px-5 py-2.5 text-sm font-medium text-white transition hover:bg-accent-strong disabled:opacity-40";
const BTN_GHOST =
  "rounded-lg border border-hairline-strong bg-surface px-4 py-2.5 text-sm font-medium text-ink-2 transition hover:text-ink disabled:opacity-40";
const BTN_QUIET =
  "rounded-md border border-hairline-strong bg-surface px-2.5 py-1 text-xs text-ink-2 transition hover:text-ink disabled:opacity-40";

const RUN_STATUS_TEXT: Record<RunStatus, string> = {
  running: "流水线运行中",
  completed: "全部完成",
  failed: "存在失败节点",
  aborted: "已中断",
};

/** 历史列表用的短时间格式，避免 toLocaleString 在服务端/客户端输出不一致 */
function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 提纲文本解析：提交前先拦一道语法错误，避免无效请求打到服务端 */
function parseOutlineText(
  text: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false, error: "提纲必须是 JSON 对象" };
    }
    return { ok: true, value };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "JSON 解析失败",
    };
  }
}

type Mode = "single" | "multi-topic" | "multi-version";

/** 策划 Agent 的四个渠道 key，与 lib/outline-diff.ts 的 OUTLINE_CHANNELS 对齐 */
type OutlineChannelKey = "longForm" | "script" | "xhs" | "image";

/** 提纲文档：已知字段给类型，其余字段原样保留，避免表单编辑丢掉扩展内容 */
interface OutlineDoc {
  topic?: string;
  outline?: Partial<Record<OutlineChannelKey, Record<string, unknown>>>;
  [key: string]: unknown;
}

function isOutlineDoc(value: unknown): value is OutlineDoc {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const outline = (value as { outline?: unknown }).outline;
  return !!outline && typeof outline === "object" && !Array.isArray(outline);
}

/** 表单里读字符串字段：类型不对就按空串处理，不让脏数据把输入框渲染崩掉 */
function outlineText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** 数组字段按每行一条编辑，读写都走这个约定 */
function outlineLines(value: unknown): string {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").join("\n")
    : "";
}

function outlineList(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/** 表单输入框的统一外观 */
const OUTLINE_FIELD_CLASS =
  "w-full rounded-md border border-hairline-strong bg-canvas px-2.5 py-1.5 text-xs text-ink outline-none transition focus:border-accent";

const MODE_TABS: { id: Mode; label: string }[] = [
  { id: "single", label: "单次生成模式" },
  { id: "multi-topic", label: "批量选题模式" },
  { id: "multi-version", label: "多版生成模式" },
];

/** 本地会话：只记 runId 与展示信息，快照本身仍从服务端读 */
const SESSION_KEY = "cab-last-run";
/** 超过一天的上次任务不再提示，避免开屏被旧数据打扰 */
const SESSION_TTL = 24 * 60 * 60 * 1000;
/** 提纲撤销栈上限：只保留最近 20 次变更，超出丢最早的一条 */
const OUTLINE_HISTORY_LIMIT = 20;
/** 提纲输入停顿多久记一步：不依赖失焦，撤销按钮随时跟得上 */
const OUTLINE_AUTOSAVE_MS = 1200;
/** API 连接状态探测间隔：30 秒内服务端断开能被发现，又不会频繁打扰后端 */
const API_POLL_MS = 30 * 1000;
/** 历史保留批次数：与 lib/history.ts 的 MAX_BATCHES 对齐，这里只用于提示文案 */
const HISTORY_BATCH_LIMIT = 5;

/** 示例选题：降低"不知道输入什么"的启动成本 */
const EXAMPLE_TOPICS = [
  "午睡为什么越睡越困",
  "AI 编程会不会取代程序员",
  "远程办公三年，我为什么又回了办公室",
];

/** 首次进入的三步引导，目标元素由 ref 定位 */
const TOUR_STEPS = [
  {
    title: "先给一个选题",
    desc: "写一句话即可，也可以点下方的示例选题直接填入。",
  },
  {
    title: "选一个运行模式",
    desc: "单次生成一个版本，批量模式可以一次跑多个选题或三个创作维度。",
  },
  {
    title: "启动流水线",
    desc: "五个 Agent 会依次亮起，运行中可以随时中断单个节点。",
  },
];

/** 分叉轨道配色：与卡片状态保持同一套语义 */
const RAIL_LINE: Record<NodeStatus, string> = {
  pending: "bg-hairline-strong",
  running: "bg-blue-300",
  completed: "bg-emerald-300",
  failed: "bg-red-300",
  cancelled: "bg-amber-300",
};

const RAIL_DOT: Record<NodeStatus, string> = {
  pending: "bg-neutral-300",
  running: "bg-blue-500",
  completed: "bg-emerald-500",
  failed: "bg-red-500",
  cancelled: "bg-amber-500",
};

interface TaskResult {
  id: string;
  topic: string;
  label: string;
  /** 多版模式：该任务对应的创作维度 */
  variant?: VariantKey;
  status: "queued" | "pending" | "running" | "completed" | "failed" | "aborted";
  nodes: Record<NodeId, AgentNodeState>;
  runId?: string;
  /** 创建时间：侧边栏按它排序并展示，刷新恢复时取快照里的值 */
  createdAt: number;
  /** 该任务跑完后由服务端下发的执行报告 */
  report?: RunReport | null;
}

/**
 * 侧边栏任务条目：把「本次会话的内存任务」和「服务端历史快照」统一成一个展示模型。
 * 平台标签位暂时用创作维度/模式代替 —— 现有 run 没有真实平台字段。
 */
interface SidebarTaskItem {
  key: string;
  title: string;
  tag: string;
  createdAt: number;
  status:
    | "idle"
    | "queued"
    | "pending"
    | "running"
    | "completed"
    | "failed"
    | "aborted";
  /** current：本次会话内存任务；history：服务端落盘快照 */
  source: "current" | "history";
  /** 批量/多版任务在 tasks 里的下标 */
  taskIndex?: number;
  /** 批量条目所属运行模式，切回时用来恢复 tab */
  batchMode?: Mode;
  /** 历史条目原样保留，点击时直接交给 openHistoryRun */
  historyEntry?: HistoryRunEntry;
}

/** 侧边栏状态点：与任务 tab、节点卡片共用同一套颜色语义 */
function sidebarStatusDot(status: SidebarTaskItem["status"]): string {
  switch (status) {
    case "running":
      return "bg-blue-500 animate-pulse";
    case "completed":
      return "bg-green-500";
    case "failed":
      return "bg-red-500";
    case "aborted":
      return "bg-amber-500";
    default:
      return "bg-neutral-300";
  }
}

/** 历史回看态：只读展示落盘快照，不建立 SSE 连接 */
interface ReviewingState {
  runId: string;
  variantName: string | null;
  /** 本次 run 选用的文风模板名，历史快照里读出来 */
  styleNames: string[];
  finishedAt: number | null;
}

/** 模板编辑态：id 为 null 表示新建 */
interface StyleDraft {
  id: string | null;
  channel: StyleChannel;
  name: string;
  summary: string;
  prompt: string;
}

function emptyNodes(): Record<NodeId, AgentNodeState> {
  const nodes = {} as Record<NodeId, AgentNodeState>;
  for (const id of NODE_ORDER) {
    nodes[id] = {
      id,
      name: NODE_META[id].name,
      status: "pending",
      content: "",
      attempt: 0,
    };
  }
  return nodes;
}

const REPORT_STATUS_TEXT: Record<string, string> = {
  completed: "完成",
  running: "生成中",
  failed: "失败",
  cancelled: "已中断",
  pending: "未启动",
};

function variantLabel(key: string | null): string {
  if (!key) return "";
  return VARIANTS.find((v) => v.key === key)?.name ?? key;
}

/** 单次运行的执行报告，数据全部来自服务端下发的 RunReport */
function ReportCard({ report, title = "本次流水线执行报告" }: { report: RunReport; title?: string }) {
  return (
    <section className="rounded-xl border border-dashed border-hairline-strong bg-surface/60 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xs font-semibold tracking-wide text-ink-2">{title}</h2>
        <span className="text-xs tabular-nums text-ink-3">
          总耗时 {formatDuration(report.durationMs)}
        </span>
      </div>
      <p className="mt-1 text-xs text-ink-3">
        {report.topic}
        {report.variant ? ` · ${variantLabel(report.variant)}` : ""}
      </p>

      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[720px] text-left text-xs tabular-nums">
          <thead className="text-ink-3">
            <tr>
              <th className="py-1 pr-3 font-normal">节点</th>
              <th className="py-1 pr-3 font-normal">文风</th>
              <th className="py-1 pr-3 font-normal">模型</th>
              <th className="py-1 pr-3 font-normal">状态</th>
              <th className="py-1 pr-3 font-normal">耗时</th>
              <th className="py-1 pr-3 font-normal">输入 token</th>
              <th className="py-1 pr-3 font-normal">输出 token</th>
              <th className="py-1 font-normal">重试</th>
            </tr>
          </thead>
          <tbody>
            {report.nodes.map((n) => (
              <tr key={n.nodeId} className="border-t border-hairline">
                <td className="py-1.5 pr-3 font-medium text-ink">{n.name}</td>
                <td className="max-w-[10rem] truncate py-1.5 pr-3 text-ink-2">
                  {n.styleName ?? "—"}
                </td>
                <td className="py-1.5 pr-3 font-mono text-[11px] text-ink-3">
                  {n.model}
                </td>
                <td className="py-1.5 pr-3">
                  {REPORT_STATUS_TEXT[n.status] ?? n.status}
                </td>
                <td className="py-1.5 pr-3">
                  {n.attempts > 0 ? formatDuration(n.durationMs) : "—"}
                </td>
                <td className="py-1.5 pr-3">
                  {n.usage ? formatTokens(n.usage.promptTokens) : "—"}
                </td>
                <td className="py-1.5 pr-3">
                  {n.usage ? formatTokens(n.usage.completionTokens) : "—"}
                </td>
                <td className="py-1.5">
                  {n.retries > 0 ? (
                    <span className="text-amber-600">{n.retries} 次</span>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2">
        <span>模型调用 {report.totals.llmCalls} 次</span>
        <span>token 合计 {formatTokens(report.totals.totalTokens)}</span>
        {report.totals.reasoningTokens > 0 && (
          <span>其中思维链 {formatTokens(report.totals.reasoningTokens)}</span>
        )}
        {report.totals.retries > 0 && (
          <span className="text-amber-600">自动重试 {report.totals.retries} 次</span>
        )}
        {report.parallel?.speedup != null && (
          <span className="text-emerald-600">
            并行加速 {report.parallel.speedup}×（4 路串行需{" "}
            {formatDuration(report.parallel.serialMs)}，实际{" "}
            {formatDuration(report.parallel.wallMs)}）
          </span>
        )}
        {report.hasEstimated && (
          <span className="text-amber-600">含字符估算值，非服务端真实用量</span>
        )}
      </div>
    </section>
  );
}

/** 批量模式全部结束后的横向汇总，用来对比各版本的耗时与成本 */
function BatchSummary({ tasks }: { tasks: TaskResult[] }) {
  const totalTokens = tasks.reduce(
    (sum, t) => sum + (t.report?.totals.totalTokens ?? 0),
    0,
  );
  return (
    <section className="rounded-xl border border-dashed border-hairline-strong bg-surface/60 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xs font-semibold tracking-wide text-ink-2">
          批量执行汇总
        </h2>
        <span className="text-xs tabular-nums text-ink-3">
          token 合计 {formatTokens(totalTokens)}
        </span>
      </div>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[520px] text-left text-xs tabular-nums">
          <thead className="text-ink-3">
            <tr>
              <th className="py-1 pr-3 font-normal">任务</th>
              <th className="py-1 pr-3 font-normal">状态</th>
              <th className="py-1 pr-3 font-normal">总耗时</th>
              <th className="py-1 pr-3 font-normal">token 合计</th>
              <th className="py-1 font-normal">自动重试</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((t) => (
              <tr key={t.id} className="border-t border-hairline">
                <td className="py-1.5 pr-3 font-medium text-ink">
                  {t.label}
                </td>
                <td className="py-1.5 pr-3">
                  {REPORT_STATUS_TEXT[t.status] ?? t.status}
                </td>
                <td className="py-1.5 pr-3">
                  {t.report ? formatDuration(t.report.durationMs) : "—"}
                </td>
                <td className="py-1.5 pr-3">
                  {t.report ? formatTokens(t.report.totals.totalTokens) : "—"}
                </td>
                <td className="py-1.5">
                  {t.report?.totals.retries ? (
                    <span className="text-amber-600">
                      {t.report.totals.retries} 次
                    </span>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default function Home() {
  const [mode, setMode] = useState<Mode>("single");
  const [topic, setTopic] = useState("");
  const [multiTopic, setMultiTopic] = useState("");

  // 单次模式状态
  const [nodes, setNodes] = useState<Record<NodeId, AgentNodeState>>(emptyNodes);
  const [runStatus, setRunStatus] = useState<RunStatus | "idle">("idle");
  const [runId, setRunId] = useState<string | null>(null);

  // 批量模式状态
  const [tasks, setTasks] = useState<TaskResult[]>([]);
  const [activeTaskIndex, setActiveTaskIndex] = useState(0);

  const [notice, setNotice] = useState("");
  /** 单次模式下的执行报告，由 snapshot 或 run:done 下发 */
  const [report, setReport] = useState<RunReport | null>(null);
  /** SSE 断开重连提示，收到新快照自动清除 */
  const [reconnectNotice, setReconnectNotice] = useState("");
  const [copied, setCopied] = useState<Partial<Record<NodeId, boolean>>>({});
  /** 卡片展开态；默认折叠，节点开始运行时自动展开 */
  const [expanded, setExpanded] = useState<Partial<Record<NodeId, boolean>>>({});
  const esRef = useRef<EventSource | null>(null);
  const batchRunningRef = useRef(false);

  // 历史回看：批次列表来自服务端落盘快照，不依赖当前内存态
  const [historyBatches, setHistoryBatches] = useState<HistoryBatch[]>([]);
  const [reviewing, setReviewing] = useState<ReviewingState | null>(null);

  // 成品库：与历史批次解耦，用户主动保存的产出不被 5 批上限淘汰
  const [libraryItems, setLibraryItems] = useState<SavedItem[]>([]);
  const [libraryOpen, setLibraryOpen] = useState(false);
  /** 正在保存的节点 id，用于按钮 loading 态 */
  const [libraryBusy, setLibraryBusy] = useState<NodeId | "">("");
  // 项目库：整批收藏，与单张卡片成品库独立
  const [projectItems, setProjectItems] = useState<ProjectItem[]>([]);
  const [libraryTab, setLibraryTab] = useState<"card" | "project">("card");
  const [projectBusy, setProjectBusy] = useState(false);
  // 批量/多版模式：横向对比视图，把多个任务的四路产出并排展示
  const [compareView, setCompareView] = useState(false);

  // 风格模板：内置 + 自定义全量列表，按渠道过滤使用
  const [styleTemplates, setStyleTemplates] = useState<StyleTemplate[]>([]);
  const [styleSelection, setStyleSelection] = useState<
    Partial<Record<StyleChannel, string>>
  >({});
  const [stylePanelOpen, setStylePanelOpen] = useState(false);
  const [styleDraft, setStyleDraft] = useState<StyleDraft | null>(null);
  const [styleError, setStyleError] = useState("");
  const [styleBusy, setStyleBusy] = useState(false);

  // 提纲人工干预：版本链按 runId 缓存，批量模式切换 tab 不丢
  const [outlines, setOutlines] = useState<
    Record<string, { versions: OutlineVersion[]; activeId: string | null }>
  >({});
  const [outlineEditing, setOutlineEditing] = useState(false);
  const [outlineDraft, setOutlineDraft] = useState("");
  const [outlineSelectedVersion, setOutlineSelectedVersion] = useState<
    string | null
  >(null);
  const [outlineError, setOutlineError] = useState("");
  const [outlineNotice, setOutlineNotice] = useState("");
  /** 提纲编辑方式：默认表单，结构无法识别时退回 JSON 让人修 */
  const [outlineJsonMode, setOutlineJsonMode] = useState(false);
  const [outlineBusy, setOutlineBusy] = useState(false);
  /**
   * 提纲编辑的本地撤销栈：只存草稿文本，纯前端，不落库也不上后端。
   * 数据放 ref 里避免每次输入都触发重渲染，canUndo/canRedo 单独用 state 驱动按钮态。
   */
  const outlineHistory = useRef<{ entries: string[]; index: number }>({
    entries: [],
    index: -1,
  });
  const [outlineHistoryState, setOutlineHistoryState] = useState({
    canUndo: false,
    canRedo: false,
    undoSteps: 0,
    redoSteps: 0,
  });
  /** 进入编辑时的原始草稿：切任务时据此判断有没有未提交的修改 */
  const outlineBaselineRef = useRef("");

  /** 单次模式当前 run 的创建时间，侧边栏展示与排序用 */
  const [singleCreatedAt, setSingleCreatedAt] = useState<number | null>(null);

  // 侧边栏：折叠只影响界面，不参与任何流水线状态
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** null 表示尚未探测完成，避免首屏先闪一下「未连接」 */
  const [apiOnline, setApiOnline] = useState<boolean | null>(null);

  /** 刷新后接回的上次任务：只存快照，点「继续查看」才载入，不抢屏 */
  const [pendingSession, setPendingSession] = useState<{
    mode: Mode;
    items: {
      topic: string;
      label: string;
      variant?: VariantKey;
      snap: RunSnapshot;
    }[];
  } | null>(null);

  // 首次进入的三步引导：localStorage 只记一次，也可从头部按钮重新唤起
  const [tourStep, setTourStep] = useState(0);
  const [tourLayout, setTourLayout] = useState<{
    rect: { top: number; left: number; width: number; height: number };
    vw: number;
    vh: number;
  } | null>(null);
  const topicInputRef = useRef<HTMLInputElement | null>(null);
  const modeTabsRef = useRef<HTMLDivElement | null>(null);
  const startButtonRef = useRef<HTMLButtonElement | null>(null);

  const loadHistory = useCallback(async () => {
    try {
      const res = await fetch("/api/history", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { batches?: HistoryBatch[] };
      setHistoryBatches(data.batches ?? []);
    } catch {
      // 历史列表取不到不影响主流程
    }
  }, []);

  const loadLibrary = useCallback(async () => {
    try {
      const res = await fetch("/api/library", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { items?: SavedItem[] };
      setLibraryItems(data.items ?? []);
    } catch {
      // 成品库取不到不影响流水线
    }
  }, []);

  const loadProjects = useCallback(async () => {
    try {
      const res = await fetch("/api/projects", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { items?: ProjectItem[] };
      setProjectItems(data.items ?? []);
    } catch {
      // 项目库取不到不影响流水线
    }
  }, []);

  // 首次进入拉一次：历史入口与成品库/项目库数量在刷新后仍然有内容
  useEffect(() => {
    void loadHistory();
    void loadLibrary();
    void loadProjects();
  }, [loadHistory, loadLibrary, loadProjects]);

  // API 连接状态：复用历史接口做轻量探测，切回前台立刻补测一次
  useEffect(() => {
    let cancelled = false;
    async function probe() {
      try {
        const res = await fetch("/api/history", { cache: "no-store" });
        if (!cancelled) setApiOnline(res.ok);
      } catch {
        if (!cancelled) setApiOnline(false);
      }
    }
    void probe();
    const timer = window.setInterval(() => void probe(), API_POLL_MS);
    function handleVisible() {
      if (document.visibilityState === "visible") void probe();
    }
    document.addEventListener("visibilitychange", handleVisible);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", handleVisible);
    };
  }, []);

  const loadStyles = useCallback(async () => {
    try {
      const res = await fetch("/api/styles", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { templates?: StyleTemplate[] };
      const templates = data.templates ?? [];
      setStyleTemplates(templates);
      // 已有选择保持不变；没有选择时回落到该渠道的内置默认模板
      setStyleSelection((prev) => {
        const next = { ...prev };
        for (const ch of STYLE_CHANNELS) {
          if (next[ch.key]) continue;
          const fallback =
            templates.find(
              (t) => t.id === DEFAULT_STYLE_BY_CHANNEL[ch.key] && t.channel === ch.key,
            ) ?? templates.find((t) => t.channel === ch.key);
          if (fallback) next[ch.key] = fallback.id;
        }
        return next;
      });
    } catch {
      // 模板列表取不到不影响主流程
    }
  }, []);

  /** 记录「最近一次运行」到本地，刷新或重开页面时用来接回 */
  const saveSession = useCallback(
    (
      sessionMode: Mode,
      entries: {
        runId: string;
        topic: string;
        label: string;
        variant?: VariantKey;
      }[],
    ) => {
      try {
        window.localStorage.setItem(
          SESSION_KEY,
          JSON.stringify({
            savedAt: Date.now(),
            mode: sessionMode,
            entries: entries.filter((entry) => entry.runId),
          }),
        );
      } catch {
        // 隐私模式下写不进去，不影响主流程
      }
    },
    [],
  );

  useEffect(() => {
    void loadStyles();
  }, [loadStyles]);

  // 首次访问自动弹引导；已看过或存储不可用时安静跳过
  useEffect(() => {
    try {
      if (window.localStorage.getItem("cab-guide-seen") !== "1") setTourStep(1);
    } catch {
      // 隐私模式读不到 localStorage，不打扰用户
    }
  }, []);

  // 引导每一步都重新测量目标位置，窗口缩放或滚动时同步更新
  useEffect(() => {
    if (tourStep === 0) return;
    const target =
      tourStep === 1
        ? topicInputRef.current
        : tourStep === 2
          ? modeTabsRef.current
          : startButtonRef.current;
    if (!target) {
      setTourLayout(null);
      return;
    }
    const measure = () => {
      const rect = target.getBoundingClientRect();
      setTourLayout({
        rect: {
          top: rect.top,
          left: rect.left,
          width: rect.width,
          height: rect.height,
        },
        vw: window.innerWidth,
        vh: window.innerHeight,
      });
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [tourStep]);

  useEffect(
    () => () => {
      esRef.current?.close();
      batchRunningRef.current = false;
    },
    [],
  );

  // 当前展示的数据源
  const currentNodes =
    mode === "single" ? nodes : tasks[activeTaskIndex]?.nodes ?? emptyNodes();
  const currentRunId =
    mode === "single" ? runId : tasks[activeTaskIndex]?.runId ?? null;
  const currentTaskStatus =
    mode === "single" ? runStatus : tasks[activeTaskIndex]?.status ?? "idle";
  const currentTopic =
    mode === "single" ? topic : tasks[activeTaskIndex]?.topic ?? topic;
  const currentReport =
    mode === "single" ? report : tasks[activeTaskIndex]?.report ?? null;
  const isRunning = currentTaskStatus === "running";
  const isCompleted = currentTaskStatus === "completed";
  /**
   * 是否还有流水线在跑：单次看当前视图，批量要看整批。
   * 批量时用户可能切到已完成的任务，此时队列仍在推进，不能只看当前任务状态。
   */
  const hasLiveRun =
    mode === "single"
      ? isRunning
      : tasks.some(
          (t) =>
            t.status === "running" ||
            t.status === "pending" ||
            t.status === "queued",
        );

  /**
   * 侧边栏任务列表：本次会话任务置顶，后面接服务端最近历史（最多 5 批）。
   * 当前会话的 runId 已在历史里落盘时跳过，避免同一条任务出现两次。
   */
  const sidebarCurrent: SidebarTaskItem[] = [];
  if (mode === "single") {
    if (runId) {
      sidebarCurrent.push({
        key: runId,
        title: currentTopic || "未命名选题",
        // 回看态优先展示快照里的创作维度名
        tag: reviewing?.variantName ?? "四路并行",
        createdAt: singleCreatedAt ?? 0,
        status:
          currentTaskStatus === "idle"
            ? "pending"
            : (currentTaskStatus as SidebarTaskItem["status"]),
        source: "current",
      });
    }
  } else {
    tasks.forEach((task, index) => {
      sidebarCurrent.push({
        key: task.id,
        title: task.topic,
        tag: task.variant ? variantLabel(task.variant) : task.label,
        createdAt: task.createdAt,
        status: task.status,
        source: "current",
        taskIndex: index,
        batchMode: mode,
      });
    });
  }
  const currentSessionRunIds = new Set(sidebarCurrent.map((item) => item.key));

  /** 历史按批次分组：同一批的多版任务收成一组，避免平铺成十几条 */
  const sidebarHistoryGroups: {
    key: string;
    title: string;
    createdAt: number;
    items: SidebarTaskItem[];
  }[] = [];
  for (const batch of historyBatches) {
    const items: SidebarTaskItem[] = [];
    for (const run of batch.runs) {
      if (currentSessionRunIds.has(run.runId)) continue;
      items.push({
        key: run.runId,
        title: run.topic,
        tag: run.variantName ?? "四路并行",
        createdAt: run.createdAt,
        status: run.status,
        source: "history",
        historyEntry: run,
      });
    }
    if (items.length === 0) continue;
    sidebarHistoryGroups.push({
      key: batch.batchId,
      // 批量选题批次用「N 个选题」做组标题，单条批次直接用选题
      title:
        batch.topics.length > 1
          ? `${batch.topics.length} 个选题`
          : batch.topics[0] ?? "历史任务",
      createdAt: batch.createdAt,
      items,
    });
  }
  sidebarHistoryGroups.sort((a, b) => b.createdAt - a.createdAt);
  const sidebarTaskCount =
    sidebarCurrent.length +
    sidebarHistoryGroups.reduce((sum, group) => sum + group.items.length, 0);

  function isSidebarTaskActive(item: SidebarTaskItem): boolean {
    if (item.source === "history") return reviewing?.runId === item.key;
    if (item.taskIndex !== undefined) {
      return (
        !reviewing &&
        mode !== "single" &&
        item.taskIndex === activeTaskIndex &&
        !compareView
      );
    }
    return Boolean(runId) && runId === item.key;
  }

  /** 侧边栏单条任务：历史条目额外给一个「迭代」入口 */
  function renderSidebarTask(item: SidebarTaskItem) {
    const active = isSidebarTaskActive(item);
    const historyEntry = item.historyEntry;
    return (
      <li key={item.key}>
        <div
          className={`flex items-center gap-1 rounded-lg border transition ${
            active
              ? "border-accent/40 bg-accent/10"
              : "border-transparent hover:bg-canvas"
          }`}
        >
          <button
            onClick={() => selectSidebarTask(item)}
            title={`${item.title} · ${item.tag}${
              item.createdAt > 0 ? ` · ${formatTime(item.createdAt)}` : ""
            }`}
            className={`flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-2 text-left ${
              sidebarCollapsed ? "justify-center" : ""
            }`}
          >
            <span
              className={`h-2 w-2 shrink-0 rounded-full ${sidebarStatusDot(item.status)}`}
            />
            {!sidebarCollapsed && (
              <span className="min-w-0 flex-1">
                <span
                  className={`block truncate text-xs ${
                    active ? "font-medium text-accent" : "text-ink"
                  }`}
                >
                  {item.title}
                </span>
                <span className="mt-1 flex items-center gap-1.5 text-[10px] text-ink-3">
                  <span className="shrink-0 rounded border border-hairline bg-canvas px-1 py-0.5">
                    {item.tag}
                  </span>
                  {item.source === "current" && item.status === "queued" && (
                    <span className="shrink-0 rounded border border-amber-200 bg-amber-50 px-1 py-0.5 text-amber-700">
                      排队中
                    </span>
                  )}
                  <span className="shrink-0 tabular-nums">
                    {item.createdAt > 0 ? formatTime(item.createdAt) : ""}
                  </span>
                </span>
              </span>
            )}
          </button>
          {historyEntry && !sidebarCollapsed && (
            <button
              onClick={() => void resumeHistoryRun(historyEntry)}
              disabled={hasLiveRun}
              title={
                hasLiveRun
                  ? "流水线运行中，结束后才能迭代历史任务"
                  : "接回可编辑视图，改动提纲只重跑受影响的渠道"
              }
              className="mr-1 shrink-0 rounded border border-hairline-strong px-1.5 py-0.5 text-[10px] text-ink-3 transition hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-hairline-strong disabled:hover:text-ink-3"
            >
              迭代
            </button>
          )}
        </div>
      </li>
    );
  }

  /**
   * 切任务前的统一守护：草稿归属会变，不能悄悄丢掉或带到新任务上。
   * 有未提交改动先确认；确认后一律清空编辑态（含撤销栈）。
   */
  function beginTaskSwitch(): boolean {
    if (
      outlineEditing &&
      outlineDraft !== outlineBaselineRef.current &&
      !window.confirm("当前提纲还有未提交的修改，切换任务会丢弃这些修改。继续？")
    ) {
      return false;
    }
    resetOutlineEditor();
    return true;
  }

  /**
   * 侧边栏切任务：当前会话任务切视图，历史任务进只读回看。
   * 运行中不允许跳历史：openHistoryRun 会关闭当前 SSE，批量队列会因此卡住。
   */
  function selectSidebarTask(item: SidebarTaskItem) {
    if (item.source === "history") {
      if (hasLiveRun) {
        setNotice("流水线运行中，结束后再回看历史任务");
        return;
      }
      if (!beginTaskSwitch() || !item.historyEntry) return;
      void openHistoryRun(item.historyEntry);
      return;
    }
    if (item.taskIndex === undefined || !beginTaskSwitch()) return;
    // 回看会临时切到单次视图，切回批量任务时把模式恢复回来
    setReviewing(null);
    setMode(item.batchMode ?? mode);
    setActiveTaskIndex(item.taskIndex);
    setCompareView(false);
    setNotice("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  /** 新建流水线任务：清空当前结果回到输入区，历史与成品库不受影响 */
  function handleNewTask() {
    // 批量队列可能正跑在别的任务上，不能只看当前视图
    if (hasLiveRun) {
      setNotice("流水线运行中，结束后再新建任务");
      return;
    }
    esRef.current?.close();
    setReviewing(null);
    setSettingsOpen(false);
    setCompareView(false);
    setMode("single");
    setTopic("");
    setMultiTopic("");
    setTasks([]);
    setActiveTaskIndex(0);
    setNodes(emptyNodes());
    setRunStatus("idle");
    setRunId(null);
    setReport(null);
    setSingleCreatedAt(null);
    setPendingSession(null);
    setNotice("");
    setReconnectNotice("");
    setCopied({});
    setExpanded({});
    resetOutlineEditor();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  // 收藏整个项目要求四路内容都已完成并产出实际内容
  const allFourCompleted = PROJECT_CHANNEL_IDS.every(
    (id) => currentNodes[id]?.status === "completed",
  );

  // 当前 run 的提纲版本链与编辑草稿状态
  const currentOutline = currentRunId ? outlines[currentRunId] ?? null : null;
  const outlineVersions = currentOutline?.versions ?? [];
  const activeOutlineVersion =
    outlineVersions.find((v) => v.id === currentOutline?.activeId) ?? null;
  const draftParse = outlineEditing ? parseOutlineText(outlineDraft) : null;
  const outlineChanged =
    draftParse?.ok === true &&
    JSON.stringify(draftParse.value) !==
      JSON.stringify(activeOutlineVersion?.outline ?? null);
  /** 提交前预览：这次改动会重跑哪几路，与服务端调度用同一套 diff */
  const draftAffected =
    draftParse?.ok === true
      ? diffOutlineChannels(
          activeOutlineVersion?.outline ?? null,
          draftParse.value,
        )
      : [];

  /** 表单编辑读的就是这份解析结果；结构不认识时为 null，退回 JSON 模式 */
  const outlineShape =
    draftParse?.ok === true && isOutlineDoc(draftParse.value)
      ? draftParse.value
      : null;

  /** 表单改动的唯一出口：改完重新序列化回草稿文本，撤销栈与提交链路完全不变 */
  function updateOutline(mutate: (doc: OutlineDoc) => void) {
    if (draftParse?.ok !== true || !isOutlineDoc(draftParse.value)) return;
    const doc = JSON.parse(JSON.stringify(draftParse.value)) as OutlineDoc;
    mutate(doc);
    setOutlineDraft(JSON.stringify(doc, null, 2));
  }

  function updateOutlineChannel(
    channel: OutlineChannelKey,
    patch: Record<string, unknown>,
  ) {
    updateOutline((doc) => {
      const outline = (doc.outline ??= {});
      outline[channel] = { ...(outline[channel] ?? {}), ...patch };
    });
  }

  /** 渠道表单块：角度 + 若干行文本字段，四个渠道共用同一套结构 */
  const renderOutlineChannel = (
    channel: OutlineChannelKey,
    title: string,
    fields: { key: string; label: string; lines?: boolean }[],
  ) => {
    const data = outlineShape?.outline?.[channel] ?? {};
    return (
      <div
        key={channel}
        className="flex flex-col gap-2 rounded-lg border border-hairline bg-surface p-3"
      >
        <p className="text-xs font-medium text-ink">{title}</p>
        <label className="flex flex-col gap-1">
          <span className="text-[10px] text-ink-3">切入角度</span>
          <input
            value={outlineText(data.angle)}
            onChange={(event) =>
              updateOutlineChannel(channel, { angle: event.target.value })
            }
            className={OUTLINE_FIELD_CLASS}
          />
        </label>
        {fields.map((field) => (
          <label key={field.key} className="flex flex-col gap-1">
            <span className="text-[10px] text-ink-3">{field.label}</span>
            {field.lines ? (
              <textarea
                rows={3}
                value={outlineLines(data[field.key])}
                onChange={(event) =>
                  updateOutlineChannel(channel, {
                    [field.key]: outlineList(event.target.value),
                  })
                }
                className={`${OUTLINE_FIELD_CLASS} resize-y leading-relaxed`}
              />
            ) : (
              <input
                value={outlineText(data[field.key])}
                onChange={(event) =>
                  updateOutlineChannel(channel, {
                    [field.key]: event.target.value,
                  })
                }
                className={OUTLINE_FIELD_CLASS}
              />
            )}
          </label>
        ))}
      </div>
    );
  };

  const patchNodeSingle = useCallback(
    (nodeId: NodeId, patch: Partial<AgentNodeState>) => {
      setNodes((prev) => ({
        ...prev,
        [nodeId]: { ...prev[nodeId], ...patch },
      }));
    },
    [],
  );

  const toggleNode = useCallback((nodeId: NodeId) => {
    setExpanded((prev) => ({ ...prev, [nodeId]: !prev[nodeId] }));
  }, []);

  /** 节点开始运行时自动展开，让流式输出始终可见 */
  const expandNode = useCallback((nodeId: NodeId) => {
    setExpanded((prev) => (prev[nodeId] ? prev : { ...prev, [nodeId]: true }));
  }, []);

  const patchNodeTask = useCallback(
    (taskIndex: number, nodeId: NodeId, patch: Partial<AgentNodeState>) => {
      setTasks((prev) =>
        prev.map((t, idx) =>
          idx === taskIndex
            ? { ...t, nodes: { ...t.nodes, [nodeId]: { ...t.nodes[nodeId], ...patch } } }
            : t,
        ),
      );
    },
    [],
  );

  /** 快照里的提纲版本链按 runId 并入本地缓存，单次与批量模式共用 */
  const applyOutlineSnapshot = useCallback((snap: RunSnapshot) => {
    setOutlines((prev) => ({
      ...prev,
      [snap.runId]: {
        versions: snap.outlineVersions ?? [],
        activeId: snap.outlineVersionId ?? null,
      },
    }));
  }, []);

  // —— 提纲编辑的本地撤销 / 重做 ——
  /** 把栈的当前位置同步到按钮可用态 */
  const syncOutlineHistory = useCallback(() => {
    const { entries, index } = outlineHistory.current;
    setOutlineHistoryState({
      canUndo: index > 0,
      canRedo: index < entries.length - 1,
      undoSteps: Math.max(index, 0),
      redoSteps: Math.max(entries.length - 1 - index, 0),
    });
  }, []);

  /** 开一次编辑会话：用当前草稿做栈底，保证第一次撤销能回到初始内容 */
  const seedOutlineHistory = useCallback(
    (text: string) => {
      outlineHistory.current = { entries: [text], index: 0 };
      syncOutlineHistory();
    },
    [syncOutlineHistory],
  );

  /** 切换版本 / 提交 / 切任务时清空，避免撤销到另一个任务的草稿 */
  const clearOutlineHistory = useCallback(() => {
    outlineHistory.current = { entries: [], index: -1 };
    syncOutlineHistory();
  }, [syncOutlineHistory]);

  /** 失焦时记一次变更：与栈顶相同的草稿不记，避免光标进出白占一格 */
  const recordOutlineHistory = useCallback(
    (text: string) => {
      const history = outlineHistory.current;
      if (history.entries[history.index] === text) return;
      // 在历史中间继续编辑时丢弃「未来」分支，与常见编辑器行为一致
      const kept = [...history.entries.slice(0, history.index + 1), text];
      const trimmed = kept.slice(-OUTLINE_HISTORY_LIMIT);
      outlineHistory.current = { entries: trimmed, index: trimmed.length - 1 };
      syncOutlineHistory();
    },
    [syncOutlineHistory],
  );

  const undoOutline = useCallback(() => {
    const history = outlineHistory.current;
    if (history.index <= 0) return;
    history.index -= 1;
    setOutlineDraft(history.entries[history.index]);
    setOutlineError("");
    syncOutlineHistory();
  }, [syncOutlineHistory]);

  const redoOutline = useCallback(() => {
    const history = outlineHistory.current;
    if (history.index >= history.entries.length - 1) return;
    history.index += 1;
    setOutlineDraft(history.entries[history.index]);
    setOutlineError("");
    syncOutlineHistory();
  }, [syncOutlineHistory]);

  // 快捷键：焦点在文本域内交给浏览器原生撤销（字符级更细），在外部才接管 Ctrl/Cmd+Z
  useEffect(() => {
    if (!outlineEditing) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key.toLowerCase() !== "z") return;
      const tag = (event.target as HTMLElement | null)?.tagName;
      if (tag === "TEXTAREA" || tag === "INPUT") return;
      event.preventDefault();
      if (event.shiftKey) redoOutline();
      else undoOutline();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [outlineEditing, redoOutline, undoOutline]);

  // 输入停顿即记一步：不依赖失焦，避免「撤销」在编辑中一直不可用
  useEffect(() => {
    if (!outlineEditing) return;
    const timer = window.setTimeout(() => {
      recordOutlineHistory(outlineDraft);
    }, OUTLINE_AUTOSAVE_MS);
    return () => window.clearTimeout(timer);
  }, [outlineEditing, outlineDraft, recordOutlineHistory]);

  /** 策划完成时快照里还没有版本链，单独拉一次全量快照补上 */
  const refreshOutline = useCallback(
    async (id: string) => {
      try {
        const res = await fetch(`/api/run/${id}`, { cache: "no-store" });
        if (!res.ok) return;
        applyOutlineSnapshot((await res.json()) as RunSnapshot);
      } catch {
        // 拉取失败不影响主流程，策划卡会退回展示原始文本
      }
    },
    [applyOutlineSnapshot],
  );

  // 单次模式 SSE
  const connectSingle = useCallback(
    (id: string) => {
      esRef.current?.close();
      const es = new EventSource(`/api/stream/${id}`);
      esRef.current = es;

      es.addEventListener("snapshot", (ev) => {
        // 断线重连时服务端会重新下发全量快照，这里整体替换即可，不需要回放事件
        const snap = JSON.parse((ev as MessageEvent).data) as RunSnapshot;
        setNodes(snap.nodes);
        setRunStatus(snap.status);
        setReport(snap.report);
        setSingleCreatedAt(snap.createdAt);
        applyOutlineSnapshot(snap);
        setReconnectNotice("");
        if (snap.status !== "running") es.close();
      });

      es.addEventListener("node:start", (ev) => {
        const d = JSON.parse((ev as MessageEvent).data) as {
          nodeId: NodeId;
          attempt: number;
        };
        patchNodeSingle(d.nodeId, {
          status: "running",
          content: "",
          imageUrl: undefined,
          error: undefined,
          attempt: d.attempt,
        });
        expandNode(d.nodeId);
      });

      es.addEventListener("node:token", (ev) => {
        const d = JSON.parse((ev as MessageEvent).data) as {
          nodeId: NodeId;
          text: string;
        };
        setNodes((prev) => ({
          ...prev,
          [d.nodeId]: {
            ...prev[d.nodeId],
            content: prev[d.nodeId].content + d.text,
          },
        }));
      });

      es.addEventListener("node:image", (ev) => {
        const d = JSON.parse((ev as MessageEvent).data) as {
          nodeId: NodeId;
          url: string;
        };
        patchNodeSingle(d.nodeId, { imageUrl: d.url });
      });

      es.addEventListener("node:done", (ev) => {
        const d = JSON.parse((ev as MessageEvent).data) as { nodeId: NodeId };
        patchNodeSingle(d.nodeId, { status: "completed" });
        // 策划完成瞬间版本链才产生，补拉一次快照让编辑入口立刻可用
        if (d.nodeId === "planner") void refreshOutline(id);
      });

      es.addEventListener("node:error", (ev) => {
        const d = JSON.parse((ev as MessageEvent).data) as {
          nodeId: NodeId;
          message: string;
        };
        patchNodeSingle(d.nodeId, { status: "failed", error: d.message });
      });

      es.addEventListener("node:cancelled", (ev) => {
        const d = JSON.parse((ev as MessageEvent).data) as { nodeId: NodeId };
        patchNodeSingle(d.nodeId, { status: "cancelled" });
      });

      es.addEventListener("run:done", (ev) => {
        const d = JSON.parse((ev as MessageEvent).data) as {
          report: RunReport | null;
        };
        setRunStatus((prev) => (prev === "aborted" ? prev : "completed"));
        setReport(d.report);
        // run 已落盘，刷新历史列表
        void loadHistory();
        es.close();
      });

      es.addEventListener("run:failed", (ev) => {
        const d = JSON.parse((ev as MessageEvent).data) as {
          message: string;
          report: RunReport | null;
        };
        setRunStatus("failed");
        setNotice(d.message);
        setReport(d.report);
        void loadHistory();
        es.close();
      });

      es.onerror = () => {
        // EventSource 自带重连，服务端重连后立刻补发全量快照，这里只做可见提示
        if (es.readyState !== EventSource.CLOSED) {
          setReconnectNotice("连接中断，正在重连…");
        }
      };
    },
    [patchNodeSingle, expandNode, loadHistory, applyOutlineSnapshot, refreshOutline],
  );

  // 批量模式 SSE，返回 Promise 在 run 结束时 resolve
  function connectTask(runId: string, taskIndex: number): Promise<void> {
    return new Promise((resolve) => {
      esRef.current?.close();
      const es = new EventSource(`/api/stream/${runId}`);
      esRef.current = es;

      es.addEventListener("snapshot", (ev) => {
        // 断线重连后服务端补发全量快照；如果 run 已经结束，这里必须直接收尾，
        // 否则错过 run:done 会让整个批量队列永远卡住
        const snap = JSON.parse((ev as MessageEvent).data) as RunSnapshot;
        setTasks((prev) =>
          prev.map((t, idx) =>
            idx === taskIndex
              ? { ...t, nodes: snap.nodes, status: snap.status, report: snap.report }
              : t,
          ),
        );
        applyOutlineSnapshot(snap);
        setReconnectNotice("");
        if (snap.status !== "running") {
          es.close();
          resolve();
        }
      });

      es.addEventListener("node:start", (ev) => {
        const d = JSON.parse((ev as MessageEvent).data) as {
          nodeId: NodeId;
          attempt: number;
        };
        patchNodeTask(taskIndex, d.nodeId, {
          status: "running",
          content: "",
          imageUrl: undefined,
          error: undefined,
          attempt: d.attempt,
        });
        expandNode(d.nodeId);
      });

      es.addEventListener("node:token", (ev) => {
        const d = JSON.parse((ev as MessageEvent).data) as {
          nodeId: NodeId;
          text: string;
        };
        setTasks((prev) =>
          prev.map((t, idx) =>
            idx === taskIndex
              ? {
                  ...t,
                  nodes: {
                    ...t.nodes,
                    [d.nodeId]: {
                      ...t.nodes[d.nodeId],
                      content: t.nodes[d.nodeId].content + d.text,
                    },
                  },
                }
              : t,
          ),
        );
      });

      es.addEventListener("node:image", (ev) => {
        const d = JSON.parse((ev as MessageEvent).data) as {
          nodeId: NodeId;
          url: string;
        };
        patchNodeTask(taskIndex, d.nodeId, { imageUrl: d.url });
      });

      es.addEventListener("node:done", (ev) => {
        const d = JSON.parse((ev as MessageEvent).data) as { nodeId: NodeId };
        patchNodeTask(taskIndex, d.nodeId, { status: "completed" });
        if (d.nodeId === "planner") void refreshOutline(runId);
      });

      es.addEventListener("node:error", (ev) => {
        const d = JSON.parse((ev as MessageEvent).data) as {
          nodeId: NodeId;
          message: string;
        };
        patchNodeTask(taskIndex, d.nodeId, { status: "failed", error: d.message });
      });

      es.addEventListener("node:cancelled", (ev) => {
        const d = JSON.parse((ev as MessageEvent).data) as { nodeId: NodeId };
        patchNodeTask(taskIndex, d.nodeId, { status: "cancelled" });
      });

      es.addEventListener("run:done", (ev) => {
        const d = JSON.parse((ev as MessageEvent).data) as {
          report: RunReport | null;
        };
        setTasks((prev) =>
          prev.map((t, idx) =>
            idx === taskIndex
              ? { ...t, status: "completed", report: d.report }
              : t,
          ),
        );
        // 本批完成一个 run，历史列表同步刷新
        void loadHistory();
        es.close();
        resolve();
      });

      es.addEventListener("run:failed", (ev) => {
        const d = JSON.parse((ev as MessageEvent).data) as {
          message: string;
          report: RunReport | null;
        };
        setTasks((prev) =>
          prev.map((t, idx) =>
            idx === taskIndex
              ? { ...t, status: "failed", report: d.report }
              : t,
          ),
        );
        setNotice(d.message);
        void loadHistory();
        es.close();
        resolve();
      });

      es.onerror = () => {
        if (es.readyState !== EventSource.CLOSED) {
          setReconnectNotice("连接中断，正在重连…");
        }
      };
    });
  }

  // 单次：开始
  async function handleStartSingle() {
    const value = topic.trim();
    if (!value) return;
    esRef.current?.close();
    setReviewing(null);
    setNodes(emptyNodes());
    setRunStatus("running");
    setNotice("");
    setReport(null);
    setReconnectNotice("");
    setCopied({});
    setExpanded({});
    resetOutlineEditor();
    setPendingSession(null);
    try {
      const res = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic: value, styles: stylesPayload() }),
      });
      const data = (await res.json()) as { runId?: string; error?: string };
      if (!res.ok || !data.runId) throw new Error(data.error ?? `启动失败 ${res.status}`);
      setRunId(data.runId);
      // 记下本次运行，刷新后能接回来
      saveSession("single", [
        { runId: data.runId, topic: value, label: "单次生成" },
      ]);
      connectSingle(data.runId);
    } catch (err) {
      setRunStatus("failed");
      setNotice(err instanceof Error ? err.message : String(err));
    }
  }

  // 批量：开始
  async function handleStartBatch() {
    let taskList: { topic: string; label: string; variant?: VariantKey }[] = [];
    if (mode === "multi-topic") {
      const topics = multiTopic
        .split("\n")
        .map((t) => t.trim())
        .filter(Boolean)
        .slice(0, 3);
      if (topics.length === 0) return;
      taskList = topics.map((t, i) => ({ topic: t, label: `选题 ${i + 1}` }));
    } else {
      const t = topic.trim();
      if (!t) return;
      // 多版模式固定三个创作维度，不再让用户选数量
      taskList = VARIANTS.map((v) => ({
        topic: t,
        label: v.name,
        variant: v.key,
      }));
    }

    const initial: TaskResult[] = taskList.map((t, i) => ({
      id: `${Date.now()}-${i}`,
      topic: t.topic,
      label: t.label,
      variant: t.variant,
      status: "queued",
      nodes: emptyNodes(),
      createdAt: Date.now(),
    }));

    setTasks(initial);
    setActiveTaskIndex(0);
    setNotice("");
    setReconnectNotice("");
    setCopied({});
    setExpanded({});
    resetOutlineEditor();
    setPendingSession(null);
    batchRunningRef.current = true;

    // 同一批任务共享 batchId，历史回看时聚合为一个批次
    const batchUuid = crypto.randomUUID();
    // 已成功创建的任务：落本地会话，刷新后能接回已启动的部分
    const created: {
      runId: string;
      topic: string;
      label: string;
      variant?: VariantKey;
    }[] = [];

    for (let i = 0; i < initial.length; i++) {
      if (!batchRunningRef.current) {
        setTasks((prev) =>
          prev.map((t, idx) => (idx >= i ? { ...t, status: "aborted" } : t)),
        );
        break;
      }
      setActiveTaskIndex(i);
      setTasks((prev) =>
        prev.map((t, idx) => (idx === i ? { ...t, status: "running" } : t)),
      );
      try {
        const res = await fetch("/api/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            topic: initial[i].topic,
            ...(initial[i].variant ? { variant: initial[i].variant } : {}),
            batchId: batchUuid,
            styles: stylesPayload(),
          }),
        });
        const data = (await res.json()) as { runId?: string; error?: string };
        if (!res.ok || !data.runId) throw new Error(data.error ?? `启动失败 ${res.status}`);
        setTasks((prev) =>
          prev.map((t, idx) => (idx === i ? { ...t, runId: data.runId } : t)),
        );
        created.push({
          runId: data.runId,
          topic: initial[i].topic,
          label: initial[i].label,
          variant: initial[i].variant,
        });
        saveSession(mode, created);
        await connectTask(data.runId, i);
      } catch (err) {
        setTasks((prev) =>
          prev.map((t, idx) => (idx === i ? { ...t, status: "failed" } : t)),
        );
        setNotice(err instanceof Error ? err.message : String(err));
      }
    }
    batchRunningRef.current = false;
  }

  function handleStopAll() {
    if (mode === "single") {
      if (!runId) return;
      fetch(`/api/stop/${runId}`, { method: "POST" });
      setRunStatus("aborted");
    } else {
      batchRunningRef.current = false;
      esRef.current?.close();
      setTasks((prev) =>
        prev.map((t) =>
          t.status === "running" ||
          t.status === "pending" ||
          t.status === "queued"
            ? { ...t, status: "aborted" }
            : t,
        ),
      );
    }
  }

  async function handleStopNode(nodeId: NodeId) {
    if (!currentRunId) return;
    await fetch(`/api/stop/${currentRunId}?nodeId=${nodeId}`, { method: "POST" });
  }

  async function handleRerun(nodeId: NodeId) {
    if (!currentRunId) return;
    setNotice("");
    const res = await fetch(`/api/rerun/${nodeId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId: currentRunId }),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setNotice(data.error ?? `重跑失败 ${res.status}`);
      return;
    }
    setCopied((prev) => {
      const next = { ...prev };
      delete next[nodeId];
      return next;
    });
    // 重跑后重新连接 SSE
    if (mode === "single") {
      setRunStatus("running");
      // 重跑会让服务端作废旧报告，前端同步清空
      setReport(null);
      connectSingle(currentRunId);
    } else {
      const idx = activeTaskIndex;
      setTasks((prev) =>
        prev.map((t, i) =>
          i === idx ? { ...t, status: "running", report: null } : t,
        ),
      );
      connectTask(currentRunId, idx);
    }
  }

  // —— 提纲人工干预：编辑、版本回退、局部重生成 ——
  function beginOutlineEdit(version?: OutlineVersion) {
    if (!currentRunId) return;
    const target = version ?? activeOutlineVersion;
    const text = target
      ? JSON.stringify(target.outline, null, 2)
      : currentNodes.planner.content.trim();
    setOutlineDraft(text);
    outlineBaselineRef.current = text;
    // 结构可识别的提纲默认进表单，识别不了先给 JSON 让人修
    const parsed = parseOutlineText(text);
    setOutlineJsonMode(!(parsed.ok && isOutlineDoc(parsed.value)));
    // 换版本等于开新会话：旧版本上的编辑历史不应带过来
    seedOutlineHistory(text);
    setOutlineSelectedVersion(target?.id ?? null);
    setOutlineEditing(true);
    setOutlineError("");
    setOutlineNotice("");
    expandNode("planner");
  }

  function cancelOutlineEdit() {
    setOutlineEditing(false);
    setOutlineDraft("");
    setOutlineSelectedVersion(null);
    setOutlineError("");
    setOutlineJsonMode(false);
    outlineBaselineRef.current = "";
    clearOutlineHistory();
  }

  /** 新任务开始或进入回看时清空编辑态，避免上一个 run 的草稿串台 */
  function resetOutlineEditor() {
    setOutlineEditing(false);
    setOutlineDraft("");
    setOutlineSelectedVersion(null);
    setOutlineError("");
    setOutlineNotice("");
    setOutlineJsonMode(false);
    outlineBaselineRef.current = "";
    clearOutlineHistory();
  }

  async function handleOutlineRegenerate() {
    const runId = currentRunId;
    if (!runId) return;

    const parsed = parseOutlineText(outlineDraft);
    if (!parsed.ok) {
      setOutlineError(parsed.error);
      return;
    }

    setOutlineBusy(true);
    setOutlineError("");
    setOutlineNotice("");
    try {
      const res = await fetch(`/api/outline/${runId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ outline: parsed.value }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        version?: OutlineVersion;
        versions?: OutlineVersion[];
        affected?: NodeId[];
        error?: string;
      };
      if (!res.ok || !data.version || !data.versions) {
        throw new Error(data.error ?? `重生成失败 ${res.status}`);
      }

      setOutlines((prev) => ({
        ...prev,
        [runId]: { versions: data.versions!, activeId: data.version!.id },
      }));
      setOutlineEditing(false);
      setOutlineSelectedVersion(null);
      // 提交成功即关闭编辑会话，历史栈随之作废
      clearOutlineHistory();
      setOutlineNotice(
        `已提交「${data.version.id} ${data.version.label}」，重生成范围：${(
          data.affected ?? []
        )
          .map((id) => NODE_META[id].name)
          .join("、")}`,
      );

      const affected = data.affected ?? [];
      setCopied((prev) => {
        const next = { ...prev };
        for (const id of affected) delete next[id];
        return next;
      });

      // 下游已重新调度，重连 SSE 观察本次局部重生成
      if (mode === "single") {
        setRunStatus("running");
        setReport(null);
        connectSingle(runId);
      } else {
        const idx = activeTaskIndex;
        setTasks((prev) =>
          prev.map((t, i) =>
            i === idx ? { ...t, status: "running", report: null } : t,
          ),
        );
        connectTask(runId, idx);
      }
    } catch (err) {
      setOutlineError(err instanceof Error ? err.message : String(err));
    } finally {
      setOutlineBusy(false);
    }
  }

  async function handleCopy(nodeId: NodeId) {
    const text = currentNodes[nodeId].content;
    if (!text || copied[nodeId]) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied((prev) => ({ ...prev, [nodeId]: true }));
    } catch {
      setNotice("复制失败，请手动选择文本复制");
    }
  }

  async function handleCopyAll() {
    const lf = currentNodes.longform.content.trim();
    const sc = currentNodes.script.content.trim();
    const xhs = currentNodes.xhs.content.trim();
    if (!lf && !sc && !xhs) return;
    const text = [
      `# 选题：${currentTopic}`,
      "## 公众号长文",
      lf,
      "## 短视频脚本",
      sc,
      "## 小红书笔记",
      xhs,
    ].join("\n\n");
    try {
      await navigator.clipboard.writeText(text);
      setNotice("已复制四路产出");
    } catch {
      setNotice("复制失败，请手动选择文本复制");
    }
  }

  function handleDownloadImage() {
    const url = currentNodes.image.imageUrl;
    if (!url) return;
    const a = document.createElement("a");
    a.href = url;
    a.download = `${currentTopic || "image"}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  function handleExportAll() {
    const lf = currentNodes.longform.content;
    const sc = currentNodes.script.content;
    const xhs = currentNodes.xhs.content;
    const img = currentNodes.image.imageUrl || "";
    const md = `# 选题：${currentTopic}\n\n## 公众号长文\n\n${lf}\n\n## 短视频脚本\n\n${sc}\n\n## 小红书笔记\n\n${xhs}\n\n## 配图\n\n![配图](${img})\n`;
    const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${currentTopic || "content"}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // —— 成品库：把内容卡片存成不被历史淘汰的长期产出 ——
  async function handleSaveToLibrary(nodeId: NodeId) {
    const runId = currentRunId;
    if (!runId || !isSavableNodeId(nodeId) || libraryBusy) return;

    setLibraryBusy(nodeId);
    try {
      const res = await fetch("/api/library", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId, nodeId }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        updated?: boolean;
        error?: string;
      };
      if (!res.ok) throw new Error(data.error ?? `入库失败 ${res.status}`);
      await loadLibrary();
      setNotice(
        data.updated
          ? `已更新成品库里的「${NODE_META[nodeId].name}」`
          : `已收藏到成品库：${NODE_META[nodeId].name}`,
      );
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setLibraryBusy("");
    }
  }

  async function handleRemoveLibraryItem(item: SavedItem) {
    try {
      const res = await fetch(`/api/library/${encodeURIComponent(item.id)}`, {
        method: "DELETE",
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? `删除失败 ${res.status}`);
      setLibraryItems((prev) => prev.filter((entry) => entry.id !== item.id));
      setNotice("已从成品库移除");
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleCopyLibraryItem(item: SavedItem) {
    if (!item.content.trim()) {
      setNotice("该成品没有可复制的文本");
      return;
    }
    try {
      await navigator.clipboard.writeText(item.content);
      setNotice(`已复制「${LIBRARY_NODE_NAMES[item.nodeId]}」`);
    } catch {
      setNotice("复制失败，请手动选择文本复制");
    }
  }

  function handleDownloadLibraryItem(item: SavedItem) {
    const a = document.createElement("a");
    if (item.nodeId === "image" && item.imageUrl) {
      a.href = item.imageUrl;
      a.download = `${item.topic || "image"}.png`;
    } else {
      const md = `# ${item.topic}\n\n## ${LIBRARY_NODE_NAMES[item.nodeId]}\n\n${item.content}\n`;
      a.href = URL.createObjectURL(
        new Blob([md], { type: "text/markdown;charset=utf-8" }),
      );
      a.download = `${item.topic || "content"}-${item.nodeId}.md`;
    }
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
  }

  // —— 项目库：把一整条流水线的全部产出收藏成一个整体 ——
  async function handleSaveProject() {
    const runId = currentRunId;
    if (!runId || projectBusy) return;
    setProjectBusy(true);
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        updated?: boolean;
        error?: string;
      };
      if (!res.ok) throw new Error(data.error ?? `收藏失败 ${res.status}`);
      await loadProjects();
      setNotice(
        data.updated ? "已更新项目库里的这批产出" : "已收藏整个项目到项目库",
      );
      // 收藏完直接切到项目标签，让用户立刻看到结果
      setLibraryTab("project");
      setLibraryOpen(true);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setProjectBusy(false);
    }
  }

  async function handleRemoveProject(item: ProjectItem) {
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(item.id)}`, {
        method: "DELETE",
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? `删除失败 ${res.status}`);
      setProjectItems((prev) => prev.filter((entry) => entry.id !== item.id));
      setNotice("已从项目库移除");
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    }
  }

  function handleDownloadProject(item: ProjectItem) {
    const { longform, script, xhs, image } = item.channels;
    const md =
      `# 选题：${item.topic}\n\n` +
      `## 公众号长文\n\n${longform.content}\n\n` +
      `## 短视频脚本\n\n${script.content}\n\n` +
      `## 小红书笔记\n\n${xhs.content}\n\n` +
      `## 配图\n\n![配图](${image.imageUrl || ""})\n`;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(
      new Blob([md], { type: "text/markdown;charset=utf-8" }),
    );
    a.download = `${item.topic || "project"}-项目.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
  }

  // 打开一条历史任务：用落盘快照回填结果区，进入只读回看，不建立 SSE
  async function openHistoryRun(entry: HistoryRunEntry) {
    esRef.current?.close();
    try {
      const res = await fetch(`/api/run/${entry.runId}`, { cache: "no-store" });
      if (!res.ok) throw new Error("历史快照已不存在");
      const snap = (await res.json()) as RunSnapshot;
      setMode("single");
      setTopic(snap.topic);
      setNodes(snap.nodes);
      setRunStatus(snap.status);
      setRunId(snap.runId);
      setReport(snap.report);
      setSingleCreatedAt(snap.createdAt);
      setExpanded({});
      setCopied({});
      setNotice("");
      setReconnectNotice("");
      // 历史快照里同样带着提纲版本链，回看态可查但不能编辑
      applyOutlineSnapshot(snap);
      resetOutlineEditor();
      setReviewing({
        runId: snap.runId,
        variantName: entry.variantName,
        // 老快照没有 styles 字段，兜底成空数组
        styleNames: Object.values(snap.styles ?? {})
          .map((style) => style?.name)
          .filter((name): name is string => Boolean(name)),
        finishedAt: snap.finishedAt,
      });
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * 把快照载入正常视图（不是只读回看），载入后可以继续编辑提纲。
   * 只在快照状态是 running 时连 SSE，终态不会凭空产生事件流。
   */
  function applySnapshotToView(snap: RunSnapshot) {
    esRef.current?.close();
    setReviewing(null);
    setMode("single");
    setTopic(snap.topic);
    setNodes(snap.nodes);
    setRunStatus(snap.status);
    setRunId(snap.runId);
    setReport(snap.report);
    setSingleCreatedAt(snap.createdAt);
    setCopied({});
    setExpanded({});
    setReconnectNotice("");
    applyOutlineSnapshot(snap);
    resetOutlineEditor();
    if (snap.status === "running") connectSingle(snap.runId);
  }

  /**
   * 批量会话恢复：只恢复已经拿到 runId 的任务。
   * 刷新发生在队列中间时，未启动的任务不会被凭空补出来，避免出现永远待跑的 tab。
   */
  function applySnapshotsToBatch(
    sessionMode: Mode,
    items: {
      topic: string;
      label: string;
      variant?: VariantKey;
      snap: RunSnapshot;
    }[],
  ) {
    const restored: TaskResult[] = items.map((item, index) => ({
      id: `restored-${index}`,
      topic: item.topic,
      label: item.label,
      variant: item.variant,
      status:
        item.snap.status === "running"
          ? "running"
          : item.snap.status === "failed"
            ? "failed"
            : item.snap.status === "aborted"
              ? "aborted"
              : "completed",
      nodes: item.snap.nodes,
      runId: item.snap.runId,
      createdAt: item.snap.createdAt,
      report: item.snap.report,
    }));

    esRef.current?.close();
    setReviewing(null);
    setMode(sessionMode);
    setTasks(restored);
    setActiveTaskIndex(0);
    setCopied({});
    setExpanded({});
    setReconnectNotice("");
    for (const item of items) applyOutlineSnapshot(item.snap);
    resetOutlineEditor();

    const runningIndex = restored.findIndex((task) => task.status === "running");
    if (runningIndex >= 0 && restored[runningIndex].runId) {
      void connectTask(restored[runningIndex].runId!, runningIndex);
    }
  }

  // 历史批次「继续迭代」：接回内存后进入可编辑视图，不动原产出
  async function resumeHistoryRun(entry: Pick<HistoryRunEntry, "runId">) {
    if (!beginTaskSwitch()) return;
    try {
      const res = await fetch(`/api/run/${entry.runId}/resume`, {
        method: "POST",
      });
      if (!res.ok) throw new Error("历史快照已不存在");
      const snap = (await res.json()) as RunSnapshot;
      applySnapshotToView(snap);
      setNotice(`已接回「${snap.topic}」，可编辑提纲后局部重生成`);
      saveSession("single", [
        { runId: snap.runId, topic: snap.topic, label: "历史续跑" },
      ]);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    }
  }

  // 刷新后点「继续查看」：先把快照回灌进内存，再接回视图
  async function resumePendingSession() {
    const session = pendingSession;
    if (!session) return;

    const items: typeof session.items = [];
    for (const item of session.items) {
      try {
        const res = await fetch(`/api/run/${item.snap.runId}/resume`, {
          method: "POST",
        });
        if (!res.ok) continue;
        items.push({ ...item, snap: (await res.json()) as RunSnapshot });
      } catch {
        // 单个任务回灌失败时跳过
      }
    }

    setPendingSession(null);
    if (items.length === 0) {
      setNotice("上次任务的历史快照已不存在");
      return;
    }

    if (session.mode === "single") applySnapshotToView(items[0].snap);
    else applySnapshotsToBatch(session.mode, items);
  }

  function dismissPendingSession() {
    setPendingSession(null);
    try {
      window.localStorage.removeItem(SESSION_KEY);
    } catch {
      // 存储不可用时只清内存态
    }
  }

  // 首屏接回上次运行：运行中的直接接回去，已结束的只给一条提示，不抢屏
  useEffect(() => {
    let cancelled = false;

    async function restoreSession() {
      let saved: {
        savedAt?: number;
        mode?: Mode;
        entries?: {
          runId: string;
          topic: string;
          label: string;
          variant?: VariantKey;
        }[];
      } | null = null;
      try {
        const raw = window.localStorage.getItem(SESSION_KEY);
        if (!raw) return;
        saved = JSON.parse(raw);
      } catch {
        return;
      }

      const entries = saved?.entries?.filter((entry) => entry?.runId) ?? [];
      if (entries.length === 0) return;
      if (Date.now() - (saved?.savedAt ?? 0) > SESSION_TTL) {
        try {
          window.localStorage.removeItem(SESSION_KEY);
        } catch {
          // 存储不可用时不处理
        }
        return;
      }

      const items: {
        topic: string;
        label: string;
        variant?: VariantKey;
        snap: RunSnapshot;
      }[] = [];
      for (const entry of entries) {
        try {
          const res = await fetch(`/api/run/${entry.runId}`, {
            cache: "no-store",
          });
          if (!res.ok) continue;
          items.push({
            topic: entry.topic,
            label: entry.label,
            variant: entry.variant,
            snap: (await res.json()) as RunSnapshot,
          });
        } catch {
          // 单个任务取不到跳过，不影响其余恢复
        }
      }
      if (cancelled || items.length === 0) return;

      const sessionMode: Mode = saved?.mode ?? "single";
      if (items.some((item) => item.snap.status === "running")) {
        // 跑到一半的任务不能等用户点，直接接回并继续看流
        if (sessionMode === "single") applySnapshotToView(items[0].snap);
        else applySnapshotsToBatch(sessionMode, items);
        setNotice("已接回刷新前的运行");
      } else {
        setPendingSession({ mode: sessionMode, items });
      }
    }

    void restoreSession();
    return () => {
      cancelled = true;
    };
    // 只在首屏跑一次；接回函数内部只用到稳定的 setState
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function exitReview() {
    setReviewing(null);
    setRunId(null);
    setNodes(emptyNodes());
    setRunStatus("idle");
    setReport(null);
    setSingleCreatedAt(null);
    setCopied({});
    setExpanded({});
    setNotice("");
    resetOutlineEditor();
  }

  /** 删除一个历史批次：整批删，删的是落盘文件，不影响内存里正在跑的任务 */
  async function handleDeleteHistoryBatch(
    batchId: string,
    title: string,
    runIds: string[],
  ) {
    if (
      !window.confirm(
        `删除「${title}」这一批 ${runIds.length} 个任务？删除后无法恢复，成品库里收藏的卡片不受影响。`,
      )
    ) {
      return;
    }
    try {
      const res = await fetch(
        `/api/history?batchId=${encodeURIComponent(batchId)}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(body?.error ?? `删除失败（${res.status}）`);
      }
      // 正在回看的就是这批：先退出，避免对着已删数据继续编辑
      if (reviewing && runIds.includes(reviewing.runId)) exitReview();
      await loadHistory();
      setNotice("已删除该批历史任务");
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    }
  }

  // 引导：结束并记住，下次不再自动弹出
  function finishTour() {
    setTourStep(0);
    setTourLayout(null);
    try {
      window.localStorage.setItem("cab-guide-seen", "1");
    } catch {
      // 存储不可用时只在本次会话关闭
    }
  }

  function nextTourStep() {
    if (tourStep >= TOUR_STEPS.length) {
      finishTour();
      return;
    }
    setTourStep((step) => step + 1);
  }

  // 点示例选题：单次/多版直接填入，批量模式追加一行，最多 3 条
  function applyExample(example: string) {
    if (isRunning) return;
    if (mode === "multi-topic") {
      const lines = multiTopic
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      if (lines.includes(example) || lines.length >= 3) return;
      setMultiTopic([...lines, example].join("\n"));
      return;
    }
    setTopic(example);
  }

  // —— 风格模板管理 ——
  function openNewStyle(channel: StyleChannel) {
    setStyleError("");
    setStyleDraft({ id: null, channel, name: "", summary: "", prompt: "" });
  }

  function openEditStyle(template: StyleTemplate) {
    setStyleError("");
    setStyleDraft({
      id: template.id,
      channel: template.channel,
      name: template.name,
      summary: template.summary,
      prompt: template.prompt,
    });
  }

  // 内置模板只读，复制一份成自定义模板后再改
  function copyStyle(template: StyleTemplate) {
    setStyleError("");
    setStyleDraft({
      id: null,
      channel: template.channel,
      name: `${template.name} 副本`.slice(0, STYLE_NAME_MAX),
      summary: template.summary,
      prompt: template.prompt,
    });
  }

  async function saveStyle() {
    if (!styleDraft) return;
    setStyleBusy(true);
    setStyleError("");
    try {
      const editing = styleDraft.id !== null;
      const res = await fetch(
        editing ? `/api/styles/${styleDraft.id}` : "/api/styles",
        {
          method: editing ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            channel: styleDraft.channel,
            name: styleDraft.name,
            summary: styleDraft.summary,
            prompt: styleDraft.prompt,
          }),
        },
      );
      const data = (await res.json().catch(() => ({}))) as {
        template?: StyleTemplate;
        error?: string;
      };
      if (!res.ok || !data.template) {
        throw new Error(data.error ?? `保存失败 ${res.status}`);
      }
      setStyleDraft(null);
      await loadStyles();
    } catch (err) {
      setStyleError(err instanceof Error ? err.message : String(err));
    } finally {
      setStyleBusy(false);
    }
  }

  async function removeStyle(template: StyleTemplate) {
    if (!window.confirm(`删除模板「${template.name}」？删除后不可恢复。`)) return;
    setStyleError("");
    try {
      const res = await fetch(`/api/styles/${template.id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `删除失败 ${res.status}`);
      }
      // 被删的正好是当前选中项时，回落到同渠道的内置默认模板
      setStyleSelection((prev) =>
        prev[template.channel] === template.id
          ? { ...prev, [template.channel]: DEFAULT_STYLE_BY_CHANNEL[template.channel] }
          : prev,
      );
      await loadStyles();
    } catch (err) {
      setStyleError(err instanceof Error ? err.message : String(err));
    }
  }

  /** 只把真正选中的模板发给后端，空选项表示沿用 Agent 默认文风 */
  function stylesPayload(): Partial<Record<StyleChannel, string>> {
    const payload: Partial<Record<StyleChannel, string>> = {};
    for (const ch of STYLE_CHANNELS) {
      const selected = styleSelection[ch.key];
      if (selected) payload[ch.key] = selected;
    }
    return payload;
  }

  function switchMode(next: Mode) {
    // 切模式会清空任务列表，批量队列还在跑时同样要拦住
    if (hasLiveRun) return;
    // 回看态下切模式视为离开回看，避免历史内容与新模式的空态混在一起
    if (reviewing) exitReview();
    setMode(next);
    setNotice("");
    setTasks([]);
    setActiveTaskIndex(0);
    resetOutlineEditor();
  }

  const showBatchInput = mode === "multi-topic" || mode === "multi-version";
  const allExpanded = NODE_ORDER.every((id) => expanded[id]);
  const customStyleCount = styleTemplates.filter((t) => !t.builtin).length;

  // 批量模式全局进度：只把 completed 计入已完成，失败/中断单独统计
  const batchTotal = tasks.length;
  const batchCompleted = tasks.filter((t) => t.status === "completed").length;
  /** 排队中的任务数：串行队列里用户看不到进度，需要单独给个数字 */
  const batchQueued = tasks.filter((t) => t.status === "queued").length;
  const batchFailed = tasks.filter((t) => t.status === "failed").length;
  const batchAborted = tasks.filter((t) => t.status === "aborted").length;
  const batchRunning = tasks.find((t) => t.status === "running");
  const batchPercent = batchTotal > 0 ? Math.round((batchCompleted / batchTotal) * 100) : 0;
  const batchUnit = mode === "multi-version" ? "版" : "选题";

  const statusText =
    currentTaskStatus === "idle"
      ? "未开始"
      : currentTaskStatus in RUN_STATUS_TEXT
        ? RUN_STATUS_TEXT[currentTaskStatus as RunStatus]
        : currentTaskStatus;
  const statusDotClass =
    currentTaskStatus === "failed"
      ? "bg-red-500"
      : currentTaskStatus === "completed"
        ? "bg-emerald-500"
        : currentTaskStatus === "aborted"
          ? "bg-amber-500"
          : currentTaskStatus === "running"
            ? "bg-blue-500 animate-pulse"
            : "bg-neutral-300";

  function toggleAll() {
    if (allExpanded) {
      setExpanded({});
      return;
    }
    setExpanded(
      NODE_ORDER.reduce(
        (acc, id) => {
          acc[id] = true;
          return acc;
        },
        {} as Partial<Record<NodeId, boolean>>,
      ),
    );
  }

  // 引导气泡：优先放在目标下方，空间不够则翻到上方
  const tourCopy = tourStep > 0 ? TOUR_STEPS[tourStep - 1] : null;
  const tourTooltipStyle: CSSProperties = tourLayout
    ? {
        top:
          tourLayout.rect.top + tourLayout.rect.height + 16 + 170 < tourLayout.vh
            ? tourLayout.rect.top + tourLayout.rect.height + 16
            : Math.max(16, tourLayout.rect.top - 186),
        left: Math.min(
          Math.max(16, tourLayout.rect.left),
          Math.max(16, tourLayout.vw - 316),
        ),
        width: 300,
      }
    : {
        top: "50%",
        left: "50%",
        transform: "translate(-50%, -50%)",
        width: 300,
      };

  return (
    <>
      {/* 3D 氛围背景：最底层装饰，指针事件穿透，不参与任何交互 */}
      <BackgroundScene active={isRunning} />

      <div className="relative flex min-h-screen">
        {/* 左侧边栏：只承载导航，不参与流水线与 SSE 逻辑 */}
        <aside
          className={`sticky top-0 z-30 flex h-screen shrink-0 flex-col border-r border-hairline bg-surface/85 backdrop-blur transition-[width] duration-200 ${
            sidebarCollapsed ? "w-[68px]" : "w-[264px]"
          }`}
        >
          {/* 顶部：展开态显示项目名，收起态整个徽标就是展开按钮 */}
          <div
            className={`flex items-center gap-2 border-b border-hairline py-3 ${
              sidebarCollapsed ? "justify-center px-2" : "px-3"
            }`}
          >
            <button
              onClick={() => setSidebarCollapsed((prev) => !prev)}
              title={sidebarCollapsed ? "展开侧边栏" : "收起侧边栏"}
              className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-accent text-[13px] font-bold text-white transition hover:bg-accent-strong"
            >
              CA
            </button>
            {!sidebarCollapsed && (
              <>
                <p className="min-w-0 flex-1 text-[11px] font-semibold leading-snug text-ink">
                  面向自媒体场景的多 Agent 协同内容工坊
                </p>
                <span className="shrink-0 text-xs text-ink-3" aria-hidden>
                  «
                </span>
              </>
            )}
          </div>

          {/* 任务列表：本次会话在前，历史按批次分组在后 */}
          <div className="flex-1 overflow-y-auto px-2 py-3">
            {sidebarCollapsed && (
              // 收起态只留计数与运行指示：窄栏里铺一排色点没有信息量
              <div className="flex flex-col items-center gap-2 py-1">
                <span
                  title={`最近任务 ${sidebarTaskCount} 个，展开侧边栏查看`}
                  className="grid h-8 w-8 place-items-center rounded-lg border border-hairline bg-canvas text-[11px] tabular-nums text-ink-2"
                >
                  {sidebarTaskCount}
                </span>
                {hasLiveRun && (
                  <span
                    title="流水线运行中"
                    className="h-2 w-2 animate-pulse rounded-full bg-blue-500"
                  />
                )}
              </div>
            )}
            {!sidebarCollapsed && (
              <p className="px-2 pb-2 text-[10px] font-medium tracking-wide text-ink-3">
                最近任务
                {sidebarTaskCount > 0 ? ` (${sidebarTaskCount})` : ""}
              </p>
            )}
            {!sidebarCollapsed && (
            <ul className="flex flex-col gap-1">
              {sidebarCurrent.length > 0 && (
                <li>
                  {!sidebarCollapsed && (
                    <p className="px-2 pb-1 text-[10px] font-medium text-ink-3">
                      当前视图
                    </p>
                  )}
                  <ul className="flex flex-col gap-1">
                    {sidebarCurrent.map(renderSidebarTask)}
                  </ul>
                </li>
              )}
              {sidebarHistoryGroups.map((group) => (
                <li key={group.key} className="mt-1">
                  {!sidebarCollapsed && (
                    <p className="flex items-baseline gap-1.5 px-2 pb-1 text-[10px] text-ink-3">
                      <span
                        className="min-w-0 flex-1 truncate"
                        title={group.title}
                      >
                        {group.title}
                      </span>
                      <span className="shrink-0 tabular-nums">
                        {formatTime(group.createdAt)}
                      </span>
                      <button
                        onClick={() =>
                          void handleDeleteHistoryBatch(
                            group.key,
                            group.title,
                            group.items.map((item) => item.key),
                          )
                        }
                        title="删除这一批历史任务"
                        className="shrink-0 rounded px-1 text-[10px] text-ink-3 transition hover:text-red-600"
                      >
                        删除
                      </button>
                    </p>
                  )}
                  <ul className="flex flex-col gap-1">
                    {group.items.map(renderSidebarTask)}
                  </ul>
                </li>
              ))}
              {sidebarTaskCount === 0 && (
                <li className="px-2 py-3 text-[11px] leading-relaxed text-ink-3">
                  还没有任务，输入选题开始生成后会出现在这里
                </li>
              )}
            </ul>
            )}
            {!sidebarCollapsed && sidebarHistoryGroups.length > 0 && (
              <p className="px-2 pt-2 text-[10px] leading-relaxed text-ink-3">
                本地保留最近 {HISTORY_BATCH_LIMIT} 批，重要产出请收藏到成品库
              </p>
            )}
          </div>

          {/* 功能菜单 */}
          <div className="border-t border-hairline px-2 py-2">
            <button
              onClick={handleNewTask}
              disabled={hasLiveRun}
              title={
                hasLiveRun
                  ? "流水线运行中，结束后才能新建任务"
                  : "清空当前结果，开始新一轮"
              }
              className={`flex w-full items-center gap-2 rounded-lg border border-transparent px-2 py-2 text-xs text-ink-2 transition hover:bg-canvas hover:text-ink disabled:cursor-not-allowed disabled:opacity-40 ${
                sidebarCollapsed ? "justify-center" : ""
              }`}
            >
              <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md border border-hairline text-[13px] leading-none">
                ＋
              </span>
              {!sidebarCollapsed && <span>新建流水线任务</span>}
            </button>
            <button
              onClick={() => {
                setStylePanelOpen(true);
                void loadStyles();
              }}
              title="打开风格模板库"
              className={`mt-1 flex w-full items-center gap-2 rounded-lg border border-transparent px-2 py-2 text-xs text-ink-2 transition hover:bg-canvas hover:text-ink ${
                sidebarCollapsed ? "justify-center" : ""
              }`}
            >
              <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md border border-hairline text-[11px] leading-none">
                风
              </span>
              {!sidebarCollapsed && (
                <span>
                  风格模板库
                  {customStyleCount > 0 ? ` (${customStyleCount})` : ""}
                </span>
              )}
            </button>
            <button
              onClick={() => setSettingsOpen(true)}
              title="设置"
              className={`mt-1 flex w-full items-center gap-2 rounded-lg border border-transparent px-2 py-2 text-xs text-ink-2 transition hover:bg-canvas hover:text-ink ${
                sidebarCollapsed ? "justify-center" : ""
              }`}
            >
              <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md border border-hairline text-[11px] leading-none">
                设
              </span>
              {!sidebarCollapsed && <span>设置</span>}
            </button>
          </div>

          {/* 底部：API 连接状态 */}
          <div
            className={`border-t border-hairline py-2.5 ${
              sidebarCollapsed ? "px-2" : "px-3"
            }`}
          >
            <div
              className={`flex items-center gap-2 text-[10px] text-ink-3 ${
                sidebarCollapsed ? "justify-center" : ""
              }`}
            >
              <span
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                  apiOnline === false
                    ? "bg-red-500"
                    : apiOnline
                      ? "bg-emerald-500"
                      : "bg-neutral-300"
                }`}
              />
              {!sidebarCollapsed && (
                <span
                  className="truncate"
                  title="探测的是本地 Next 服务与读写是否正常，不代表模型接口状态"
                >
                  {apiOnline === null
                    ? "服务检测中…"
                    : apiOnline
                      ? "本地服务正常"
                      : "本地服务未响应"}
                </span>
              )}
            </div>
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
      <header className="sticky top-0 z-20 border-b border-hairline bg-surface/85 backdrop-blur">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-3 px-6 py-3">
          <div className="flex items-center gap-3">
            <span className="grid h-9 w-9 place-items-center rounded-lg bg-accent text-[13px] font-bold text-white">
              CA
            </span>
            <div className="flex flex-col">
              <h1 className="text-base font-semibold leading-tight text-ink">
                Content Agent Board
              </h1>
              <p className="text-xs text-ink-3">
                选题 → 策划拆解 → 长文 / 脚本 / 小红书 / 配图 四路并行
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1.5 rounded-full border border-hairline bg-canvas px-2.5 py-1 text-xs text-ink-2">
              <span className={`h-1.5 w-1.5 rounded-full ${statusDotClass}`} />
              {statusText}
            </span>
            <button
              onClick={() => setTourStep(1)}
              className={`${BTN_QUIET} px-3 py-1.5`}
            >
              使用引导
            </button>
            <button
              onClick={() => {
                setStylePanelOpen((prev) => !prev);
                if (!stylePanelOpen) void loadStyles();
              }}
              className={`${BTN_QUIET} px-3 py-1.5`}
            >
              风格模板
              {customStyleCount > 0 ? ` (${customStyleCount})` : ""}
            </button>
            <button
              onClick={() => {
                setLibraryOpen((prev) => !prev);
                if (!libraryOpen) void loadLibrary();
              }}
              className={`${BTN_QUIET} px-3 py-1.5`}
            >
              成品库
              {libraryItems.length + projectItems.length > 0
                ? ` (${libraryItems.length + projectItems.length})`
                : ""}
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-5 px-6 py-6">
      {/* 首屏说明区：产品定位 + 流水线示意图 */}
      <section className="reveal relative overflow-hidden rounded-2xl border border-hairline bg-surface shadow-card">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(36rem_20rem_at_100%_0%,#eef0ff_0%,transparent_70%)]" />
        <div className="relative flex flex-col gap-6 p-6 md:flex-row md:items-center md:p-7">
          <div className="flex-1">
            <span className="inline-flex items-center rounded-full border border-indigo-100 bg-indigo-50/70 px-2.5 py-1 text-[11px] font-medium text-indigo-600">
              多 Agent 协同 · 内容生产流水线
            </span>
            <h2 className="mt-3 text-xl font-semibold tracking-tight text-ink md:text-2xl">
              一个选题，五个 Agent，四路产出
            </h2>
            <p className="mt-2 max-w-xl text-sm leading-relaxed text-ink-2">
              策划 Agent 先把选题拆成结构化提纲，长文、脚本、小红书、配图并行开工；
              每个节点的耗时、token 与重试都会记进执行报告，历史批次随时可回看。
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              {["5 个 Agent 节点", "4 路并行生成", "全过程可回看"].map(
                (item) => (
                  <span
                    key={item}
                    className="rounded-md border border-hairline bg-canvas px-2 py-1 text-[11px] text-ink-2"
                  >
                    {item}
                  </span>
                ),
              )}
            </div>
          </div>

          <div className="hidden w-[300px] shrink-0 md:block">
            <div className="overflow-hidden rounded-xl border border-hairline bg-gradient-to-br from-indigo-50 via-white to-violet-50">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={HERO_IMAGE}
                alt="多 Agent 内容流水线示意图"
                className="h-[168px] w-full object-cover"
                onError={(e) => {
                  e.currentTarget.style.display = "none";
                }}
              />
            </div>
          </div>
        </div>
      </section>

      {/* 成品库：卡片成品库与整批项目库共用一个面板，用标签切换 */}
      {libraryOpen && (
        <section className={`${CARD} flex flex-col gap-3 p-4`}>
          <div className="flex items-start justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold text-ink">
                成品库
                <span className="ml-2 text-[11px] font-normal tabular-nums text-ink-3">
                  共 {libraryItems.length + projectItems.length} 项
                </span>
              </h2>
              <p className="text-xs text-ink-3">
                卡片：单路产出；项目：一整条流水线的四路产出。都不随历史批次淘汰。
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-3">
              <button
                onClick={() => {
                  void loadLibrary();
                  void loadProjects();
                }}
                className="text-xs text-ink-3 transition hover:text-ink"
              >
                刷新
              </button>
              <button
                onClick={() => setLibraryOpen(false)}
                className="rounded-md border border-hairline-strong px-2 py-0.5 text-xs text-ink-2 transition hover:border-ink-3 hover:text-ink"
              >
                收起
              </button>
            </div>
          </div>

          {/* 标签切换：卡片 / 项目 */}
          <div className="flex items-center gap-1">
            <button
              onClick={() => setLibraryTab("card")}
              className={`rounded-md px-3 py-1 text-xs transition ${
                libraryTab === "card"
                  ? "bg-accent text-white"
                  : "text-ink-2 hover:text-ink"
              }`}
            >
              卡片 ({libraryItems.length}/{LIBRARY_MAX_ITEMS})
            </button>
            <button
              onClick={() => setLibraryTab("project")}
              className={`rounded-md px-3 py-1 text-xs transition ${
                libraryTab === "project"
                  ? "bg-accent text-white"
                  : "text-ink-2 hover:text-ink"
              }`}
            >
              项目 ({projectItems.length}/{PROJECT_MAX_ITEMS})
            </button>
          </div>

          {libraryTab === "card" ? (
            libraryItems.length === 0 ? (
              <p className="text-xs text-ink-3">
                还没有收藏的卡片。任务跑完后，点内容卡右上角的「收藏」即可入库。
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {libraryItems.map((item) => (
                  <li
                    key={item.id}
                    className="flex flex-col gap-1.5 rounded-lg border border-hairline px-3 py-2"
                  >
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="rounded bg-canvas px-1.5 py-0.5 text-[11px] text-ink-2">
                        {LIBRARY_NODE_NAMES[item.nodeId]}
                      </span>
                      <span
                        className="max-w-[18rem] truncate font-medium text-ink"
                        title={item.topic}
                      >
                        {item.topic}
                      </span>
                      <span className="tabular-nums text-ink-3">
                        {formatTime(item.savedAt)}
                      </span>
                      {item.styleName && (
                        <span className="text-[11px] text-ink-3">
                          风格 · {item.styleName}
                        </span>
                      )}
                      <span className="ml-auto flex items-center gap-1">
                        <button
                          onClick={() => void handleCopyLibraryItem(item)}
                          className="rounded-md border border-hairline-strong px-2 py-0.5 text-[11px] text-ink-2 transition hover:border-accent hover:text-accent"
                        >
                          复制
                        </button>
                        <button
                          onClick={() => handleDownloadLibraryItem(item)}
                          className="rounded-md border border-hairline-strong px-2 py-0.5 text-[11px] text-ink-2 transition hover:border-accent hover:text-accent"
                        >
                          下载
                        </button>
                        <button
                          onClick={() => void handleRemoveLibraryItem(item)}
                          className="rounded-md border border-hairline-strong px-2 py-0.5 text-[11px] text-ink-3 transition hover:border-red-300 hover:text-red-600"
                        >
                          移除
                        </button>
                      </span>
                    </div>
                    <p className="line-clamp-2 text-[11px] leading-relaxed text-ink-3">
                      {item.nodeId === "image"
                        ? `提示词：${item.content}`
                        : item.content}
                    </p>
                  </li>
                ))}
              </ul>
            )
          ) : projectItems.length === 0 ? (
            <p className="text-xs text-ink-3">
              还没有收藏的项目。四路全部完成后，点「执行监视」右侧的「收藏整个项目」。
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {projectItems.map((item) => (
                <li
                  key={item.id}
                  className="flex flex-col gap-2 rounded-lg border border-hairline px-3 py-2"
                >
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="rounded bg-canvas px-1.5 py-0.5 text-[11px] text-ink-2">
                      项目
                    </span>
                    <span
                      className="max-w-[18rem] truncate font-medium text-ink"
                      title={item.topic}
                    >
                      {item.topic}
                    </span>
                    <span className="tabular-nums text-ink-3">
                      {formatTime(item.savedAt)}
                    </span>
                    <span className="ml-auto flex items-center gap-1">
                      <button
                        onClick={() => handleDownloadProject(item)}
                        className="rounded-md border border-hairline-strong px-2 py-0.5 text-[11px] text-ink-2 transition hover:border-accent hover:text-accent"
                      >
                        下载全套
                      </button>
                      <button
                        onClick={() => void handleRemoveProject(item)}
                        className="rounded-md border border-hairline-strong px-2 py-0.5 text-[11px] text-ink-3 transition hover:border-red-300 hover:text-red-600"
                      >
                        移除
                      </button>
                    </span>
                  </div>
                  {/* 四路产出的两行预览，便于快速确认收藏的是哪一版 */}
                  <div className="grid gap-1 sm:grid-cols-2">
                    {PROJECT_CHANNEL_IDS.map((id) => {
                      const ch = item.channels[id];
                      return (
                        <div
                          key={id}
                          className="flex flex-col gap-0.5 rounded-md bg-canvas/60 px-2 py-1.5"
                        >
                          <span className="text-[11px] font-medium text-ink-2">
                            {PROJECT_CHANNEL_NAMES[id]}
                            {ch.styleName ? ` · ${ch.styleName}` : ""}
                          </span>
                          <p className="line-clamp-1 text-[11px] text-ink-3">
                            {id === "image"
                              ? ch.content
                                ? `提示词：${ch.content}`
                                : "（仅配图）"
                              : ch.content || "（无正文）"}
                          </p>
                        </div>
                      );
                    })}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {/* 风格模板库：三个渠道分区管理，内置只读、自定义可增删改 */}
      {stylePanelOpen && (
        <section className={`${CARD} flex flex-col gap-3 p-4`}>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold text-ink">风格模板库</h2>
              <p className="text-xs text-ink-3">
                每个渠道一套文风描述，运行时与控制台下拉配合使用；提纲维度与文风互相独立，可自由组合
              </p>
            </div>
            <button
              onClick={() => void loadStyles()}
              className="text-xs text-ink-3 transition hover:text-ink"
            >
              刷新
            </button>
          </div>

          {/* 编辑区：新建与编辑共用一张表单 */}
          {styleDraft && (
            <div className="panel-in rounded-lg border border-accent/30 bg-accent/5 p-3">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-semibold text-ink">
                  {styleDraft.id ? "编辑自定义模板" : "新建自定义模板"}
                </h3>
                <button
                  onClick={() => {
                    setStyleDraft(null);
                    setStyleError("");
                  }}
                  className="text-xs text-ink-3 transition hover:text-ink"
                >
                  取消
                </button>
              </div>
              <div className="mt-2 grid gap-2 md:grid-cols-2">
                <label className="flex flex-col gap-1">
                  <span className="text-[11px] text-ink-3">渠道</span>
                  <select
                    value={styleDraft.channel}
                    onChange={(event) =>
                      setStyleDraft({
                        ...styleDraft,
                        channel: event.target.value as StyleChannel,
                      })
                    }
                    disabled={styleDraft.id !== null}
                    className="rounded-md border border-hairline-strong bg-surface px-2.5 py-1.5 text-xs text-ink outline-none transition focus:border-accent disabled:bg-canvas disabled:text-ink-3"
                  >
                    {STYLE_CHANNELS.map((ch) => (
                      <option key={ch.key} value={ch.key}>
                        {ch.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[11px] text-ink-3">
                    模板名称（最多 {STYLE_NAME_MAX} 字）
                  </span>
                  <input
                    value={styleDraft.name}
                    maxLength={STYLE_NAME_MAX}
                    onChange={(event) =>
                      setStyleDraft({ ...styleDraft, name: event.target.value })
                    }
                    placeholder="例如：小红书深夜情绪风"
                    className="rounded-md border border-hairline-strong bg-surface px-2.5 py-1.5 text-xs text-ink outline-none transition placeholder:text-ink-3 focus:border-accent"
                  />
                </label>
                <label className="flex flex-col gap-1 md:col-span-2">
                  <span className="text-[11px] text-ink-3">
                    一句话说明（最多 {STYLE_SUMMARY_MAX} 字）
                  </span>
                  <input
                    value={styleDraft.summary}
                    maxLength={STYLE_SUMMARY_MAX}
                    onChange={(event) =>
                      setStyleDraft({ ...styleDraft, summary: event.target.value })
                    }
                    placeholder="例如：第一人称情绪流，适合深夜话题"
                    className="rounded-md border border-hairline-strong bg-surface px-2.5 py-1.5 text-xs text-ink outline-none transition placeholder:text-ink-3 focus:border-accent"
                  />
                </label>
                <label className="flex flex-col gap-1 md:col-span-2">
                  <span className="text-[11px] text-ink-3">
                    文风 / 格式 / 排版 / 标签描述（最多 {STYLE_PROMPT_MAX} 字，会原样注入 Agent）
                  </span>
                  <textarea
                    value={styleDraft.prompt}
                    maxLength={STYLE_PROMPT_MAX}
                    rows={6}
                    onChange={(event) =>
                      setStyleDraft({ ...styleDraft, prompt: event.target.value })
                    }
                    placeholder={"文风：……\n格式：……\n排版：……\n标签：……"}
                    className="rounded-md border border-hairline-strong bg-surface px-2.5 py-2 text-xs leading-relaxed text-ink outline-none transition placeholder:text-ink-3 focus:border-accent"
                  />
                </label>
              </div>
              {styleError && (
                <p className="mt-2 text-xs text-red-600">{styleError}</p>
              )}
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                  onClick={() => void saveStyle()}
                  disabled={
                    styleBusy ||
                    !styleDraft.name.trim() ||
                    !styleDraft.prompt.trim()
                  }
                  className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white transition hover:bg-accent-strong disabled:opacity-40"
                >
                  {styleBusy ? "保存中…" : "保存模板"}
                </button>
                <span className="text-[11px] text-ink-3">
                  保存后会出现在控制台的渠道下拉里
                </span>
              </div>
            </div>
          )}

          <div className="grid gap-3 md:grid-cols-3">
            {STYLE_CHANNELS.map((ch) => {
              const list = styleTemplates.filter((t) => t.channel === ch.key);
              return (
                <div
                  key={ch.key}
                  className="flex flex-col gap-2 rounded-lg border border-hairline bg-canvas/40 p-3"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <h3 className="text-xs font-semibold text-ink">{ch.label}</h3>
                      <p className="text-[11px] text-ink-3">{ch.hint}</p>
                    </div>
                    <button
                      onClick={() => openNewStyle(ch.key)}
                      className="shrink-0 rounded-md border border-hairline-strong bg-surface px-2 py-1 text-[11px] text-ink-2 transition hover:border-accent hover:text-accent"
                    >
                      新建
                    </button>
                  </div>
                  <ul className="flex flex-col gap-2">
                    {list.map((template) => (
                      <li
                        key={template.id}
                        className="rounded-md border border-hairline bg-surface p-2.5"
                      >
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="truncate text-xs font-medium text-ink">
                            {template.name}
                          </span>
                          {template.builtin && (
                            <span className="shrink-0 rounded border border-hairline bg-canvas px-1 py-0.5 text-[10px] text-ink-3">
                              内置
                            </span>
                          )}
                          {styleSelection[ch.key] === template.id && (
                            <span className="shrink-0 rounded bg-accent/10 px-1 py-0.5 text-[10px] text-accent">
                              使用中
                            </span>
                          )}
                        </div>
                        <p className="mt-1 truncate text-[11px] text-ink-3">
                          {template.summary}
                        </p>
                        <p className="mt-1 line-clamp-2 whitespace-pre-line text-[11px] leading-relaxed text-ink-2">
                          {template.prompt}
                        </p>
                        <div className="mt-2 flex items-center gap-3 text-[11px]">
                          <button
                            onClick={() => copyStyle(template)}
                            className="text-ink-2 transition hover:text-accent"
                          >
                            复制
                          </button>
                          {!template.builtin && (
                            <>
                              <button
                                onClick={() => openEditStyle(template)}
                                className="text-ink-2 transition hover:text-accent"
                              >
                                编辑
                              </button>
                              <button
                                onClick={() => void removeStyle(template)}
                                className="text-ink-3 transition hover:text-red-600"
                              >
                                删除
                              </button>
                            </>
                          )}
                        </div>
                      </li>
                    ))}
                    {list.length === 0 && (
                      <li className="text-[11px] text-ink-3">该渠道暂无模板</li>
                    )}
                  </ul>
                </div>
              );
            })}
          </div>
          {styleError && !styleDraft && (
            <p className="text-xs text-red-600">{styleError}</p>
          )}
        </section>
      )}

      {/* 回看态提示：只读展示，不建立 SSE */}
      {reviewing && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-blue-200 bg-blue-50/70 px-4 py-2.5 text-sm">
          <span className="font-medium text-blue-800">历史回看</span>
          <span className="text-blue-700">
            {reviewing.variantName ? `${reviewing.variantName} · ` : ""}
            {reviewing.finishedAt ? formatTime(reviewing.finishedAt) : ""}
          </span>
          {reviewing.styleNames.length > 0 && (
            <span className="text-xs text-blue-600">
              文风：{reviewing.styleNames.join(" / ")}
            </span>
          )}
          <span className="text-xs text-blue-600">
            只读快照，没有实时流；继续编辑会基于这条任务改提纲并局部重生成
          </span>
          <button
            onClick={() => void resumeHistoryRun({ runId: reviewing.runId })}
            className="ml-auto rounded-md bg-blue-600 px-2.5 py-1 text-xs font-medium text-white transition hover:bg-blue-700"
          >
            继续编辑并迭代
          </button>
          <button
            onClick={exitReview}
            className="rounded-md border border-blue-300 bg-white px-2.5 py-1 text-xs text-blue-700"
          >
            退出回看
          </button>
        </div>
      )}

      {/* 上次任务提示：已结束的运行只提示不抢屏，点一下才载入 */}
      {pendingSession && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-hairline-strong bg-surface px-3 py-2 text-xs">
          <span className="font-medium text-ink">上次任务</span>
          <span className="max-w-[20rem] truncate text-ink-2">
            {pendingSession.items.map((item) => item.topic).join(" / ")}
          </span>
          <span className="tabular-nums text-ink-3">
            {formatTime(
              pendingSession.items[0].snap.finishedAt ??
                pendingSession.items[0].snap.createdAt,
            )}
          </span>
          <button
            onClick={() => void resumePendingSession()}
            className="rounded-md border border-hairline-strong px-2 py-1 text-ink-2 transition hover:border-accent hover:text-accent"
          >
            继续查看
          </button>
          <button
            onClick={dismissPendingSession}
            className="rounded-md px-2 py-1 text-ink-3 transition hover:text-ink"
          >
            忽略
          </button>
        </div>
      )}

      {/* 运行控制台：模式切换 + 输入 + 动作收进一张卡，按钮按权重分主次 */}
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-[11px] tabular-nums text-ink-3">01</span>
        <h2 className="text-sm font-semibold text-ink">运行控制台</h2>
        <span className="text-xs text-ink-3">选择模式、输入选题、启动流水线</span>
      </div>

      <section
        className={`${CARD} reveal overflow-hidden`}
        style={{ animationDelay: "80ms" }}
      >
        <div
          ref={modeTabsRef}
          className="flex gap-1 border-b border-hairline bg-canvas/70 p-2"
        >
          {MODE_TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => switchMode(tab.id)}
              disabled={hasLiveRun}
              className={`flex-1 rounded-md px-4 py-2 text-sm font-medium transition disabled:opacity-40 ${
                mode === tab.id
                  ? "bg-surface text-ink shadow-card"
                  : "text-ink-2 hover:text-ink"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="flex flex-col gap-3 p-4">
          {mode === "single" && (
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                ref={topicInputRef}
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !isRunning) handleStartSingle();
                }}
                placeholder="输入一个选题，例如：AI 编程会不会取代程序员"
                className="flex-1 rounded-lg border border-hairline-strong bg-surface px-3.5 py-2.5 text-sm text-ink outline-none transition placeholder:text-ink-3 focus:border-accent focus:ring-4 focus:ring-accent/10"
              />
              <div className="flex flex-wrap gap-2">
                <button
                  ref={startButtonRef}
                  onClick={handleStartSingle}
                  disabled={isRunning || !topic.trim()}
                  className={BTN_PRIMARY}
                >
                  {isRunning ? "运行中…" : "开始生成"}
                </button>
                <button
                  onClick={handleStopAll}
                  disabled={!isRunning}
                  className={BTN_GHOST}
                >
                  全部中断
                </button>
                <button
                  onClick={() => void handleCopyAll()}
                  disabled={!isCompleted}
                  title="把长文、脚本、小红书三路产出一起复制到剪贴板"
                  className={BTN_GHOST}
                >
                  复制全部
                </button>
                <button
                  onClick={handleExportAll}
                  disabled={!isCompleted}
                  className={BTN_GHOST}
                >
                  导出全部
                </button>
              </div>
            </div>
          )}

          {showBatchInput && (
            <div className="flex flex-col gap-3">
              {mode === "multi-topic" ? (
                <textarea
                  value={multiTopic}
                  onChange={(e) => setMultiTopic(e.target.value)}
                  placeholder={"每行一个选题，最多 3 个，例如：\nAI 编程会不会取代程序员\n远程办公的利与弊\n如何培养专注力"}
                  rows={4}
                  className="w-full rounded-lg border border-hairline-strong bg-surface px-3.5 py-3 text-sm text-ink outline-none transition placeholder:text-ink-3 focus:border-accent focus:ring-4 focus:ring-accent/10"
                />
              ) : (
                <div className="flex flex-col gap-3">
                  <input
                    value={topic}
                    onChange={(e) => setTopic(e.target.value)}
                    placeholder="输入一个选题，将按三个维度各生成一版"
                    className="w-full rounded-lg border border-hairline-strong bg-surface px-3.5 py-2.5 text-sm text-ink outline-none transition placeholder:text-ink-3 focus:border-accent focus:ring-4 focus:ring-accent/10"
                  />
                  <div className="flex flex-wrap gap-2">
                    {VARIANTS.map((v) => (
                      <div
                        key={v.key}
                        className="flex flex-col gap-0.5 rounded-lg border border-hairline bg-canvas/60 px-3 py-2"
                      >
                        <span className="text-xs font-medium text-ink">{v.name}</span>
                        <span className="text-[11px] text-ink-3">{v.angle}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={handleStartBatch}
                  disabled={
                    isRunning ||
                    (mode === "multi-topic"
                      ? !multiTopic.trim()
                      : !topic.trim())
                  }
                  className={BTN_PRIMARY}
                >
                  {isRunning ? "运行中…" : "开始批量生成"}
                </button>
                <button
                  onClick={handleStopAll}
                  disabled={!isRunning}
                  className={BTN_GHOST}
                >
                  全部中断
                </button>
                <button
                  onClick={() => void handleCopyAll()}
                  disabled={!isCompleted}
                  title="把长文、脚本、小红书三路产出一起复制到剪贴板"
                  className={BTN_GHOST}
                >
                  复制全部
                </button>
                <button
                  onClick={handleExportAll}
                  disabled={!isCompleted}
                  className={BTN_GHOST}
                >
                  导出当前套
                </button>
              </div>
            </div>
          )}

          {/* 风格模板：每个下游内容 Agent 独立选文风，启动时快照进 run */}
          <div className="rounded-lg border border-hairline bg-canvas/50 p-3">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="text-[11px] font-medium text-ink-2">风格模板</span>
              <span className="text-[11px] text-ink-3">
                三个内容 Agent 各自选文风，与提纲维度自由组合
              </span>
            </div>
            <div className="mt-2 grid gap-2 sm:grid-cols-3">
              {STYLE_CHANNELS.map((ch) => (
                <label key={ch.key} className="flex flex-col gap-1">
                  <span className="text-[11px] text-ink-3">{ch.label}</span>
                  <select
                    value={styleSelection[ch.key] ?? ""}
                    onChange={(event) =>
                      setStyleSelection((prev) => ({
                        ...prev,
                        [ch.key]: event.target.value,
                      }))
                    }
                    disabled={isRunning}
                    className="w-full rounded-md border border-hairline-strong bg-surface px-2 py-1.5 text-xs text-ink outline-none transition focus:border-accent disabled:bg-canvas disabled:text-ink-3"
                  >
                    <option value="">不使用模板</option>
                    {styleTemplates
                      .filter((t) => t.channel === ch.key)
                      .map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                          {t.builtin ? "（内置）" : ""}
                        </option>
                      ))}
                  </select>
                </label>
              ))}
            </div>
          </div>

          {/* 示例选题：不知道写什么时一键填入 */}
          <div className="flex flex-wrap items-center gap-2 border-t border-dashed border-hairline pt-3">
            <span className="text-[11px] text-ink-3">试试这些选题</span>
            {EXAMPLE_TOPICS.map((example) => {
              const used =
                mode === "multi-topic" ? multiTopic.includes(example) : topic === example;
              return (
                <button
                  key={example}
                  onClick={() => applyExample(example)}
                  disabled={isRunning}
                  className={`rounded-full border px-2.5 py-1 text-xs transition disabled:opacity-40 ${
                    used
                      ? "border-accent bg-accent text-white"
                      : "border-hairline-strong bg-surface text-ink-2 hover:border-accent hover:text-accent"
                  }`}
                >
                  {example}
                </button>
              );
            })}
          </div>
        </div>

        {/* 运行状态条：常驻在控制台底部 */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-hairline bg-canvas/50 px-4 py-2 text-xs">
          <span className="text-ink-3">流水线状态</span>
          <span className="flex items-center gap-1.5 font-medium text-ink">
            <span className={`h-1.5 w-1.5 rounded-full ${statusDotClass}`} />
            {statusText}
          </span>
          {currentRunId && (
            <span className="font-mono text-[11px] text-ink-3">
              runId {currentRunId.slice(0, 8)}
            </span>
          )}
          {notice && <span className="text-red-600">{notice}</span>}
          {reconnectNotice && (
            <span className="text-amber-600">{reconnectNotice}</span>
          )}
        </div>
      </section>

      {/* 批量模式全局进度 */}
      {mode !== "single" && batchTotal > 0 && (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <span className="font-medium text-ink">
              批量 {batchTotal} {batchUnit}：已完成 {batchCompleted}/{batchTotal}
              {batchRunning
                ? `，当前运行 ${batchRunning.label}`
                : batchCompleted === batchTotal
                  ? "，全部完成"
                  : ""}
              {batchQueued > 0 ? `，排队 ${batchQueued}` : ""}
            </span>
            {batchFailed > 0 && (
              <span className="text-red-600">失败 {batchFailed}</span>
            )}
            {batchAborted > 0 && (
              <span className="text-amber-600">已中断 {batchAborted}</span>
            )}
            {batchTotal >= 2 &&
              batchCompleted === batchTotal &&
              !compareView && (
                <button
                  onClick={() => setCompareView(true)}
                  className="rounded-md border border-accent px-2 py-0.5 text-accent transition hover:bg-accent hover:text-white"
                >
                  查看本批对比
                </button>
              )}
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-200">
            <div
              className="h-full rounded-full bg-accent transition-all"
              style={{ width: `${batchPercent}%` }}
            />
          </div>
        </div>
      )}

      {/* 批量模式 tabs：任务未创建时也保留这一行，保证「横向对比」入口始终可见 */}
      {mode !== "single" && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap gap-2">
            {tasks.length === 0 && (
              <span className="text-xs text-ink-3">
                输入多行选题并开始生成后，这里会出现任务切换
              </span>
            )}
            {tasks.map((t, idx) => (
              <button
                key={t.id}
                onClick={() => {
                  if (!beginTaskSwitch()) return;
                  setActiveTaskIndex(idx);
                  setCompareView(false);
                }}
                className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs transition ${
                  idx === activeTaskIndex && !compareView
                    ? "border-accent bg-accent text-white"
                    : "border-hairline bg-surface text-ink-2 hover:text-ink"
                }`}
              >
                <span
                  className={`h-2 w-2 rounded-full ${
                    t.status === "completed"
                      ? "bg-green-500"
                      : t.status === "running"
                        ? "bg-blue-500 animate-pulse"
                        : t.status === "failed"
                          ? "bg-red-500"
                          : t.status === "aborted"
                            ? "bg-amber-500"
                            : "bg-neutral-300"
                  }`}
                />
                {t.label}
                {t.status === "queued" && (
                  <span className="text-[10px] opacity-70">排队</span>
                )}
              </button>
            ))}
          </div>
          {/*
            横向对比：始终渲染，任务不足两个时置灰。
            直接隐藏按钮会让用户不知道有这个功能、也不知道为什么没有。
          */}
          <button
            onClick={() => setCompareView((v) => !v)}
            disabled={tasks.length < 2}
            className={`rounded-lg border px-3 py-1.5 text-xs transition ${
              tasks.length < 2
                ? "cursor-not-allowed border-hairline bg-surface text-ink-3 opacity-50"
                : compareView
                  ? "border-accent bg-accent text-white"
                  : "border-hairline bg-surface text-ink-2 hover:text-ink"
            }`}
            title={
              tasks.length < 2
                ? "至少需要 2 个任务才能对比，请在上方输入多行选题后开始生成"
                : "把多个任务的四路产出并排对比"
            }
          >
            横向对比
          </button>
        </div>
      )}

      {/* 执行监视 */}
      <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-[11px] tabular-nums text-ink-3">02</span>
          <h2 className="text-sm font-semibold text-ink">执行监视</h2>
          <span className="text-xs text-ink-3">5 个 Agent 节点</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => void handleSaveProject()}
            disabled={!allFourCompleted || projectBusy}
            title={allFourCompleted ? "把本批四路产出一起收藏" : "四路全部完成后才可收藏"}
            className={BTN_QUIET}
          >
            {projectBusy ? "收藏中…" : "收藏整个项目"}
          </button>
          <button onClick={toggleAll} className={BTN_QUIET}>
            {allExpanded ? "全部收起" : "全部展开"}
          </button>
        </div>
      </div>

      {compareView && mode !== "single" ? (
        <div className="overflow-x-auto rounded-lg border border-hairline">
          <table className="min-w-full border-collapse text-left">
            <thead>
              <tr className="border-b border-hairline bg-canvas">
                <th className="sticky left-0 z-10 w-28 shrink-0 bg-canvas px-3 py-2 text-xs font-semibold text-ink">
                  渠道
                </th>
                {tasks.map((t, idx) => (
                  <th
                    key={t.id}
                    className="min-w-[14rem] px-3 py-2 align-top"
                  >
                    <button
                      type="button"
                      onClick={() => {
                        if (!beginTaskSwitch()) return;
                        setActiveTaskIndex(idx);
                        setCompareView(false);
                      }}
                      className="flex w-full flex-col gap-0.5 text-left hover:text-accent"
                    >
                      <span
                        className="truncate text-xs font-semibold text-ink"
                        title={t.topic}
                      >
                        {t.topic}
                      </span>
                      <span className="text-[11px] text-ink-3">
                        {t.variant
                          ? `${VARIANTS.find((v) => v.key === t.variant)?.name ?? t.variant} · `
                          : ""}
                        {t.label}
                      </span>
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(["longform", "script", "xhs", "image"] as const).map(
                (channel) => (
                  <tr
                    key={channel}
                    className="border-b border-hairline last:border-0"
                  >
                    <td className="sticky left-0 z-10 w-28 shrink-0 bg-canvas px-3 py-2 align-top">
                      <span className="text-xs font-medium text-ink-2">
                        {NODE_META[channel].name}
                      </span>
                    </td>
                    {tasks.map((t, idx) => {
                      const node = t.nodes[channel];
                      const hasContent =
                        node.status === "completed" &&
                        (channel === "image"
                          ? !!node.imageUrl
                          : !!node.content?.trim());
                      const content = node.content ?? "";
                      return (
                        <td
                          key={t.id}
                          className="px-3 py-2 align-top"
                        >
                          {hasContent ? (
                            <div
                              role="button"
                              tabIndex={0}
                              onClick={() => {
                                if (!beginTaskSwitch()) return;
                                setActiveTaskIndex(idx);
                                setCompareView(false);
                              }}
                              onKeyDown={(e) => {
                                if (e.key === "Enter" || e.key === " ") {
                                  e.preventDefault();
                                  if (!beginTaskSwitch()) return;
                                  setActiveTaskIndex(idx);
                                  setCompareView(false);
                                }
                              }}
                              className="group relative block w-full cursor-pointer rounded-md p-1.5 text-left transition hover:bg-surface"
                            >
                              {channel === "image" ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img
                                  src={node.imageUrl ?? undefined}
                                  alt="配图"
                                  className="max-h-28 w-full rounded object-contain"
                                />
                              ) : (
                                <>
                                  <p className="line-clamp-2 whitespace-pre-wrap break-words text-xs text-ink-2">
                                    {content}
                                  </p>
                                  {/* hover 预览全文，pointer-events-none 避免挡住点击 */}
                                  <div className="pointer-events-none absolute left-0 right-0 top-full z-20 mt-1 max-h-52 overflow-auto rounded-md border border-hairline bg-surface p-2 text-[11px] leading-relaxed text-ink-2 opacity-0 shadow-lg transition group-hover:opacity-100">
                                    <div className="whitespace-pre-wrap break-words">
                                      {content}
                                    </div>
                                  </div>
                                </>
                              )}
                              <span
                                className="mt-1 flex gap-1"
                                onClick={(e) => e.stopPropagation()}
                              >
                                {channel !== "image" ? (
                                  <>
                                    <button
                                      type="button"
                                      onClick={() => {
                                        void navigator.clipboard
                                          .writeText(content)
                                          .then(() =>
                                            setNotice("已复制到剪贴板"),
                                          )
                                          .catch(() =>
                                            setNotice("复制失败"),
                                          );
                                      }}
                                      className="rounded border border-hairline-strong px-1.5 py-0.5 text-[10px] text-ink-3 transition hover:border-accent hover:text-accent"
                                    >
                                      复制
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => {
                                        const a = document.createElement("a");
                                        a.href = URL.createObjectURL(
                                          new Blob([content], {
                                            type: "text/markdown;charset=utf-8",
                                          }),
                                        );
                                        a.download = `${t.topic}-${NODE_META[channel].name}.md`;
                                        document.body.appendChild(a);
                                        a.click();
                                        document.body.removeChild(a);
                                        URL.revokeObjectURL(a.href);
                                      }}
                                      className="rounded border border-hairline-strong px-1.5 py-0.5 text-[10px] text-ink-3 transition hover:border-accent hover:text-accent"
                                    >
                                      下载
                                    </button>
                                  </>
                                ) : (
                                  <a
                                    href={node.imageUrl ?? undefined}
                                    target="_blank"
                                    rel="noreferrer"
                                    download
                                    className="rounded border border-hairline-strong px-1.5 py-0.5 text-[10px] text-ink-3 transition hover:border-accent hover:text-accent"
                                  >
                                    查看原图
                                  </a>
                                )}
                                <span className="ml-auto text-[10px] text-ink-3">
                                  点击查看完整 →
                                </span>
                              </span>
                            </div>
                          ) : (
                            <span className="text-xs text-ink-3">
                              {node.status === "completed"
                                ? "（无内容）"
                                : "未完成"}
                            </span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      ) : (
      <>
      {/* 卡片区：hover 时其余卡片退到背景，聚焦当前节点 */}
      <div
        className="node-grid reveal grid grid-cols-1 gap-4 md:grid-cols-2 md:items-start xl:grid-cols-4"
        style={{ animationDelay: "160ms" }}
      >
        {NODE_ORDER.map((nodeId) => {
          const node = currentNodes[nodeId];
          const style = STATUS_STYLE[node.status];
          const isPlanner = nodeId === "planner";
          const isExpanded = !!expanded[nodeId];
          const canStop = node.status === "running" || node.status === "pending";
          const canRerun =
            !isPlanner &&
            !reviewing &&
            currentNodes.planner.status === "completed" &&
            (node.status === "failed" ||
              node.status === "cancelled" ||
              node.status === "completed");
          // 只有真正产出了内容（或配图）的卡片才可收藏，空结果不入库
          const canCollect =
            !isPlanner &&
            node.status === "completed" &&
            (nodeId === "image" ? !!node.imageUrl : !!node.content.trim());

          return (
            <Fragment key={nodeId}>
            <section
              className={`relative flex flex-col gap-3 overflow-hidden rounded-xl border border-hairline bg-surface p-4 shadow-card transition duration-200 hover:-translate-y-0.5 hover:shadow-pop ${
                isPlanner ? "md:col-span-2 xl:col-span-4" : ""
              } ${node.status === "running" ? "ring-1 ring-blue-200/70" : ""}`}
            >
              {/* 状态用左色条表达，卡片底始终中性；运行中轻微脉冲提示活动节点 */}
              <span
                className={`absolute inset-y-0 left-0 w-[3px] ${style.bar} ${
                  node.status === "running" ? "animate-pulse" : ""
                }`}
                aria-hidden
              />
              {/* 卡片较窄时收藏按钮换行而不是挤掉状态标签 */}
              <div className="flex flex-wrap items-start gap-2">
                <button
                  type="button"
                  onClick={() => toggleNode(nodeId)}
                  className="flex min-w-0 flex-1 items-start justify-between gap-2 text-left"
                >
                  <span className="flex items-center gap-2.5">
                    <span
                      className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg text-[13px] font-semibold ring-1 ${NODE_META[nodeId].tint}`}
                    >
                      {NODE_META[nodeId].glyph}
                    </span>
                    <span className="text-sm font-semibold text-ink">
                      {NODE_META[nodeId].name}
                    </span>
                    {isPlanner && (
                      <span className="rounded border border-hairline bg-canvas px-1.5 py-0.5 text-[10px] text-ink-3">
                        结构化提纲
                      </span>
                    )}
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <span className={`rounded-full px-2 py-0.5 text-xs ${style.badge}`}>
                      {style.label}
                      {node.attempt > 1 ? ` · 第${node.attempt}次` : ""}
                    </span>
                    <span className="text-xs text-ink-3">
                      {isExpanded ? "收起" : "展开"}
                    </span>
                  </span>
                </button>
                {/* 收藏入口固定在卡片头部，不随展开状态或滚动位置消失 */}
                {canCollect && (
                  <button
                    type="button"
                    onClick={() => void handleSaveToLibrary(nodeId)}
                    disabled={libraryBusy === nodeId}
                    title="收藏到成品库"
                    className="shrink-0 rounded-md border border-hairline-strong px-2 py-1 text-[11px] text-ink-2 transition hover:border-accent hover:text-accent disabled:opacity-50"
                  >
                    {libraryBusy === nodeId ? "收藏中…" : "收藏"}
                  </button>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <p className="text-xs text-ink-3">{NODE_META[nodeId].desc}</p>
                {node.style && (
                  <span className="max-w-full truncate rounded border border-indigo-100 bg-indigo-50 px-1.5 py-0.5 text-[10px] text-indigo-600">
                    风格 · {node.style.name}
                  </span>
                )}
              </div>

              {/* 执行指标：耗时 / token / 重试，折叠态也展示 */}
              {node.metrics && (
                <div className="flex flex-wrap items-center gap-1.5 text-[11px] tabular-nums">
                  <span className="rounded border border-hairline bg-canvas px-1.5 py-0.5 text-ink-2">
                    {node.metrics.durationMs !== undefined
                      ? formatDuration(node.metrics.durationMs)
                      : "计时中"}
                  </span>
                  {node.metrics.usage && (
                    <span className="rounded border border-hairline bg-canvas px-1.5 py-0.5 text-ink-2">
                      {formatTokens(node.metrics.usage.totalTokens)} tokens
                      {node.metrics.usageEstimated ? "（估算）" : ""}
                    </span>
                  )}
                  {node.metrics.retries > 0 && (
                    <span className="rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-amber-700">
                      重试 {node.metrics.retries} 次
                    </span>
                  )}
                </div>
              )}

              {node.error && (
                <p className="rounded-md border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-700">
                  {node.error}
                </p>
              )}

              {/* 折叠态：只给状态和内容预览 */}
              {!isExpanded && (
                <div className="flex flex-col gap-2">
                  {nodeId === "image" && node.imageUrl && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={node.imageUrl}
                      alt="配图结果"
                      className="w-full rounded-lg border border-hairline object-cover"
                    />
                  )}
                  {node.content ? (
                    <>
                      <p className="truncate text-xs text-ink-2">
                        {node.content.trim().split("\n")[0]}
                      </p>
                      <span className="text-[11px] text-ink-3">
                        已生成 {node.content.length} 字
                      </span>
                    </>
                  ) : (
                    <span className="text-[11px] text-ink-3">（暂无内容）</span>
                  )}
                </div>
              )}

              {isExpanded && (
                <div className="panel-in flex flex-col gap-3">
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => handleStopNode(nodeId)}
                      disabled={!isRunning || !canStop}
                      className={BTN_QUIET}
                    >
                      中断
                    </button>
                    {isPlanner &&
                      !reviewing &&
                      node.status === "completed" &&
                      !outlineEditing && (
                        <button
                          onClick={() => beginOutlineEdit()}
                          className={BTN_QUIET}
                        >
                          编辑提纲
                        </button>
                      )}
                    {isPlanner && outlineEditing && (
                      <button
                        onClick={cancelOutlineEdit}
                        disabled={outlineBusy}
                        className={BTN_QUIET}
                      >
                        取消编辑
                      </button>
                    )}
                    {!isPlanner && (
                      <button
                        onClick={() => handleRerun(nodeId)}
                        disabled={!canRerun}
                        className={BTN_QUIET}
                      >
                        重跑
                      </button>
                    )}
                    {!isPlanner && nodeId !== "image" && node.status === "completed" && (
                      <button
                        onClick={() => handleCopy(nodeId)}
                        disabled={!!copied[nodeId]}
                        className={`rounded-md border px-2.5 py-1 text-xs transition ${
                          copied[nodeId]
                            ? "border-hairline bg-canvas text-ink-3"
                            : "border-hairline-strong bg-surface text-ink-2 hover:text-ink"
                        }`}
                      >
                        {copied[nodeId] ? "已复制" : "复制"}
                      </button>
                    )}
                    {canCollect && (
                      <button
                        onClick={() => void handleSaveToLibrary(nodeId)}
                        disabled={libraryBusy === nodeId}
                        className={BTN_QUIET}
                      >
                        {libraryBusy === nodeId ? "收藏中…" : "收藏到成品库"}
                      </button>
                    )}
                  </div>

                  {nodeId === "image" && node.imageUrl && (
                    <>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={node.imageUrl}
                        alt="配图结果"
                        className="w-full rounded-lg border border-hairline object-cover"
                      />
                      <button onClick={handleDownloadImage} className={BTN_QUIET}>
                        下载图片
                      </button>
                    </>
                  )}

                  {nodeId === "image" &&
                    node.status === "running" &&
                    !node.imageUrl &&
                    node.content && (
                      <p className="rounded-md border border-blue-200 bg-blue-50 px-2 py-1 text-xs text-blue-700">
                        提示词已生成，正在调用 Seedream 出图…
                      </p>
                    )}

                  {isPlanner ? (
                    <div className="flex flex-col gap-2">
                      {outlineVersions.length > 0 && (
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-[11px] text-ink-3">提纲版本</span>
                          {outlineVersions.map((version) => {
                            const isActive =
                              version.id === currentOutline?.activeId;
                            const isSelected =
                              outlineEditing &&
                              version.id === outlineSelectedVersion;
                            return (
                              <button
                                key={version.id}
                                onClick={() => beginOutlineEdit(version)}
                                disabled={!!reviewing || outlineBusy}
                                title={`${version.label}${
                                  version.affected?.length
                                    ? ` · 改动：${version.affected
                                        .map((id) => NODE_META[id].name)
                                        .join("、")}`
                                    : ""
                                } · ${formatTime(version.createdAt)}`}
                                className={`rounded-md border px-2 py-0.5 text-[11px] transition disabled:opacity-50 ${
                                  isSelected
                                    ? "border-accent bg-accent text-white"
                                    : isActive
                                      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                                      : "border-hairline-strong bg-surface text-ink-2 hover:border-accent hover:text-accent"
                                }`}
                              >
                                {version.id} · {version.label}
                                {version.affected && version.affected.length > 0 && (
                                  <span className="ml-1 opacity-70">
                                    {version.affected
                                      .map((id) => CHANNEL_SHORT[id])
                                      .join("/")}
                                  </span>
                                )}
                                {isActive ? " · 当前" : ""}
                              </button>
                            );
                          })}
                        </div>
                      )}

                      {outlineEditing ? (
                        <>
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-[11px] text-ink-3">编辑方式</span>
                            <button
                              onClick={() => setOutlineJsonMode((prev) => !prev)}
                              className="rounded-md border border-hairline-strong px-2 py-0.5 text-[11px] text-ink-2 transition hover:border-accent hover:text-accent"
                            >
                              {outlineJsonMode ? "改用表单编辑" : "改用 JSON 编辑"}
                            </button>
                            {!outlineJsonMode && !outlineShape && (
                              <span className="text-[11px] text-amber-600">
                                当前提纲结构无法识别，请先切到 JSON 编辑修复
                              </span>
                            )}
                          </div>
                          {outlineJsonMode ? (
                            <textarea
                              value={outlineDraft}
                              onChange={(event) =>
                                setOutlineDraft(event.target.value)
                              }
                              onBlur={() => recordOutlineHistory(outlineDraft)}
                              rows={16}
                              spellCheck={false}
                              className="max-h-96 w-full resize-y overflow-auto rounded-lg border border-hairline-strong bg-canvas p-3 font-mono text-[11px] leading-relaxed text-ink outline-none transition focus:border-accent"
                            />
                          ) : outlineShape ? (
                            <div className="flex flex-col gap-3">
                              <label className="flex flex-col gap-1">
                                <span className="text-[11px] font-medium text-ink-2">
                                  选题
                                </span>
                                <input
                                  value={outlineText(outlineShape.topic)}
                                  onChange={(event) =>
                                    updateOutline((doc) => {
                                      doc.topic = event.target.value;
                                    })
                                  }
                                  className={OUTLINE_FIELD_CLASS}
                                />
                              </label>
                              <div className="grid gap-3 md:grid-cols-2">
                                {renderOutlineChannel("longForm", "公众号长文", [
                                  {
                                    key: "structure",
                                    label: "段落要点（每行一条）",
                                    lines: true,
                                  },
                                ])}
                                {renderOutlineChannel("script", "短视频脚本", [
                                  {
                                    key: "shots",
                                    label: "分镜（每行一条）",
                                    lines: true,
                                  },
                                ])}
                                {renderOutlineChannel("xhs", "小红书笔记", [
                                  { key: "headline", label: "标题" },
                                  {
                                    key: "tags",
                                    label: "标签（每行一个）",
                                    lines: true,
                                  },
                                ])}
                                {renderOutlineChannel("image", "配图", [
                                  {
                                    key: "prompts",
                                    label: "配图描述词（每行一条）",
                                    lines: true,
                                  },
                                ])}
                              </div>
                            </div>
                          ) : null}
                          {outlineJsonMode && draftParse && !draftParse.ok && (
                            <p className="text-[11px] text-red-600">
                              JSON 语法错误：{draftParse.error}
                            </p>
                          )}
                          {outlineError && (
                            <p className="text-[11px] text-red-600">
                              {outlineError}
                            </p>
                          )}
                          <div className="flex flex-wrap items-center gap-2">
                            <button
                              onClick={() => void handleOutlineRegenerate()}
                              disabled={
                                outlineBusy ||
                                isRunning ||
                                !draftParse?.ok ||
                                draftAffected.length === 0
                              }
                              className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white transition hover:bg-accent-strong disabled:opacity-40"
                            >
                              {outlineBusy
                                ? "提交中…"
                                : "基于当前提纲重生成下游"}
                            </button>
                            {/* 撤销/重做只回退本地草稿，不触发任何模型调用 */}
                            <button
                              onClick={undoOutline}
                              disabled={!outlineHistoryState.canUndo || outlineBusy}
                              title="回到上一个记录点（停顿 1.2 秒或失焦时自动记录；焦点不在输入框时也可按 Ctrl/Cmd+Z）"
                              className="rounded-md border border-hairline-strong px-2.5 py-1.5 text-xs text-ink-2 transition hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-40"
                            >
                              撤销
                            </button>
                            <button
                              onClick={redoOutline}
                              disabled={!outlineHistoryState.canRedo || outlineBusy}
                              title="恢复被撤销的修改（Ctrl/Cmd+Shift+Z）"
                              className="rounded-md border border-hairline-strong px-2.5 py-1.5 text-xs text-ink-2 transition hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-40"
                            >
                              重做
                            </button>
                            {outlineHistoryState.undoSteps > 0 && (
                              <span className="text-[11px] text-ink-3">
                                可撤销 {outlineHistoryState.undoSteps} 步
                              </span>
                            )}
                            {draftParse?.ok && !outlineChanged && (
                              <span className="text-[11px] text-ink-3">
                                与当前版本一致，修改后才能提交
                              </span>
                            )}
                            {draftParse?.ok &&
                              outlineChanged &&
                              draftAffected.length === 0 && (
                                <span className="text-[11px] text-amber-600">
                                  只改了选题：选题变化不影响四个渠道，请修改至少一个渠道后再提交
                                </span>
                              )}
                            {draftAffected.length > 0 && (
                              <span className="text-[11px] text-accent">
                                将重跑：
                                {draftAffected
                                  .map((id) => NODE_META[id].name)
                                  .join("、")}
                              </span>
                            )}
                          </div>
                          <p className="text-[11px] text-ink-3">
                            仅重跑提纲有变化的渠道，未改动渠道保留原产出；不会重新执行策划 Agent
                          </p>
                        </>
                      ) : (
                        <>
                          {outlineNotice && (
                            <p className="text-[11px] text-emerald-600">
                              {outlineNotice}
                            </p>
                          )}
                          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-hairline bg-canvas p-3 font-mono text-[11px] leading-relaxed text-ink-2">
                            {activeOutlineVersion
                              ? JSON.stringify(
                                  activeOutlineVersion.outline,
                                  null,
                                  2,
                                )
                              : node.content || "（暂无内容）"}
                          </pre>
                        </>
                      )}
                    </div>
                  ) : (
                    <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-hairline bg-canvas p-3 text-xs leading-relaxed text-ink-2">
                      {node.content || "（暂无内容）"}
                    </pre>
                  )}
                </div>
              )}
            </section>

            {/* 分叉轨道：只在 xl 四列布局下出现，把策划节点与四路产出连成一张图 */}
            {isPlanner && (
              <div className="relative hidden h-8 xl:col-span-4 xl:block">
                <span
                  className={`absolute left-1/2 -top-4 h-8 w-px -translate-x-1/2 ${RAIL_LINE[node.status]}`}
                  aria-hidden
                />
                <div className="grid h-full grid-cols-4 gap-4">
                  {NODE_ORDER.slice(1).map((id, index) => {
                    const target = currentNodes[id];
                    return (
                      <div key={id} className="relative">
                        <span
                          className={`absolute top-4 h-px ${
                            index === 0
                              ? "left-1/2 right-0"
                              : index === NODE_ORDER.length - 2
                                ? "left-0 right-1/2"
                                : "left-0 right-0"
                          } ${RAIL_LINE[target.status]}`}
                          aria-hidden
                        />
                        <span
                          className={`absolute left-1/2 top-4 h-8 w-px -translate-x-1/2 ${RAIL_LINE[target.status]}`}
                          aria-hidden
                        />
                        <span
                          className={`absolute left-1/2 top-4 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-surface ${RAIL_DOT[target.status]} ${
                            target.status === "running" ? "animate-pulse" : ""
                          }`}
                          aria-hidden
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            </Fragment>
          );
        })}
      </div>
      </>
      )}

      {/* 空态提示：还没跑过任何任务时告诉用户下一步做什么 */}
      {!isRunning &&
        !reviewing &&
        currentNodes.planner.status === "pending" && (
          <p className="text-center text-xs text-ink-3">
            在上面输入一个选题并点击「开始生成」，五个 Agent 会依次亮起
          </p>
        )}

      {/* 执行报告：单次模式看整条流水线，批量模式看当前选中任务 */}
      {currentReport && (
        <ReportCard
          report={currentReport}
          title={
            mode === "single"
              ? "本次流水线执行报告"
              : `${tasks[activeTaskIndex]?.label ?? ""} 执行报告`
          }
        />
      )}

      {/* 批量任务全部结束后给出横向汇总 */}
      {mode !== "single" &&
        batchTotal > 1 &&
        tasks.every((t) => t.status !== "running" && t.status !== "pending") && (
          <BatchSummary tasks={tasks} />
        )}
      </main>
        </div>
      </div>

      {/* 设置：轻量弹层，只放本地体验相关选项，不触碰历史与成品 */}
      {settingsOpen && (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-ink/40 px-4"
          role="dialog"
          aria-modal="true"
          aria-label="设置"
          onClick={() => setSettingsOpen(false)}
        >
          <div
            className="w-full max-w-sm rounded-xl border border-hairline bg-surface p-5 shadow-pop"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-ink">设置</h3>
              <button
                onClick={() => setSettingsOpen(false)}
                className="text-xs text-ink-3 transition hover:text-ink"
              >
                关闭
              </button>
            </div>
            <p className="mt-1 text-[11px] leading-relaxed text-ink-3">
              只放本地体验相关的选项，不影响已保存的历史快照与成品库。
            </p>

            <div className="mt-4 flex flex-col gap-2">
              <div className="flex items-center justify-between rounded-lg border border-hairline bg-canvas px-3 py-2">
                <div>
                  <p className="text-xs text-ink">侧边栏收起</p>
                  <p className="mt-0.5 text-[10px] text-ink-3">
                    只在本次会话生效，刷新后恢复展开
                  </p>
                </div>
                <button
                  onClick={() => setSidebarCollapsed((prev) => !prev)}
                  aria-pressed={sidebarCollapsed}
                  aria-label="切换侧边栏收起"
                  className={`relative h-5 w-9 shrink-0 rounded-full transition ${
                    sidebarCollapsed ? "bg-accent" : "bg-neutral-300"
                  }`}
                >
                  <span
                    className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${
                      sidebarCollapsed ? "left-4" : "left-0.5"
                    }`}
                  />
                </button>
              </div>

              <button
                onClick={() => {
                  setSettingsOpen(false);
                  setTourStep(1);
                }}
                className="flex items-center justify-between rounded-lg border border-hairline bg-canvas px-3 py-2 text-left text-xs text-ink transition hover:border-accent hover:text-accent"
              >
                重新查看使用引导
                <span className="text-ink-3">›</span>
              </button>

              <button
                onClick={() => {
                  if (
                    !window.confirm(
                      "只清除本机保存的上次会话记录，刷新后不再自动接回；历史快照与成品库不受影响。继续？",
                    )
                  ) {
                    return;
                  }
                  try {
                    window.localStorage.removeItem(SESSION_KEY);
                  } catch {
                    // 隐私模式下本来就没有写入，忽略即可
                  }
                  setPendingSession(null);
                  setSettingsOpen(false);
                  setNotice("已清除刷新恢复记录，历史快照与成品库不受影响");
                }}
                className="flex items-center justify-between rounded-lg border border-hairline bg-canvas px-3 py-2 text-left text-xs text-ink transition hover:border-red-300 hover:text-red-600"
              >
                <span className="flex flex-col">
                  <span>清除刷新恢复记录</span>
                  <span className="mt-0.5 text-[10px] text-ink-3">
                    只影响刷新后自动接回，不删历史任务
                  </span>
                </span>
                <span className="text-ink-3">›</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 首次进入引导：半透明遮罩挖出目标区域，逐步说明三步 */}
      {tourStep > 0 && (
        <div
          className="fixed inset-0 z-50"
          role="dialog"
          aria-modal="true"
          aria-label="使用引导"
          onClick={nextTourStep}
        >
          {tourLayout ? (
            <div
              className="pointer-events-none absolute rounded-xl ring-2 ring-white/90 transition-all duration-300"
              style={{
                top: tourLayout.rect.top - 6,
                left: tourLayout.rect.left - 6,
                width: tourLayout.rect.width + 12,
                height: tourLayout.rect.height + 12,
                boxShadow: "0 0 0 9999px rgba(17, 24, 39, 0.42)",
              }}
            />
          ) : (
            <div className="absolute inset-0 bg-ink/40" />
          )}

          <div
            className="absolute rounded-xl border border-hairline bg-surface p-4 shadow-pop"
            style={tourTooltipStyle}
            onClick={(event) => event.stopPropagation()}
          >
            <p className="text-[11px] font-mono tabular-nums text-ink-3">
              {tourStep} / {TOUR_STEPS.length}
            </p>
            <h3 className="mt-1 text-sm font-semibold text-ink">
              {tourCopy?.title}
            </h3>
            <p className="mt-1 text-xs leading-relaxed text-ink-2">
              {tourCopy?.desc}
            </p>
            <div className="mt-3 flex items-center justify-between">
              <button
                onClick={finishTour}
                className="text-xs text-ink-3 transition hover:text-ink"
              >
                跳过
              </button>
              <button
                onClick={nextTourStep}
                className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white transition hover:bg-accent-strong"
              >
                {tourStep === TOUR_STEPS.length ? "开始使用" : "下一步"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
