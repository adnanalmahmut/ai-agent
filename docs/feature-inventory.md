# Implemented features

This inventory is a current capability map. Source and tests remain
authoritative.

| Area             | Implemented capability                                                                                                                | Primary source                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Identity         | Email/password and Google sign-in, verification, reset, session management, account deactivation/restore, and platform administration | `apps/control-plane/src/infrastructure/auth/`, `apps/platform/src/features/auth/`             |
| Organizations    | Membership, invitations, organization settings, archive/restore, and tenant-scoped audit history                                      | `apps/control-plane/src/features/organizations/`, `apps/platform/src/features/organization/`  |
| Control plane    | Feature flags, runtime settings, encrypted managed secrets, and audit history                                                         | `apps/control-plane/src/features/control-plane/`, `apps/platform/src/features/control-plane/` |
| Agent management | Code-owned definitions, immutable organization versions, model policy pinning, and exact versioned tool grants                        | `apps/control-plane/src/features/agent-management/`, `apps/control-plane/src/ai/`                   |
| Knowledge        | Organization spaces, document ingestion, chunking, embedding, retrieval, and agent context budgets                                    | `apps/control-plane/src/features/knowledge/`                                                  |
| Content ideas    | Idempotent asynchronous generation with durable run status and organization-scoped results                                            | `apps/control-plane/src/features/content/ideas/`                                              |
| Content projects | Idempotent promotion of an agent-produced idea into a project and initial draft snapshot                                              | `apps/control-plane/src/features/content/projects/`                                           |
| Governed tools   | Audited read-only execution and approval-gated external side effects                                                                  | `apps/control-plane/src/ai/tools/`, `apps/control-plane/src/features/agent-management/approvals/`   |
| MCP              | Bounded external sessions over the same tool registry, grants, gateway, and audit ledger                                              | `apps/control-plane/src/features/agent-management/mcp/`                                       |
| Operations       | Immutable release sets, automatic Staging delivery, rollback, backup/restore, host compatibility, and release retention               | `.github/workflows/`, `ops/`                                                            |

The public web application currently provides the localized public surface. The
authenticated Platform is the product and operator interface for the
capabilities above.
