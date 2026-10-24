import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import type { TaskResult } from "../api/types";
import fixture from "../../vendor/contract/fixtures/task-result.json";
import { waitForTaskResult } from "./task-result-read";

const pending = () => new ApiError(409, "RESULT_NOT_READY", "read_pending", "尚未生成");

describe("bounded result reads", () => {
  it("reads a later-ready result without exposing any task mutation method", async () => {
    const reader = { taskResult: vi.fn().mockRejectedValueOnce(pending()).mockResolvedValueOnce(fixture) };
    const wait = vi.fn().mockResolvedValue(undefined);
    const abort = new AbortController();
    expect(await waitForTaskResult(reader, "task_demo", abort.signal, wait)).toEqual(fixture as TaskResult);
    expect(reader.taskResult).toHaveBeenCalledTimes(2);
    expect(reader.taskResult).toHaveBeenCalledWith("task_demo", abort.signal);
  });

  it("stops after four pending reads so old records cannot create an endless poll", async () => {
    const reader = { taskResult: vi.fn().mockRejectedValue(pending()) };
    const wait = vi.fn().mockResolvedValue(undefined);
    expect(await waitForTaskResult(reader, "task_demo", new AbortController().signal, wait)).toBeNull();
    expect(reader.taskResult).toHaveBeenCalledTimes(4);
    expect(wait.mock.calls.map(call => call[0])).toEqual([250, 750, 1500, 3000]);
  });

  it("does not retry errors other than RESULT_NOT_READY", async () => {
    const failure = new ApiError(403, "TASK_ACCESS_DENIED", "read_denied", "无权访问");
    const reader = { taskResult: vi.fn().mockRejectedValue(failure) };
    await expect(waitForTaskResult(reader, "task_demo", new AbortController().signal, async () => undefined)).rejects.toBe(failure);
    expect(reader.taskResult).toHaveBeenCalledTimes(1);
  });

  it("aborts a pending owner read before issuing another GET", async () => {
    const abort = new AbortController();
    const reader = { taskResult: vi.fn() };
    const wait = async () => { abort.abort(); };
    expect(await waitForTaskResult(reader, "task_demo", abort.signal, wait)).toBeNull();
    expect(reader.taskResult).not.toHaveBeenCalled();
  });
});
