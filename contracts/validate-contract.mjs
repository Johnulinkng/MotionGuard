import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import SwaggerParser from '@apidevtools/swagger-parser';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const contractRoot = path.dirname(fileURLToPath(import.meta.url));
const httpMethods = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);
const mutationMethods = new Set(['post', 'put', 'patch', 'delete']);
const privateFieldNames = new Set([
  'signature', 'rawsignature', 'signingkey', 'secretkey', 'accesskey', 'modelapikey',
  'embeddingapikey', 'ipctoken', 'ipccredentials', 'ipccredential', 'executiongrant',
  'rawauthorization', 'signedauthorization', 'eip3009authorization', 'paymentpayload',
  'rawpaymentpayload', 'rawconversation', 'rawdialogue', 'chainofthought',
  'hiddenreasoning', 'databasepath', 'providerstacktrace', 'stacktrace',
  'rawevidence', 'executablerule', 'rulecode', 'fullprompt', 'systemprompt',
]);

function safeKey(key) {
  return key.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function isSensitiveField(key) {
  const normalized = safeKey(key);
  return privateFieldNames.has(normalized)
    || /privatekey|apikey|mnemonic|seedphrase|password|clientsecret/.test(normalized);
}

function visit(value, callback, pointer = '#', ancestors = new Set()) {
  callback(value, pointer);
  if (!value || typeof value !== 'object' || ancestors.has(value)) return;
  const nextAncestors = new Set(ancestors).add(value);
  for (const [key, child] of Object.entries(value)) {
    visit(child, callback, `${pointer}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`, nextAncestors);
  }
}

function pointerGet(document, reference) {
  if (reference === '#') return document;
  if (!reference.startsWith('#/')) throw new Error(`Only internal JSON references are allowed: ${reference}`);
  const segments = decodeURIComponent(reference.slice(2)).split('/').map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'));
  let current = document;
  for (const segment of segments) {
    if (!current || typeof current !== 'object' || !Object.hasOwn(current, segment)) {
      throw new Error(`Unresolved reference: ${reference}`);
    }
    current = current[segment];
  }
  return current;
}

function resolve(document, value, seen = new Set()) {
  if (!value || typeof value !== 'object' || !value.$ref) return value;
  if (seen.has(value.$ref)) throw new Error(`Circular reference outside a schema: ${value.$ref}`);
  return resolve(document, pointerGet(document, value.$ref), new Set(seen).add(value.$ref));
}

function normalizeSchema(value) {
  if (Array.isArray(value)) return value.map(normalizeSchema);
  if (!value || typeof value !== 'object') return value;
  const output = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === '$ref' && typeof child === 'string' && child.startsWith('#/components/schemas/')) {
      output[key] = child.replace('#/components/schemas/', '#/$defs/');
    } else {
      output[key] = normalizeSchema(child);
    }
  }
  return output;
}

function allowsValue(document, inputSchema, expected) {
  const schema = resolve(document, inputSchema);
  return schema && (schema.const === expected || (Array.isArray(schema.enum) && schema.enum.includes(expected)));
}

function schemaVersionFixed(document, inputSchema, version) {
  const schema = resolve(document, inputSchema);
  return schema && (schema.const === version || (Array.isArray(schema.enum) && schema.enum.length === 1 && schema.enum[0] === version));
}

function formatAjvErrors(errors) {
  return (errors ?? []).map((error) => `${error.instancePath || '/'} ${error.message}${error.params ? ` ${JSON.stringify(error.params)}` : ''}`).join('; ');
}

function fail(errors, message) {
  errors.push(message);
}

function checkSensitiveData(value, label, errors, { fixture = false } = {}) {
  visit(value, (node, pointer) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    for (const [key, child] of Object.entries(node)) {
      if (isSensitiveField(key)) fail(errors, `${label}${pointer.slice(1)}/${key}: forbidden public field`);
      if (fixture && /^(txHash|transactionHash)$/i.test(key) && child !== null) {
        fail(errors, `${label}${pointer.slice(1)}/${key}: MOCK fixtures must not claim a transaction hash`);
      }
      if (fixture && /^(executionMode|mode)$/i.test(key) && ['MOCK', 'TESTNET', 'MAINNET'].includes(child) && child !== 'MOCK') {
        fail(errors, `${label}${pointer.slice(1)}/${key}: fixtures must use MOCK execution mode`);
      }
    }
  });
  visit(value, (node, pointer) => {
    if (typeof node !== 'string') return;
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(node)
      || /\b(?:sk|rk)-(?:proj-)?[A-Za-z0-9_-]{20,}\b/.test(node)
      || /\bBearer\s+[A-Za-z0-9._-]{20,}/i.test(node)) {
      fail(errors, `${label}${pointer.slice(1)}: possible credential material in public data`);
    }
  });
}

