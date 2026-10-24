import { ApiError } from "../api/client";
import type { TaskResult } from "../api/types";

type Reader = { taskResult(id: string, signal?: AbortSignal): Promise<TaskResult> };

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new DOMException("Result read aborted", "AbortError")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** Only repeats the read endpoint after RESULT_NOT_READY; never reruns a task. */
export async function waitForTaskResult(reader: Reader, taskId: string, signal: AbortSignal,
  wait: (ms: number, signal: AbortSignal) => Promise<void> = pause): Promise<TaskResult | null> {
  for (const delay of [250, 750, 1500, 3000]) {
    await wait(delay, signal);
    if (signal.aborted) return null;
    try { return await reader.taskResult(taskId, signal); }
    catch (cause) {
      if (!(cause instanceof ApiError && cause.status === 409 && cause.code === "RESULT_NOT_READY")) throw cause;
    }
  }
  return null;
}
