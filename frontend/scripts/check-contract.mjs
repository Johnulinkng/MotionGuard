import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const VERSION = "0.2.0";
const SHA256 = /^[a-f0-9]{64}$/;
const hash = (value) => createHash("sha256").update(value).digest("hex");

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function localFile(root, pathname) {
  requireCondition(
    typeof pathname === "string" &&
      pathname.length > 0 &&
      !isAbsolute(pathname) &&
      !pathname.includes("\\") &&
      !pathname.includes(":") &&
      !pathname.includes("\0") &&
      pathname
        .split("/")
        .every((part) => part && part !== "." && part !== ".."),
    `Invalid snapshot path: ${String(pathname)}`,
  );
  const rootPath = realpathSync(root);
  const fullPath = realpathSync(resolve(rootPath, pathname));
  const withinRoot = relative(rootPath, fullPath);
  requireCondition(
    withinRoot !== ".." &&
      !withinRoot.startsWith(`..${sep}`) &&
      !isAbsolute(withinRoot),
    `Snapshot path escapes its directory: ${pathname}`,
  );
  requireCondition(
    statSync(fullPath).isFile(),
    `Snapshot entry is not a file: ${pathname}`,
  );
  return fullPath;
}

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));

/** Verify the published local bundle only; never read the lock's upstream source. */
export function verifyContract(root = projectRoot) {
  const lock = readJson(localFile(root, "contract.lock.json"));
  requireCondition(
    lock.status === "ready",
    "Contract snapshot is not published: lock status must be ready.",
  );
  requireCondition(
    lock.contract_version === VERSION,
    `Expected frozen contract version ${VERSION}.`,
  );
  requireCondition(
    lock.hash_algorithm === "sha256",
    "Contract lock must use sha256.",
  );
  requireCondition(
    SHA256.test(lock.sha256 ?? ""),
    "Contract lock is missing the OpenAPI SHA-256.",
  );
  requireCondition(
    SHA256.test(lock.bundle_sha256 ?? ""),
    "Contract lock is missing the bundle SHA-256.",
  );
  requireCondition(
    lock.snapshot === "vendor/contract/openapi.json",
    "Contract snapshot must stay in vendor/contract/openapi.json.",
  );

  const snapshotPath = localFile(root, lock.snapshot);
  const vendorRoot = dirname(snapshotPath);
  const specBytes = readFileSync(snapshotPath);
  const spec = JSON.parse(specBytes.toString("utf8"));
  requireCondition(
    hash(specBytes) === lock.sha256,
    "OpenAPI SHA-256 differs from contract.lock.json.",
  );
  requireCondition(
    spec.openapi === "3.1.0",
    "Expected the published OpenAPI 3.1.0 snapshot.",
  );
  requireCondition(
    spec.info?.version === VERSION,
    "OpenAPI version differs from the frozen contract version.",
  );

  const manifest = readJson(localFile(vendorRoot, "release-manifest.json"));
  requireCondition(
    manifest.contract_version === VERSION,
    "Release manifest contract version mismatch.",
  );
  requireCondition(
    manifest.sha256 === lock.sha256,
    "Release manifest OpenAPI hash differs from the lock.",
  );
  requireCondition(
    manifest.bundle_sha256 === lock.bundle_sha256,
    "Release manifest bundle hash differs from the lock.",
  );
  requireCondition(
    Array.isArray(manifest.files) && manifest.files.length > 0,
    "Release manifest has no file inventory.",
  );
  requireCondition(
    hash(JSON.stringify(manifest.files)) === lock.bundle_sha256,
    "Release manifest file inventory has an invalid bundle SHA-256.",
  );

  const verified = new Set();
  for (const entry of manifest.files) {
    requireCondition(
      entry && typeof entry.path === "string",
      "Release manifest has an invalid file entry.",
    );
    requireCondition(
      !verified.has(entry.path),
      `Release manifest repeats ${entry.path}.`,
    );
    requireCondition(
      SHA256.test(entry.sha256 ?? ""),
      `Invalid file hash for ${entry.path}.`,
    );
    const fullPath = localFile(vendorRoot, entry.path);
    requireCondition(
      hash(readFileSync(fullPath)) === entry.sha256,
      `Snapshot file SHA-256 mismatch: ${entry.path}`,
    );
    verified.add(entry.path);
  }
  for (const required of [
    "openapi.json",
    "mock-server.mjs",
    "API_GUIDE.md",
    "fixtures/manifest.json",
  ]) {
    requireCondition(
      verified.has(required),
      `Release manifest is missing ${required}.`,
    );
  }
  const fixtureManifest = readJson(
    localFile(vendorRoot, "fixtures/manifest.json"),
  );
  requireCondition(
    fixtureManifest.contractVersion === VERSION,
    "Fixture manifest contract version mismatch.",
  );
  requireCondition(
    Array.isArray(fixtureManifest.fixtures),
    "Fixture manifest has no fixture inventory.",
  );
  for (const fixture of fixtureManifest.fixtures) {
    requireCondition(
      typeof fixture.file === "string" &&
        verified.has(`fixtures/${fixture.file}`),
      `Unpublished fixture: ${String(fixture.file)}`,
    );
  }

  return {
    ok: true,
    contractVersion: VERSION,
    openapiSha256: lock.sha256,
    bundleSha256: lock.bundle_sha256,
    verifiedFiles: verified.size,
    scope:
      "Published contract integrity only; no payment or backend validation.",
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    console.log(JSON.stringify(verifyContract(), null, 2));
  } catch (error) {
    console.error(`Contract check failed: ${error.message}`);
    process.exitCode = 1;
  }
}
