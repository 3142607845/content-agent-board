# Round 17：提纲编辑的本地撤销 / 重做

## 我的提问

阶段 13（批量横向对比）收口后，按 `docs/architecture.md` 候选表做 P2：编辑态撤销。改提纲只有两条退路——手动改回，或点版本 chip 重新载入，后者会把本次所有未提交修改一次性丢掉。

## 我的确认与约束

按方案实现，同时明确五条硬约束：

1. 只记提纲表单字段改动，纯前端本地，不存正文、不上后端；
2. `useRef` 数组存历史，上限 20 条；
3. `blur` 失焦才记录变更；
4. 快捷键 `Ctrl+Z` / `Cmd+Z`、`Ctrl+Shift+Z`；界面加撤销/重做按钮，无历史置灰；
5. 切换版本、提交、切 tab 清空历史栈，防止串上下文。

## 实现

全部在 `app/page.tsx`：

- 模块级常量 `OUTLINE_HISTORY_LIMIT = 20`。
- `outlineHistory = useRef({ entries: string[], index: number })` 存栈数据，`outlineHistoryState = { canUndo, canRedo }` 用 state 驱动按钮。
- `syncOutlineHistory` / `seedOutlineHistory` / `clearOutlineHistory` / `recordOutlineHistory` / `undoOutline` / `redoOutline` 全部用 `useCallback` 包裹，依赖只到 `syncOutlineHistory`，保证快捷键 effect 的依赖稳定。
- 文本域加 `onBlur={() => recordOutlineHistory(outlineDraft)}`。
- 操作区在提交按钮后补「撤销 / 重做」两个按钮，`disabled` 由 `canUndo / canRedo` 与 `outlineBusy` 决定。
- `beginOutlineEdit` 里 `seedOutlineHistory(text)`：用当前版本内容做栈底。
- `cancelOutlineEdit` / `resetOutlineEditor` / 提交成功分支 / 任务 tab 点击 都调用 `clearOutlineHistory()`。

## 验证

静态检查：`npx tsc --noEmit` 通过；`npm run lint` 仍为 4 条既有问题（`react-hooks/set-state-in-effect`，均在本轮之前），没有新增。

代码走读确认的路径：

1. 打开编辑 → 只有栈底 1 条，「撤销」「重做」均置灰。
2. 改字段 → 失焦（点提交按钮或点空白）时入栈一次，`canUndo` 转 true。
3. 连改 3 次 → 点 3 次撤销逐级回退到初始内容，第 4 次点击仍置灰。
4. 撤销后点重做 → 逐级恢复；撤销后再编辑 → 未来分支被截断，重做置灰。
5. 点版本 chip → 用该版本重新做栈底，撤销立即置灰。
6. 提交成功 → 编辑器关闭，再进入编辑时撤销为重灰状态。
7. 批量模式切 tab → 历史栈清空。
8. 栈超过 20 条 → 丢最早的一条，`index` 始终指向栈顶。

## 反思

两个取舍值得记下来：

1. **焦点在文本域内不接管 `Ctrl+Z`**。用户要求了快捷键，但如果连文本域内也接管，按一次 Ctrl+Z 会退掉整段修改，而用户的预期通常是「退一个字符」。所以只在焦点离开编辑区时才走历史栈，文本域内交给浏览器原生撤销。这个行为写进了按钮的 `title`，避免用户以为是 bug。
2. **按 `blur` 记录而不是 `onChange`**。`onChange` 会让栈里塞满几十条中间态，20 条上限几秒就用完，撤销变成逐字符回退。`blur` 一次记一段，正好对应「改完一段想反悔」的动作。

另外，栈数据放 `useRef` 而按钮态放 `state` 是刻意的：输入过程中不因为历史变化触发重渲染，只有 `blur` 那一刻才同步一次按钮状态。
