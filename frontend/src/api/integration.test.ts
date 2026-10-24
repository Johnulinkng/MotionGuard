import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error The immutable owner-published Node simulator does not ship TypeScript declarations.
import { createMockServer } from "../../vendor/contract/mock-server.mjs";
import { MotionClient } from "./client";
import type { MockScenario } from "./client";
import { subscribeTaskEvents } from "./events";
import type { TaskSnapshot, TaskStatus } from "./types";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createMockServer({ stepMs: 2, history: 64 }) as Server;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function poll(
  client: MotionClient,
  id: string,
  status: TaskStatus,
): Promise<TaskSnapshot> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const snapshot = await client.task(id);
    if (snapshot.status === status) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`MOCK task did not reach ${status}`);
}

async function launch(
  scenario: MockScenario,
): Promise<{ client: MotionClient; snapshot: TaskSnapshot }> {
  const client = new MotionClient({ baseUrl });
  const catalog = await client.catalog();
  expect(client.executionMode).toBe("MOCK");
  let snapshot = await client.createTask(
    {
      goal: "比较指定供应商的交付条件",
      allowedVendorIds: [catalog.vendors[0].vendorId],
      budgetAtomic: "1000000",
      maxPaidCalls: 3,
      expiresAt: "2099-01-01T00:00:00.000Z",
    },
    undefined,
    scenario,
  );
  expect(snapshot.status).toBe("DRAFT");
  snapshot = await client.plan(snapshot.taskId, snapshot.etag);
  expect(snapshot.status).toBe("PLANNING");
  snapshot = await poll(client, snapshot.taskId, "AWAITING_AUTHORIZATION");
  const plan = await client.resourcePlan(snapshot.taskId);
  expect(plan.status).toBe("DRAFT");
  snapshot = await client.authorize(
    snapshot.taskId,
    snapshot.etag,
    plan.planHash,
  );
  expect(snapshot.status).toBe("READY");
  expect((await client.resourcePlan(snapshot.taskId)).status).toBe("FROZEN");
  snapshot = await client.run(
    snapshot.taskId,
    snapshot.etag,
    snapshot.authorization!.version,
  );
  expect(snapshot.status).toBe("RUNNING");
  snapshot = await poll(
    client,
    snapshot.taskId,
    scenario === "review"
      ? "PAUSED_REVIEW"
      : scenario === "unknown"
        ? "AWAITING_SETTLEMENT"
        : "COMPLETED",
  );
  return { client, snapshot };
}

describe("MotionClient over actual local contract MOCK HTTP/SSE", () => {
  it.each(["normal", "blocked", "unknown", "lesson"] as const)(
    "runs the %s scenario through the locked client",
    async (scenario) => {
      const { client, snapshot } = await launch(scenario);
      const payments = await client.payments(snapshot.taskId);
      expect(payments.items).toHaveLength(1);
      const payment = payments.items[0];
      expect(payment.executionMode).toBe("MOCK");
      expect(payment.authorizationStatus).not.toBe("SIGNED_TESTNET");
      expect(payment.receipt.transactionHash).toBeNull();
      expect(await client.payment(snapshot.taskId, payment.paymentId)).toEqual(
        payment,
      );
      expect(await client.decision(snapshot.taskId, payment.paymentId)).toEqual(
        payment.decision,
      );
      const evidence = await client.evidence(
        snapshot.taskId,
        payment.decision.evidenceIds[0],
      );
      expect(evidence.taskId).toBe(snapshot.taskId);
      const budget = await client.budget(snapshot.taskId);
      expect(
        BigInt(budget.availableAtomic) +
          BigInt(budget.reservedAtomic) +
          BigInt(budget.outstandingAtomic) +
          BigInt(budget.settledAtomic),
      ).toBe(BigInt(budget.limitAtomic));
      if (scenario === "blocked") {
        expect(payment.state).toBe("REJECTED");
        expect(payment.decision.hardGate).toBe("BLOCK");
        expect(budget.settledAtomic).toBe("0");
      }
      if (scenario === "unknown") {
        expect(payment.receipt.status).toBe("UNKNOWN");
        expect(budget.outstandingAtomic).toBe("10000");
        const revoked = await client.revoke(snapshot.taskId, snapshot.etag);
        expect(revoked.authorization!.status).toBe("REVOKED");
        expect(revoked.budget.outstandingAtomic).toBe("10000");
      }
      if (scenario === "lesson") {
        const lessons = await client.lessons(snapshot.taskId);
        expect(lessons.items[0].status).toBe("ACTIVE");
        expect(lessons.memoryVersion).toBe("memory_m1");
      }
    },
  );

  it("approves and replays the exact review once, then reads its completion event", async () => {
    const { client, snapshot } = await launch("review");
    const review = (await client.reviews(snapshot.taskId)).items[0];
    expect(review.status).toBe("PENDING");
    const result = await client.resolveReview(
      snapshot.taskId,
      review,
      "APPROVE",
      "integration-approve-001",
    );
    expect(result.review.status).toBe("APPROVED");
    expect(
      await client.resolveReview(
        snapshot.taskId,
        review,
        "APPROVE",
        "integration-approve-001",
      ),
    ).toEqual(result);
    const completed = await poll(client, snapshot.taskId, "COMPLETED");
    expect(completed.budget.settledAtomic).toBe("10000");
    expect((await client.payments(snapshot.taskId)).items).toHaveLength(1);
    const abort = new AbortController();
    const seen: string[] = [];
    await subscribeTaskEvents(
      client,
      snapshot.taskId,
      completed.lastEventSeq - 1,
      {
        onResync() {
          throw new Error("Fresh cursor should not need resync");
        },
        onEvent(value) {
          seen.push(value.type);
          abort.abort();
        },
      },
      abort.signal,
    );
    expect(seen).toEqual(["task.completed"]);
  });

  it("rejects a review without creating a simulated authorization", async () => {
    const { client, snapshot } = await launch("review");
    const review = (await client.reviews(snapshot.taskId)).items[0];
    const result = await client.resolveReview(
      snapshot.taskId,
      review,
      "REJECT",
    );
    expect(result.review.status).toBe("REJECTED");
    expect(result.task.budget.settledAtomic).toBe("0");
    expect(result.task.budget.outstandingAtomic).toBe("0");
    const payment = (await client.payments(snapshot.taskId)).items[0];
    expect(payment.authorizationStatus).toBe("NOT_CREATED");
    expect(payment.receipt.status).toBe("NONE");
  });
});
