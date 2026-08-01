import { CATEGORY_ORDER, TIER_ORDER } from "./content.js";

export type LocaleDict = Record<string, string>;

function itemNames(): { zh: LocaleDict; en: LocaleDict } {
  const zh: LocaleDict = {};
  const en: LocaleDict = {};
  let n = 1;
  for (const category of CATEGORY_ORDER) {
    for (const tier of TIER_ORDER) {
      const code = `A${String(n).padStart(2, "0")}`;
      zh[`item.syn.${category}.${tier}.name`] = `档案对象 ${code}`;
      en[`item.syn.${category}.${tier}.name`] = `Archive Object ${code}`;
      n++;
    }
  }
  return { zh, en };
}

const items = itemNames();

export const ZH_CN: LocaleDict = {
  ...items.zh,
  "app.title": "奇局",
  "app.tagline": "四席密封竞价：隔着有限情报为整包拍品估值。",
  "home.playVsAi": "对战 AI",
  "home.watchDemo": "观看 AI 演示",
  "home.seedOptional": "种子（可选，用于复现）",
  "home.language": "语言",
  "setup.title": "选择你的分析员与工具包",
  "setup.analyst": "分析员",
  "setup.toolPackage": "工具包",
  "setup.lock": "锁定选择",
  "setup.waitingOthers": "等待其他席位锁定……",
  "analyst.surveyor.name": "测绘员",
  "analyst.cataloger.name": "编目员",
  "analyst.statistician.name": "统计员",
  "analyst.appraiser.name": "估价师",
  "analyst.surveyor.desc": "拍卖开始：揭示 4 个随机未知对象的轮廓。",
  "analyst.cataloger.desc": "拍卖开始：揭示 3 个对象的类别；第 3 回合鉴定 1 个身份。",
  "analyst.statistician.desc": "拍卖开始：揭示 2 个随机品级的精确件数；第 4 回合揭示一个类别的平均价值。",
  "analyst.appraiser.desc": "拍卖开始：揭示 1 个对象的精确价值；第 2、4 回合各揭示 2 个新品级。",
  "kit.survey.name": "勘测包",
  "kit.catalog.name": "编目包",
  "kit.appraisal.name": "估价包",
  "kit.survey.shape-scan.name": "轮廓扫描",
  "kit.survey.category-scan.name": "类别扫描",
  "kit.catalog.tier-scan.name": "品级扫描",
  "kit.catalog.identify.name": "身份鉴定",
  "kit.appraisal.value-probe.name": "价值探针",
  "kit.appraisal.category-mean.name": "类别均值",
  "kit.survey.desc": "轮廓扫描 ×1、类别扫描 ×1。",
  "kit.catalog.desc": "品级扫描 ×1、身份鉴定 ×1。",
  "kit.appraisal.desc": "价值探针 ×1、类别均值 ×1。",
  "category.artifact": "器物",
  "category.geology": "地质",
  "category.mechanism": "机巧",
  "category.botany": "植物",
  "category.ephemera": "文献",
  "category.anomaly": "异常",
  "tier.documented": "登记",
  "tier.scarce": "稀见",
  "tier.exceptional": "珍罕",
  "tier.singular": "孤品",
  "table.round": "第 {round} 回合",
  "table.tiebreak": "加赛",
  "table.deadline": "剩余 {seconds} 秒",
  "table.yourBid": "你的报价",
  "table.submitBid": "提交报价",
  "table.lockBid": "锁定报价",
  "table.locked": "已锁定",
  "table.pass": "弃权（0）",
  "table.useTool": "使用工具",
  "table.waitingReveal": "等待其他席位锁定或截止……",
  "table.catalogRange": "目录范围",
  "table.candidates": "{count} 个候选",
  "table.valueRange": "{min} – {max}",
  "table.mean": "均值 {mean}",
  "table.seats": "席位",
  "table.you": "你",
  "table.history": "公开记录",
  "table.noHistory": "暂无公开记录。",
  "intel.public.title": "公开情报",
  "intel.private.title": "私人情报",
  "intel.field.tier": "品级",
  "intel.field.category": "类别",
  "intel.field.shape": "轮廓",
  "intel.field.identity": "身份",
  "intel.field.value": "价值",
  "intel.aggregate.count": "类别 {key} 共 {value} 件",
  "intel.aggregate.countTier": "品级 {key} 共 {value} 件",
  "intel.aggregate.mean": "类别 {key} 平均价值 {value}",
  "board.ariaLabel": "拍品网格",
  "board.cell.concealed": "未揭示格",
  "board.cell.revealed": "已揭示：{detail}",
  "board.unidentified": "未鉴定对象",
  "board.shapeOnly": "仅轮廓已知",
  "board.closeDetail": "关闭详情",
  "board.aggregates": "聚合情报",
  "reveal.title": "第 {round} 回合揭晓",
  "reveal.sold": "成交！{seat} 以 {amount} 取得拍品。",
  "reveal.continue": "未成交，进入下一回合。",
  "reveal.tiebreak": "最高价并列，进入加赛。",
  "reveal.noSale": "再次并列，流拍。",
  "result.title": "比赛结果",
  "result.buyer": "拍品取得者",
  "result.winningBid": "成交价",
  "result.actualValue": "真实价值",
  "result.noSale": "流拍：无人取得拍品。",
  "result.economic": "经济结果",
  "result.profit": "利润",
  "result.rank": "排名",
  "result.bonus": "过价奖励",
  "result.restart": "再来一局",
  "result.label.bargain": "捡漏",
  "result.label.fair": "合理成交",
  "result.label.overbid": "过价",
  "demo.pause": "暂停",
  "demo.resume": "继续",
  "demo.step": "单步",
  "demo.speed": "速度",
  "demo.seed": "种子",
  "demo.copySeed": "复制种子",
  "error.connection": "连接已断开。正在尝试重连……",
  "error.fatal": "比赛已不可用，请返回首页。",
  "error.backHome": "返回首页",
  "common.loading": "载入中……",
  "common.cancel": "取消",
};

