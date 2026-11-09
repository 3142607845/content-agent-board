import { streamChat, type ChatMessage } from "../llm";

export interface AgentRunOptions {
  signal?: AbortSignal;
  /** 每收到一个 token 回调一次，用于 SSE 推给前端 */
  onToken?: (token: string) => void;
}

/**
 * Agent 基类
 *
 * 每个 Agent 只声明自己的「模型 + prompt + 参数」，
 * 组装 messages、调用模型、流式回调这些公共逻辑都放这里。
 * 不处理 HTTP，不处理 SSE 输出，那属于接口层。
 */
export abstract class BaseAgent {
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly systemPrompt: string;
  /** 方舟模型 id，各 Agent 可不同 */
  abstract readonly modelId: string;

  /** 默认低温，减少发散；需要稳定结构的 Agent 可以覆盖 */
  readonly temperature: number = 0.3;

  /** 只有策划 Agent 会覆盖成 json_object */
  readonly responseFormat?: "json_object";

  protected buildMessages(input: string): ChatMessage[] {
    return [
      { role: "system", content: this.systemPrompt },
      { role: "user", content: input },
    ];
  }

  /** 跑一次，返回完整文本 */
  async run(input: string, options: AgentRunOptions = {}): Promise<string> {
    return streamChat({
      model: this.modelId,
      messages: this.buildMessages(input),
      temperature: this.temperature,
      responseFormat: this.responseFormat,
      signal: options.signal,
      onToken: options.onToken,
    });
  }
}
