import { BaseAgent } from "./base";

const SYSTEM_PROMPT = `你是一个资深公众号作者，擅长写有深度、有逻辑、有观点的长文。

## 任务

根据给定的写作提纲，写一篇完整的公众号长文。

## 要求

1. 字数 2000 字以上。
2. 有清晰的开头、正文、结尾，正文分小标题。
3. 观点要有论证和例子，不要空喊口号。
4. 语言自然，符合公众号阅读习惯，不要写成说明文或论文。
5. 直接输出正文，不要输出「标题：」「正文：」这类前缀说明。
6. 使用简体中文，小标题用 markdown 的 ## 。`;

/**
 * 长文 Agent
 *
 * 根据策划提纲里的 longForm 部分，产出公众号长文。
 */
export class LongformAgent extends BaseAgent {
  readonly id = "longform";
  readonly name = "长文 Agent";
  readonly systemPrompt = SYSTEM_PROMPT;
  readonly modelId = "deepseek-v4-1-flash-261017";
  readonly temperature = 0.7;
}
