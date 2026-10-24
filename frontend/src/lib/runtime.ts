import type { ProviderCallDiagnostic, TaskResult } from "../api/types";

/** Structured provider mode is separate from payment mode and successful calls. */
export function modelExecutionLabel(result?: TaskResult | null): string {
  if (!result) return "模型来源尚无执行报告";
  return result.model.mode === "LIVE_API" ? "实时模型 API（后端报告）" : "确定性沙箱模型";
}

export function roleExecutionLabel(result: TaskResult | null | undefined, role: ProviderCallDiagnostic["role"]): string {
  if (!result) return "尚无执行报告";
  const calls = result.model.diagnostics.filter(call => call.role === role);
  if (!calls.length && role === "curator" && result.learningMode === "NO_ONLINE_LABELS") return "未运行 · 无真实标签";
  if (!calls.length) return "无模型调用记录";
  const successes = calls.filter(call => call.status === "SUCCEEDED").length;
  return successes === calls.length ? `成功 ${successes}/${calls.length}` : `成功 ${successes}/${calls.length} · 有失败`;
}
