import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { TaskSnapshot } from "../api/types";
import { TaskEvidence } from "./task-evidence";

const task = {
  taskId: "task_evidence_test",
  summary: "evidence_000000000000000000000001",
} as TaskSnapshot;

describe("TaskEvidence entry", () => {
  it("preserves the existing UI when structured references are empty", () => {
    const client = { evidence: vi.fn() };
    const html = renderToStaticMarkup(createElement(TaskEvidence, {
      client, task, events: [], evidenceIds: [],
    }));
    expect(html).toBe("");
    expect(client.evidence).not.toHaveBeenCalled();
  });

  it("starts as an expandable panel and does not read evidence before opening", () => {
    const client = { evidence: vi.fn() };
    const html = renderToStaticMarkup(createElement(TaskEvidence, {
      client, task, events: [], evidenceIds: ["evidence_structured"],
    }));
    expect(html).toContain("资料与模型记录");
    expect(html).toContain("1 条引用");
    expect(html).not.toContain("task-evidence-body");
    expect(client.evidence).not.toHaveBeenCalled();
  });
});
