/**
 * 导出元信息模块 —— 给导出的 Markdown / PDF 加一个结构化的前置块。
 *
 * 职责：从 RunReport / 当前会话里提取选题、时间、token 与耗时，
 * 格式化成一段 Markdown front-matter，供导出函数调用。
 *
 * 设计原则：单一职责、纯函数、零依赖——调用方只传数据，不做任何副作用。
 */

export interface ExportMetaInput {
  /** 选题 */
  topic: string;
  /** 本地时区时间，ISO 格式或时间戳都行 */
  timestamp: Date | number | string;
  /** 可选：本次 run 的各节点耗时 ms */
  nodeDurationsMs?: { nodeId: string; name: string; durationMs: number }[];
  /** 可选：token 总和 */
  totalTokens?: number;
  /** 可选：并行加速比 */
  speedup?: number | null;
}

/**
 * 把耗时毫秒格式化成人类可读的 "N.Ns" 或 "Nm Ns"。
 * 200ms 以内向上取整 1 秒。
 */
export function formatDuration(ms: number): string {
  if (!ms || ms < 0) return "0s";
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}m ${s.toFixed(0)}s`;
}

/** YYYY-MM-DD HH:mm（本地时区）*/
export function formatLocalTime(input: Date | number | string): string {
  const d = input instanceof Date ? input : new Date(input);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 组装 Markdown 元信息块。
 * 调用方负责把它拼到正文开头。
 *
 * 约束：
 * - 不导入任何外部包（零依赖）
 * - 不访问全局状态、不写文件（纯函数）
 * - 节点列表为空时只输出选题 + 时间，不占多余行数
 */
export function buildMetaBlock(input: ExportMetaInput): string {
  const topic = input.topic || "(未命名选题)";
  const time = formatLocalTime(input.timestamp);

  let block = `<!-- 自动生成元信息，请勿手动修改 -->\n`;
  block += `> **选题**：${topic}\n`;
  block += `> **生成时间**：${time}\n`;

  const lines: string[] = [];
  if (input.nodeDurationsMs && input.nodeDurationsMs.length > 0) {
    const parts = input.nodeDurationsMs
      .map((n) => `${n.name} ${formatDuration(n.durationMs)}`)
      .join(" · ");
    lines.push(`> **节点耗时**：${parts}`);
  }
  if (typeof input.totalTokens === "number") {
    lines.push(`> **Token 总和**：${input.totalTokens.toLocaleString()}`);
  }
  if (input.speedup != null && input.speedup !== undefined) {
    lines.push(`> **并行加速比**：${input.speedup.toFixed(2)}x`);
  }
  if (lines.length > 0) block += lines.join("\n") + "\n";

  return block + "\n";
}
