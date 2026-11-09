import { BaseAgent } from "./base";
import { generateImage } from "../image";

const SYSTEM_PROMPT = `你是一个 AI 绘图提示词工程师，擅长把中文创意描述转写成高质量的文生图提示词。

## 任务

根据给定的配图方向和描述词，输出一条最终用于 AI 绘图的提示词。

## 要求

1. 只输出提示词本身，不要任何解释、前缀、引号、markdown 标记。
2. 用中文描述画面主体、场景、风格、构图、光线、色调，控制在 60 到 120 字。
3. 要具体到可以直接出图，避免「好看」「高级」这类空词。
4. 不要出现文字、logo、水印相关的描述。
5. 只输出一行。`;

/**
 * 配图 Agent
 *
 * 分两步：
 * 1. 先用文本模型把策划提纲里的配图描述扩写成高质量出图提示词（这一步是流式的，前端能看到思考过程）
 * 2. 再把提示词交给 Seedream 生成真实图片
 *
 * 因为这个 Agent 有两种产出（文本提示词 + 图片 URL），所以不只用 BaseAgent.run，
 * 额外提供一个 generate 方法把两步串起来。
 */
export class ImageAgent extends BaseAgent {
  readonly id = "image";
  readonly name = "配图 Agent";
  readonly systemPrompt = SYSTEM_PROMPT;
  // 文本扩写用豆包，中文视觉描述能力强；真正的出图交给 Seedream
  readonly modelId = "doubao-seed-2-1-pro-260915";
  readonly temperature = 0.4;

  /**
   * 先扩写提示词，再出图。
   * onToken 只回调扩写阶段的文本，onPrompt 回调最终提示词，方便编排层记录。
   */
  async generate(
    input: string,
    options: {
      signal?: AbortSignal;
      onToken?: (token: string) => void;
      onPrompt?: (prompt: string) => void;
    } = {},
  ): Promise<{ prompt: string; imageUrl: string }> {
    const prompt = (
      await this.run(input, { signal: options.signal, onToken: options.onToken })
    ).trim();

    options.onPrompt?.(prompt);

    const { url } = await generateImage({ prompt, signal: options.signal });
    return { prompt, imageUrl: url };
  }
}
