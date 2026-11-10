/**
 * 模型调用统一出口（ModelAdapter）
 *
 * 当前只对接火山方舟统一网关，OpenAI 兼容协议。
 * 切换模型只改调用方传进来的 modelId，不需要改这里。
 * 未来如果要对接口外部原生 API，在 streamChat 内部按 provider 分支即可，
 * 上层 Agent 拿到的仍然是「一串 token 回调 + 完整文本」。
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * 一次模型调用的 token 用量。
 *
 * completionTokens 包含 reasoningTokens（思维链），
 * 所以「输出 token 数」可能明显大于正文字数，这不是算错。
 */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
  cachedTokens?: number;
}

export interface StreamChatOptions {
  /** 方舟上的模型 id，或推理接入点 id（ep-xxxx） */
  model: string;
  messages: ChatMessage[];
  /**
   * 强制模型返回 JSON 对象。
   * 仅策划 Agent 使用，其他 Agent 输出长文本，不开这个。
   */
  responseFormat?: "json_object";
  temperature?: number;
  signal?: AbortSignal;
  /** 每收到一个 token 回调一次 */
  onToken?: (token: string) => void;
  /**
   * 流结束时回调一次 token 用量。
   * 服务端不返回 usage 时不会触发，调用方需要自行降级。
   */
  onUsage?: (usage: TokenUsage) => void;
}

const DEFAULT_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";

function toNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * 解析方舟返回的 usage。
 * 中间分片会带 "usage": null，只在最后一片给真实值，所以调用方要判空。
 */
function parseUsage(raw: unknown): TokenUsage | null {
  if (!raw || typeof raw !== "object") return null;
  const u = raw as Record<string, unknown>;
  const completionDetails = (u.completion_tokens_details ?? {}) as Record<string, unknown>;
  const promptDetails = (u.prompt_tokens_details ?? {}) as Record<string, unknown>;
  return {
    promptTokens: toNumber(u.prompt_tokens),
    completionTokens: toNumber(u.completion_tokens),
    totalTokens: toNumber(u.total_tokens),
    reasoningTokens: toNumber(completionDetails.reasoning_tokens) || undefined,
    cachedTokens: toNumber(promptDetails.cached_tokens) || undefined,
  };
}

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
 * 流式调用模型，返回完整文本。
 * 内部边推边回调，调用方不需要关心 SSE 解析细节。
 */
export async function streamChat(options: StreamChatOptions): Promise<string> {
  const { apiKey, baseUrl } = getConfig();
  const {
    model,
    messages,
    responseFormat,
    temperature = 0.3,
    signal,
    onToken,
    onUsage,
  } = options;

  const body: Record<string, unknown> = {
    model,
    messages,
    stream: true,
    temperature,
    // 让服务端在流末尾补一片 usage，用于统计 token 消耗
    stream_options: { include_usage: true },
  };
  if (responseFormat) {
    body.response_format = { type: responseFormat };
  }

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    throw new Error(`模型调用失败 ${res.status}: ${detail.slice(0, 500)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();

  let full = "";
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // SSE 以 \n 分隔，chunk 边界可能把一行切成两半，所以保留最后一段不完整内容
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || !line.startsWith("data:")) continue;

      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;

      let json: unknown;
      try {
        json = JSON.parse(payload);
      } catch {
        // 单个分片解析失败不影响整体，跳过
        continue;
      }

      // usage 只在最后一片给出，且中间分片是 null。
      // 必须放在 choices 判空之前：服务端可能返回 choices 为空、只带 usage 的收尾分片。
      const usage = parseUsage((json as { usage?: unknown }).usage);
      if (usage) onUsage?.(usage);

      const choices = (json as { choices?: unknown }).choices;
      if (!Array.isArray(choices) || choices.length === 0) continue;

      const delta = (choices[0] as { delta?: Record<string, unknown> }).delta;
      if (!delta) continue;

      // 只取正文，忽略 reasoning_content 等思考过程字段
      const content = delta.content;
      if (typeof content !== "string" || content.length === 0) continue;

      full += content;
      onToken?.(content);
    }
  }

  return full;
}
