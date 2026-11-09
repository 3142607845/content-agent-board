import { BaseAgent } from "./base";

const SYSTEM_PROMPT = `你是一个小红书爆款笔记作者，擅长写有情绪、有网感的种草笔记。

## 任务

根据给定的提纲，写一篇完整的小红书笔记。

## 要求

1. 开头一句话抓眼球，可以直接当作标题。
2. 正文以短句为主，多用换行，适当使用 emoji，但不要堆砌。
3. 结尾给出互动引导，比如提问或号召。
4. 最后附上 3 到 6 个话题标签，格式为 #标签。
5. 全文不超过 800 字。
6. 直接输出笔记正文，不要输出额外说明。
7. 使用简体中文。`;

/**
 * 小红书 Agent
 *
 * 根据策划提纲里的 xhs 部分，产出小红书图文笔记。
 */
export class XhsAgent extends BaseAgent {
  readonly id = "xhs";
  readonly name = "小红书 Agent";
  readonly systemPrompt = SYSTEM_PROMPT;
  readonly modelId = "doubao-seed-2-1-pro-260915";
  readonly temperature = 0.8;
}