export const EN: LocaleDict = {
  ...items.en,
  "app.title": "Qiju",
  "app.tagline": "A four-seat sealed-bid auction: value the lot through a veil of partial intel.",
  "home.playVsAi": "Play vs AI",
  "home.watchDemo": "Watch AI demo",
  "home.seedOptional": "Seed (optional, for reproduction)",
  "home.language": "Language",
  "setup.title": "Choose your analyst and tool package",
  "setup.analyst": "Analyst",
  "setup.toolPackage": "Tool package",
  "setup.lock": "Lock in",
  "setup.waitingOthers": "Waiting for other seats to lock in…",
  "analyst.surveyor.name": "Surveyor",
  "analyst.cataloger.name": "Cataloger",
  "analyst.statistician.name": "Statistician",
  "analyst.appraiser.name": "Appraiser",
  "analyst.surveyor.desc": "Auction start: reveal shapes of 4 random unknown slots.",
  "analyst.cataloger.desc": "Auction start: reveal 3 slot categories; round 3: identify 1 identity.",
  "analyst.statistician.desc": "Auction start: exact counts of 2 random tiers; round 4: mean value of one category.",
  "analyst.appraiser.desc": "Auction start: reveal 1 exact value; rounds 2 and 4: reveal 2 new tiers each.",
  "kit.survey.name": "Survey Kit",
  "kit.catalog.name": "Catalog Kit",
  "kit.appraisal.name": "Appraisal Kit",
  "kit.survey.shape-scan.name": "Shape Scan",
  "kit.survey.category-scan.name": "Category Scan",
  "kit.catalog.tier-scan.name": "Tier Scan",
  "kit.catalog.identify.name": "Identify",
  "kit.appraisal.value-probe.name": "Value Probe",
  "kit.appraisal.category-mean.name": "Category Mean",
  "kit.survey.desc": "Shape Scan ×1, Category Scan ×1.",
  "kit.catalog.desc": "Tier Scan ×1, Identify ×1.",
  "kit.appraisal.desc": "Value Probe ×1, Category Mean ×1.",
  "category.artifact": "Artifact",
  "category.geology": "Geology",
  "category.mechanism": "Mechanism",
  "category.botany": "Botany",
  "category.ephemera": "Ephemera",
  "category.anomaly": "Anomaly",
  "tier.documented": "Documented",
  "tier.scarce": "Scarce",
  "tier.exceptional": "Exceptional",
  "tier.singular": "Singular",
  "table.round": "Round {round}",
  "table.tiebreak": "Tiebreak",
  "table.deadline": "{seconds}s left",
  "table.yourBid": "Your bid",
  "table.submitBid": "Submit bid",
  "table.lockBid": "Lock bid",
  "table.locked": "Locked",
  "table.pass": "Pass (0)",
  "table.useTool": "Use tool",
  "table.waitingReveal": "Waiting for other seats or the deadline…",
  "table.catalogRange": "Catalog range",
  "table.candidates": "{count} candidates",
  "table.valueRange": "{min} – {max}",
  "table.mean": "mean {mean}",
  "table.seats": "Seats",
  "table.you": "You",
  "table.history": "Public history",
  "table.noHistory": "No public records yet.",
  "intel.public.title": "Public intel",
  "intel.private.title": "Private intel",
  "intel.field.tier": "tier",
  "intel.field.category": "category",
  "intel.field.shape": "shape",
  "intel.field.identity": "identity",
  "intel.field.value": "value",
  "intel.aggregate.count": "category {key}: {value} items",
  "intel.aggregate.countTier": "tier {key}: {value} items",
  "intel.aggregate.mean": "category {key} mean value {value}",
  "board.ariaLabel": "Lot board",
  "board.cell.concealed": "concealed cell",
  "board.cell.revealed": "revealed: {detail}",
  "board.unidentified": "unidentified object",
  "board.shapeOnly": "shape only",
  "board.closeDetail": "close detail",
  "board.aggregates": "aggregate intel",
  "reveal.title": "Round {round} reveal",
  "reveal.sold": "Sold! {seat} takes the lot at {amount}.",
  "reveal.continue": "No sale; next round.",
  "reveal.tiebreak": "Top bids tied; tiebreak round.",
  "reveal.noSale": "Tied again; the lot is not sold.",
  "result.title": "Match result",
  "result.buyer": "Lot acquired by",
  "result.winningBid": "Winning bid",
  "result.actualValue": "Actual value",
  "result.noSale": "No sale: nobody acquired the lot.",
  "result.economic": "Economic results",
  "result.profit": "Profit",
  "result.rank": "Rank",
  "result.bonus": "Overbid bonus",
  "result.restart": "Play again",
  "result.label.bargain": "Bargain",
  "result.label.fair": "Fair deal",
  "result.label.overbid": "Overbid",
  "demo.pause": "Pause",
  "demo.resume": "Resume",
  "demo.step": "Step",
  "demo.speed": "Speed",
  "demo.seed": "Seed",
  "demo.copySeed": "Copy seed",
  "error.connection": "Connection lost. Reconnecting…",
  "error.fatal": "This match is no longer available. Please return home.",
  "error.backHome": "Back to home",
  "common.loading": "Loading…",
  "common.cancel": "Cancel",
};

export function getLocale(locale: "zh-CN" | "en"): LocaleDict {
  return locale === "en" ? EN : ZH_CN;
}

export function validateLocales(): string[] {
  const problems: string[] = [];
  const zhKeys = new Set(Object.keys(ZH_CN));
  for (const key of Object.keys(EN)) {
    if (!zhKeys.has(key)) problems.push(`en-only key: ${key}`);
    if (EN[key] === "") problems.push(`empty en value: ${key}`);
  }
  for (const key of zhKeys) {
    if (!(key in EN)) problems.push(`zh-only key: ${key}`);
    if (ZH_CN[key] === "") problems.push(`empty zh value: ${key}`);
    const zhPlaceholders = placeholders(ZH_CN[key]!);
    const enPlaceholders = placeholders(EN[key] ?? "");
    if (zhPlaceholders.join("|") !== enPlaceholders.join("|")) {
      problems.push(`placeholder mismatch: ${key}`);
    }
  }
  return problems;
}

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();
}
