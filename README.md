# Content Agent Board

把一个选题扔进去，四个 Agent 并行产出长文、短视频脚本、小红书文案和配图，全程在看板上可见、可中断、可重跑。

本文件同时是提交材料里的**复现性声明与重现指南**：按下面的顺序操作，一台干净的电脑可在 10 分钟内跑通第一次生成。

## 10 分钟极速复现

| 时间段 | 做什么 | 完成后应看到 |
|---|---|---|
| 0-2 分钟 | 获取代码、安装依赖 | `npm install` 正常结束，无编译错误 |
| 2-3 分钟 | 复制环境变量模板并填入 Key | 项目根目录出现 `.env.local` |
| 3-5 分钟 | 在方舟控制台确认模型已开通 | 控制台显示模型「已开通」 |
| 5-6 分钟 | 启动服务 | 浏览器自动打开 `http://localhost:3000` |
| 6-10 分钟 | 按验收清单跑一次生成 | 四张内容卡全部完成，历史出现该批次 |

如果账号已开通过模型，第 3 步可跳过，整体约 7 分钟。

## 第 0 步：前置条件与依赖清单

| 类别 | 要求 | 说明 |
|---|---|---|
| Node.js | ≥ 20（实测 20 / 22 均可） | 仅此一项运行时依赖 |
| npm | 随 Node 安装 | 用于安装依赖与启动 |
| 浏览器 | Chrome / Edge 最新版 | 需要 EventSource，IE 不支持 |
| 操作系统 | Windows 10/11，或 macOS / Linux | Windows 可直接用 `start.bat` |
| 账号 | 火山方舟（Ark）API Key | 唯一的第三方服务 |

**不需要**：数据库、Docker、Redis、消息队列。运行数据以 JSON 文件形式写在项目内的 `data/` 目录。

运行时依赖只有 4 个，均无原生编译步骤：

| 依赖 | 版本 | 用途 |
|---|---|---|
| next | 16.4.5 | 页面与 API Routes |
| react / react-dom | 19.3.0 | 前端渲染 |
| three | ^0.187.0 | 首页装饰性 3D 背景 |

开发依赖：TypeScript 5、ESLint 9、Tailwind CSS 4（`@tailwindcss/turbopack`）。

## 第 1 步：获取代码并安装依赖

```powershell
git clone https://github.com/3142607845/content-agent-board.git
cd content-agent-board
npm install
```

## 第 2 步：环境变量模板

复制 `.env.example` 为 `.env.local`，只需要填两项：

```ini
# 火山方舟统一网关配置
ARK_API_KEY=your_ark_api_key_here
ARK_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
```

| 变量 | 是否必填 | 取值 |
|---|---|---|
| `ARK_API_KEY` | 必填 | 方舟控制台 → API Key 管理 → 新建或复制 |
| `ARK_BASE_URL` | 可选 | 默认值即为北京区网关，不改即可 |

`.env.local` 已在 `.gitignore` 中，不会被提交。除这两项外没有其他环境变量；各 Agent 的模型 id 写在代码里（见下一步），不走环境变量。

## 第 3 步：确认模型已开通

代码中固定使用以下 6 个模型，账号未开通会直接返回 404。请在方舟控制台逐个确认「已开通」：

| 角色 | 模型 id | 定义位置 |
|---|---|---|
| 策划 Agent | `deepseek-v4-1-flash-261017` | `lib/agents/planner.ts` |
| 公众号长文 | `deepseek-v4-1-flash-261017` | `lib/agents/longform.ts` |
| 短视频脚本 | `deepseek-v4-1-flash-261017` | `lib/agents/script.ts` |
| 小红书文案 | `glm-5-3-flash-260828` | `lib/agents/xhs.ts` |
| 配图提示词扩写 | `doubao-seed-2-1-pro-260915` | `lib/agents/image.ts` |
| 图片生成 | `doubao-seedream-5-0-flash-260915` | `lib/image.ts` |

若你的账号里模型 id 与上表不同（控制台显示名通常不带日期后缀），以控制台列出的真实 id 为准，改对应文件中的 `modelId` 即可，其他代码不用动。

## 第 4 步：启动

**Windows 一键启动（推荐）**：双击项目根目录的 `start.bat`。脚本会检查 Node.js、缺少依赖时自动 `npm install`、启动 dev server，并在首页可访问后自动打开浏览器；若 3000 端口已有服务在运行，则只打开浏览器，不重复启动。

**手动启动**：

```powershell
npm run dev
```

然后访问 <http://localhost:3000>。

## 第 5 步：验收清单

依次完成下面 6 项，即视为复现成功：

