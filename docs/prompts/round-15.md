# Round 15：整批项目库

## 我的提问

阶段 11 做了卡片成品库后，我想再做一个「收藏整个项目」：把一次流水线的四个产出连同选题、提纲一起存成一个整体。

## AI 的评审意见

提了三个关键点：

1. 和卡片成品库不要混在一个表里。容量差 4 倍（200 vs 50）、展示粒度不同、淘汰语义不同，混排会让排序与空态都出现两套分支。
2. 正文与提纲必须继续只从服务端快照取，不能信任前端传的整批 JSON。
3. 入口放「执行监视」标题行右侧，只在四路全部完成时可用；面板里用 tab 切换卡片/项目。

## 我的确认与决策过程

三点都同意。分库的核心原因不是「文件拆两个」，而是避免在同一个列表里维护两套排序与容量规则——那种代码半年后一定出 bug。容量定 50 是因为一条项目含长文全文，体积是卡片的 4 倍以上，200 条会把 `data/` 撑得很大。

## 实现

- `lib/project-model.ts`：`ProjectItem`、`ProjectChannel`、`PROJECT_MAX_ITEMS = 50`、渠道名映射。
- `lib/project-storage.ts`：`data/projects.json` 读写，按 `runId` 幂等 upsert，超出 50 淘汰最旧。
- `app/api/projects/route.ts`：GET 列表；POST 校验四路全部完成且正文/配图非空，从快照取正文与提纲。
- `app/api/projects/[id]/route.ts`：DELETE，不存在返回 404。
- `app/page.tsx`：「收藏整个项目」按钮、面板 tab、项目列表（选题 + 保存时间 + 四路预览 + 下载全套/移除）。
- `docs/architecture.md`：新增「项目库」章节、关键决策第 15 条、模块职责 5 行。
- `.gitignore`：加 `data/projects.json`。

## 验证

浏览器实测（复用已完成的历史 run）：

1. 「执行监视」右侧出现「收藏整个项目」按钮，四路完成时未禁用。
2. 点击 → 提示「已收藏整个项目到项目库」，面板自动切到项目 tab，项目数 1，头部总数变为卡片+项目合计。
3. 项目条目展示四路预览（公众号长文 / 短视频脚本 / 小红书笔记 / 配图），每行带风格名。
4. 再次点击同一按钮 → 提示「已更新项目库里的这批产出」，数量不变，幂等成立。
5. 点「移除」→ 出现「还没有收藏的项目」空态，列表清零。
6. API：`GET /api/projects` 返回 1 条且 channels 含 longform/script/xhs/image；`POST {runId: "not-exist"}` 返回 404。
7. `npx tsc --noEmit` 通过；`npm run lint` 仍为 4 条既有问题。

## 反思

这次实现有一个小坑：`RunSnapshot` 没有 `outline` 字段，只有 `outlineVersions` + `outlineVersionId`。写 `saveProject` 时第一版直接取 `snapshot.outline`，tsc 报错。要取当前激活提纲得自己按 `outlineVersionId` 从版本链里找，找不到就用最后一个——和 `resumeRun` 里的逻辑一致。这种「快照只留版本链、当前版本要自己推导」的模式应该在 `orchestrator.ts` 里抽个 `getActiveOutline(snapshot)` 工具函数，避免每个消费方都重写一遍找版本的逻辑，下一轮可以顺手收掉。
