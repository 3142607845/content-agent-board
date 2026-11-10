/**
 * 多版生成的三个固定创作维度
 *
 * 多版模式不是「同一选题跑三次」，而是定向生成三种结构不同的提纲。
 * 差异化必须落到结构骨架上，只换形容词没有意义 —— 模型仍然会给出三份相似内容。
 *
 * 本文件只放纯数据，前后端共用：前端取 name 做 tab 标签，后端取 promptBlock 注入策划 Agent。
 */

export type VariantKey = "analysis" | "story" | "beginner";

export interface VariantSpec {
  key: VariantKey;
  /** tab 上展示的名字 */
  name: string;
  /** 一句话定位，用于界面说明 */
  angle: string;
  /** 注入策划 Agent 的结构约束 */
  promptBlock: string;
}

export const VARIANTS: VariantSpec[] = [
  {
    key: "analysis",
    name: "深度分析版",
    angle: "靠逻辑与证据说服，结构严谨",
    promptBlock: `本次必须生成【深度分析版】提纲，结构骨架必须完整体现在字段里，不得写成通用提纲。

定位：论证型内容，靠逻辑推理和事实证据说服读者，不靠情绪。
公众号长文 structure 必须按此推进：
  1) 用具体现象或数据切入，指出这个现象背后的矛盾
  2) 拆出 2-3 个核心论点，每个论点都要配可验证的论据（数据、案例、对比）
  3) 明确写出一个反面观点，并给出回应
  4) 收束成结论，并给读者可执行的建议
短视频脚本 shots 必须：先抛出一个反直觉的问题制造张力，再层层递进拆解，最后给出明确判断。
小红书 angle 必须：结论前置，正文用分点干货，不写感悟和抒情。
配图 prompts 必须：偏理性、有对比或数据感，避免抽象装饰。`,
  },
  {
    key: "story",
    name: "故事化叙述版",
    angle: "靠具体人物与冲突代入，情绪推进",
    promptBlock: `本次必须生成【故事化叙述版】提纲，结构骨架必须完整体现在字段里，不得写成通用提纲。

定位：叙事型内容，靠一个具体的人物和事件把读者带进去，观点藏在故事后面。
公众号长文 structure 必须按此推进：
  1) 开篇直接落到一个具体的人、具体的时间、具体的场景（有姓名感的角色，不要用「很多人」）
  2) 写清他遇到的冲突或困境，要有细节和对话感
  3) 写他做出改变的过程，以及过程中的犹豫和代价
  4) 最后才点出观点，且观点要短
短视频脚本 shots 必须：前 3 秒给冲突钩子，中段呈现人物困境，中后段给转折，结尾一句话落点。
小红书 angle 必须：第一人称经历叙述，写情绪和真实感受，用口语，不写条目式干干货。
配图 prompts 必须：画面里要有明确的主角、动作和场景，有情绪氛围，避免纯概念图。`,
  },
  {
    key: "beginner",
    name: "科普入门版",
    angle: "零基础视角，用类比降低门槛",
    promptBlock: `本次必须生成【科普入门版】提纲，结构骨架必须完整体现在字段里，不得写成通用提纲。

定位：面向完全不懂这个主题的小白，靠生活化类比和分步拆解降低理解门槛，全程不假设读者有背景知识。
公众号长文 structure 必须按此推进：
  1) 用一个日常生活场景做类比，先把陌生概念换成熟悉的东西
  2) 分步拆解，每一步只讲一个点，讲完再进下一步，不堆砌术语
  3) 列出 2-3 个新手最容易踩的误区，并说明为什么错
  4) 用一句话做总结，让读者能直接复述给别人听
短视频脚本 shots 必须：用一个类比贯穿全片，按步骤推进，结尾给避坑提醒。
小红书 angle 必须：新手视角，写「我一开始也以为…其实」，给清单式的入门要点。
配图 prompts 必须：画面干净、指向具体事物，像教学示意图那样一眼能看懂。`,
  },
];

export const VARIANT_KEYS: VariantKey[] = VARIANTS.map((v) => v.key);

export function isVariantKey(value: unknown): value is VariantKey {
  return typeof value === "string" && VARIANT_KEYS.includes(value as VariantKey);
}

export function getVariant(key: VariantKey | null | undefined): VariantSpec | undefined {
  return VARIANTS.find((v) => v.key === key);
}