async function jsonFile(filename) {
  const raw = await readFile(filename, 'utf8');
  return JSON.parse(raw.replace(/^\uFEFF/, ''));
}

/** Validate the source contract and immutable public fixture examples. No service is started. */
export async function validateContract(root = contractRoot, { readJson = jsonFile, listDirectory = readdir } = {}) {
  const errors = [];
  const document = await readJson(path.join(root, 'openapi.json'));
  const manifest = await readJson(path.join(root, 'fixtures', 'manifest.json'));
  const version = document.info?.version;
  const objectFormatVersion = document['x-object-format-version'] ?? version;
  if (document.openapi !== '3.1.0' && document.openapi !== '3.1.1') fail(errors, 'openapi: expected OpenAPI 3.1');
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) fail(errors, 'info.version: expected a semantic contract version');
  if (document['x-contract-version'] !== version) fail(errors, 'x-contract-version must match info.version');
  if (manifest.contractVersion !== version) fail(errors, 'fixtures/manifest.json: contractVersion must match info.version');

  let referenceCount = 0;
  visit(document, (node, pointer) => {
    if (!node || typeof node !== 'object' || !Object.hasOwn(node, '$ref')) return;
    referenceCount += 1;
    try {
      if (typeof node.$ref !== 'string') throw new Error('$ref must be a string');
      pointerGet(document, node.$ref);
    } catch (error) {
      fail(errors, `openapi${pointer.slice(1)}: ${error.message}`);
    }
  });
  // Do not let a malformed contract trigger remote network resolution.
  if (!errors.length) {
    try {
      await SwaggerParser.validate(structuredClone(document), { resolve: { external: false } });
    } catch (error) {
      fail(errors, `OpenAPI structural validation: ${error.message}`);
    }
  }

  // Conditional branches may constrain a property whose type is declared in the
  // parent schema. This is valid JSON Schema; Ajv's strictTypes lint forbids it.
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false, strictRequired: true, validateFormats: true });
  addFormats(ajv);
  // OpenAPI annotations are not JSON Schema validation keywords.
  for (const keyword of ['discriminator', 'example', 'xml', 'externalDocs']) ajv.addKeyword(keyword);
  const schemas = document.components?.schemas ?? {};
  const definitions = normalizeSchema(schemas);
  const validationCache = new Map();
  const validateExample = (schema, value, label) => {
    try {
      const normalized = normalizeSchema(schema);
      const cacheKey = JSON.stringify(normalized);
      let validator = validationCache.get(cacheKey);
      if (!validator) {
        validator = ajv.compile({ $schema: 'https://json-schema.org/draft/2020-12/schema', $defs: definitions, allOf: [normalized] });
        validationCache.set(cacheKey, validator);
      }
      if (!validator(value)) fail(errors, `${label}: ${formatAjvErrors(validator.errors)}`);
      else if (resolve(document, schema)?.properties?.schemaVersion?.const === '0.2.0' && resolve(document, schema)?.properties?.sources) {
        for (const source of value.sources) if (!value.evidenceIds.includes(source.evidenceId)) fail(errors, `${label}: TaskResult source must reference one of its evidenceIds`);
        if (value.dataMode === 'LIVE_HTTP' && value.learningMode !== 'NO_ONLINE_LABELS') fail(errors, `${label}: LIVE_HTTP must not claim sandbox-oracle labels`);
      }
    } catch (error) {
      fail(errors, `${label}: invalid JSON Schema: ${error.message}`);
    }
  };
  for (const [name, schema] of Object.entries(schemas)) {
    try {
      ajv.compile({ $schema: 'https://json-schema.org/draft/2020-12/schema', $defs: definitions, allOf: [normalizeSchema(schema)] });
    } catch (error) {
      fail(errors, `components/schemas/${name}: ${error.message}`);
    }
    visit(schema, (node, pointer) => {
      if (!node || typeof node !== 'object' || Array.isArray(node)) return;
      if (node.properties) {
        for (const property of Object.keys(node.properties)) {
          if (isSensitiveField(property)) fail(errors, `components/schemas/${name}${pointer.slice(1)}/properties/${property}: forbidden public field`);
        }
      }
      const types = Array.isArray(node.type) ? node.type : [node.type];
      if (types.includes('object') && node.additionalProperties !== false && node.unevaluatedProperties !== false) {
        fail(errors, `components/schemas/${name}${pointer.slice(1)}: public object schemas must reject undeclared fields`);
      }
      if (Object.hasOwn(node, 'example')) {
        validateExample(node, node.example, `components/schemas/${name}${pointer.slice(1)}/example`);
        checkSensitiveData(node.example, `components/schemas/${name}${pointer.slice(1)}/example`, errors, { fixture: true });
      }
      if (Array.isArray(node.examples)) node.examples.forEach((value, index) => {
        validateExample(node, value, `components/schemas/${name}${pointer.slice(1)}/examples/${index}`);
        checkSensitiveData(value, `components/schemas/${name}${pointer.slice(1)}/examples/${index}`, errors, { fixture: true });
      });
    });
  }

  let operationCount = 0;
  let mutationCount = 0;
  let inlineExampleCount = 0;
  const operationIds = new Set();
  const validateExamples = (holder, label, { fixture = false } = {}) => {
    if (!holder?.schema) return;
    if (Object.hasOwn(holder, 'example')) {
      inlineExampleCount += 1;
      validateExample(holder.schema, holder.example, `${label}/example`);
      checkSensitiveData(holder.example, `${label}/example`, errors, { fixture });
    }
    for (const [name, rawExample] of Object.entries(holder.examples ?? {})) {
      const example = resolve(document, rawExample);
      if (example.externalValue) fail(errors, `${label}/examples/${name}: examples must be local and auditable`);
      if (!Object.hasOwn(example, 'value')) continue;
      inlineExampleCount += 1;
      validateExample(holder.schema, example.value, `${label}/examples/${name}`);
      checkSensitiveData(example.value, `${label}/examples/${name}`, errors, { fixture });
    }
  };

  for (const [route, rawPathItem] of Object.entries(document.paths ?? {})) {
    const pathItem = resolve(document, rawPathItem);
    if (!route.startsWith('/api/v1/')) fail(errors, `${route}: public API paths must be under /api/v1/`);
    if (/\/(internal|signer)(\/|$)/i.test(route)) fail(errors, `${route}: private service routes cannot be public`);
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!httpMethods.has(method)) continue;
      operationCount += 1;
      const operationLabel = `${method.toUpperCase()} ${route}`;
      if (!operation.operationId || operationIds.has(operation.operationId)) fail(errors, `${operationLabel}: operationId is missing or duplicated`);
      operationIds.add(operation.operationId);
      const parameters = [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])].map((parameter) => resolve(document, parameter));
      const headers = new Map(parameters.filter((parameter) => parameter.in === 'header').map((parameter) => [parameter.name.toLowerCase(), parameter]));
      const requireHeader = (name) => {
        const header = headers.get(name.toLowerCase());
        if (!header || header.required !== true) fail(errors, `${operationLabel}: ${name} must be a required request header`);
        return header;
      };
      const versionHeader = requireHeader('X-Contract-Version');
      if (versionHeader && !schemaVersionFixed(document, versionHeader.schema, version)) fail(errors, `${operationLabel}: X-Contract-Version must be fixed to ${version}`);
      if (mutationMethods.has(method)) {
        mutationCount += 1;
        requireHeader('Idempotency-Key');
        if (/\{[^}]+\}/.test(route)) requireHeader('If-Match');
      }
      for (const parameter of parameters) validateExamples(parameter, `${operationLabel}/parameters/${parameter.name}`);
      const requestBody = resolve(document, operation.requestBody);
      for (const [mediaType, media] of Object.entries(requestBody?.content ?? {})) {
        validateExamples(media, `${operationLabel}/requestBody/${mediaType}`);
      }
      const responses = operation.responses ?? {};
      if (!Object.keys(responses).some((status) => /^2\d\d$/.test(status))) fail(errors, `${operationLabel}: no successful response is documented`);
      for (const [status, rawResponse] of Object.entries(responses)) {
        const response = resolve(document, rawResponse);
        const responseHeaders = new Map(Object.entries(response.headers ?? {}).map(([name, header]) => [name.toLowerCase(), resolve(document, header)]));
        if (!schemaVersionFixed(document, responseHeaders.get('x-contract-version')?.schema, version)) fail(errors, `${operationLabel}/${status}: response X-Contract-Version must be fixed to ${version}`);
        const modeHeader = responseHeaders.get('x-execution-mode');
        if (!modeHeader || !allowsValue(document, modeHeader.schema, 'MOCK') || !allowsValue(document, modeHeader.schema, 'TESTNET')) fail(errors, `${operationLabel}/${status}: X-Execution-Mode must document MOCK and TESTNET`);
        const isSse = Object.hasOwn(response.content ?? {}, 'text/event-stream');
        if (isSse) {
          if (!response['x-event-schema']?.$ref) {
            fail(errors, `${operationLabel}/${status}: SSE must declare x-event-schema`);
          } else {
            const eventSchema = resolve(document, response['x-event-schema']);
            if (!schemaVersionFixed(document, eventSchema?.properties?.schemaVersion, objectFormatVersion)) fail(errors, `${operationLabel}/${status}: SSE event schemaVersion must be fixed to object format ${objectFormatVersion}`);
            for (const field of ['eventId', 'taskId', 'type', 'occurredAt', 'aggregateVersion', 'executionMode']) {
              if (!eventSchema?.required?.includes(field)) fail(errors, `${operationLabel}/${status}: SSE event schema must require ${field}`);
            }
          }
        }
        if (/^2\d\d$/.test(status) && !isSse && status !== '204' && !responseHeaders.has('etag')) fail(errors, `${operationLabel}/${status}: resource response must document ETag`);
        for (const [name, header] of responseHeaders) validateExamples(header, `${operationLabel}/${status}/headers/${name}`);
        for (const [mediaType, media] of Object.entries(response.content ?? {})) {
          validateExamples(media, `${operationLabel}/${status}/${mediaType}`, { fixture: true });
        }
      }
    }
  }
  if (!operationCount) fail(errors, 'paths: contract must include public API operations');

  if (!Array.isArray(manifest.fixtures) || !manifest.fixtures.length) fail(errors, 'fixtures/manifest.json: fixtures must be a non-empty array');
  const registeredFiles = new Set();
  let fixtureCount = 0;
  const fixtureDirectory = path.resolve(root, 'fixtures');
  for (const entry of manifest.fixtures ?? []) {
    if (!entry || typeof entry.file !== 'string' || typeof entry.schema !== 'string') {
      fail(errors, 'fixtures/manifest.json: each entry must name file and schema');
      continue;
    }
    const filename = path.resolve(fixtureDirectory, entry.file);
    if (!filename.startsWith(`${fixtureDirectory}${path.sep}`) || !entry.file.endsWith('.json')) {
      fail(errors, `fixture ${entry.file}: file must stay inside fixtures/ and use .json`);
      continue;
    }
    if (registeredFiles.has(entry.file)) fail(errors, `fixture ${entry.file}: duplicate manifest entry`);
    registeredFiles.add(entry.file);
    if (!Object.hasOwn(schemas, entry.schema)) {
      fail(errors, `fixture ${entry.file}: unknown schema ${entry.schema}`);
      continue;
    }
    try {
      const fixture = await readJson(filename);
      fixtureCount += 1;
      validateExample({ $ref: `#/components/schemas/${entry.schema}` }, fixture, `fixture ${entry.file}`);
      checkSensitiveData(fixture, `fixture ${entry.file}`, errors, { fixture: true });
      // Pure catalog/plan/review views have no execution mode field; their
      // execution context is carried by the required transport response header.
      // Every mode field actually present in a fixture is checked above.
    } catch (error) {
      fail(errors, `fixture ${entry.file}: ${error.message}`);
    }
  }
  for (const entry of await listDirectory(fixtureDirectory, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.json') && entry.name !== 'manifest.json' && !registeredFiles.has(entry.name)) fail(errors, `fixture ${entry.name}: JSON file is missing from manifest`);
  }

  return { ok: errors.length === 0, version, operationCount, mutationCount, schemaCount: Object.keys(schemas).length, fixtureCount, inlineExampleCount, referenceCount, errors };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await validateContract();
    if (!result.ok) {
      for (const error of result.errors) console.error(`FAIL ${error}`);
      console.error(`Contract validation failed (${result.errors.length} errors).`);
      process.exitCode = 1;
    } else {
      console.log(`Contract ${result.version} valid: ${result.operationCount} operations (${result.mutationCount} mutations), ${result.schemaCount} schemas, ${result.fixtureCount} fixtures, ${result.inlineExampleCount} inline examples, ${result.referenceCount} internal refs.`);
    }
  } catch (error) {
    console.error(`Contract validation failed: ${error.message}`);
    process.exitCode = 1;
  }
}
