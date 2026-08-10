/**
 * src/engine/interview/questionBank.ts
 * 面试题库与选题引擎（模块 B · 设计 §5.3 / §7 通道①）。
 *
 * 「对话式收敛」的题库设计原则（三阶段递进，熵逐级下降）：
 *   P1_understanding —— 先让 agent 复述/澄清需求，把用户脑中的模糊目标逼成显式边界；
 *   P2_craft_probe   —— 按工种下探 craft 维，把「会不会」变成「怎么做、做到什么程度」；
 *   P3_pressure      —— 加约束（工期/成本/冲突），把「理想答案」压成「真实取舍」。
 *
 * ★ 数据流通道①（市场能力标签 → 面试评估维度）在 `selectQuestions` 落地：
 *   marketplaceStore.taskProfile.dimBoost（任务画像的维度强调系数）
 *   → boostedDims() 取出被强调的通用六维
 *   → ① P2/P3 选题按「与强调维的交集权重」降序排序（考查重心跟着任务走）
 *   → ② P1 题的 targetDims 追加强调维（保证强调维从第一轮起就在被观测）
 *
 * 本文件全部为纯函数、无副作用（不读 store / 不发网络），可直接单测。
 */
import type { CraftDim, JobType, RadarDim } from '@/types/evaluation';
import type { InterviewPhase, InterviewQuestion } from '@/types/interview';

/** 阶段顺序（选题与展示的唯一真相） */
export const PHASE_ORDER: InterviewPhase[] = [
  'P1_understanding',
  'P2_craft_probe',
  'P3_pressure',
];

/** 阶段中文标签 */
export const PHASE_LABELS: Record<InterviewPhase, string> = {
  P1_understanding: 'P1 理解与澄清',
  P2_craft_probe: 'P2 手艺探针',
  P3_pressure: 'P3 压力与取舍',
};

/** 阶段收敛意图（UI 提示语，解释「这一阶段在收敛什么」） */
export const PHASE_HINTS: Record<InterviewPhase, string> = {
  P1_understanding: '把模糊需求逼成显式边界：复述、澄清、暴露假设。',
  P2_craft_probe: '按工种下探真实手艺：方法、标准、失败处理。',
  P3_pressure: '加约束看取舍：工期、成本、冲突下的工程判断。',
};

/** 题干中的任务占位符 */
export const TASK_PLACEHOLDER = '{{需求}}';

/** 每阶段默认取题数（可由调用方覆盖） */
export const DEFAULT_PER_PHASE: Record<InterviewPhase, number> = {
  P1_understanding: 2,
  P2_craft_probe: 3,
  P3_pressure: 2,
};

/* ===================== 题库正文（确定性数据，顺序即默认优先级） ===================== */

/** P1 · 理解与澄清（三工种通用） */
const P1_QUESTIONS: InterviewQuestion[] = [
  {
    qId: 'p1_restate',
    phase: 'P1_understanding',
    jobType: 'any',
    prompt: `请先用你自己的话复述这个任务：${TASK_PLACEHOLDER}。说明你理解的交付物是什么、验收标准是什么，以及哪些地方我还没说清楚。`,
    targetDims: ['task', 'comm'],
    followups: [
      '你复述里没有提到验收标准，请补一条你认为最硬的验收线。',
      '「我没说清楚的地方」请具体到字段/格式/边界，不要泛泛而谈。',
    ],
  },
  {
    qId: 'p1_clarify3',
    phase: 'P1_understanding',
    jobType: 'any',
    prompt:
      '如果只允许你问我 3 个问题来消除歧义，你会问哪 3 个？请说明为什么这 3 个问题的信息量最大。',
    targetDims: ['comm', 'task'],
    followups: [
      '这 3 个问题里哪一个答错代价最大？为什么？',
      '如果我全部回答「随你」，你会怎么办？',
    ],
  },
  {
    qId: 'p1_assumption',
    phase: 'P1_understanding',
    jobType: 'any',
    prompt:
      '在信息不足时你会先建立哪些默认假设？请逐条列出，并说明每条假设一旦错了会造成什么后果。',
    targetDims: ['task', 'reliability'],
    followups: ['你会在什么时间点回来跟我确认这些假设？', '哪条假设你最没把握？'],
  },
];

