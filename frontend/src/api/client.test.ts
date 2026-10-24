import { afterEach, describe, expect, it, vi } from "vitest";
import catalog from "../../vendor/contract/fixtures/catalog.json";
import task from "../../vendor/contract/fixtures/normal-task.json";
import plan from "../../vendor/contract/fixtures/resource-plan.json";
import payment from "../../vendor/contract/fixtures/allowed-payment.json";
import review from "../../vendor/contract/fixtures/review-required.json";
import lesson from "../../vendor/contract/fixtures/active-lesson.json";
import evidence from "../../vendor/contract/fixtures/evidence.json";
import result from "../../vendor/contract/fixtures/task-result.json";
import failedResult from "../../vendor/contract/fixtures/task-result-failed.json";
import freeCatalog from "../../vendor/contract/fixtures/catalog-free.json";
import { ApiError, MotionClient, validatePublicView } from "./client";
import type { CreateTask, ReviewView } from "./types";

const createBody: CreateTask = {
  goal: "比较供应商交付条件",
  allowedVendorIds: ["vendor_alpha"],
  budgetAtomic: "1000000",
  maxPaidCalls: 3,
  expiresAt: "2099-01-01T00:00:00.000Z",
};
const reviewView = review as ReviewView;

function json(
  payload: unknown,
  status = 200,
  extra: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
      "X-Contract-Version": "0.2.0",
      "X-Execution-Mode": "MOCK",
      ETag: task.etag,
      ...extra,
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("locked public schemas", () => {
  it("accepts structured 0.2 results and explicitly free catalog entries while old views stay 0.1", () => {
    expect(validatePublicView("TaskResult", result)).toEqual(result);
    expect(validatePublicView("TaskResult", failedResult)).toEqual(failedResult);
    expect(validatePublicView("Catalog", freeCatalog)).toEqual(freeCatalog);
    expect(() => validatePublicView("Catalog", { ...freeCatalog, vendors: freeCatalog.vendors.map(({ billing: _billing, ...vendor }) => vendor) })).toThrow(ApiError);
  });

  it("rejects unregistered source references, private diagnostics and false live learning labels", () => {
    expect(() => validatePublicView("TaskResult", { ...result, evidenceIds: [] })).toThrow(ApiError);
    expect(() => validatePublicView("TaskResult", { ...failedResult, learningMode: "SANDBOX_ORACLE" })).toThrow(ApiError);
    expect(() => validatePublicView("TaskResult", { ...failedResult, model: { ...failedResult.model, diagnostics: failedResult.model.diagnostics.map(call => ({ ...call, apiKey: "forbidden-field" })) } })).toThrow(ApiError);
  });
  it("validates all published views and collection wrappers", () => {
    expect(validatePublicView("Catalog", catalog)).toEqual(catalog);
    expect(validatePublicView("TaskSnapshot", task)).toEqual(task);
    expect(validatePublicView("ResourcePlan", plan)).toEqual(plan);
    expect(validatePublicView("PaymentView", payment)).toEqual(payment);
    expect(validatePublicView("ReviewView", review)).toEqual(review);
    expect(validatePublicView("LessonView", lesson)).toEqual(lesson);
    expect(validatePublicView("EvidenceSummary", evidence)).toEqual(evidence);
    expect(
      validatePublicView("PaymentList", {
        schemaVersion: "0.1.0",
        items: [payment],
        nextCursor: null,
      }).items,
    ).toHaveLength(1);
    expect(
      validatePublicView("ReviewList", {
        schemaVersion: "0.1.0",
        items: [review],
      }).items,
    ).toHaveLength(1);
    expect(
      validatePublicView("LessonList", {
        schemaVersion: "0.1.0",
        items: [lesson],
        memoryVersion: "memory_m0",
      }).items,
    ).toHaveLength(1);
  });

  it("rejects unknown fields, money numbers and incompatible version/enums", () => {
    expect(() =>
      validatePublicView("Catalog", { ...catalog, schemaVersion: "0.2.0" }),
    ).toThrow(ApiError);
    expect(() =>
      validatePublicView("TaskSnapshot", {
        ...task,
        privateSigner: "forbidden",
      }),
    ).toThrow(ApiError);
    expect(() =>
      validatePublicView("TaskSnapshot", { ...task, status: "SUCCESS" }),
    ).toThrow(ApiError);
    expect(() =>
      validatePublicView("PaymentView", { ...payment, amountAtomic: 10000 }),
    ).toThrow(ApiError);
  });

  const testnetPayment = {
    ...payment,
    executionMode: "TESTNET",
    authorizationStatus: "SIGNED_TESTNET",
    receipt: {
      ...payment.receipt,
      status: "CONFIRMED",
      transactionHash: `0x${"a".repeat(64)}`,
      mockReceiptId: null,
    },
  };

  it("accepts the public TESTNET signed and confirmed combination", () => {
    expect(
      validatePublicView("PaymentView", testnetPayment).receipt.status,
    ).toBe("CONFIRMED");
  });

  it.each([
    [
      "MOCK with real authorization",
      { ...payment, authorizationStatus: "SIGNED_TESTNET" },
    ],
    [
      "MOCK with confirmed settlement",
      { ...payment, receipt: { ...payment.receipt, status: "CONFIRMED" } },
    ],
    [
      "MOCK with a chain transaction hash",
      {
        ...payment,
        receipt: { ...payment.receipt, transactionHash: `0x${"a".repeat(64)}` },
      },
    ],
    [
      "TESTNET with simulated authorization",
      { ...testnetPayment, authorizationStatus: "SIMULATED" },
    ],
    [
      "TESTNET with simulated settlement",
      {
        ...testnetPayment,
        receipt: { ...testnetPayment.receipt, status: "SIMULATED" },
      },
    ],
    [
      "TESTNET with a mock receipt",
      {
        ...testnetPayment,
        receipt: {
          ...testnetPayment.receipt,
          mockReceiptId: "mock_incompatible",
        },
      },
    ],
  ])(
    "rejects %s through the published conditional schema, including collection items",
    (_label, value) => {
      expect(() => validatePublicView("PaymentView", value)).toThrow(ApiError);
      expect(() =>
        validatePublicView("PaymentList", {
          schemaVersion: "0.1.0",
          items: [value],
          nextCursor: null,
        }),
      ).toThrow(ApiError);
    },
  );
});

describe("MotionClient", () => {
  it("reads a 0.2 TaskResult with a read-only GET and no scenario controls", async () => {
    const fetcher = vi.fn().mockResolvedValue(json(result));
    vi.stubGlobal("fetch", fetcher);
    expect(await new MotionClient().taskResult("task_demo")).toEqual(result);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("/api/v1/tasks/task_demo/result");
    expect(init.method).toBeUndefined();
    expect(init.headers.get("X-Contract-Version")).toBe("0.2.0");
    expect(init.headers.has("Idempotency-Key")).toBe(false);
    expect(init.headers.has("X-Mock-Scenario")).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("keeps RESULT_NOT_READY as a read result without retrying or running the task", async () => {
    const fetcher = vi.fn().mockResolvedValue(json({ schemaVersion: "0.1.0", error: { code: "RESULT_NOT_READY", requestId: "result_pending", message: "尚未生成" } }, 409));
    vi.stubGlobal("fetch", fetcher);
    await expect(new MotionClient().taskResult("task_demo")).rejects.toMatchObject({ status: 409, code: "RESULT_NOT_READY" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects another task's result and a result/header payment-mode mismatch", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(json({ ...result, taskId: "task_other" })).mockResolvedValueOnce(json(result, 200, { "X-Execution-Mode": "TESTNET" })));
    await expect(new MotionClient().taskResult("task_demo")).rejects.toMatchObject({ code: "INVALID_API_RESPONSE" });
    await expect(new MotionClient().taskResult("task_demo")).rejects.toMatchObject({ code: "INVALID_API_RESPONSE" });
  });
  it("accepts an authenticated MOCK backend without interpreting authentication as real execution", async () => {
    const authenticatedTask = { ...task, authMode: "OPERATOR_SESSION" };
    const fetcher = vi.fn().mockResolvedValue(json(authenticatedTask));
    vi.stubGlobal("fetch", fetcher);
    const client = new MotionClient({ token: "in-memory-session" });

    expect(await client.task("task_demo")).toEqual(authenticatedTask);
    expect(client.executionMode).toBe("MOCK");
    expect(fetcher.mock.calls[0][1].headers.get("Authorization")).toBe(
      "Bearer in-memory-session",
    );
    expect(fetcher.mock.calls[0][1].headers.has("X-Mock-Scenario")).toBe(false);
  });

  it("retains operator-session authentication for TESTNET responses", async () => {
    const unauthenticatedTask = { ...task, executionMode: "TESTNET" };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        json(unauthenticatedTask, 200, { "X-Execution-Mode": "TESTNET" }),
      ),
    );
    const client = new MotionClient();

    await expect(client.task("task_demo")).rejects.toMatchObject({
      code: "INVALID_API_RESPONSE",
    });
    expect(client.executionMode).toBeNull();
  });

  it("checks nested task authentication when resolving a TESTNET review", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        json(
          {
            schemaVersion: "0.1.0",
            review,
            task: { ...task, executionMode: "TESTNET" },
          },
          200,
          { "X-Execution-Mode": "TESTNET", ETag: review.etag },
        ),
      ),
    );
    const client = new MotionClient();

    await expect(
      client.resolveReview("task_demo", reviewView, "APPROVE"),
    ).rejects.toMatchObject({ code: "INVALID_API_RESPONSE" });
    expect(client.executionMode).toBeNull();
  });

  it("sends contract and bearer headers, keeps token out of URL and learns mode from checked headers", async () => {
    const fetcher = vi.fn().mockResolvedValue(json(catalog));
    vi.stubGlobal("fetch", fetcher);
    const client = new MotionClient({
      baseUrl: "http://127.0.0.1:4010/",
      token: "in-memory-session",
    });
    expect(client.executionMode).toBeNull();
    expect(await client.catalog()).toEqual(catalog);
    expect(client.executionMode).toBe("MOCK");
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:4010/api/v1/catalog");
    expect(url).not.toContain("session");
    expect(init.headers.get("Authorization")).toBe("Bearer in-memory-session");
    expect(init.headers.get("X-Contract-Version")).toBe("0.2.0");
    expect(init.headers.get("Accept")).toBe("application/json");
    expect(Object.keys(client)).not.toContain("token");
  });

  it("sends exact review snapshot and review ETag, never task ETag", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        json({ schemaVersion: "0.1.0", review, task }, 200, {
          ETag: review.etag,
        }),
      );
    vi.stubGlobal("fetch", fetcher);
    const client = new MotionClient();
    await client.resolveReview(
      "task_demo",
      reviewView,
      "APPROVE",
      "approve-demo-001",
    );
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("/api/v1/tasks/task_demo/reviews/review_demo/resolve");
    expect(init.headers.get("If-Match")).toBe(review.etag);
    expect(init.headers.get("If-Match")).not.toBe(task.etag);
    expect(init.headers.get("Idempotency-Key")).toBe("approve-demo-001");
    expect(JSON.parse(init.body)).toEqual({
      choice: "APPROVE",
      snapshotHash: review.snapshotHash,
    });
  });

  it("returns stable 412 code and request ID without refreshing or automatically replaying mutation", async () => {
    const payload = {
      schemaVersion: "0.1.0",
      error: {
        code: "PRECONDITION_FAILED",
        requestId: "request_conflict",
        message: "资源已经变化",
        details: { currentEtag: '"task_demo:v6"' },
      },
    };
    const fetcher = vi.fn().mockResolvedValue(json(payload, 412));
    vi.stubGlobal("fetch", fetcher);
    const failure = await new MotionClient()
      .authorize("task_demo", task.etag, plan.planHash)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({
      status: 412,
      code: "PRECONDITION_FAILED",
      requestId: "request_conflict",
      details: { currentEtag: '"task_demo:v6"' },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not retry a POST when the response may have been lost", async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValue(new TypeError("network disconnected"));
    vi.stubGlobal("fetch", fetcher);
    await expect(
      new MotionClient().run("task_demo", task.etag, 1, "run-demo-001"),
    ).rejects.toThrow("network disconnected");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("generates a valid key and sends an empty object for cancellation", async () => {
    const fetcher = vi.fn().mockResolvedValue(json(task));
    vi.stubGlobal("fetch", fetcher);
    await new MotionClient().cancel("task_demo", task.etag);
    const init = fetcher.mock.calls[0][1];
    expect(init.headers.get("Idempotency-Key")).toMatch(
      /^[A-Za-z0-9._:-]{8,128}$/,
    );
    expect(init.headers.get("If-Match")).toBe(task.etag);
    expect(init.body).toBe("{}");
  });

  it("rejects wildcard/missing ETag and invalid request input before fetch", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const client = new MotionClient();
    await expect(client.cancel("task_demo", "*")).rejects.toMatchObject({
      code: "INVALID_ETAG",
    });
    await expect(
      client.cancel("task_demo", undefined as unknown as string),
    ).rejects.toMatchObject({ code: "INVALID_ETAG" });
    await expect(
      client.createTask({ ...createBody, budgetAtomic: "1.5" }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(client.run("task_demo", task.etag, 0)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("permits a scenario header only for explicit create on a verified MOCK connection", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json(catalog))
      .mockResolvedValueOnce(json(task));
    vi.stubGlobal("fetch", fetcher);
    const client = new MotionClient();
    await expect(
      client.createTask(createBody, undefined, "review"),
    ).rejects.toMatchObject({ code: "MOCK_SCENARIO_NOT_ALLOWED" });
    await client.catalog();
    await client.createTask(createBody, "create-demo-001", "review");
    expect(fetcher.mock.calls[0][1].headers.has("X-Mock-Scenario")).toBe(false);
    expect(fetcher.mock.calls[1][1].headers.get("X-Mock-Scenario")).toBe(
      "review",
    );
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual(createBody);
  });

  it.each([
    ["missing version", { "X-Contract-Version": "" }],
    ["wrong version", { "X-Contract-Version": "0.1.0" }],
    ["missing mode", { "X-Execution-Mode": "" }],
    ["unknown mode", { "X-Execution-Mode": "PRODUCTION" }],
    ["missing strong etag", { ETag: 'W/"task_demo:v5"' }],
  ])(
    "rejects %s instead of presenting a compatible connection",
    async (_label, headers) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(json(catalog, 200, headers)),
      );
      const client = new MotionClient();
      await expect(client.catalog()).rejects.toMatchObject({
        code: "INVALID_API_RESPONSE",
      });
      expect(client.executionMode).toBeNull();
    },
  );

  it("rejects inconsistent mode inside task and payment collections", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          json(task, 200, { "X-Execution-Mode": "TESTNET" }),
        )
        .mockResolvedValueOnce(
          json({
            schemaVersion: "0.1.0",
            items: [{ ...payment, executionMode: "TESTNET" }],
            nextCursor: null,
          }),
        ),
    );
    const client = new MotionClient();
    await expect(client.task("task_demo")).rejects.toMatchObject({
      code: "INVALID_API_RESPONSE",
    });
    await expect(client.payments("task_demo")).rejects.toMatchObject({
      code: "INVALID_API_RESPONSE",
    });
  });

  it("pins the first verified mode and blocks mutations after a mode change", async () => {
    const testnetTask = {
      ...task,
      executionMode: "TESTNET",
      authMode: "OPERATOR_SESSION",
    };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json(catalog))
      .mockResolvedValueOnce(
        json(testnetTask, 200, { "X-Execution-Mode": "TESTNET" }),
      );
    vi.stubGlobal("fetch", fetcher);
    const client = new MotionClient();
    await client.catalog();
    await expect(client.task("task_demo")).rejects.toMatchObject({
      code: "EXECUTION_MODE_CHANGED",
    });
    expect(client.executionMode).toBe("MOCK");
    await expect(client.run("task_demo", task.etag, 1)).rejects.toMatchObject({
      code: "EXECUTION_MODE_CHANGED",
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not pin an unverified or failed response", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        json(
          {
            schemaVersion: "0.1.0",
            error: {
              code: "UNAUTHORIZED",
              requestId: "request_auth",
              message: "未登录",
            },
          },
          401,
          { "X-Execution-Mode": "TESTNET" },
        ),
      )
      .mockResolvedValueOnce(json(catalog));
    vi.stubGlobal("fetch", fetcher);
    const client = new MotionClient();
    await expect(client.catalog()).rejects.toMatchObject({ status: 401 });
    expect(client.executionMode).toBeNull();
    await client.catalog();
    expect(client.executionMode).toBe("MOCK");
  });

  it("pins mode again at commit when concurrent initial responses complete out of order", async () => {
    let finishSlow: ((value: unknown) => void) | undefined;
    const slowResponse = json(catalog);
    vi.spyOn(slowResponse, "json").mockImplementation(
      () =>
        new Promise((resolve) => {
          finishSlow = resolve;
        }),
    );
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(slowResponse)
      .mockResolvedValueOnce(
        json(
          { ...task, executionMode: "TESTNET", authMode: "OPERATOR_SESSION" },
          200,
          { "X-Execution-Mode": "TESTNET" },
        ),
      );
    vi.stubGlobal("fetch", fetcher);
    const client = new MotionClient();
    const slow = client.catalog();
    await client.task("task_demo");
    expect(client.executionMode).toBe("TESTNET");
    finishSlow!(catalog);
    await expect(slow).rejects.toMatchObject({
      code: "EXECUTION_MODE_CHANGED",
    });
    expect(client.executionMode).toBe("TESTNET");
  });

  it("rejects credential-bearing API addresses", () => {
    expect(
      () => new MotionClient({ baseUrl: "https://user:secret@example.test" }),
    ).toThrow(ApiError);
    expect(
      () => new MotionClient({ baseUrl: "https://example.test?token=secret" }),
    ).toThrow(ApiError);
    expect(() => new MotionClient({ baseUrl: "javascript:alert(1)" })).toThrow(
      ApiError,
    );
  });
});
