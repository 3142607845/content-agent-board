/**
 * 平台文风模板
 *
 * 公众号长文、短视频脚本、小红书笔记各有一套风格模板库。
 * 本文件只放纯数据与纯函数，前后端共用：
 * - 前端用它渲染模板管理面板与运行时下拉
 * - 后端用它取内置模板、校验用户输入、拼装注入 Agent 的风格块
 *
 * 模板内容只是 prompt 描述，不参与任何逻辑分支；
 * 真正的「文风、格式、排版、标签」约束全部写在 prompt 里，
 * 由 buildStyleBlock 追加到下游 Agent 的入参，与策划提纲共同决定产出。
 */

export type StyleChannel = "longform" | "script" | "xhs";

export interface StyleTemplate {
  id: string;
  channel: StyleChannel;
  name: string;
  /** 一句话定位，管理面板里展示 */
  summary: string;
  /** 文风 / 格式 / 排版 / 标签的完整描述 */
  prompt: string;
  /** 内置模板只读，可复制为自定义模板后再改 */
  builtin: boolean;
  createdAt: number;
  updatedAt: number;
}

/**
 * 注入 Agent 时用的最小字段。
 *
 * Run 里存的是快照而不是模板 id：模板后续被编辑或删除，
 * 已经跑完的历史任务仍然能还原当时用的是哪套文风、原文写了什么。
 */
export interface StyleSnapshot {
  id: string;
  name: string;
  prompt: string;
}

export interface StyleChannelSpec {
  key: StyleChannel;
  label: string;
  hint: string;
}

export const STYLE_CHANNELS: StyleChannelSpec[] = [
  { key: "longform", label: "公众号长文", hint: "文风、结构与排版" },
  { key: "script", label: "短视频脚本", hint: "口播语气、分镜与节奏" },
  { key: "xhs", label: "小红书笔记", hint: "标题、正文排版与话题标签" },
];

export const STYLE_NAME_MAX = 24;
export const STYLE_SUMMARY_MAX = 60;
export const STYLE_PROMPT_MAX = 2000;

export function isStyleChannel(value: unknown): value is StyleChannel {
  return STYLE_CHANNELS.some((ch) => ch.key === value);
}

