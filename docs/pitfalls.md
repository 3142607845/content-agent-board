# AI 踩坑记录

> 这个文件记录"AI 第一版写错了什么、我怎么发现的、怎么引导它修正"。
> 这是比赛技术文档和演示视频里最有价值的素材，每解决一个问题就记一条。

## 模板

**问题：**
（AI 生成的代码出了什么错）

**现象：**
（运行时看到的报错或异常行为）

**我的判断：**
（我认为问题出在哪）

**引导方式：**
（我是怎么跟 AI 说的，让它改对）

**最终方案：**
（修正后的做法）

---

## 记录 01 — Next.js 16 的 cacheComponents 与路由导出冲突（2026-11-09，阶段 1）

**问题：**
AI 按旧版本 Next.js 的经验，在 `app/api/run/route.ts` 里写了 `export const runtime = "nodejs"` 和 `export const dynamic = "force-dynamic"`。

**现象：**
接口返回 500，终端编译报错：Next.js 16 默认开启 `cacheComponents`，路由文件不允许导出 `dynamic`；删掉后又报 `runtime` 同样不兼容。

**我的判断：**
脚手架是 `create-next-app@latest` 生成的最新版 Next.js 16，缓存策略和旧版本不同，AI 的知识停留在旧版本。

**引导方式：**
把报错原文贴给 AI，让它不要靠记忆，直接按编译器的报错信息修。

**最终方案：**
删掉 `runtime` 和 `dynamic` 两个导出。阶段 1 的 SSE 流式接口不需要它们就能工作。

**经验：** 版本相关的报错要贴原文，不要让 AI 凭记忆猜。

---

## 记录 02 — 模型显示名 ≠ 真实模型 id（2026-11-09，阶段 1）

**问题：**
AI 一开始把策划 Agent 的 `modelId` 写成显示名 `deepseek-v4.1-flash`。

**现象：**
接口返回 404，模型不存在。

**我的判断：**
方舟控制台上显示的名字和 API 调用用的模型 id 可能不一致。

**引导方式：**
让 AI 调用方舟的 `/api/v3/models` 列出当前账号可见的模型清单，从清单里取真实 id，而不是猜。

**最终方案：**
真实 id 为 `deepseek-v4-1-flash-261017`（带日期后缀），修改 `lib/agents/planner.ts` 后调用成功。同理 `Doubao-Seed-2.1-pro` 真实 id 为 `doubao-seed-2-1-pro-260915`。

**经验：** 任何云平台的模型 id 都要先查清单再写，显示名不可信。

---

## 记录 03 — 模型已存在但未开通（2026-11-09，阶段 1）

**问题：**
修正模型 id 后，接口仍返回 `404 ModelNotOpen`。

**现象：**
报错原文：`Your account 2134177219 has not activated the model ...`，提示去 Ark Console 开通。

**我的判断：**
这不是代码问题，是账号权限问题。AI 无法代替我开通。

**引导方式：**
AI 明确了卡点归属（账号权限而非代码），我登录方舟控制台开通 DeepSeek-V4.1-Flash 和 Doubao-Seed-2.1-pro，开通后立即恢复。

**最终方案：**
开通后无需改代码，直接验证通过。本次验证：450 个 SSE token 事件、`event: done` 收尾、输出可被 `JSON.parse` 解析、四渠道字段齐全。

**经验：** 报错信息里出现"activated / permission / quota"字样时，先怀疑账号配置，不要改代码。
