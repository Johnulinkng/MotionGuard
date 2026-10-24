import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import task from "../../vendor/contract/fixtures/normal-task.json";
import payment from "../../vendor/contract/fixtures/allowed-payment.json";
import resultFixture from "../../vendor/contract/fixtures/task-result.json";
import failedFixture from "../../vendor/contract/fixtures/task-result-failed.json";
import { AgentPanel, PaymentDetails, TaskPanel, TaskResultView } from "../components/workspace";
import type { TaskSnapshot, PaymentView, TaskResult } from "../api/types";
import { modelExecutionLabel, roleExecutionLabel } from "./runtime";

const snapshot = task as TaskSnapshot;
const live: TaskResult = { ...(failedFixture as TaskResult), status: "COMPLETED", report: "已获取公开资料并完成分析。" };

describe("structured model execution and payment presentation", () => {
  it("keeps a live adapter distinct from a failed call and MOCK payments", () => {
    expect(modelExecutionLabel(live)).toBe("实时模型 API（后端报告）");
    expect(roleExecutionLabel(live, "worker")).toBe("成功 0/1 · 有失败");
    const html = renderToStaticMarkup(createElement(AgentPanel, { task: snapshot, result: live }));
    expect(html).toContain("成功 0/1 · 有失败");
    expect(html).toContain("未运行 · 无真实标签");
    expect(html).not.toContain("查看经验记录");
    const details = renderToStaticMarkup(createElement(PaymentDetails, { payment: payment as PaymentView }));
    expect(details).toContain("MOCK");
    expect(details).toContain("SIMULATED");
    expect(details).toContain("无链上交易哈希");
  });

  it("uses call diagnostics rather than task stage or summary prefixes", () => {
    expect(modelExecutionLabel(null)).toBe("模型来源尚无执行报告");
    expect(roleExecutionLabel(null, "worker")).toBe("尚无执行报告");
    expect(modelExecutionLabel(resultFixture as TaskResult)).toBe("确定性沙箱模型");
    const success: TaskResult = { ...live, model: { ...live.model, diagnostics: live.model.diagnostics.map(call => ({ ...call, status: "SUCCEEDED" })) } };
    expect(roleExecutionLabel(success, "worker")).toBe("成功 1/1");
    expect(roleExecutionLabel(success, "threat")).toBe("无模型调用记录");
  });

  it("shows the full completed report when no payment occurred", () => {
    const noop = () => undefined;
    const html = renderToStaticMarkup(createElement(TaskPanel, {
      task: snapshot, result: live, plan: null, payments: [], reviews: [], lessons: [], events: [],
      catalog: null, tab: "payments", setTab: noop, busy: false, connection: "connected",
      onPlan: noop, onAuthorize: noop, onRun: noop, onReview: noop, onPayment: noop,
      onLesson: noop, onCancel: noop, onRevoke: noop, onRefresh: noop,
    }));
    expect(html).toContain("任务完整报告");
    expect(html).toContain(live.report);
    expect(html).toContain("任务已完成，未产生付款");
    expect(html).not.toContain("任务执行后");
    expect(html).toContain("付款 MOCK");
    expect(html).toContain("不自动晋升");
  });

  it("escapes report text and preserves absent usage as unreported", () => {
    const result = { ...live, report: '<img src=x onerror="alert(1)">' };
    const html = renderToStaticMarkup(createElement(TaskResultView, { result }));
    expect(html).toContain("&lt;img");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("token 用量 未返回");
  });
});