/** P2 · 手艺探针（image） */
const P2_IMAGE_QUESTIONS: InterviewQuestion[] = [
  {
    qId: 'p2_img_composition',
    phase: 'P2_craft_probe',
    jobType: 'image',
    prompt: `针对「${TASK_PLACEHOLDER}」，请描述你的构图方案：主体位置、视觉重心、留白比例、视线引导线分别怎么安排？`,
    targetDims: ['img_composition', 'creativity'],
    followups: ['如果画幅从 16:9 换成 9:16，你的构图怎么改？'],
  },
  {
    qId: 'p2_img_style_fit',
    phase: 'P2_craft_probe',
    jobType: 'image',
    prompt:
      '客户说要「高级感但不冷淡」。请把这句模糊描述拆成可执行的风格参数：色板、材质、光线、参考坐标。',
    targetDims: ['img_style_fit', 'quality'],
    followups: ['给我两个你会拒绝的参考方向，并说明拒绝理由。'],
  },
  {
    qId: 'p2_img_fidelity',
    phase: 'P2_craft_probe',
    jobType: 'image',
    prompt:
      '出图出现多指、文字乱码、结构崩坏时，你的排查与修复顺序是什么？哪些问题你会选择重生成而不是修图？',
    targetDims: ['img_fidelity', 'reliability'],
    followups: ['你怎么判断一张图「已经救不回来了」？'],
  },
  {
    qId: 'p2_img_consistency',
    phase: 'P2_craft_probe',
    jobType: 'image',
    prompt:
      '一个系列 8 张图要保持同一审美，你用什么手段保证一致性？如何验收「像同一个人做的」？',
    targetDims: ['img_aesthetic_consistency', 'quality'],
    followups: ['如果第 6 张明显跑偏，你怎么定位是哪个环节漂移？'],
  },
  {
    qId: 'p2_img_multimodal',
    phase: 'P2_craft_probe',
    jobType: 'image',
    prompt:
      '我同时给你一张参考图和一段文字描述，两者冲突时以谁为准？请给出你的判定规则和例外情况。',
    targetDims: ['img_multimodal_follow', 'task'],
    followups: ['举一个「必须以文字为准」的例子。'],
  },
];

/** P2 · 手艺探针（text） */
const P2_TEXT_QUESTIONS: InterviewQuestion[] = [
  {
    qId: 'p2_txt_factuality',
    phase: 'P2_craft_probe',
    jobType: 'text',
    prompt:
      '写行业稿时遇到无法核实的数字，你怎么处理？请给出你的事实核查流程和不确定信息的表述方式。',
    targetDims: ['txt_factuality', 'reliability'],
    followups: ['如果我要求你「就按这个数字写」，你会怎么回应？'],
  },
  {
    qId: 'p2_txt_coherence',
    phase: 'P2_craft_probe',
    jobType: 'text',
    prompt: `针对「${TASK_PLACEHOLDER}」，给你 3000 字素材要压成 800 字，你如何组织结构才能保证逻辑不断裂？`,
    targetDims: ['txt_coherence', 'quality'],
    followups: ['你删掉的那 2200 字，判断标准是什么？'],
  },
  {
    qId: 'p2_txt_tone_fit',
    phase: 'P2_craft_probe',
    jobType: 'text',
    prompt:
      '同一条产品公告，面向开发者和面向投资人，你会怎么改写语气、信息密度和举例方式？请各给一句开头。',
    targetDims: ['txt_tone_fit', 'comm'],
    followups: ['你怎么判断语气「过了」？'],
  },
  {
    qId: 'p2_txt_density',
    phase: 'P2_craft_probe',
    jobType: 'text',
    prompt: '你如何判断一段文案「废话多」？请给出可操作的删减标准，最好能量化。',
    targetDims: ['txt_info_density', 'comm'],
    followups: ['哪种「废话」你会刻意保留？为什么？'],
  },
  {
    qId: 'p2_txt_instruction',
    phase: 'P2_craft_probe',
    jobType: 'text',
    prompt:
      '如果需求里同时要求「口语化」和「专业严谨」，你怎么取舍？会不会回来问我，还是自己拍板？',
    targetDims: ['txt_instruction_follow', 'task'],
    followups: ['你拍板的边界在哪里？什么情况下必须问我？'],
  },
];

