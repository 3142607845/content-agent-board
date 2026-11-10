/**
 * 文生图统一出口
 *
 * 火山方舟的图像生成走 /images/generations，和 chat/completions 不是同一套协议，
 * 而且没有流式，只能一次性返回结果，所以单独放一个文件，不塞进 llm.ts。
 *
 * 配置读取和 llm.ts 保持一致：同样两个环境变量。
 * 暂不抽公共模块，避免改动已验收的代码。
 *
 * 出图直接要 base64 并落盘到 public/generated，避免依赖方舟返回的 24 小时临时签名链接。
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export interface GenerateImageOptions {
  /** 出图提示词 */
  prompt: string;
  /** 方舟图像模型 id，默认用 Seedream 5.0 flash */
  model?: string;
  /** 图片尺寸，默认 1024x1024 */
  size?: string;
  signal?: AbortSignal;
}

export interface GeneratedImage {
  /** 落盘后的站内路径，例如 /generated/xxx.png */
  url: string;
}

const DEFAULT_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";
const DEFAULT_IMAGE_MODEL = "doubao-seedream-5-0-flash-260915";
const GENERATED_DIR = path.join(process.cwd(), "public", "generated");

function getConfig() {
  const apiKey = process.env.ARK_API_KEY;
  if (!apiKey) {
    throw new Error("缺少环境变量 ARK_API_KEY，请在 .env.local 中配置");
  }
  return {
    apiKey,
    baseUrl: process.env.ARK_BASE_URL || DEFAULT_BASE_URL,
  };
}

/**
 * 根据提示词生成一张图片，返回可访问的图片 URL。
 */
export async function generateImage(
  options: GenerateImageOptions,
): Promise<GeneratedImage> {
  const { apiKey, baseUrl } = getConfig();
  const {
    prompt,
    model = DEFAULT_IMAGE_MODEL,
    size = "1024x1024",
    signal,
  } = options;

  const res = await fetch(`${baseUrl}/images/generations`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      prompt,
      size,
      response_format: "b64_json",
      watermark: false,
    }),
    signal,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`图片生成失败 ${res.status}: ${detail.slice(0, 500)}`);
  }

  const json = (await res.json()) as {
    data?: Array<{ b64_json?: string }>;
  };

  const raw = json.data?.[0]?.b64_json;
  if (!raw) {
    throw new Error("图片生成成功但没有返回 b64_json");
  }

  // 兼容可能带 data:image/...;base64, 前缀的返回
  const base64 = raw.replace(/^data:image\/\w+;base64,/, "");

  await mkdir(GENERATED_DIR, { recursive: true });
  const filename = `${randomUUID()}.png`;
  await writeFile(path.join(GENERATED_DIR, filename), Buffer.from(base64, "base64"));

  return { url: `/generated/${filename}` };
}
