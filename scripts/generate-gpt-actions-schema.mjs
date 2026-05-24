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
const sourceToGpt = allowlist.source_to_gpt_operation_id_map || {};

// ── Load vendor snapshot ────────────────────────────────────────────
const rawYaml = readFileSync(resolve(ROOT, 'vendor/n8n-openapi.snapshot.yml'), 'utf8');
const spec = yaml.parse(rawYaml);

// ── Build component parameter lookup ────────────────────────────────
const compParams = spec.components?.parameters || {};
// Also look for capitalized key variants (Cursor, Limit, etc.)
for (const [name, param] of Object.entries(spec.components?.parameters || {})) {
  const nameLower = name.toLowerCase();
  if (nameLower !== name && !compParams[nameLower]) {
    compParams[nameLower] = param;
  }
}

function resolveParamRef(refStr) {
  if (!refStr || typeof refStr !== 'string') return null;
  // Parse #/components/parameters/Name
  const parts = refStr.replace(/^#\//, '').split('/');
  if (parts[0] === 'components' && parts[1] === 'parameters') {
    const key = parts.slice(2).join('/');
    const direct = spec.components?.parameters?.[key];
    const lower = spec.components?.parameters?.[key.toLowerCase()];
    return direct || lower || null;
  }
  return null;
}

// ── Build source operation index ────────────────────────────────────
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
const gptToSource = {};
for (const [sourceId, gptId] of Object.entries(sourceToGpt)) {
  gptToSource[gptId] = sourceId;
}

const resolvedOps = [];
for (const gptId of includeGptIds) {
  if (sourceOps[gptId]) {
    resolvedOps.push({ gptId, sourceId: gptId, ...sourceOps[gptId] });
  } else {
    const mappedSourceId = gptToSource[gptId];
    if (mappedSourceId && sourceOps[mappedSourceId]) {
      resolvedOps.push({ gptId, sourceId: mappedSourceId, ...sourceOps[mappedSourceId] });
    } else {
      console.error(`WARN: operationId "${gptId}" not found in source. Skipping.`);
    }
  }
}

if (resolvedOps.length === 0) {
  console.error('FATAL: No operations resolved.');
  process.exit(1);
}

// ── Helpers ─────────────────────────────────────────────────────────

/** Strip readOnly: true properties from a schema object (mutator, returns new obj). */
function stripReadOnly(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(stripReadOnly);
  if (schema.$ref) return schema;

  const out = { ...schema };
  if (out.properties) {
    const newProps = {};
    for (const [name, val] of Object.entries(out.properties)) {
      if (val && typeof val === 'object' && val.readOnly === true) {
        continue; // skip readOnly
      }
      newProps[name] = stripReadOnly(val);
    }
    out.properties = newProps;
    if (Object.keys(out.properties).length === 0) delete out.properties;
  }
  if (out.required) {
    // Remove required fields that are no longer in properties
    if (out.properties) {
      out.required = out.required.filter(f => out.properties[f]);
    }
    if (out.required.length === 0) delete out.required;
  }
  // Clean readOnly/writeOnly from self
  if (out.readOnly) delete out.readOnly;
  if (out.writeOnly) delete out.writeOnly;
  if (out.items) out.items = stripReadOnly(out.items);
  if (out.allOf) out.allOf = out.allOf.map(stripReadOnly);
  if (out.oneOf) out.oneOf = out.oneOf.map(stripReadOnly);
  if (out.anyOf) out.anyOf = out.anyOf.map(stripReadOnly);
  if (out.additionalProperties && typeof out.additionalProperties === 'object') {
    out.additionalProperties = stripReadOnly(out.additionalProperties);
  }
  return out;
}

/** Remove properties from schema that clash with path parameter names. */
function removeClashingProps(schema, paramNames) {
  if (!schema || typeof schema !== 'object' || !schema.properties) return schema;
  const out = { ...schema, properties: { ...schema.properties } };
  for (const name of paramNames) {
    if (out.properties[name]) {
      delete out.properties[name];
    }
  }
  // Update required if needed
  if (out.required) {
    out.required = out.required.filter(f => out.properties[f]);
    if (out.required.length === 0) delete out.required;
  }
  if (Object.keys(out.properties).length === 0) delete out.properties;
  return out;
}

/** Extract a schema object safe for GPT Builder: no nulls, no malformed additionalProperties. */
function cleanSchema(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(cleanSchema);
  if (obj.$ref) return obj; // keep refs

  const out = {};
  const keep = [
    '$ref', 'type', 'description', 'format', 'nullable', 'default', 'example',
    'readOnly', 'writeOnly', 'required', 'enum', 'minimum', 'maximum',
    'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems',
    'oneOf', 'anyOf', 'allOf', 'properties', 'items', 'additionalProperties',
  ];

  for (const key of keep) {
    const val = obj[key];
    if (val === undefined || val === null) continue; // NEVER output null
    if (key === 'additionalProperties') {
      // Must be boolean or object, never null
      if (val === true || val === false || (typeof val === 'object' && val !== null)) {
        out[key] = cleanSchema(val);
      }
      continue;
    }
    if (key === 'properties') {
      out[key] = {};
      for (const [propName, propVal] of Object.entries(val)) {
        if (propVal !== null && propVal !== undefined) {
          out[key][propName] = cleanSchema(propVal);
        }
      }
      if (Object.keys(out[key]).length === 0) delete out[key];
      continue;
    }
    out[key] = cleanSchema(val);
  }

  return out;
}

/** Check if a URL path has template params like {id}, {versionId} etc. */
function extractPathTemplateNames(path) {
  const names = [];
  const re = /\{(\w+)\}/g;
  let m;
  while ((m = re.exec(path)) !== null) names.push(m[1]);
  return names;
}

const usedRefs = new Set();
const outputPaths = {};

// ── Process each operation ──────────────────────────────────────────
for (const { gptId, method, path, operation } of resolvedOps) {
  const outputOp = {
    operationId: gptId,
    summary: gptId,
    description: operation.description || operation.summary || gptId,
    tags: operation.tags || [],
    parameters: [],
    responses: {},
  };

  const mutationMethods = ['POST', 'PUT', 'PATCH', 'DELETE'];
  if (mutationMethods.includes(method.toUpperCase())) {
    outputOp['x-openai-isConsequential'] = true;
  }

  // ── Resolve parameters ────────────────────────────────────────────
  const resolvedParams = [];

  // Resolve $ref parameters from source
  const rawParams = operation.parameters || [];
  for (const p of rawParams) {
    if (p.$ref) {
      const resolved = resolveParamRef(p.$ref);
      if (resolved) {
        // Extract only GPT-safe fields
        const param = {
          name: resolved.name || '',
          in: resolved.in || '',
          required: resolved.required || false,
          description: resolved.description || '',
          schema: cleanSchema(resolved.schema) || { type: 'string' },
        };
        if (param.name && param.in) {
          resolvedParams.push(param);
        }
      }
    } else {
      // Inline param
      const param = {
        name: p.name || '',
        in: p.in || '',
        required: p.required || false,
        description: p.description || '',
        schema: cleanSchema(p.schema) || { type: 'string' },
      };
      resolvedParams.push(param);
    }
  }

  // Ensure path template params are present
  const templateNames = extractPathTemplateNames(path);
  const existingPathParamIds = resolvedParams
    .filter(p => p.in === 'path')
    .map(p => p.name);

  for (const tplName of templateNames) {
    if (!existingPathParamIds.includes(tplName)) {
      resolvedParams.push({
        name: tplName,
        in: 'path',
        required: true,
        description: `${tplName} identifier`,
        schema: { type: 'string' },
      });
    }
  }

  outputOp.parameters = resolvedParams;

  // ── RequestBody ───────────────────────────────────────────────────
  if (operation.requestBody) {
    const rb = operation.requestBody;
    const jsonContent = rb.content?.['application/json'];
    if (jsonContent?.schema) {
      const schema = jsonContent.schema;

      let bodySchema;

      if (gptId === 'createWorkflow') {
        // Enforce strict createWorkflow schema
        bodySchema = {
          type: 'object',
          description: 'Always send complete n8n workflow payload. Never omit nodes, connections, or settings. Never send only name. Use Manual Trigger node for safe draft workflows.',
          required: ['name', 'nodes', 'connections', 'settings'],
          additionalProperties: false,
          properties: {
            name: { type: 'string', description: 'Workflow name (required)' },
            nodes: {
              type: 'array',
              description: 'Workflow nodes/operations (required, at least one node)',
              items: { type: 'object' },
              minItems: 1,
            },
            connections: {
              type: 'object',
              description: 'Connections between nodes (required, can be empty {})',
              additionalProperties: true,
            },
            settings: {
              type: 'object',
              description: 'Workflow settings (required, can be empty {})',
              additionalProperties: true,
            },
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
      } else if (gptId === 'updateWorkflow') {
        // updateWorkflow: allow partial update, but require name
        const bodySchemaRef = {
          type: 'object',
          description: 'Workflow update payload. Include id as path parameter. For full replace, send complete payload.',
          required: ['name', 'nodes', 'connections', 'settings'],
          additionalProperties: false,
          properties: {
            name: { type: 'string', description: 'Workflow name (required)' },
            nodes: {
              type: 'array',
              description: 'Workflow nodes/operations (required)',
              items: { type: 'object' },
              minItems: 1,
            },
            connections: {
              type: 'object',
              description: 'Connections between nodes (required, can be empty {})',
              additionalProperties: true,
            },
            settings: {
              type: 'object',
              description: 'Workflow settings (required, can be empty {})',
              additionalProperties: true,
            },
          },
        };
        bodySchema = bodySchemaRef;
      } else if (schema.$ref) {
        // For $ref request bodies: get the source schema, strip readOnly props,
        // remove properties that clash with path params, then inline.
        const refName = schema.$ref.replace('#/components/schemas/', '');
        const sourceSchema = spec.components?.schemas?.[refName];
        if (sourceSchema) {
          let cleaned = cleanSchema(sourceSchema);
          cleaned = stripReadOnly(cleaned);
          const pathParamNames = resolvedParams.filter(p => p.in === 'path').map(p => p.name);
          if (pathParamNames.length > 0) {
            cleaned = removeClashingProps(cleaned, pathParamNames);
          }
          bodySchema = cleaned;
        } else {
          usedRefs.add(refName);
          bodySchema = { $ref: schema.$ref };
        }
      } else {
        bodySchema = cleanSchema(schema);
      }

      outputOp.requestBody = {
        required: rb.required !== false,
        content: { 'application/json': { schema: bodySchema } },
      };
    }
  }

  // ── Responses ─────────────────────────────────────────────────────
  outputOp.responses = { '200': { description: 'Success' } };
  for (const code of ['400', '401', '403', '404']) {
    if (operation.responses?.[code]) {
      outputOp.responses[code] = { description: code === '400' ? 'Bad Request' : code === '401' ? 'Unauthorized' : code === '403' ? 'Forbidden' : 'Not Found' };
    }
  }

  // ── Add to output paths ───────────────────────────────────────────
  if (!outputPaths[path]) outputPaths[path] = {};
  outputPaths[path][method] = outputOp;
}

// ── Collect referenced component schemas ────────────────────────────
const outputSchemas = {};
for (const refName of usedRefs) {
  const sourceSchema = spec.components?.schemas?.[refName];
  if (sourceSchema) {
    outputSchemas[refName] = cleanSchema(sourceSchema);
  }
}

// Ensure no schema has additionalProperties: null
for (const [name, schema] of Object.entries(outputSchemas)) {
  if (schema.additionalProperties === undefined || schema.additionalProperties === null) {
    delete schema.additionalProperties;
  }
  if (schema.properties) {
    for (const [propName, propVal] of Object.entries(schema.properties)) {
      if (propVal === null) delete schema.properties[propName];
    }
    if (Object.keys(schema.properties).length === 0) delete schema.properties;
  }
}

// ── Assemble ────────────────────────────────────────────────────────
const output = {
  openapi: '3.0.3',
  info: {
    title: 'n8n REST Control API',
    version: '1.5.8-generated-allowlist',
    description: 'GPT-compatible OpenAPI schema for n8n workflow and resource management via n8n-control proxy.',
  },
  servers: [{ url: 'https://n8n-control-production.up.railway.app/api/v1' }],
  security: [{ N8nApiKey: [] }],
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

output.components.schemas = Object.keys(outputSchemas).length > 0
  ? outputSchemas
  : {};

// ── Write output ────────────────────────────────────────────────────
const outputYaml = yaml.stringify(output, { lineWidth: 120, noCompatMode: true, quotingType: '"' });
writeFileSync(resolve(ROOT, 'openapi.yaml'), outputYaml, 'utf8');

console.log(`Generated openapi.yaml: ${resolvedOps.length} operations, ${usedRefs.size} schemas, version 1.5.8-generated-allowlist`);
console.log('Operation IDs:', JSON.stringify(resolvedOps.map(o => o.gptId).sort()));
