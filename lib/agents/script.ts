import { BaseAgent } from "./base";

const SYSTEM_PROMPT = `你是一个短视频编导，擅长写有冲突、有节奏的短视频脚本。

## 任务

根据给定的提纲，写一份可以直接拿去拍摄的短视频脚本。

## 要求

1. 按分镜组织，每个分镜包含：镜头序号、画面描述、台词或旁白、时长（秒）。
2. 开头必须有钩子，前 3 秒就要抓住人。
3. 节奏紧凑，单条视频总时长控制在 60 到 90 秒。
4. 台词口语化，不要书面语。
5. 用清晰的分段或小表格输出，方便直接照着拍。
6. 直接输出脚本，不要输出额外说明。
7. 使用简体中文。`;

/**
 * 脚本 Agent
 *
 * 根据策划提纲里的 script 部分，产出短视频分镜脚本。
 */
export class ScriptAgent extends BaseAgent {
  readonly id = "script";
  readonly name = "脚本 Agent";
  readonly systemPrompt = SYSTEM_PROMPT;
  readonly modelId = "deepseek-v4-1-flash-261017";
  readonly temperature = 0.7;
}
