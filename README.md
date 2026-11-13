# Content Agent Board

把一个选题扔进去，四个 Agent 并行产出长文、短视频脚本、小红书文案和配图，全程在看板上可见、可中断、可重跑。

## 技术栈

- 前端：Next.js App Router + 卡片网格看板
- 后端：Next.js API Routes
- 通信：SSE 流式推送
- 模型：火山方舟（ARK）统一网关，单 Key 多模型

## 快速开始

### 1. 配置密钥

复制 `.env.example` 为 `.env.local`，填入火山方舟 API Key：

```ini
ARK_API_KEY=your_ark_api_key_here
ARK_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
```

各 Agent 使用的模型 id 写在 `lib/agents/*.ts` 中，不走环境变量。

### 2. 启动服务

**Windows 一键启动（推荐）**：双击项目根目录的 `start.bat`。

脚本会依次检查 Node.js、缺少依赖时自动 `npm install`、启动 dev server，并在首页可访问后自动打开浏览器。如果 3000 端口已有服务在运行，则只打开浏览器，不会重复启动。

**手动启动**：

```powershell
npm install
npm run dev
```

然后访问 <http://localhost:3000>。

### 3. 停止服务

关闭运行 dev server 的终端窗口即可。电脑重启后服务不会保留，需要重新双击 `start.bat` 或执行 `npm run dev`。

### 4. 开机自启（可选）

如果你经常隔天再打开项目、每次都遇到 `ERR_CONNECTION_REFUSED`，可以让服务在登录 Windows 后自动在后台运行：

1. `Win + R` 输入 `shell:startup` 回车，打开启动目录
2. 在启动目录新建快捷方式，目标填：

   ```
   cmd /c "e:\content-agent-board\start.bat" --no-browser
   ```

3. 右键快捷方式 →「属性」→「运行方式」选「最小化」，「起始位置」填项目目录

`--no-browser` 表示只启动服务、不自动打开浏览器，避免每次登录都弹窗。若 3000 端口已有服务在运行，脚本会直接退出，不会启动第二个实例。删除该快捷方式即可取消自启。

> 第 2 步的路径请按实际 clone 位置调整。