| # | 操作 | 预期结果 |
|---|---|---|
| 1 | 打开首页 | 左侧边栏底部显示「本地服务正常」 |
| 2 | 在输入框填一个选题，点「开始生成」 | 策划卡进入运行中，文字流式出现 |
| 3 | 等待策划完成 | 长文 / 脚本 / 小红书 / 配图四张卡同时进入运行中 |
| 4 | 等待全部完成 | 四张卡状态均为完成，配图卡出现图片 |
| 5 | 查看项目目录 | `data/runs/` 下出现本次 run 的 JSON；图片落在 `public/generated/` |
| 6 | 刷新页面 | 左侧历史列表仍能看到刚才这一批任务 |

任一节点失败不影响其余三个节点；策划失败则四路都不会启动，界面会提示「策划提纲生成失败，无法继续生成内容」。

## 常见报错对照

以下四条来自本项目开发过程中的真实报错，按现象可直接定位：

| 现象 | 原因 | 处理 |
|---|---|---|
| 启动即报 500，提示路由不允许导出 `dynamic` / `runtime` | Next.js 16 默认开启 `cacheComponents` | 删除路由文件里的 `runtime`、`dynamic` 导出 |
| 接口 404，提示模型不存在 | 用了控制台的显示名而非真实模型 id | 调用 `/api/v3/models` 列出清单，取带日期后缀的真实 id |
| 接口 404，提示 `ModelNotOpen` / `has not activated` | 账号未开通该模型 | 方舟控制台开通对应模型，无需改代码 |
| 历史记录里的图片过一段时间变成裂图 | 曾经直接存 Seedream 返回的签名 URL | 本项目已改为 `b64_json` 直出并落盘 `public/generated/`，此问题已修复 |

## 数据落盘与目录

| 路径 | 内容 | 是否进仓库 |
|---|---|---|
| `data/runs/` | 历史任务快照，按批次聚合保留最近 5 批 | 否 |
| `data/library.json` | 卡片成品库 | 否 |
| `data/projects.json` | 整批项目库 | 否 |
| `data/styles.json` | 自定义风格模板 | 否 |
| `public/generated/` | 配图产物 | 否 |

清空这些目录即可回到初始状态，不影响代码运行。

## 自检命令

提交前跑三条：

```powershell
npm run lint
npx tsc --noEmit
npm run build
```

## 功能一览

- **流水线生成**：策划 Agent 先出差异化提纲，再并行驱动长文、短视频脚本、小红书文案、配图四条支线，全程 SSE 流式可见。
- **三种运行模式**：单次生成、批量选题排队生成、多版生成；排队中的任务显示「排队中」，队列推进期间不会误开新任务。
- **提纲人工干预**：结构化表单与 JSON 双模式编辑，支持本地撤销/重做（最多 20 步），提交前可预览影响面，只重生成受影响的下游节点。
- **风格模板库**：内置模板加自定义模板，按渠道选择，header 与侧边栏两处入口指向同一面板。
- **历史任务回看**：任务落盘后可按批次回看、继续迭代、整批横向对比或删除；本地保留最近 5 批，重要产出建议收藏。
- **成品库与项目库**：单条产出收藏到成品库，整批产出收藏为项目，方便复用。
- **左侧边栏**：任务列表、新建、模板、设置与服务状态集中在一条可折叠侧栏内。

## 文档

- [docs/architecture.md](docs/architecture.md)：架构定稿、模块职责、关键设计决策、后续迭代候选。
- [docs/pitfalls.md](docs/pitfalls.md)：踩过的坑、发现过程与引导 AI 修正的方式。
- [docs/prompts/round-XX.md](docs/prompts)：每轮迭代的提问、AI 方案、用户决策、验证与反思。

## 停止服务

关闭运行 dev server 的终端窗口即可。电脑重启后服务不会保留，需要重新双击 `start.bat` 或执行 `npm run dev`。

## 开机自启（可选）

如果经常隔天打开项目、每次都遇到 `ERR_CONNECTION_REFUSED`，可以让服务在登录 Windows 后自动后台运行：

1. `Win + R` 输入 `shell:startup` 回车，打开启动目录；
2. 新建快捷方式，目标填：

   ```
   cmd /c "e:\content-agent-board\start.bat" --no-browser
   ```

3. 右键快捷方式 →「属性」→「运行方式」选「最小化」，「起始位置」填项目目录。

`--no-browser` 表示只启动服务、不自动打开浏览器；若 3000 端口已有服务在运行，脚本会直接退出，不会启动第二个实例。删除该快捷方式即可取消自启。第 2 步路径请按实际 clone 位置调整。
