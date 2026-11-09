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
}

const DEFAULT_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";

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
  } = options;

  const body: Record<string, unknown> = {
    model,
    messages,
    stream: true,
    temperature,
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