/** P2 · 手艺探针（code） */
const P2_CODE_QUESTIONS: InterviewQuestion[] = [
  {
    qId: 'p2_code_runnability',
    phase: 'P2_craft_probe',
    jobType: 'code',
    prompt: `拿到「${TASK_PLACEHOLDER}」这个需求后，你交付前会跑哪些验证，才敢跟我说「这段代码能跑」？`,
    targetDims: ['code_runnability', 'task'],
    followups: ['如果本地跑得通、线上跑不通，你的第一步是什么？'],
  },
  {
    qId: 'p2_code_efficiency',
    phase: 'P2_craft_probe',
    jobType: 'code',
    prompt:
      '一个接口 p99 从 200ms 劣化到 2s，你的定位路径是什么？前三步分别做什么、看什么指标？',
    targetDims: ['code_efficiency', 'cost'],
    followups: ['如果指标都正常但用户仍说慢，你怎么办？'],
  },
  {
    qId: 'p2_code_tests',
    phase: 'P2_craft_probe',
    jobType: 'code',
    prompt:
      '你会为这个需求写哪几类测试？哪些分支你一定要覆盖，哪些你会主动放弃并说明理由？',
    targetDims: ['code_test_coverage', 'reliability'],
    followups: ['「主动放弃」的那部分，你会怎么跟我交代风险？'],
  },
  {
    qId: 'p2_code_maintainability',
    phase: 'P2_craft_probe',
    jobType: 'code',
    prompt:
      '你怎么划分模块边界？请举一个你会拒绝的「为复用而抽象」的例子，并说明拒绝理由。',
    targetDims: ['code_maintainability', 'quality'],
    followups: ['你怎么判断一个抽象是「过早抽象」？'],
  },
  {
    qId: 'p2_code_security',
    phase: 'P2_craft_probe',
    jobType: 'code',
    prompt:
      '这个功能如果直接暴露到公网，你会重点防哪三类风险？分别怎么防、怎么验证防住了？',
    targetDims: ['code_security', 'reliability'],
    followups: ['你会把密钥放在哪里？为什么不是环境变量之外的其他地方？'],
  },
];

/** P3 · 压力与取舍（三工种通用） */
const P3_QUESTIONS: InterviewQuestion[] = [
  {
    qId: 'p3_deadline',
    phase: 'P3_pressure',
    jobType: 'any',
    prompt:
      '需求不变但工期砍半，你会砍掉什么、保留什么？请给出你的取舍原则，而不只是结论。',
    targetDims: ['reliability', 'task', 'cost'],
    followups: ['被砍掉的部分你怎么向我交代？', '如果我不同意你的取舍呢？'],
  },
  {
    qId: 'p3_failure',
    phase: 'P3_pressure',
    jobType: 'any',
    prompt:
      '讲一次你做错的判断：当时的错误认知是什么，你是怎么发现的，最后怎么纠正的？',
    targetDims: ['reliability', 'comm'],
    followups: ['这件事之后你改了哪条工作习惯？'],
  },
  {
    qId: 'p3_cost',
    phase: 'P3_pressure',
    jobType: 'any',
    prompt:
      '如果每一次调用都在花我的钱，你会如何降低单位交付成本而不牺牲质量？请给出可执行的两条。',
    targetDims: ['cost', 'quality'],
    followups: ['这两条会带来什么副作用？'],
  },
  {
    qId: 'p3_disagree',
    phase: 'P3_pressure',
    jobType: 'any',
    prompt:
      '我坚持一个你认为明显错误的方案，你会怎么处理？请说清楚你会争取到什么程度、什么时候执行。',
    targetDims: ['comm', 'reliability'],
    followups: ['如果时间不允许充分讨论呢？'],
  },
];

