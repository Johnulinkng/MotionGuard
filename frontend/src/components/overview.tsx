import { useId, useRef, useState, type FormEvent } from "react";
import {
  ArrowDown,
  ArrowRight,
  Fingerprint,
  Play,
  PlugsConnected,
  ShieldCheck,
  Target,
} from "@phosphor-icons/react";
import type { ExecutionMode } from "../api/types";
import { Button } from "./ui";

export interface OverviewHeroProps {
  connected: boolean;
  busy: boolean;
  simulatorControls: boolean;
  mode: ExecutionMode | null;
  onNew: (goal: string) => void;
  onDemo: () => void;
  onConnect: () => void;
}

const suggestions = [
  {
    label: "整理资料要点",
    goal: "根据授权目录中的资料，整理主题、关键事实和对应来源，明确资料未覆盖的问题。",
  },
  {
    label: "核对资料来源",
    goal: "核对授权资料中的核心主张，区分原文事实、模型归纳和仍待验证的信息，并列出来源。",
  },
];

const steps = [
  {
    id: "goal",
    title: "原始目标",
    caption: "由你定义任务范围",
    icon: Target,
    detail: "用原始目标确定任务范围，再选择允许使用的商家和预算。",
  },
  {
    id: "plan",
    title: "资源计划",
    caption: "确认后冻结授权",
    icon: Fingerprint,
    detail: "先查看资源、单价和调用次数。确认后，Agent 按冻结的授权执行。",
  },
  {
    id: "policy",
    title: "付款检查",
    caption: "每笔请求独立判断",
    icon: ShieldCheck,
    detail: "每次付款先检查授权与风险。需要人工复核时暂停，硬约束不可覆盖。",
  },
] as const;

export function OverviewHero({
  connected,
  busy,
  simulatorControls,
  mode,
  onNew,
  onDemo,
  onConnect,
}: OverviewHeroProps) {
  const [goal, setGoal] = useState("");
  const [activeStep, setActiveStep] =
    useState<(typeof steps)[number]["id"]>("plan");
  const textarea = useRef<HTMLTextAreaElement>(null);
  const id = useId();
  const selectedStep = steps.find((step) => step.id === activeStep)!;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (connected && !busy && goal.trim()) onNew(goal.trim());
  }

  return (
    <section className="overview-hero" aria-labelledby={`${id}-title`}>
      <div className="overview-copy">
        <h2 className="overview-title" id={`${id}-title`}>
          下一项任务，从这里开始。
        </h2>
        <p className="overview-intro">
          写下目标，再选择可信资料来源、预算与授权期限。
        </p>
        <form className="composer-form" onSubmit={submit}>
          <label className="composer-label" htmlFor={`${id}-goal`}>
            任务目标预览
          </label>
          <textarea
            className="composer-input"
            id={`${id}-goal`}
            ref={textarea}
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
            maxLength={2000}
            rows={4}
            placeholder="例如：根据授权目录中的资料，整理核心结论、来源及尚待核实的问题。"
            aria-describedby={`${id}-hint ${id}-count`}
            disabled={busy}
          />
          <div className="composer-suggestions" aria-label="填入任务示例">
            {suggestions.map((suggestion) => (
              <button
                className="composer-suggestion"
                type="button"
                key={suggestion.label}
                disabled={busy}
                onClick={() => {
                  setGoal(suggestion.goal);
                  textarea.current?.focus();
                }}
              >
                {suggestion.label}
                <ArrowRight size={12} aria-hidden="true" />
              </button>
            ))}
          </div>
          <div className="composer-footer">
            <span className="composer-count" id={`${id}-count`}>
              {goal.length} / 2000
            </span>
            <Button
              className="composer-submit"
              type="submit"
              disabled={!connected || busy || !goal.trim()}
            >
              设置任务与授权
              <ArrowRight size={15} aria-hidden="true" />
            </Button>
          </div>
          <p className="composer-hint" id={`${id}-hint`}>
            下一步确认设置，此处不会创建任务或授权付款。
          </p>
        </form>
        {(!connected || (mode === "MOCK" && simulatorControls)) && (
          <div className="composer-secondary">
            {!connected ? (
              <Button variant="secondary" disabled={busy} onClick={onConnect}>
                <PlugsConnected size={15} aria-hidden="true" />
                配置连接
              </Button>
            ) : (
              <Button variant="ghost" disabled={busy} onClick={onDemo}>
                <Play size={14} aria-hidden="true" />
                体验模拟流程
              </Button>
            )}
          </div>
        )}
      </div>
      <aside className="trust-map" aria-labelledby={`${id}-trust-title`}>
        <div className="trust-map-heading">
          <ShieldCheck size={18} aria-hidden="true" />
          <h3 id={`${id}-trust-title`}>授权流程示意</h3>
        </div>
        <div className="trust-flow">
          {steps.map((step, index) => {
            const Icon = step.icon;
            return (
              <div className="trust-step" key={step.id}>
                {index > 0 && (
                  <div className="trust-connector" aria-hidden="true">
                    <ArrowDown size={15} />
                  </div>
                )}
                <button
                  className={`trust-node ${activeStep === step.id ? "is-active" : ""}`}
                  type="button"
                  onClick={() => setActiveStep(step.id)}
                  aria-pressed={activeStep === step.id}
                  aria-controls={`${id}-trust-explanation`}
                >
                  <span className="trust-node-icon">
                    <Icon size={21} aria-hidden="true" />
                  </span>
                  <span className="trust-node-copy">
                    <strong>{step.title}</strong>
                    <span>{step.caption}</span>
                  </span>
                  <span className="trust-node-index" aria-hidden="true">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                </button>
              </div>
            );
          })}
        </div>
        <div
          className="trust-explanation"
          id={`${id}-trust-explanation`}
          aria-live="polite"
          aria-atomic="true"
        >
          <strong>{selectedStep.title}</strong>
          <p>{selectedStep.detail}</p>
        </div>
      </aside>
    </section>
  );
}
