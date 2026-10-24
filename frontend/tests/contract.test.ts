import { createHash } from "node:crypto";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockOptions } from "../scripts/mock.mjs";
import { projectRoot, verifyContract } from "../scripts/check-contract.mjs";

let temporaryRoot: string;

beforeEach(() => {
  temporaryRoot = mkdtempSync(join(tmpdir(), "motion-contract-"));
  cpSync(
    join(projectRoot, "contract.lock.json"),
    join(temporaryRoot, "contract.lock.json"),
  );
  cpSync(join(projectRoot, "vendor"), join(temporaryRoot, "vendor"), {
    recursive: true,
  });
});

afterEach(() => rmSync(temporaryRoot, { recursive: true, force: true }));

describe("published frontend contract snapshot", () => {
  it("verifies the frozen spec, fixture and simulator bundle", () => {
    expect(verifyContract(temporaryRoot)).toMatchObject({
      ok: true,
      contractVersion: "0.2.0",
      verifiedFiles: 16,
    });
  });

  it("fails when the snapshot has not been published", () => {
    const path = join(temporaryRoot, "contract.lock.json");
    const lock = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(
      path,
      JSON.stringify({ ...lock, status: "pending", sha256: null }),
    );
    expect(() => verifyContract(temporaryRoot)).toThrow(/not published/);
  });

  it("detects fixture tampering even when OpenAPI is unchanged", () => {
    writeFileSync(
      join(temporaryRoot, "vendor/contract/fixtures/catalog.json"),
      "{}",
    );
    expect(() => verifyContract(temporaryRoot)).toThrow(
      /Snapshot file SHA-256 mismatch: fixtures\/catalog.json/,
    );
  });

  it("rejects a changed manifest inventory", () => {
    const path = join(temporaryRoot, "vendor/contract/release-manifest.json");
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    manifest.files.pop();
    writeFileSync(path, JSON.stringify(manifest));
    expect(() => verifyContract(temporaryRoot)).toThrow(
      /invalid bundle SHA-256/,
    );
  });

  it("rejects traversal paths even if the manifest bundle hash is updated", () => {
    const path = join(temporaryRoot, "vendor/contract/release-manifest.json");
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    manifest.files[0].path = "../outside";
    manifest.bundle_sha256 = createHash("sha256")
      .update(JSON.stringify(manifest.files))
      .digest("hex");
    const lockPath = join(temporaryRoot, "contract.lock.json");
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    writeFileSync(
      lockPath,
      JSON.stringify({ ...lock, bundle_sha256: manifest.bundle_sha256 }),
    );
    writeFileSync(path, JSON.stringify(manifest));
    expect(() => verifyContract(temporaryRoot)).toThrow(
      /Invalid snapshot path/,
    );
  });
});

describe("mock launcher options", () => {
  it("defaults to the local normal scenario", () => {
    expect(mockOptions()).toEqual({
      port: 4010,
      scenario: "normal",
      check: false,
    });
  });

  it("forwards explicit scenario, port and self-check options", () => {
    expect(
      mockOptions(["--scenario=review", "--port", "4012", "--check"]),
    ).toEqual({ port: 4012, scenario: "review", check: true });
  });

  it.each([
    ["--port=0"],
    ["--port=65536"],
    ["--port=4.1"],
    ["--scenario=production"],
    ["--scenario"],
    ["--unknown"],
  ])("rejects unsupported arguments %j", (...args) => {
    expect(() => mockOptions(args)).toThrow();
  });
});