/** 全量题库（只读；按 P1 → P2(image/text/code) → P3 排列） */
export const QUESTION_BANK: InterviewQuestion[] = [
  ...P1_QUESTIONS,
  ...P2_IMAGE_QUESTIONS,
  ...P2_TEXT_QUESTIONS,
  ...P2_CODE_QUESTIONS,
  ...P3_QUESTIONS,
];

/* ===================== 选题引擎（纯函数） ===================== */

/** 选题入参 */
export interface QuestionSelectOptions {
  /** 工种（null = 不限，退化为通用题 + code 探针） */
  jobType: JobType | null;
  /** 通道①：任务画像的维度强调系数（缺省视为 1） */
  dimBoost?: Partial<Record<RadarDim, number>>;
  /** 需求标签（用于题干占位符渲染） */
  tags?: string[];
  /** 每阶段取题数（覆盖 DEFAULT_PER_PHASE） */
  perPhase?: Partial<Record<InterviewPhase, number>>;
}

/** 取出被任务画像「强调」的通用六维（降序），阈值默认 1.05 */
export function boostedDims(
  dimBoost: Partial<Record<RadarDim, number>> | undefined,
  threshold = 1.05,
): RadarDim[] {
  if (!dimBoost) return [];
  return (Object.entries(dimBoost) as Array<[RadarDim, number | undefined]>)
    .filter(([, v]) => typeof v === 'number' && v >= threshold)
    .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
    .map(([dim]) => dim);
}

/** 某题与「强调维」的匹配权重（交集维的 boost 之和；无交集为 0） */
export function questionBoostWeight(
  question: InterviewQuestion,
  dimBoost: Partial<Record<RadarDim, number>> | undefined,
): number {
  if (!dimBoost) return 0;
  let sum = 0;
  for (const dim of question.targetDims) {
    const value = (dimBoost as Record<string, number | undefined>)[dim];
    if (typeof value === 'number' && value > 1) sum += value - 1;
  }
  return sum;
}

/** 该阶段、该工种可用的题池（'any' 题恒可用） */
export function questionsOf(
  phase: InterviewPhase,
  jobType: JobType | null,
): InterviewQuestion[] {
  const effective: JobType = jobType ?? 'code';
  return QUESTION_BANK.filter(
    (q) => q.phase === phase && (q.jobType === 'any' || q.jobType === effective),
  );
}

/**
 * 生成本场面试的题序（通道①落地点）。
 *
 * 排序策略：先按「与任务强调维的匹配权重」降序（稳定排序，权重相同保持题库顺序），
 * 再按阶段顺序拼接；P1 题的 targetDims 追加强调维，保证任务重心从第一轮起被观测。
 */
export function selectQuestions(opts: QuestionSelectOptions): InterviewQuestion[] {
  const { jobType, dimBoost, perPhase } = opts;
  const boosted = boostedDims(dimBoost);
  const plan: InterviewQuestion[] = [];

  for (const phase of PHASE_ORDER) {
    const limit = perPhase?.[phase] ?? DEFAULT_PER_PHASE[phase];
    if (limit <= 0) continue;

    const pool = questionsOf(phase, jobType);
    // 稳定排序：附带原始下标做次级比较键
    const ranked = pool
      .map((q, index) => ({ q, index, weight: questionBoostWeight(q, dimBoost) }))
      .sort((a, b) => (b.weight - a.weight) || (a.index - b.index))
      .slice(0, limit)
      .map((item) => item.q);

    for (const q of ranked) {
      // 通道①：P1 阶段把任务强调维并入考查维度（去重）
      const targetDims =
        phase === 'P1_understanding' && boosted.length > 0
          ? mergeDims(q.targetDims, boosted)
          : [...q.targetDims];
      plan.push({ ...q, targetDims });
    }
  }

  return plan;
}

