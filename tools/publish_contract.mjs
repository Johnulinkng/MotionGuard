// Contract-owner tooling. Copies a tested release into independently committed repositories.
import { readFile, writeFile, mkdir, readdir, lstat, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'contracts');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const apiBytes = await readFile(path.join(source, 'openapi.json'));
const api = JSON.parse(apiBytes);
const version = api.info?.version;
if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) throw new Error('Missing semantic contract version');
const files = ['openapi.json', 'API_GUIDE.md', 'mock-server.mjs'];
async function collect(relative) {
  for (const item of await readdir(path.join(source, relative), { withFileTypes: true })) {
    const child = path.posix.join(relative, item.name);
    if (item.isSymbolicLink()) throw new Error(`Symlink is not a release input: ${child}`);
    if (item.isDirectory()) await collect(child);
    else if (item.isFile() && item.name.endsWith('.json')) files.push(child);
  }
}
await collect('fixtures');
files.sort();
const entries = [];
for (const file of files) {
  if (!(await lstat(path.join(source, file))).isFile()) throw new Error(`Not a regular file: ${file}`);
  const bytes = await readFile(path.join(source, file));
  entries.push({ path: file, sha256: digest(bytes) });
}
const sha256 = digest(apiBytes);
const bundle_sha256 = digest(JSON.stringify(entries));
// Validate every target before any write. A ready version is immutable.
for (const name of ['frontend', 'backend']) {
  const previous = JSON.parse(await readFile(path.join(root, name, 'contract.lock.json'), 'utf8'));
  if (previous.status === 'ready' && previous.contract_version === version &&
      (previous.sha256 !== sha256 || previous.bundle_sha256 !== bundle_sha256)) {
    throw new Error(`${name}: ready ${version} differs; publish a new contract version first`);
  }
}
const release = { contract_version: version, sha256, bundle_sha256, files: entries,
  published_at: new Date().toISOString(), verification_scope: 'schema, fixtures and mock; no product or payment validation' };
for (const name of ['frontend', 'backend']) {
  const targetRoot = path.join(root, name, 'vendor', 'contract');
  for (const file of files) {
    const target = path.resolve(targetRoot, file);
    if (!target.startsWith(targetRoot + path.sep)) throw new Error('Release path escapes snapshot');
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(source, file), target);
  }
  await writeFile(path.join(targetRoot, 'release-manifest.json'), JSON.stringify(release, null, 2) + '\n');
  await writeFile(path.join(root, name, 'contract.lock.json'), JSON.stringify({
    contract_version: version, source: '../contracts/openapi.json',
    snapshot: 'vendor/contract/openapi.json', hash_algorithm: 'sha256', sha256,
    bundle_sha256, status: 'ready'
  }, null, 2) + '\n');
}
await writeFile(path.join(source, 'release-manifest.json'), JSON.stringify(release, null, 2) + '\n');
process.stdout.write(JSON.stringify({ contract_version: version, sha256, bundle_sha256,
  files: files.length, snapshots: ['frontend', 'backend'] }, null, 2) + '\n');
