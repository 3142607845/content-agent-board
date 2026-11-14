import { promises as fs } from "node:fs";
import path from "node:path";
import {
  BUILTIN_STYLES,
  isStyleChannel,
  normalizeStyleInput,
  type StyleChannel,
  type StyleSnapshot,
  type StyleTemplate,
} from "./styles";

/**
 * 风格模板存储
 *
 * 内置模板写在代码里，永远可用；用户自定义模板落盘到 data/styles.json。
 * 与历史快照同一套思路：运行时目录不进仓库，写盘失败只影响「保存」这个动作，
 * 不会影响已经跑起来的流水线。
 *
 * 每次写都是「读全量 → 改一条 → 覆盖写」，单机演示场景够用。
 */

const STYLE_FILE = path.join(process.cwd(), "data", "styles.json");
const MAX_CUSTOM = 30;
const ID_PATTERN = /^[a-zA-Z0-9-]{1,64}$/;

interface StyleFile {
  version: 1;
  templates: StyleTemplate[];
}

function isStoredStyle(value: unknown): value is StyleTemplate {
  if (!value || typeof value !== "object") return false;
  const t = value as Record<string, unknown>;
  return (
    typeof t.id === "string" &&
    ID_PATTERN.test(t.id) &&
    isStyleChannel(t.channel) &&
    typeof t.name === "string" &&
    typeof t.summary === "string" &&
    typeof t.prompt === "string"
  );
}

async function readCustomStyles(): Promise<StyleTemplate[]> {
  try {
    const raw = await fs.readFile(STYLE_FILE, "utf8");
    const parsed = JSON.parse(raw) as { templates?: unknown };
    if (!Array.isArray(parsed.templates)) return [];
    // builtin 标记以代码为准，手改文件也无法把自定义模板伪装成内置模板
    return parsed.templates
      .filter(isStoredStyle)
      .map((t) => ({ ...t, builtin: false }));
  } catch {
    // 文件不存在、损坏、无读权限，一律当作「还没有自定义模板」
    return [];
  }
}

async function writeCustomStyles(templates: StyleTemplate[]): Promise<void> {
  await fs.mkdir(path.dirname(STYLE_FILE), { recursive: true });
  const payload: StyleFile = { version: 1, templates };
  await fs.writeFile(STYLE_FILE, JSON.stringify(payload, null, 2), "utf8");
}

/** 内置在前、自定义在后；自定义按最近更新排序 */
export async function listStyles(): Promise<StyleTemplate[]> {
  const custom = await readCustomStyles();
  custom.sort((a, b) => b.updatedAt - a.updatedAt);
  return [...BUILTIN_STYLES, ...custom];
}

export type StyleMutationResult =
  | { ok: true; template: StyleTemplate }
  | { ok: false; status: number; error: string };

export async function createStyle(raw: unknown): Promise<StyleMutationResult> {
  const normalized = normalizeStyleInput(raw);
  if (!normalized.ok) return { ok: false, status: 400, error: normalized.error };

  const custom = await readCustomStyles();
  if (custom.length >= MAX_CUSTOM) {
    return {
      ok: false,
      status: 400,
      error: `自定义模板最多 ${MAX_CUSTOM} 套，请先删除不用的模板`,
    };
  }
  const duplicated = custom.some(
    (t) => t.channel === normalized.value.channel && t.name === normalized.value.name,
  );
  if (duplicated) {
    return { ok: false, status: 409, error: "同一渠道下已存在同名模板" };
  }

  const now = Date.now();
  const template: StyleTemplate = {
    id: `custom-${crypto.randomUUID()}`,
    ...normalized.value,
    builtin: false,
    createdAt: now,
    updatedAt: now,
  };

  try {
    await writeCustomStyles([...custom, template]);
  } catch (err) {
    console.error("[styles] 写入失败", err);
    return { ok: false, status: 500, error: "模板写入磁盘失败" };
  }

  return { ok: true, template };
}

export async function updateStyle(
  id: string,
  raw: unknown,
): Promise<StyleMutationResult> {
  if (!ID_PATTERN.test(id)) {
    return { ok: false, status: 404, error: "模板不存在" };
  }
  if (BUILTIN_STYLES.some((t) => t.id === id)) {
    return { ok: false, status: 403, error: "内置模板只读，请复制为自定义模板后修改" };
  }

  const normalized = normalizeStyleInput(raw);
  if (!normalized.ok) return { ok: false, status: 400, error: normalized.error };

  const custom = await readCustomStyles();
  const index = custom.findIndex((t) => t.id === id);
  if (index < 0) return { ok: false, status: 404, error: "模板不存在" };

  const duplicated = custom.some(
    (t) =>
      t.id !== id &&
      t.channel === normalized.value.channel &&
      t.name === normalized.value.name,
  );
  if (duplicated) {
    return { ok: false, status: 409, error: "同一渠道下已存在同名模板" };
  }

  const next: StyleTemplate = {
    ...custom[index],
    ...normalized.value,
    builtin: false,
    updatedAt: Date.now(),
  };
  custom[index] = next;

  try {
    await writeCustomStyles(custom);
  } catch (err) {
    console.error("[styles] 写入失败", err);
    return { ok: false, status: 500, error: "模板写入磁盘失败" };
  }

  return { ok: true, template: next };
}

export async function deleteStyle(
  id: string,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  if (!ID_PATTERN.test(id)) {
    return { ok: false, status: 404, error: "模板不存在" };
  }
  if (BUILTIN_STYLES.some((t) => t.id === id)) {
    return { ok: false, status: 403, error: "内置模板不可删除" };
  }

  const custom = await readCustomStyles();
  if (!custom.some((t) => t.id === id)) {
    return { ok: false, status: 404, error: "模板不存在" };
  }

  try {
    await writeCustomStyles(custom.filter((t) => t.id !== id));
  } catch (err) {
    console.error("[styles] 写入失败", err);
    return { ok: false, status: 500, error: "模板删除失败" };
  }

  return { ok: true };
}

/**
 * 把前端传来的 { channel: templateId } 解析成模板快照。
 *
 * 只在创建 run 时解析一次：之后模板被编辑或删除，
 * 本次 run 的风格与历史回看都不受影响。
 */
export async function resolveStyles(
  selection: unknown,
): Promise<
  | { ok: true; styles: Partial<Record<StyleChannel, StyleSnapshot>> }
  | { ok: false; error: string }
> {
  if (selection === undefined || selection === null) {
    return { ok: true, styles: {} };
  }
  if (typeof selection !== "object" || Array.isArray(selection)) {
    return { ok: false, error: "styles 必须是对象" };
  }

  const entries = Object.entries(selection as Record<string, unknown>).filter(
    ([, value]) => typeof value === "string" && value.length > 0,
  );
  if (entries.length === 0) return { ok: true, styles: {} };

  const all = await listStyles();
  const styles: Partial<Record<StyleChannel, StyleSnapshot>> = {};
  for (const [channel, value] of entries) {
    if (!isStyleChannel(channel)) {
      return { ok: false, error: `未知的模板渠道：${channel}` };
    }
    if (typeof value !== "string") {
      return { ok: false, error: "风格模板 id 必须是字符串" };
    }
    const found = all.find((t) => t.id === value);
    if (!found) return { ok: false, error: `风格模板不存在：${value}` };
    if (found.channel !== channel) {
      return { ok: false, error: `模板「${found.name}」不属于该渠道` };
    }
    styles[channel] = { id: found.id, name: found.name, prompt: found.prompt };
  }

  return { ok: true, styles };
}