export const BUILTIN_STYLES: StyleTemplate[] = [
  {
    id: "builtin-longform-deep",
    channel: "longform",
    name: "公众号深度干货风",
    summary: "观点先行、论据扎实，适合知识型长文",
    builtin: true,
    createdAt: 0,
    updatedAt: 0,
    prompt: `文风：冷静克制的专业作者口吻，结论先行，用事实、数据和案例说话。不使用「家人们」「绝了」这类网络语气词，不喊口号，不写个人抒情。
格式：开篇两到三句点明核心观点；正文分三到四个二级小标题（markdown 的 ##），每个小标题下先给判断、再给论据、最后给一句小结；结尾给读者一段可执行的建议。
排版：段落短，单段不超过四行；核心结论单独成段；重要概念用「」强调；全文加粗不超过八处；不使用表情符号。
标签：不需要话题标签，结尾用一句话收束全文。`,
  },
  {
    id: "builtin-longform-story",
    channel: "longform",
    name: "公众号故事叙事风",
    summary: "具体人物切入，情绪推进，观点藏在故事后面",
    builtin: true,
    createdAt: 0,
    updatedAt: 0,
    prompt: `文风：叙事型作者口吻，像在讲一个真实发生过的故事，克制但有温度。观点不直接抛，让读者跟着人物走完再自己得出结论。
格式：开篇直接落到一个具体的人、具体的时间、具体的场景，不用「很多人」「随着社会发展」这类空泛开头；中段写清人物遇到的冲突、犹豫和代价；转折之后才点观点，观点不超过三句。
排版：以叙述段落为主，单段不超过四行；关键对话和细节单独成段；小标题用 markdown 的 ##，标题偏口语、有画面感，不使用「一、二、三」式编号。
标签：不需要话题标签；结尾留一句有余味的话，不做总结陈词。`,
  },
  {
    id: "builtin-script-oral",
    channel: "script",
    name: "短视频口播风",
    summary: "第一人称直给，短句快节奏，可直接对着镜头念",
    builtin: true,
    createdAt: 0,
    updatedAt: 0,
    prompt: `文风：第一人称口播，像跟朋友面对面聊天。短句为主，不用书面语和长定语，不用「首先、其次、综上所述」。
格式：按分镜输出，每个分镜固定四行——镜头序号、画面描述、口播台词、时长（秒）；开头三秒必须给出钩子，直接抛结论或问题。
排版：一句台词一行，单句不超过二十字；需要强调的词用「」标出，方便直接念；每个信息点之间留一个换气停顿。
节奏：总时长控制在六十到九十秒，每五到八秒推进一个信息点，铺垫不超过两句话。
标签：结尾给一句引导互动的话，不需要话题标签。`,
  },
  {
    id: "builtin-script-conflict",
    channel: "script",
    name: "短视频冲突反转风",
    summary: "先制造对立，再反转落点，适合观点类选题",
    builtin: true,
    createdAt: 0,
    updatedAt: 0,
    prompt: `文风：有情绪的讲述者口吻，敢下判断，但不人身攻击。用对比和反问制造张力，最后给一个反直觉的落点。
格式：按分镜输出，每个分镜包含镜头序号、画面描述、台词/旁白、时长；前两个分镜必须建立冲突（两种做法、两种观点、两种结果的对立）。
排版：冲突双方的观点分行呈现，用「」标注；反转前留一句短停顿台词，例如「但问题没这么简单」。
节奏：总时长六十秒左右，前三秒抛出冲突，中段给证据或例子，最后八秒完成反转并给出判断。
标签：结尾一句话引导评论站队，不需要话题标签。`,
  },
  {
    id: "builtin-xhs-seeding",
    channel: "xhs",
    name: "小红书种草安利风",
    summary: "第一人称真实体验，情绪足、有 emoji、带话题标签",
    builtin: true,
    createdAt: 0,
    updatedAt: 0,
    prompt: `文风：第一人称真实体验，像跟闺蜜分享，口语化、有情绪起伏。可以使用「真的」「谁懂」「亲测」这类表达，但不夸张吹捧。
格式：第一行是标题，二十字以内，带一个具体吸引点；正文用短句分点，每点前加一个相关 emoji；结尾抛一个问题引导评论。
排版：每行不超过二十五字，段与段之间空一行；全文四百到六百字；emoji 总量控制在六到十个，不堆砌、不连续使用。
标签：结尾单独一行给三到六个话题标签，格式为 #标签，必须同时覆盖品类词、场景词和人群词。`,
  },
  {
    id: "builtin-xhs-checklist",
    channel: "xhs",
    name: "小红书干货清单风",
    summary: "清单体、强收纳，适合工具与经验类选题",
    builtin: true,
    createdAt: 0,
    updatedAt: 0,
    prompt: `文风：利落的分享者口吻，不寒暄、不抒情，直接给可复用的方法。句子短，信息密度高。
格式：第一行是标题，格式为「数字 + 主题 + 结果」，例如「5 个动作，让午睡不再越睡越困」；正文按清单分条，每条以序号开头，先给做法再给一句原因。
排版：每条不超过三行；条目之间空一行；不用大段 emoji，全篇 emoji 不超过三个；关键数字和结论加粗。
标签：结尾单独一行给三到六个话题标签，格式为 #标签，优先使用搜索量大的通用词（如 #干货分享 #效率提升）。`,
  },
];

/** 三个渠道的默认模板，前端首次加载时预选 */
export const DEFAULT_STYLE_BY_CHANNEL: Record<StyleChannel, string> = {
  longform: "builtin-longform-deep",
  script: "builtin-script-oral",
  xhs: "builtin-xhs-seeding",
};

export interface StyleInput {
  channel: StyleChannel;
  name: string;
  summary: string;
  prompt: string;
}

/** 校验并裁剪模板入参，接口层与存储层共用 */
export function normalizeStyleInput(
  raw: unknown,
): { ok: true; value: StyleInput } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "请求体格式不正确" };
  }
  const body = raw as Record<string, unknown>;

  if (!isStyleChannel(body.channel)) {
    return { ok: false, error: "未知的模板渠道" };
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return { ok: false, error: "模板名称不能为空" };
  if (name.length > STYLE_NAME_MAX) {
    return { ok: false, error: `模板名称不能超过 ${STYLE_NAME_MAX} 个字` };
  }

  const summary = typeof body.summary === "string" ? body.summary.trim() : "";
  if (summary.length > STYLE_SUMMARY_MAX) {
    return { ok: false, error: `一句话说明不能超过 ${STYLE_SUMMARY_MAX} 个字` };
  }

  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) return { ok: false, error: "模板内容不能为空" };
  if (prompt.length > STYLE_PROMPT_MAX) {
    return { ok: false, error: `模板内容不能超过 ${STYLE_PROMPT_MAX} 个字` };
  }

  return { ok: true, value: { channel: body.channel, name, summary, prompt } };
}

/** 拼到下游 Agent 入参末尾的风格块；明确优先级，避免与 Agent 默认要求各说各话 */
export function buildStyleBlock(style: StyleSnapshot): string {
  return `\n\n## 风格模板：${style.name}（优先级最高）

下面的模板由用户在运行前选定，描述本次任务要求的文风、格式、排版与标签。它与你的默认写作习惯、以及上面提纲里的渠道要求冲突时，一律以模板为准。

${style.prompt}`;
}
