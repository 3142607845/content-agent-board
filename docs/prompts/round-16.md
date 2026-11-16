# Round 16：批量结果横向对比

## 我的提问

阶段 12 做完后，下一轮按 `docs/architecture.md` 的候选顺序做 P1：批量结果横向对比。当前批量/多版模式只能用 tab 逐个看任务，比较两个选题或两个版本得来回切。

## AI 的评审意见 + 我的补充建议

AI 给的方案是：批量 tab 旁加「横向对比」开关，开启后用表格（行=渠道，列=任务）替换单任务卡片网格，纯前端读 `tasks[].nodes`，不新增接口。

我补充了三条交互：
1. 截断文字 hover 悬浮预览全文；
2. 列多时横向滚动；
3. 点击单元格直接跳转到对应任务 tab 看完整内容。

## 我的确认与决策过程

同意纯前端方案——四路正文已经在 `tasks[].nodes` 里，再做后端接口是多此一举。三条补充都接受：hover 预览用 `group-hover` 的绝对定位浮层（`pointer-events: none`，不挡点击）；横向滚动靠外层 `overflow-x-auto` + 每列 `min-width: 14rem`；单元格用 `role="button"`，内部复制/下载按钮 `stopPropagation`，点击空白处触发跳转。

## 实现

`app/page.tsx` 单点改动：

- 新增 `compareView` state。
- 批量 tab 行右侧加「横向对比」按钮（`tasks.length >= 2` 才出现，toggle 高亮）。
- 卡片网格用 `{compareView ? <table/> : <node-grid/>}` 包裹，互斥渲染。
- 表格：行 = 4 个内容渠道，列 = 全部任务；列头是选题+变体+label，可点击跳转。
- 文本格：`line-clamp-2` 截断 + hover 全文浮层 + 复制/下载；配图格：缩略图 + 查看原图；未完成显示「未完成」。
- 点击单元格或列头：`setActiveTaskIndex(idx)` + `setCompareView(false)`。

## 验证

真模型批量跑了 2 个选题（午睡、远程办公）：

1. 两个任务完成后，批量 tab 行右侧出现「横向对比」按钮。
2. 点击 → 卡片网格被表格替换：4 行（渠道）× 3 列（渠道名 + 2 个任务），12 个单元格。
3. 文本格有 hover 浮层（6 个 = 3 文本渠道 × 2 任务），配图格有缩略图。
4. 点击某个单元格 → 退出对比视图，回到对应任务的卡片网格，选中任务正确切换。
5. 点格内「复制」按钮 → 停留在对比视图，没有触发跳转（stopPropagation 生效）。
6. 未完成的格子显示「未完成」。
7. `npx tsc --noEmit` 通过；`npm run lint` 仍为 4 条既有问题（给 `<img>` 加了 `eslint-disable-next-line`，没引入新告警）。

## 反思

实现时踩到两个小坑：

1. 代码库里没有 `VARIANT_META`，只有 `VARIANTS` 数组。第一版写 `VARIANT_META[t.variant].name` 直接 tsc 报错，改成 `VARIANTS.find(v => v.key === t.variant)?.name`。
2. 对比图用原生 `<img>` 触发了 `@next/next/no-img-element` 告警，跟现有卡片一致加 `// eslint-disable-next-line` 即可，没必要为对比视图单独引入 `next/image`（远程 URL 还要配 loader，收益不大）。

另外，单元格用 `role="button"` + 键盘事件（Enter/Space）模拟跳转，避免「button 套 button」的非法嵌套——这个模式在页面里已经有先例（历史行），复用即可。

## 实测后的可发现性修正

用户实际验收时找不到「横向对比」，连续两次截图都反馈「没有你说的按钮」。排查后发现是设计问题，不是渲染 bug：

- 按钮原本的条件是 `tasks.length >= 2` 才渲染，任务不足两个时**直接消失**；
- 用户在单次模式看、在批量模式只输入一个选题时看，都看不到任何提示。

改成「始终渲染 + 不足两个时置灰」，并补两处提示：

1. 批量/多版模式下 tab 行不再随 `tasks.length > 0` 一起消失；
2. `tasks.length < 2` 时按钮 `disabled`、降透明度，`title` 写明「至少需要 2 个任务才能对比，请在上方输入多行选题后开始生成」；
3. 任务为空时左侧显示「输入多行选题并开始生成后，这里会出现任务切换」。

结论：功能存在但不可发现的入口，等价于功能不存在。以后新增只有特定状态才出现的控件，默认走「置灰 + 说明原因」而不是「隐藏」。
