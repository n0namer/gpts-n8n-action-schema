#!/usr/bin/env node
/**
 * validate-schema.mjs
 *
 * Validates generated openapi.yaml against GPT Builder compatibility rules.
 * Exit code: 0 = PASS, 1 = FAIL
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const allowlist = JSON.parse(readFileSync(resolve(ROOT, 'config/actions.allowlist.json'), 'utf8'));
const forbiddenGptIds = new Set(allowlist.forbidden_operation_ids || []);

let spec;
try {
  spec = yaml.load(readFileSync(resolve(ROOT, 'openapi.yaml'), 'utf8'));
} catch (e) {
  console.error(`FAIL YAML_PARSE: ${e.message}`);
  process.exit(1);
}

const rawYaml = readFileSync(resolve(ROOT, 'openapi.yaml'), 'utf8');

const checks = [];
function check(name, pass, detail = '') {
  checks.push({ name, status: pass ? 'PASS' : 'FAIL', detail });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}: ${name}${detail ? ' — ' + detail : ''}`);
}

// 1. YAML parsed
check('YAML_PARSE', true, 'parsed successfully');

// 2. openapi version — must be 3.1.0 or 3.1.1 for GPT Builder
const ver = (spec.openapi || '').toString();
check('OPENAPI_VERSION', ver === '3.1.0' || ver === '3.1.1', `version=${ver}`);

// 3. Server URL correct
const servers = spec.servers || [];
const serverOk = servers.some(s =>
  (s.url || '').includes('n8n-control-production.up.railway.app') &&
  (s.url || '').includes('/api/v1')
);
check('SERVER_URL', serverOk, serverOk ? servers.map(s => s.url).join(', ') : 'missing n8n-control URL');

// 4. Security scheme: apiKey header X-N8N-API-KEY
const secSchemes = spec.components?.securitySchemes || {};
const n8nKeyScheme = Object.entries(secSchemes).find(([, s]) =>
  s?.type === 'apiKey' && s?.in === 'header' && s?.name === 'X-N8N-API-KEY'
);
check('SECURITY_SCHEME', !!n8nKeyScheme, n8nKeyScheme ? 'apiKey X-N8N-API-KEY' : 'missing');

// 5. Security requirement references existing scheme
const security = spec.security || [];
const secRefOk = security.some(s => Object.keys(s).some(k => secSchemes[k]));
check('SECURITY_REQUIRES_KEY', secRefOk, 'references N8nApiKey');

// 5b. components must exist
const componentsExist = !!(spec.components && typeof spec.components === 'object' && !Array.isArray(spec.components));
check('COMPONENTS_EXIST', componentsExist, componentsExist ? 'ok' : 'missing or not object');

// 5c. components.schemas must exist and be a non-array object
const schemasExist = !!(spec.components?.schemas && typeof spec.components.schemas === 'object' && !Array.isArray(spec.components.schemas));
check('COMPONENTS_SCHEMAS_EXIST', schemasExist,
  schemasExist ? `object with ${Object.keys(spec.components.schemas).length} entries` : 'missing or not object');

// ── Collect all operations ──────────────────────────────────────────
const allOps = [];
for (const [path, methods] of Object.entries(spec.paths || {})) {
  for (const [method, op] of Object.entries(methods)) {
    allOps.push({ path, method, op });
  }
}

// 6. operationIds unique
const allIds = allOps.map(o => o.op.operationId).filter(Boolean);
const dups = allIds.filter((id, i) => allIds.indexOf(id) !== i);
check('OPERATION_IDS_UNIQUE', dups.length === 0,
  dups.length > 0 ? `DUPLICATES: ${[...new Set(dups)].join(', ')}` : `${allIds.length} unique`);

// 7. operationIds count <= 30
const limit = Math.min(30, allowlist.max_operations || 30);
check('OPERATION_IDS_COUNT', allIds.length <= limit,
  `${allIds.length} ops (limit ${limit})`);

// 8. Forbidden operationIds absent
const foundBad = allIds.filter(id => forbiddenGptIds.has(id));
check('FORBIDDEN_ABSENT', foundBad.length === 0,
  foundBad.length > 0 ? `FOUND: ${foundBad.join(', ')}` : 'all clear');

// ── Parameter checks ────────────────────────────────────────────────
let badParams = [];
let missingPathParams = [];

for (const { path, method, op } of allOps) {
  const params = op.parameters || [];

  // Extract path template names like {id}, {versionId}
  const templateNames = [...path.matchAll(/\{(\w+)\}/g)].map(m => m[1]);

  for (const p of params) {
    // Check each param has required fields
    if (!p.name || !p.in || !p.schema) {
      badParams.push(`${op.operationId} (${method.toUpperCase()} ${path}): param missing name/in/schema — ${JSON.stringify(p)}`);
    }
    // Check path params require required: true
    if (p.in === 'path' && p.required !== true) {
      badParams.push(`${op.operationId} (${method.toUpperCase()} ${path}): path param "${p.name}" required should be true`);
    }
  }

  // Check each path template has a corresponding path parameter
  const existingPathNames = params.filter(p => p.in === 'path').map(p => p.name);
  for (const tpl of templateNames) {
    if (!existingPathNames.includes(tpl)) {
      missingPathParams.push(`${op.operationId} (${method.toUpperCase()} ${path}): missing path param for {${tpl}}`);
    }
  }
}

check('PARAMS_HAVE_NAME_IN_SCHEMA', badParams.length === 0,
  badParams.length > 0 ? badParams.slice(0, 5).join('; ') : `all ${allOps.reduce((s, o) => s + (o.op.parameters || []).length, 0)} params valid`);

check('PATH_PARAMS_COVER_TEMPLATES', missingPathParams.length === 0,
  missingPathParams.length > 0 ? missingPathParams.slice(0, 5).join('; ') : 'all path templates covered');

// 9. createWorkflow exists
const createWf = allOps.find(o => o.op.operationId === 'createWorkflow');
check('CREATE_WORKFLOW_EXISTS', !!createWf, createWf ? `at ${createWf.method.toUpperCase()} ${createWf.path}` : 'MISSING');

// 10. createWorkflow requestBody.required == true
let reqBodyReqOk = false;
if (createWf) {
  reqBodyReqOk = createWf.op.requestBody?.required === true;
}
check('CREATE_WF_REQBODY_REQUIRED', reqBodyReqOk,
  createWf?.op?.requestBody?.required !== undefined ? `required=${createWf.op.requestBody.required}` : 'no requestBody');

// 11. createWorkflow schema requires name,nodes,connections,settings
let reqFieldsOk = false;
let reqDet = '';
if (createWf) {
  const s = createWf.op.requestBody?.content?.['application/json']?.schema;
  const req = s?.required || [];
  reqDet = `required=[${req.join(',')}]`;
  reqFieldsOk = req.includes('name') && req.includes('nodes') && req.includes('connections') && req.includes('settings');
}
check('CREATE_WF_REQUIRED_FIELDS', reqFieldsOk, reqDet);

// 12. createWorkflow schema additionalProperties == false
let addPropsOk = false;
if (createWf) {
  const s = createWf.op.requestBody?.content?.['application/json']?.schema;
  addPropsOk = s?.additionalProperties === false;
}
check('CREATE_WF_ADDITIONAL_PROPS_FALSE', addPropsOk,
  addPropsOk ? 'false' : 'not false');

// 13. No external $ref
const allRefs = [];
const extRefs = [];
const refMatches = rawYaml.match(/\$ref:\s*['"][^'"]+['"]/g) || [];
for (const ref of refMatches) {
  const val = ref.replace(/\$ref:\s*['"]/, '').replace(/['"]$/, '');
  allRefs.push(val);
  if (!val.startsWith('#/')) extRefs.push(val);
}
check('NO_EXTERNAL_REF', extRefs.length === 0,
  extRefs.length > 0 ? `EXTERNAL: ${extRefs.join(', ')}` : `${allRefs.length} internal refs only`);

// ── AnyResponse / $ref / anchor bans ───────────────────────────────-

// 20. No AnyResponse in raw YAML
const anyResponseMatches = rawYaml.match(/AnyResponse/g) || [];
check('NO_ANY_RESPONSE', anyResponseMatches.length === 0,
  anyResponseMatches.length > 0 ? `FOUND ${anyResponseMatches.length} occurrences` : 'clean');

// 21. No $ref in any response schema
let responseRefs = [];
for (const { path, method, op } of allOps) {
  for (const [code, resp] of Object.entries(op.responses || {})) {
    const schema = resp?.content?.['application/json']?.schema;
    if (schema && schema.$ref) {
      responseRefs.push(`${op.operationId} (${code}): $ref in response`);
    }
  }
}
check('NO_REF_IN_RESPONSES', responseRefs.length === 0,
  responseRefs.length > 0 ? responseRefs.join('; ') : 'no $ref in any response');

// 22. No YAML anchors/aliases (&ref_ or *ref_)
const anchorMatches = rawYaml.match(/&ref_|\*ref_/g) || [];
check('NO_YAML_ANCHORS', anchorMatches.length === 0,
  anchorMatches.length > 0 ? `FOUND ${anchorMatches.length} occurrences` : 'clean');

// 23. components.schemas: if non-empty, every schema must have properties
let schemasWithoutProps = [];
for (const [name, schema] of Object.entries(spec.components?.schemas || {})) {
  if (schema && typeof schema === 'object' && !schema.properties && !schema.additionalProperties && !schema.type?.startsWith?.('array')) {
    schemasWithoutProps.push(`${name}: no properties`);
  }
}
check('SCHEMAS_HAVE_PROPERTIES', schemasWithoutProps.length === 0,
  schemasWithoutProps.length > 0 ? schemasWithoutProps.join('; ') : 'all non-empty schemas have properties (or schemas is empty)');

// ── NEW CHECKS (continued) ──────────────────────────────────────────

// 14. No additionalProperties: null or properties: null in raw YAML
const nullAddProps = rawYaml.match(/additionalProperties:\s*null/g) || [];
const nullProps = rawYaml.match(/properties:\s*null/g) || [];
check('NO_NULL_ADDITIONAL_PROPS', nullAddProps.length === 0,
  nullAddProps.length > 0 ? `FOUND ${nullAddProps.length} occurrences` : 'clean');
check('NO_NULL_PROPERTIES', nullProps.length === 0,
  nullProps.length > 0 ? `FOUND ${nullProps.length} occurrences` : 'clean');

// 15. Check requestBody schemas: if required fields listed, they must exist in properties
let reqBodyMissingProps = [];
for (const { path, method, op } of allOps) {
  const rb = op.requestBody;
  if (!rb?.content?.['application/json']?.schema) continue;
  const s = rb.content['application/json'].schema;
  const required = s.required || [];
  const props = s.properties || {};
  for (const field of required) {
    if (!props[field]) {
      reqBodyMissingProps.push(`${op.operationId}: required field "${field}" not in properties`);
    }
  }
}
check('REQBODY_REQUIRED_PROPS_EXIST', reqBodyMissingProps.length === 0,
  reqBodyMissingProps.length > 0 ? reqBodyMissingProps.join('; ') : 'all required fields have properties');

// 16. Schema required fields have valid properties types
let schemaPropTypeIssues = [];
for (const [name, schema] of Object.entries(spec.components?.schemas || {})) {
  const required = schema.required || [];
  const props = schema.properties || {};
  for (const field of required) {
    const prop = props[field];
    if (!prop || (typeof prop === 'object' && !prop.type && !prop.$ref && !prop.oneOf && !prop.anyOf && !prop.allOf)) {
      schemaPropTypeIssues.push(`schema "${name}": required field "${field}" missing type info`);
    }
  }
}
check('SCHEMA_REQUIRED_FIELD_TYPES', schemaPropTypeIssues.length === 0,
  schemaPropTypeIssues.length > 0 ? schemaPropTypeIssues.join('; ') : 'all required fields typed');

// 17. No requestBody property clashes with path parameters for same operation
let paramClashes = [];
for (const { path, method, op } of allOps) {
  const params = op.parameters || [];
  const pathParamNames = params.filter(p => p.in === 'path').map(p => p.name);
  if (pathParamNames.length === 0) continue;
  const rb = op.requestBody;
  if (!rb?.content?.['application/json']?.schema) continue;
  const bodyProps = rb.content['application/json'].schema.properties || {};
  for (const name of pathParamNames) {
    if (bodyProps[name]) {
      paramClashes.push(`${op.operationId}: path param "${name}" also in request body properties`);
    }
  }
}
check('NO_BODY_PARAM_CLASH', paramClashes.length === 0,
  paramClashes.length > 0 ? paramClashes.join('; ') : 'no clashes');

// 18. No readOnly properties in request body schemas
let bodyReadOnly = [];
for (const { path, method, op } of allOps) {
  const rb = op.requestBody;
  if (!rb?.content?.['application/json']?.schema) continue;
  const s = rb.content['application/json'].schema;
  const props = s.properties || {};
  for (const [name, prop] of Object.entries(props)) {
    if (prop && typeof prop === 'object' && prop.readOnly === true) {
      bodyReadOnly.push(`${op.operationId}: requestBody property "${name}" is readOnly`);
    }
  }
}
check('NO_READONLY_IN_REQBODY', bodyReadOnly.length === 0,
  bodyReadOnly.length > 0 ? bodyReadOnly.join('; ') : 'no readOnly properties');

// 19. Every response must have content JSON schema
let missingResponseContent = [];
for (const { path, method, op } of allOps) {
  for (const [code, resp] of Object.entries(op.responses || {})) {
    const hasContent = resp?.content?.['application/json']?.schema;
    if (!hasContent) {
      missingResponseContent.push(`${op.operationId} (${code}): missing content schema`);
    }
  }
}
check('ALL_RESPONSES_HAVE_CONTENT', missingResponseContent.length === 0,
  missingResponseContent.length > 0 ? missingResponseContent.slice(0, 5).join('; ') : 'all responses have content JSON schema');

// ── Summary ─────────────────────────────────────────────────────────
const passed = checks.filter(c => c.status === 'PASS').length;
const failed = checks.filter(c => c.status === 'FAIL').length;

console.log(`\n  === SUMMARY: ${passed} PASS, ${failed} FAIL (${checks.length} checks) ===`);

if (failed > 0) process.exit(1);
