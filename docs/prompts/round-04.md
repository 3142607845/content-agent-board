# Round 04 — 阶段 1：策划 Agent 单独跑通

## 我的提问（用户视角）

进入阶段 1：先让策划 Agent 单独跑通。只要能输入一个选题、拿到策划 Agent 输出的 JSON 就算完成，不碰看板、不碰另外 4 个 Agent、不碰中断和重跑。要求先给方案不写代码：

1. Next.js 用什么方式初始化、目录怎么建
2. 策划 Agent 的 System Prompt 怎么写才能稳定输出纯 JSON
3. 最小可跑通需要哪几个文件、每个文件职责

模型 API 情况：火山方舟统一网关（`https://ark.cn-beijing.volces.com/api/v3`），共用同一 Key，OpenAI 兼容 SSE 流式，仅通过修改 model_id 切换模型。

## AI 的方案

- 初始化：不用 `create-next-app` 直接在当前目录跑（会覆盖阶段 0 的 README），改为临时目录生成再拷贝
- Prompt 三层约束：角色收敛 + 完整 JSON 样例 + 禁止项清单；参数层 `temperature=0.3` + `response_format: json_object`
- 文件划分：`lib/llm.ts`（ModelAdapter）/ `lib/agents/base.ts` / `lib/agents/planner.ts` / `app/api/run/route.ts` / `app/page.tsx`
- 风险预警：只取 `delta.content`，忽略 `reasoning_content`（思考模式输出）

## 我的确认

同意初始化方式、同意加 `response_format: json_object`、接受「阶段 1 先一次性流、阶段 2 再拆 run/stream 接口」的迭代演进方案。

## 遇到的三个真实问题（详见 pitfalls.md）

1. Next.js 16 默认开启 `cacheComponents`，路由里写 `export const runtime/dynamic` 直接编译报错 → 删掉这两个导出
2. 模型 id 显示名 ≠ 方舟真实 id（`DeepSeek-V4.1-Flash` → `deepseek-v4-1-flash-261017`），用 `/api/v3/models` 列出真实 id 后修正
3. 账号未开通模型，接口返回 `404 ModelNotOpen` → 我去方舟控制台开通 DeepSeek-V4.1-Flash 与 Doubao-Seed-2.1-pro 后恢复

## 验收结果（我自己跑 + AI 辅助验证）

- 450 个 `token` 事件流式返回，`event: done` 正常收尾，无 error 事件
- 正文 1442 字符，`JSON.parse` 成功
- 提纲字段齐全：`topic / outline.longForm / script / xhs / image`
- 浏览器实测：文字逐 token 出现、中断按钮生效、状态变为「已中断」

## 产出

- commit 3d29f39：chore: 初始化 Next.js 项目骨架
- commit 7044294：feat: 封装方舟模型流式调用与 Agent 基类
- commit de12efc：feat: 策划 Agent 与 SSE 流式接口跑通单节点
