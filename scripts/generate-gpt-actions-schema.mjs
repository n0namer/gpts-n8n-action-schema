#!/usr/bin/env node
/**
 * generate-gpt-actions-schema.mjs
 *
 * Reads vendor/n8n-openapi.snapshot.yml and config/actions.allowlist.json,
 * generates GPT-compatible openapi.yaml with only allowlisted operations.
 *
 * Usage: node scripts/generate-gpt-actions-schema.mjs
 * Output: openapi.yaml
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yaml from './yaml-parse.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// ── Load allowlist ──────────────────────────────────────────────────
const allowlist = JSON.parse(readFileSync(resolve(ROOT, 'config/actions.allowlist.json'), 'utf8'));
const includeGptIds = new Set(allowlist.include_operation_ids);
const forbiddenGptIds = new Set(allowlist.forbidden_operation_ids);
const sourceToGpt = allowlist.source_to_gpt_operation_id_map || {};

// ── Load vendor snapshot ────────────────────────────────────────────
const rawYaml = readFileSync(resolve(ROOT, 'vendor/n8n-openapi.snapshot.yml'), 'utf8');
const spec = yaml.parse(rawYaml);

// ── Parsing helpers ─────────────────────────────────────────────────
// n8n spec uses x-eov-operation-id for operationIds.
// Build source operationId → { method, path, operationObj }
const sourceOps = {};

for (const [path, methods] of Object.entries(spec.paths || {})) {
  for (const [method, operation] of Object.entries(methods)) {
    const sourceId = operation['x-eov-operation-id'];
    if (sourceId) {
      sourceOps[sourceId] = { method, path, operation };
    }
  }
}

// ── Resolve which source operations to include ──────────────────────
// Build reverse map: GPT id → source id
const gptToSource = {};
for (const [sourceId, gptId] of Object.entries(sourceToGpt)) {
  gptToSource[gptId] = sourceId;
}

const resolvedOps = [];

for (const gptId of includeGptIds) {
  // Check if it's a direct source match
  if (sourceOps[gptId]) {
    resolvedOps.push({ gptId, sourceId: gptId, ...sourceOps[gptId] });
    continue;
  }
  // Check mapped source
  const mappedSourceId = gptToSource[gptId];
  if (mappedSourceId && sourceOps[mappedSourceId]) {
    resolvedOps.push({ gptId, sourceId: mappedSourceId, ...sourceOps[mappedSourceId] });
    continue;
  }
  console.error(`WARN: operationId "${gptId}" not found in source snapshot. Skipping.`);
}

if (resolvedOps.length === 0) {
  console.error('FATAL: No operations resolved from allowlist.');
  process.exit(1);
}

// ── Build output schema ─────────────────────────────────────────────
const outputPaths = {};
const outputSchemas = {};
const usedRefs = new Set();

function extractSchema(schemaObj) {
  if (!schemaObj) return null;

  // Dereference $ref within our spec
  if (schemaObj.$ref) {
    const refPath = schemaObj.$ref.replace('#/components/schemas/', '');
    usedRefs.add(refPath);
    return schemaObj; // Keep $ref for GPT Builder compatibility (internal refs only)
  }

  if (Array.isArray(schemaObj)) {
    return schemaObj.map(extractSchema);
  }

  if (typeof schemaObj === 'object') {
    const result = {};
    for (const [key, value] of Object.entries(schemaObj)) {
      if (key === '$ref' || key === 'description' || key === 'type' || key === 'format' ||
          key === 'nullable' || key === 'default' || key === 'example' || key === 'readOnly' ||
          key === 'writeOnly' || key === 'required' || key === 'enum' ||
          key === 'minimum' || key === 'maximum' || key === 'minLength' || key === 'maxLength' ||
          key === 'pattern' || key === 'minItems' || key === 'maxItems' ||
          key === 'additionalProperties' || key === 'properties' || key === 'items' ||
          key === 'oneOf' || key === 'anyOf' || key === 'allOf') {
        result[key] = extractSchema(value);
      }
    }
    if (Object.keys(result).length > 0) return result;
    return null;
  }
  return schemaObj;
}

function gatherRequiredSchemas(schemaObj, specSchemas) {
  if (!schemaObj || typeof schemaObj !== 'object') return;
  if (Array.isArray(schemaObj)) {
    schemaObj.forEach(s => gatherRequiredSchemas(s, specSchemas));
    return;
  }
  if (schemaObj.$ref) {
    const refName = schemaObj.$ref.replace('#/components/schemas/', '');
    if (!usedRefs.has(refName) && specSchemas[refName]) {
      usedRefs.add(refName);
      gatherRequiredSchemas(specSchemas[refName], specSchemas);
    }
    return;
  }
  if (schemaObj.properties) {
    for (const val of Object.values(schemaObj.properties)) {
      gatherRequiredSchemas(val, specSchemas);
    }
  }
  if (schemaObj.items) gatherRequiredSchemas(schemaObj.items, specSchemas);
  if (schemaObj.allOf) schemaObj.allOf.forEach(s => gatherRequiredSchemas(s, specSchemas));
  if (schemaObj.oneOf) schemaObj.oneOf.forEach(s => gatherRequiredSchemas(s, specSchemas));
  if (schemaObj.anyOf) schemaObj.anyOf.forEach(s => gatherRequiredSchemas(s, specSchemas));
}

for (const { gptId, method, path, operation } of resolvedOps) {
  const outputOp = {
    operationId: gptId,
    summary: gptId,
    description: operation.description || operation.summary || gptId,
    tags: operation.tags || [],
    parameters: [],
    responses: {},
  };

  // x-openai-isConsequential: mutations are consequential
  const mutationMethods = ['POST', 'PUT', 'PATCH', 'DELETE'];
  if (mutationMethods.includes(method.toUpperCase())) {
    outputOp['x-openai-isConsequential'] = true;
  }

  // Parameters
  const params = operation.parameters || [];
  for (const param of params) {
    outputOp.parameters.push({
      name: param.name,
      in: param.in,
      required: param.required || false,
      description: param.description || '',
      schema: extractSchema(param.schema) || { type: 'string' },
    });
    if (param.schema && param.schema.$ref) {
      gatherRequiredSchemas(param.schema, spec.components?.schemas);
    }
  }

  // RequestBody
  if (operation.requestBody) {
    const rb = operation.requestBody;
    const jsonContent = rb.content?.['application/json'];
    if (jsonContent?.schema) {
      const schema = jsonContent.schema;

      // For createWorkflow, enforce strict schema with required fields
      let bodySchema;
      if (gptId === 'createWorkflow' && schema.$ref) {
        bodySchema = {
          type: 'object',
          description: 'Always send complete n8n workflow payload. Never omit nodes, connections, or settings. Never send only name. Use Manual Trigger node for safe draft workflows.',
          required: ['name', 'nodes', 'connections', 'settings'],
          additionalProperties: false,
          properties: {
            name: { type: 'string', description: 'Workflow name (required)' },
            nodes: { type: 'array', description: 'Workflow nodes/operations (required, at least one node)', items: { type: 'object' }, minItems: 1 },
            connections: { type: 'object', description: 'Connections between nodes (required, can be empty {})', additionalProperties: true },
            settings: { type: 'object', description: 'Workflow settings (required, can be empty {})', additionalProperties: true },
          },
          example: {
            name: 'Draft Workflow',
            nodes: [{
              id: 'manual-trigger',
              name: 'Manual Trigger',
              type: 'n8n-nodes-base.manualTrigger',
              typeVersion: 1,
              position: [0, 0],
              parameters: {},
            }],
            connections: {},
            settings: {},
          },
        };
      } else if (schema.$ref) {
        const refName = schema.$ref.replace('#/components/schemas/', '');
        bodySchema = { $ref: schema.$ref };
        usedRefs.add(refName);
      } else {
        bodySchema = extractSchema(schema);
      }

      outputOp.requestBody = {
        required: rb.required !== false,
        content: {
          'application/json': {
            schema: bodySchema,
          },
        },
      };

      if (bodySchema?.$ref) {
        gatherRequiredSchemas(bodySchema, spec.components?.schemas);
      }
    }
  }

  // Responses: simplified — return generic 200 response
  outputOp.responses = {
    '200': { description: 'Success' },
  };
  if (operation.responses?.['400']) {
    outputOp.responses['400'] = { description: 'Bad Request' };
  }
  if (operation.responses?.['401']) {
    outputOp.responses['401'] = { description: 'Unauthorized' };
  }
  if (operation.responses?.['403']) {
    outputOp.responses['403'] = { description: 'Forbidden' };
  }
  if (operation.responses?.['404']) {
    outputOp.responses['404'] = { description: 'Not Found' };
  }

  // Build output path
  if (!outputPaths[path]) {
    outputPaths[path] = {};
  }
  outputPaths[path][method] = outputOp;
}

// ── Collect referenced schemas ──────────────────────────────────────
const outputComponents = {
  schemas: {},
};

for (const refName of usedRefs) {
  const sourceSchema = spec.components?.schemas?.[refName];
  if (sourceSchema) {
    outputComponents.schemas[refName] = extractSchema(sourceSchema);
  }
}

// Strip unnecessary schema complex types for GPT Builder compatibility
// Keep simple schemas only

// ── Assemble final document ─────────────────────────────────────────
const output = {
  openapi: '3.1.0',
  info: {
    title: 'n8n REST Control API',
    version: '1.5.8-generated-allowlist',
    description: 'GPT-compatible OpenAPI schema for n8n workflow and resource management via n8n-control proxy. Generated from native n8n OpenAPI snapshot with allowlist.',
  },
  servers: [
    { url: 'https://n8n-control-production.up.railway.app/api/v1' },
  ],
  security: [
    { N8nApiKey: [] },
  ],
  components: {
    securitySchemes: {
      N8nApiKey: {
        type: 'apiKey',
        in: 'header',
        name: 'X-N8N-API-KEY',
        description: 'n8n API key from Settings > API (not OpenClaw/operator key). Must be a valid n8n API key with appropriate scopes.',
      },
    },
  },
  paths: outputPaths,
};

// Add schemas if any were referenced
if (Object.keys(outputComponents.schemas).length > 0) {
  output.components.schemas = outputComponents.schemas;
}

// ── Serialize to YAML ───────────────────────────────────────────────
const outputYaml = yaml.stringify(output, { lineWidth: 120, noCompatMode: true, quotingType: '"' });

writeFileSync(resolve(ROOT, 'openapi.yaml'), outputYaml, 'utf8');
console.log(`Generated openapi.yaml: ${resolvedOps.length} operations, ${usedRefs.size} schemas, version 1.5.8-generated-allowlist`);

// Report resolution
const resolvedIds = resolvedOps.map(o => o.gptId).sort();
console.log('Operation IDs:', JSON.stringify(resolvedIds));