/** 合并维度并去重（保持先后顺序） */
export function mergeDims(
  base: (RadarDim | CraftDim)[],
  extra: (RadarDim | CraftDim)[],
): (RadarDim | CraftDim)[] {
  const out: (RadarDim | CraftDim)[] = [...base];
  for (const dim of extra) {
    if (!out.includes(dim)) out.push(dim);
  }
  return out;
}

/** 题序中下一道未问的题（全部问完返回 null） */
export function nextQuestion(
  plan: InterviewQuestion[],
  askedQIds: string[],
): InterviewQuestion | null {
  const asked = new Set(askedQIds);
  for (const q of plan) {
    if (!asked.has(q.qId)) return q;
  }
  return null;
}

/**
 * 无任务需求时的通用题干替换表（qId → 不依赖具体任务的问法）。
 *
 * 只填 tags 不足以支撑「复述这个任务」这类题：占位符会退化成「本次任务」，
 * 题干变成「请复述这个任务：本次任务」——用户看不懂在问什么，agent 也没得复述。
 * 故对依赖任务上下文最强的题，缺需求时整题换成自陈式问法（考查维度不变）。
 */
const GENERIC_PROMPTS: Record<string, string> = {
  p1_restate:
    '还没有具体任务，先请你自我介绍：你最擅长交付什么类型的成果？你判断一次交付「算合格」的标准是什么？开工前你通常需要对方先说清哪些信息？',
  p2_img_composition:
    '请以你最近一次满意的作品为例，说明你的构图方案：主体位置、视觉重心、留白比例、视线引导线分别怎么安排？',
  p2_code_runnability:
    '你交付一段代码前会跑哪些验证，才敢说「这段代码能跑」？请按你实际的检查顺序说。',
  p2_txt_coherence:
    '给你 3000 字素材要压成 800 字，你如何组织结构才能保证逻辑不断裂？',
};

/**
 * 渲染题干占位符。
 *
 * 有需求文本 → 直接代入；只有标签 → 代入标签；两者皆无 → 若该题有通用问法则整题替换，
 * 否则退化为「本次任务」（保持原行为）。
 */
export function renderPrompt(
  prompt: string,
  ctx: { taskText?: string; tags?: string[]; qId?: string } = {},
): string {
  const text = (ctx.taskText ?? '').trim();
  const tags = (ctx.tags ?? []).filter(Boolean);

  if (text.length === 0 && tags.length === 0 && ctx.qId) {
    const generic = GENERIC_PROMPTS[ctx.qId];
    if (generic) return generic;
  }

  const fallback = tags.length > 0 ? tags.join('、') : '本次任务';
  return prompt.split(TASK_PLACEHOLDER).join(text.length > 0 ? text : fallback);
}

/** 题序覆盖到的全部考查维度（去重，dimTracker 的输入） */
export function planTargetDims(plan: InterviewQuestion[]): (RadarDim | CraftDim)[] {
  const out: (RadarDim | CraftDim)[] = [];
  for (const q of plan) {
    for (const dim of q.targetDims) {
      if (!out.includes(dim)) out.push(dim);
    }
  }
  return out;
}

/** 构造一道追问题（qId 追加 `:fu{n}` 后缀，供 dimTracker 统计 followupCount） */
export function makeFollowupQuestion(
  base: InterviewQuestion,
  prompt: string,
  index = 1,
): InterviewQuestion {
  return {
    qId: `${base.qId}:fu${index}`,
    phase: base.phase,
    jobType: base.jobType,
    prompt,
    targetDims: [...base.targetDims],
  };
}
