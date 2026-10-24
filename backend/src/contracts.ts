import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsImport from 'ajv-formats';
const addFormats = addFormatsImport as unknown as (ajv: Ajv2020) => void;
export const CONTRACT_VERSION = '0.2.0' as const;
const bytes = readFileSync(new URL('../vendor/contract/openapi.json', import.meta.url));
const lock = JSON.parse(readFileSync(new URL('../contract.lock.json', import.meta.url), 'utf8'));
if (createHash('sha256').update(bytes).digest('hex') !== lock.sha256) throw new Error('CONTRACT_HASH_MISMATCH');
export const contract = JSON.parse(bytes.toString());
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema({ $id: 'motion', ...contract });
const validators = new Map<string, ReturnType<Ajv2020['compile']>>();
export function validateSchema(name: string, value: unknown): boolean {
  let check = validators.get(name);
  if (!check) { check = ajv.compile({ $ref: `motion#/components/schemas/${name}` }); validators.set(name, check); }
  return !!check(value);
}
export function schemaErrors(name: string) { return validators.get(name)?.errors ?? []; }
export function assertSchema(name: string, value: unknown): void {
  if (!validateSchema(name, value)) throw new Error(`CONTRACT_RESPONSE_INVALID ${name}: ${JSON.stringify(schemaErrors(name))}`);
}
