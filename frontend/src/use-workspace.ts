import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, MotionClient } from "./api/client";
import { subscribeTaskEvents } from "./api/events";
import { waitForTaskResult } from "./lib/task-result-read";
import type {
  EventEnvelope,
  LessonView,
  PaymentView,
  ResourcePlan,
  ReviewView,
  TaskSnapshot,
  TaskResult,
} from "./api/types";

export function useTaskWorkspace(client: MotionClient, taskId: string | null) {
  const [task, setTask] = useState<TaskSnapshot | null>(null);
  const [plan, setPlan] = useState<ResourcePlan | null>(null);
  const [payments, setPayments] = useState<PaymentView[]>([]);
  const [reviews, setReviews] = useState<ReviewView[]>([]);
  const [lessons, setLessons] = useState<LessonView[]>([]);
  const [events, setEvents] = useState<EventEnvelope[]>([]);
  const [taskResult, setTaskResult] = useState<TaskResult | null>(null);
  const [resultError, setResultError] = useState<Error | null>(null);
  const [resultPending, setResultPending] = useState(false);
  const [resultOwner, setResultOwner] = useState<{ client: MotionClient; taskId: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [fresh, setFresh] = useState(false);
  const [connection, setConnection] = useState("connecting");
  const generation = useRef(0);
  const current = useRef({ client, taskId });
  current.current = { client, taskId };

  const refresh = useCallback(async () => {
    if (!taskId) return null;
    const ticket = ++generation.current;
    try {
      const snapshot = await client.task(taskId);
      const [paymentList, reviewList, lessonList, resourcePlan, resultRead] =
        await Promise.all([
          client.payments(taskId),
          client.reviews(taskId),
          client.lessons(taskId),
          snapshot.planId ? client.resourcePlan(taskId) : Promise.resolve(null),
          ["COMPLETED", "FAILED", "CANCELLED", "AWAITING_SETTLEMENT"].includes(snapshot.status)
            ? client.taskResult(taskId).then(value => ({ value, error: null as Error | null, pending: false })).catch(cause => ({
              value: null,
              pending: cause instanceof ApiError && cause.status === 409 && cause.code === "RESULT_NOT_READY",
              error: cause instanceof ApiError && cause.status === 409 && cause.code === "RESULT_NOT_READY"
                ? null : cause instanceof Error ? cause : new Error("读取任务结果失败"),
            }))
            : Promise.resolve({ value: null, error: null, pending: false }),
        ]);
      if (
        ticket !== generation.current ||
        current.current.taskId !== taskId ||
        current.current.client !== client
      )
        return null;
      setTask(snapshot);
      setPayments(paymentList.items);
      setReviews(reviewList.items);
      setLessons(lessonList.items);
      setPlan(resourcePlan);
      setTaskResult(resultRead.value);
      setResultError(resultRead.error);
      setResultPending(resultRead.pending);
      setResultOwner({ client, taskId });
      setError(null);
      setFresh(true);
      return snapshot;
    } catch (cause) {
      if (
        ticket === generation.current &&
        current.current.client === client &&
        current.current.taskId === taskId
      ) {
        setFresh(false);
        setError(
          cause instanceof Error ? cause : new Error("读取任务状态失败"),
        );
      }
      throw cause;
    }
  }, [client, taskId]);

  useEffect(() => {
    ++generation.current;
    setTask(null);
    setPlan(null);
    setPayments([]);
    setReviews([]);
    setLessons([]);
    setEvents([]);
    setTaskResult(null);
    setResultError(null);
    setResultPending(false);
    setResultOwner(null);
    setError(null);
    setFresh(false);
    if (!taskId) {
      setLoading(false);
      setConnection("closed");
      return;
    }
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = new AbortController();
    setLoading(true);
    setConnection("connecting");
    const scheduleRefresh = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (live)
          void refresh().catch((cause: Error) => {
            if (live) setError(cause);
          });
      }, 70);
    };
    void refresh()
      .then((snapshot) => {
        if (!live || !snapshot) return;
        setLoading(false);
        return subscribeTaskEvents(
          client,
          taskId,
          snapshot.lastEventSeq,
          {
            onEvent(event) {
              if (!live) return;
              setEvents((previous) =>
                previous.some((item) => item.eventId === event.eventId)
                  ? previous
                  : [...previous, event].slice(-100),
              );
              scheduleRefresh();
            },
            onResync() {
              scheduleRefresh();
            },
            onStatus(status) {
              if (live) setConnection(status);
            },
          },
          abort.signal,
        );
      })
      .catch((cause: Error) => {
        if (live && !abort.signal.aborted) {
          setError(cause);
          setConnection("error");
          setLoading(false);
        }
      });
    return () => {
      live = false;
      clearTimeout(timer);
      abort.abort();
      ++generation.current;
    };
  }, [client, taskId, refresh]);

  useEffect(() => {
    if (!taskId || !resultPending) return;
    const abort = new AbortController();
    void waitForTaskResult(client, taskId, abort.signal).then(value => {
      if (abort.signal.aborted || current.current.client !== client || current.current.taskId !== taskId) return;
      setTaskResult(value);
      setResultPending(false);
      setResultError(value ? null : new Error("完整报告尚未生成，可手动刷新快照重新读取；任务不会重新执行。"));
    }).catch(cause => {
      if (abort.signal.aborted || current.current.client !== client || current.current.taskId !== taskId) return;
      setResultPending(false);
      setResultError(cause instanceof Error ? cause : new Error("读取完整报告失败"));
    });
    return () => abort.abort();
  }, [client, taskId, resultPending]);

  useEffect(() => {
    if (!taskId || !["closed", "error", "reconnecting"].includes(connection))
      return;
    const interval = setInterval(() => {
      void refresh().catch(() => undefined);
    }, 4000);
    return () => clearInterval(interval);
  }, [taskId, connection, refresh]);

  return {
    task,
    plan,
    payments,
    reviews,
    lessons,
    events,
    taskResult: resultOwner?.client === client && resultOwner.taskId === taskId ? taskResult : null,
    resultError: resultOwner?.client === client && resultOwner.taskId === taskId ? resultError : null,
    resultPending: resultOwner?.client === client && resultOwner.taskId === taskId && resultPending,
    loading,
    error,
    connection,
    fresh,
    refresh,
    invalidate: () => setFresh(false),
  };
}
