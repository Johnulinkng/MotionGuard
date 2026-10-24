import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const specPath = new URL('../vendor/contract/openapi.json', import.meta.url);
const bytes = readFileSync(specPath);
const spec = JSON.parse(bytes);
const lock = JSON.parse(readFileSync(new URL('../contract.lock.json', import.meta.url)));
const hash = createHash('sha256').update(bytes).digest('hex');
if (!JSON.stringify(lock).includes(hash)) throw new Error('Contract snapshot hash differs from contract.lock.json');
function ts(s) {
  if (s.$ref) return s.$ref.split('/').at(-1);
  if (s.const !== undefined) return JSON.stringify(s.const);
  if (s.enum) return s.enum.map(x => JSON.stringify(x)).join(' | ');
  if (s.anyOf || s.oneOf) return (s.anyOf || s.oneOf).map(ts).join(' | ');
  // Conditional constraints refine runtime validation, not the structural TS shape.
  if (s.allOf && !s.properties) return s.allOf.filter(x => x.$ref || x.properties || x.type).map(ts).join(' & ') || 'unknown';
  if (Array.isArray(s.type)) return s.type.map(type => ts({...s, type})).join(' | ');
  if (s.type === 'null') return 'null';
  if (s.type === 'string') return 'string';
  if (s.type === 'integer' || s.type === 'number') return 'number';
  if (s.type === 'boolean') return 'boolean';
  if (s.type === 'array') return `Array<${ts(s.items || {})}>`;
  if (s.type === 'object' || s.properties) {
    const required = new Set(s.required || []);
    return '{\n' + Object.entries(s.properties || {}).map(([k,v]) => `  ${JSON.stringify(k)}${required.has(k) ? '' : '?'}: ${ts(v)};`).join('\n') +
      (s.additionalProperties && typeof s.additionalProperties === 'object' ? `\n  [key: string]: ${ts(s.additionalProperties)};` : '') + '\n}';
  }
  return 'unknown';
}
const output = '// Generated from fixed OpenAPI snapshot. Run npm run generate; do not edit.\n' +
  Object.entries(spec.components.schemas).map(([name, schema]) => `export type ${name} = ${ts(schema)};\n`).join('\n');
mkdirSync(new URL('../src/generated/', import.meta.url), {recursive: true});
writeFileSync(new URL('../src/generated/contracts.ts', import.meta.url), output);
console.log(`Generated ${Object.keys(spec.components.schemas).length} public types; snapshot ${hash}`);
