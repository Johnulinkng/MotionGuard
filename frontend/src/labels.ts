import type { TaskStatus } from "./api/types";

export const taskLabels: Record<TaskStatus, string> = {
  DRAFT: "待规划",
  PLANNING: "正在生成计划",
  AWAITING_AUTHORIZATION: "待确认计划",
  READY: "已冻结 · 待执行",
  RUNNING: "执行中",
  PAUSED_REVIEW: "等待人工复核",
  AWAITING_SETTLEMENT: "等待结算确认",
  COMPLETED: "任务已结束",
  CANCELLED: "已取消",
  FAILED: "执行失败",
};
export const tones = {
  DRAFT: "neutral",
  PLANNING: "blue",
  AWAITING_AUTHORIZATION: "amber",
  READY: "green",
  RUNNING: "green",
  PAUSED_REVIEW: "amber",
  AWAITING_SETTLEMENT: "amber",
  COMPLETED: "green",
  CANCELLED: "neutral",
  FAILED: "red",
} as const;
export const paymentLabels: Record<string, string> = {
  CREATED: "等待判定",
  RESERVED: "额度已预占",
  SIGNED: "授权已产生",
  DISPATCHED: "请求已发送",
  SETTLED: "结算已记录",
  REJECTED: "已拒绝",
  EXPIRED: "已过期",
  UNKNOWN: "结算未知",
};
export const decisionLabels: Record<string, string> = {
  ALLOW: "允许",
  REVIEW: "需要复核",
  BLOCK: "阻断",
  ERROR: "检查异常",
};
export const resourceLabels: Record<string, string> = {
  DOCUMENT: "资料采购",
  MARKET_DATA: "市场数据",
  ANALYSIS: "分析服务",
};
export const reasonLabels: Record<string, string> = {
  PLAN_MATCH: "符合冻结资源计划",
  PAYEE_NOT_AUTHORIZED: "收款方不在授权范围",
  SEMANTIC_UNCERTAINTY: "采购必要性需要确认",
  USER_APPROVED_EXACT_SNAPSHOT: "用户批准此准确快照",
  USER_REJECTED: "用户拒绝",
  NO_REGISTERED_THREAT: "未发现已登记威胁",
  RESOURCE_PLAN_MATCH: "符合资源计划",
  BUDGET_EXCEEDED: "超出预算",
};
export const scenarios = [
  ["normal", "正常资料采购"],
  ["blocked", "收款方篡改拦截"],
  ["review", "人工复核请求"],
  ["unknown", "结算未知恢复"],
  ["lesson", "沙箱经验闭环"],
] as const;
export type Scenario = (typeof scenarios)[number][0];
