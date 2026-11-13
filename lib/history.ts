import { promises as fs } from "node:fs";
import path from "node:path";
import type { RunSnapshot } from "./orchestrator";
import { getVariant, type VariantKey } from "./variants";

/**
 * 历史任务持久化
 *
 * 内存里的 Run 状态在进程重启后必然丢失，而「隔天打开项目」正是最常见的回看场景。
 * 所以流水线到达终态后，把整份 RunSnapshot 落盘到 data/runs/{runId}.json，
 * 进程重启后仍能按 runId 读出完整产出。
 *
 * 容量控制按「批次」而不是按 run：
 * 多版模式一次并行产出 3 个 run，属于同一个批次，回看时也是一个对比单元。
 * 只按 run 计数会让 5 个名额被两批就吃光。
 */

const HISTORY_DIR = path.join(process.cwd(), "data", "runs");
const MAX_BATCHES = 5;
const RUN_ID_PATTERN = /^[a-zA-Z0-9-]+$/;

/** 落盘文件 = 快照 + 所属批次 */
export interface HistoryFile extends RunSnapshot {
  batchId: string;
}

export type BatchStatus = "completed" | "partial" | "failed";

export interface HistoryRunEntry {
  runId: string;
  topic: string;
  variant: VariantKey | null;
  variantName: string | null;
  status: RunSnapshot["status"];
  createdAt: number;
  finishedAt: number | null;
  durationMs: number | null;
}

export interface HistoryBatch {
  batchId: string;
  topic: string;
  status: BatchStatus;
  createdAt: number;
  finishedAt: number | null;
  runs: HistoryRunEntry[];
}

function filePathFor(runId: string): string {
  return path.join(HISTORY_DIR, `${runId}.json`);
}

/**
 * 写入一次终态快照。
 *
 * 任何磁盘异常都只记日志、不向外抛：存历史是附加能力，
 * 不能因为它（权限、路径、磁盘满）把已经跑完的流水线标记成失败。
 */
export async function saveRunSnapshot(
  snapshot: RunSnapshot,
  batchId: string,
): Promise<void> {
  try {
    await fs.mkdir(HISTORY_DIR, { recursive: true });
    const payload: HistoryFile = { ...snapshot, batchId };
    await fs.writeFile(
      filePathFor(snapshot.runId),
      JSON.stringify(payload),
      "utf8",
    );
    await pruneBatches();
  } catch (err) {
    console.error("[history] 写入快照失败", err);
  }
}

/** 读取单次运行，供 GET /api/run/[runId] 在内存未命中时回退 */
export async function loadRunSnapshot(
  runId: string,
): Promise<HistoryFile | null> {
  if (!RUN_ID_PATTERN.test(runId)) return null;
  try {
    const raw = await fs.readFile(filePathFor(runId), "utf8");
    return JSON.parse(raw) as HistoryFile;
  } catch {
    return null;
  }
}

function batchStatus(runs: HistoryRunEntry[]): BatchStatus {
  if (runs.every((r) => r.status === "completed")) return "completed";
  if (runs.every((r) => r.status !== "completed")) return "failed";
  return "partial";
}

function toEntry(file: HistoryFile): HistoryRunEntry {
  const spec = getVariant(file.variant ?? undefined);
  return {
    runId: file.runId,
    topic: file.topic,
    variant: file.variant,
    variantName: spec?.name ?? null,
    status: file.status,
    createdAt: file.createdAt,
    finishedAt: file.finishedAt,
    durationMs:
      file.finishedAt !== null ? file.finishedAt - file.createdAt : null,
  };
}

/** 读取目录下全部快照并按批次聚合，返回最近的若干批次 */
export async function listHistoryBatches(
  limit: number = MAX_BATCHES,
): Promise<HistoryBatch[]> {
  let names: string[];
  try {
    names = await fs.readdir(HISTORY_DIR);
  } catch {
    return [];
  }

  const files: HistoryFile[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const raw = await fs.readFile(path.join(HISTORY_DIR, name), "utf8");
      files.push(JSON.parse(raw) as HistoryFile);
    } catch {
      // 损坏或正在写入的单个文件不影响整体列表
    }
  }

  const groups = new Map<string, HistoryFile[]>();
  for (const file of files) {
    const key = file.batchId || file.runId;
    const list = groups.get(key);
    if (list) list.push(file);
    else groups.set(key, [file]);
  }

  const batches: HistoryBatch[] = [];
  for (const [batchId, group] of groups) {
    const runs = group
      .map(toEntry)
      .sort((a, b) => a.createdAt - b.createdAt);
    if (runs.length === 0) continue;

    const createdAt = Math.min(...runs.map((r) => r.createdAt));
    const finished = runs.map((r) => r.finishedAt ?? r.createdAt);
    batches.push({
      batchId,
      topic: runs[0].topic,
      status: batchStatus(runs),
      createdAt,
      finishedAt: Math.max(...finished),
      runs,
    });
  }

  return batches
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit);
}

/**
 * 只保留最近 MAX_BATCHES 个批次，超出时整批删除。
 *
 * 整批删除而不是逐个文件删，避免同一批次只剩一半版本、
 * 回看时出现「3 版里少了 1 版」的错觉。
 */
async function pruneBatches(): Promise<void> {
  const batches = await listHistoryBatches(Number.MAX_SAFE_INTEGER);
  const stale = batches.slice(MAX_BATCHES);
  for (const batch of stale) {
    for (const run of batch.runs) {
      try {
        await fs.unlink(filePathFor(run.runId));
      } catch {
        // 已被并发删除或不存在，忽略
      }
    }
  }
}
