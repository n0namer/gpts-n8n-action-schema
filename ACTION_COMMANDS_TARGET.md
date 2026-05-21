# GPTs n8n Actions â€” target 30-command set

Goal: use one public OpenAPI schema for GPT Actions with the maximum high-value command set for managing n8n from ChatGPT.

North Star: ChatGPT can safely find, analyze, create, clone, validate, patch, update, activate/deactivate, and troubleshoot n8n workflows through n8n-control.

## Keep out of core schema

- Debug ping endpoints: only for setup, not daily work.
- Tag CRUD: low-value for workflow management compared to workflow/execution/credential surfaces.

## Command set 

Legend:
- BACKEND_READY: existing n8n-control/n8n Public API surface can support this now.
- NEEDS_BACKEND: new n8n-control route or normalizer logic required before adding to openapi.yaml.

### Workflow lifecycle (6)

| # | operationId | status | why it exists |
‚| - | - | - | - |
| 1 | listWorkflowsMini | BACKEND_READY | list/filter workflows before acting |
| 2 | getWorkflow | BACKEND_READY | read full workflow before update or activate |
| 3 | createWorkflow | BACKEND_READY | create new workflow or clone bypass |
| 4 | updateWorkflow | BACKEND_READY | full update after diff/validation |
| 5 | activateWorkflow | BACKEND_READY | publish a verified workflow |
| 6 | deactivateWorkflow | BACKEND_READY | safe stop before changes or incident |

### Workflow intelligence and change safety (8)

| # | operationId | status | why it exists |
‚| - | - | - | - |
| 7 | searchWorkflows | NEEDS_BACKEND | find by query, node type, active status, tag, recent errors |
| 8 | cloneWorkflow | NEEDS_BACKEND | safe copy before major edits |
| 9 | validateWorkflow | NEEDS_BACKEND | check nodes, connections, missing credentials, and structure before update/activate |
| 10 | diffWorkflows | NEEDS_BACKEND | show changes between existing and proposed workflow |
| 11 | patchWorkflow | NEEDS_BACKEND | small, targeted changes without full replacement |
| 12 | exportWorkflow | NEEDS_BACKEND | get clean JSON export for review/backup |
| 13 | importWorkflow | NEEDS_BACKEND | import a golden workflow JSON with normalized response |
| 14 | summarizeWorkflow | NEEDS_BACKEND | return node count, triggers, external dependencies, and risks |

### Executions and runtime troubleshooting (5)

| # | operationId | status | why it exists |
| - | - | - | - |
| 15 | listExecutions | BACKEND_READY | recent runs, errors, waiting jobs |
| 16 | getExecution | BACKEND_READY | detailed execution evidence |
| 17 | getRecentExecutionsForWorkflow | NEEDS_BACKEND | quick health check for a specific workflow |
| 18 | cancelExecution | NEEDS_BACKEND | stop a running/waiting execution if API supports it |
| 19 | retryExecution | NEEDS_BACKEND | rerun a failed execution if API supports it |

### Credentials and secret-safe diagnostics (4)

| # | operationId | status | why it exists |
‚| - | - | - | - |
| 20 | listCredentials | BACKEND_READY | see which integrations exist without revealing secrets |
| 21 | getCredential | BACKEND_READY | inspect metadata for workflow debug |
| 22 | getCredentialSchema | BACKEND_READY | know what fields a credential type needs |
| 23 | testCredential | BACKEND_READY | verify a credential works before activating flow |

### Variables and environment-like config (3)

| # | operationId | status | why it exists |
| - | - | - | - |
| 24 | listVariables | BACKEND_READY | see runtime config visible to n8n |
| 25 | createVariable | BACKEND_READY | add non-secret config for workflows |
| 26 | updateVariable | BACKEND_READY | change non-secret config without editing workflow json |

### Security and instance audit (1)

| # | operationId | status | why it exists |
| - | - | - | - |
| 27 | generateAudit | BACKEND_READY | catch abandoned workflows, risks, and security issues |

### Project scope (1)

| # | operationId | status | why it exists |
‚| - | - | - | - |
| 28 | listProjects | BACKEND_READY | disambiguate projectId for workflows/variables |

### Safe deployment/source write-back (2)

| # | operationId | status | why it exists |
‚| - | - | - | - |
| 29 | getControlHealth | NEEDS_BACKEND | one call for n8n-control health, version, domain, and normalizer state |
| 30 | writeBackTaskStatus | NEEDS_BACKEND | record task outcome/evidence in operational source of truth |

## OpenAPI policy

Don not add NEEDS_BACKEND commands to openapi.yaml until the corresponding n8n-control route exists and has evidence:

- raw OpenClaw or direct HTTP proof;
- ChatGPT Actions parsing proof;
- verify-after-write proof;
- no secrets in responses.
