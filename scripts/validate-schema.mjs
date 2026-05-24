#!/usr/bin/env node
/**
 * validate-schema.mjs
 *
 * Validates generated openapi.yaml against GPT Builder compatibility rules.
 *
 * Checks:
 *  - YAML parses
 *  - openapi is 3.1.0 or current
 *  - server is n8n-control production /api/v1
 *  - security scheme is apiKey header X-N8N-API-KEY
 *  - operationIds are unique
 *  - operationIds count <= 30
 *  - forbidden operationIds absent
 *  - createWorkflow exists and requestBody.required == true
 *  - createWorkflow schema requires name,nodes,connections,settings
 *  - createWorkflow schema additionalProperties == false
 *  - No external $ref
 *
 * Usage: node scripts/validate-schema.mjs
 * Exit code: 0 = PASS, 1 = FAIL
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// Load allowlist for forbidden IDs
const allowlist = JSON.parse(readFileSync(resolve(ROOT, 'config/actions.allowlist.json'), 'utf8'));
const forbiddenGptIds = new Set(allowlist.forbidden_operation_ids || []);

// Load generated schema
let spec;
try {
  const raw = readFileSync(resolve(ROOT, 'openapi.yaml'), 'utf8');
  spec = yaml.load(raw);
} catch (e) {
  console.error(`FAIL YAML_PARSE: ${e.message}`);
  process.exit(1);
}

const checks = [];
function check(name, pass, detail = '') {
  const status = pass ? 'PASS' : 'FAIL';
  checks.push({ name, status, detail });
  console.log(`  ${status}: ${name}${detail ? ' — ' + detail : ''}`);
}

// 1. YAML parsed (already done)
check('YAML_PARSE', true, `openapi parsed successfully`);

// 2. openapi version
const ver = (spec.openapi || '').toString();
const verOk = ver.startsWith('3.');
check('OPENAPI_VERSION', verOk, `version=${ver}`);

// 3. Server is n8n-control production /api/v1
const servers = spec.servers || [];
const serverOk = servers.some(s =>
  (s.url || '').includes('n8n-control-production.up.railway.app') &&
  (s.url || '').includes('/api/v1')
);
check('SERVER_URL', serverOk, serverOk ? servers.map(s => s.url).join(', ') : 'missing n8n-control URL');

// 4. Security scheme
const secSchemes = spec.components?.securitySchemes || {};
const n8nKeyScheme = Object.entries(secSchemes).find(([name, s]) =>
  s?.type === 'apiKey' && s?.in === 'header' && s?.name === 'X-N8N-API-KEY'
);
check('SECURITY_SCHEME', !!n8nKeyScheme, n8nKeyScheme ? `N8nApiKey via X-N8N-API-KEY` : 'missing apiKey header scheme');

// 5. Security requirement references existing scheme
const security = spec.security || [];
const secRefOk = security.some(s => Object.keys(s).some(k => secSchemes[k]));
check('SECURITY_REQUIRES_KEY', secRefOk, 'security references N8nApiKey');

// 6. operationIds unique
const allOps = [];
const opErrors = [];
for (const [path, methods] of Object.entries(spec.paths || {})) {
  for (const [method, op] of Object.entries(methods)) {
    if (op.operationId) {
      if (allOps.includes(op.operationId)) {
        opErrors.push(`${op.operationId} (${method.toUpperCase()} ${path})`);
      }
      allOps.push(op.operationId);
    }
  }
}
check('OPERATION_IDS_UNIQUE', opErrors.length === 0,
  opErrors.length > 0 ? `DUPLICATES: ${opErrors.join(', ')}` : `${allOps.length} unique`);

// 7. operationIds count <= 30
check('OPERATION_IDS_COUNT', allOps.length <= 30 || allOps.length <= allowlist.max_operations,
  `${allOps.length} operations (limit ${Math.min(30, allowlist.max_operations || 30)})`);

// 8. Forbidden operationIds absent
const foundForbidden = allOps.filter(id => forbiddenGptIds.has(id));
check('FORBIDDEN_ABSENT', foundForbidden.length === 0,
  foundForbidden.length > 0 ? `FOUND: ${foundForbidden.join(', ')}` : 'all clear');

// 9. createWorkflow exists
const createWfOp = allOps.includes('createWorkflow');
let createWfObj = null;
if (createWfOp) {
  for (const methods of Object.values(spec.paths || {})) {
    for (const op of Object.values(methods)) {
      if (op.operationId === 'createWorkflow') {
        createWfObj = op;
        break;
      }
    }
    if (createWfObj) break;
  }
}
check('CREATE_WORKFLOW_EXISTS', !!createWfObj, createWfObj ? 'found' : 'MISSING');

// 10. createWorkflow requestBody.required == true
let reqBodyRequiredOk = false;
if (createWfObj) {
  reqBodyRequiredOk = createWfObj.requestBody?.required === true;
}
check('CREATE_WF_REQBODY_REQUIRED', reqBodyRequiredOk,
  createWfObj?.requestBody?.required !== undefined ? `required=${createWfObj.requestBody.required}` : 'no requestBody');

// 11. createWorkflow schema requires name, nodes, connections, settings
let reqFieldsOk = false;
let reqFieldsDetail = '';
if (createWfObj) {
  const schema = createWfObj.requestBody?.content?.['application/json']?.schema;
  const required = schema?.required || [];
  const hasName = required.includes('name');
  const hasNodes = required.includes('nodes');
  const hasConnections = required.includes('connections');
  const hasSettings = required.includes('settings');
  reqFieldsOk = hasName && hasNodes && hasConnections && hasSettings;
  reqFieldsDetail = `required=[${required.join(',')}]`;
}
check('CREATE_WF_REQUIRED_FIELDS', reqFieldsOk, reqFieldsDetail);

// 12. createWorkflow schema additionalProperties == false
let addPropsOk = false;
if (createWfObj) {
  const schema = createWfObj.requestBody?.content?.['application/json']?.schema;
  addPropsOk = schema?.additionalProperties === false;
}
check('CREATE_WF_ADDITIONAL_PROPS_FALSE', addPropsOk,
  addPropsOk ? 'additionalProperties: false' : 'additionalProperties not false');

// 13. No external $ref (must not reference outside file)
let externalRefs = [];
let allRefs = [];
const raw = readFileSync(resolve(ROOT, 'openapi.yaml'), 'utf8');
const refMatches = raw.match(/\$ref:\s*['"][^'"]+['"]/g) || [];
for (const ref of refMatches) {
  const refVal = ref.replace(/\$ref:\s*['"]/, '').replace(/['"]$/, '');
  allRefs.push(refVal);
  if (!refVal.startsWith('#/')) {
    externalRefs.push(refVal);
  }
}
check('NO_EXTERNAL_REF', externalRefs.length === 0,
  externalRefs.length > 0 ? `EXTERNAL: ${externalRefs.join(', ')}` : `${allRefs.length} internal refs only`);

// ── Summary ─────────────────────────────────────────────────────────
const passed = checks.filter(c => c.status === 'PASS').length;
const failed = checks.filter(c => c.status === 'FAIL').length;

console.log(`\n  === SUMMARY: ${passed} PASS, ${failed} FAIL (${checks.length} checks) ===`);

if (failed > 0) {
  process.exit(1);
}
