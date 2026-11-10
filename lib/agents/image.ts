import { BaseAgent } from "./base";
import { generateImage } from "../image";
import type { TokenUsage } from "../llm";

const SYSTEM_PROMPT = `你是一个 AI 绘图提示词工程师，负责把选题和配图描述转写成一条可直接出图的提示词。

## 任务

根据给定的选题和配图描述，输出一条最终用于 AI 绘图的提示词。

## 硬性要求

1. 提示词必须体现选题的主角、场景和动作。例如选题是「AI 编程会不会取代程序员」，画面里就要出现程序员、电脑屏幕、代码、办公场景，不能只画抽象符号或概念意象。
2. 给定多条描述时，选择画面信息最具体、最能体现选题的那一条；不要选纯象征性构图（比如两只手相触、抽象光带这类）。
3. 必须保留描述里的人物身份、地点、物品等具体名词，不许替换成抽象概念。
4. 只输出提示词本身，不要任何解释、前缀、引号、markdown 标记。
5. 用中文描述画面主体、动作、场景、风格、构图、光线、色调，控制在 80 到 150 字。
6. 不要出现文字、logo、水印相关的描述。
7. 只输出一行。`;

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
      onUsage?: (usage: TokenUsage) => void;
    } = {},
  ): Promise<{ prompt: string; imageUrl: string }> {
    const prompt = (
      await this.run(input, {
        signal: options.signal,
        onToken: options.onToken,
        onUsage: options.onUsage,
      })
    ).trim();

    options.onPrompt?.(prompt);

    const { url } = await generateImage({ prompt, signal: options.signal });
    return { prompt, imageUrl: url };
  }
}
