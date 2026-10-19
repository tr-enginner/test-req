# Multi-Tenant Platform Design

Date: 2026-02-25

## Overview

A multi-tenant web platform that enables 20-200 users to use the full Matrix Embedded Agent capabilities (17 agents, 26 tools, 9 hooks, 13 skills, 10 slash commands) in isolated private environments without local deployment. The platform provides container-based isolation per test task and a management console for administrators.

## Requirements Summary

| Dimension | Decision |
|-----------|----------|
| User scale | Medium (20-200 users) |
| Isolation | Docker container per task |
| User interaction | Web UI (chat-based) |
| Code ingestion | Archive upload + Git clone |
| Toolchains | Platform pre-installed fixed set |
| Admin scope | Full control (quotas, audit, resource limits) |
| Tech stack | Bun/TypeScript full-stack |
| LLM access | Platform-managed unified API key, per-user metering |
| Deployment | Private server, Docker Compose |

## Architecture: Container-as-Workspace

Each test task launches an isolated Docker container running OpenCode in serve mode with the Matrix plugin pre-installed. The platform API acts as a proxy between the browser and the container's HTTP API.

```
Browser (React SPA)
    │ HTTP / SSE
Platform API (Bun + Hono)
    │ HTTP proxy
Container (opencode serve :4096)
    │ reads/writes
Persistent Volume (/data/projects/{tid}/{pid}/)
```

### Key Architectural Decisions

1. **OpenCode Serve Mode** — containers expose OpenCode's native REST API (sessions, prompt, events SSE), the platform API proxies requests after authentication and metering.
2. **Container-per-task** — strong isolation, resource limits per container, containers are ephemeral but project data persists on host volumes.
3. **Matrix Plugin unchanged** — the plugin loads normally inside OpenCode; zero modifications needed to agents, tools, hooks, or skills.

## Section 1: Interaction Layer (OpenCode Serve Proxy)

### Data Flow

```
User types "/matrix-start"
  → POST /api/projects/:id/sessions/:sid/prompt  (Platform API)
    → auth check → quota check → find container
    → POST http://{container_ip}:4096/session/{sid}/prompt  (OpenCode serve)
      → Matrix conductor agent takes over → 9-phase workflow begins

Concurrent SSE subscription:
  GET /api/projects/:id/sessions/:sid/events  (Platform API)
    → proxies OpenCode GET /event (Server-Sent Events)
    → browser renders: agent switches, tool calls, phase progress, reports
```

### Platform API Proxy Responsibilities

1. **Authentication** — JWT-based, verify user identity
2. **Route mapping** — map session to the correct container IP:port
3. **Request proxy** — forward to container's OpenCode serve API with Basic Auth
4. **SSE passthrough** — stream OpenCode events to browser in real-time
5. **Metering intercept** — extract token usage from responses, record per-user cost

## Section 2: Container Management

### Image Hierarchy

```
base-image (shared base layer)
├── Bun runtime
├── OpenCode CLI
├── Matrix Plugin (pre-installed)
├── cppcheck, mdbook, ast-grep
├── Unity test framework
└── Common build tools (make, cmake)

toolchain-arm              toolchain-8051           toolchain-generic
├── FROM base-image        ├── FROM base-image      ├── FROM base-image
├── arm-none-eabi-gcc      └── sdcc (8051 compiler) ├── gcc / g++
├── CMSIS headers                                   └── gdb
└── QEMU ARM (optional)
```

### Container Lifecycle

```
Project created → Code uploaded/cloned → User starts test
  → Create container (select image, mount project volume, inject env vars)
  → Start `opencode serve --port 4096`
  → Wait for /health ready → notify frontend
  → User interacts via Chat UI (may run for hours, full 9-phase workflow)
  → User ends / timeout / manual stop
  → Container stopped → data persisted on volume → container removed
```

### Resource Limits (per container)

| Resource | Default | Notes |
|----------|---------|-------|
| CPU | 2 cores | Compilation and static analysis need compute |
| Memory | 4 GB | cppcheck on large projects may need more |
| Disk | 10 GB | Source + .matrix artifacts + build intermediates |
| Network | Outbound to LLM API only | No inter-container communication |
| TTL | 24h max | Auto-reclaim zombie containers |

### Environment Variables Injected

```bash
OPENCODE_SERVER_PASSWORD=<random>           # Per-container API auth
OPENCODE_PROVIDER_API_KEY=<platform_key>    # Unified LLM API key
MATRIX_TENANT_ID=<tenant_id>
MATRIX_PROJECT_ID=<project_id>
MATRIX_OUTPUT_LANGUAGE=zh-CN                # From user preferences
```

## Section 3: Data Persistence & Collaboration

### Host Storage Layout

```
/data/
├── projects/
│   └── {tenant_id}/
│       └── {project_id}/
│           ├── source/          ← User source code (upload/clone)
│           └── .matrix/         ← All Matrix artifacts
│               ├── data/        (JSON structured data)
│               ├── reports/     (Markdown reports)
│               ├── book/        (mdbook HTML site)
│               ├── wiki/        (Code knowledge base)
│               └── state/       (Phase progress)
└── backups/                     ← Periodic backups
```

Container mounts `/data/projects/{tid}/{pid}` as `/workspace`. OpenCode operates within `/workspace`.

### Database Schema (PostgreSQL)

```sql
-- Tenants
tenants (id, name, created_at, quota_tokens, quota_projects)

-- Users
users (id, tenant_id, email, password_hash, role, created_at)
  -- role: admin | member

-- Projects
projects (id, tenant_id, name, toolchain, git_url, created_at, last_task_at)

-- Project members (collaboration)
project_members (project_id, user_id, role, added_at)
  -- role: owner | reviewer | viewer

-- Test tasks (each container run = one task)
tasks (id, project_id, user_id, container_id, status,
       current_phase, started_at, finished_at)
  -- status: queuing | running | completed | failed | timeout

-- Usage metering
usage_logs (id, task_id, user_id, tenant_id,
            tokens_in, tokens_out, cost_usd, agent_name, timestamp)

-- Audit trail
audit_logs (id, user_id, action, resource_type, resource_id,
            detail, ip, timestamp)
```

### Collaboration Roles

| Role | Upload code | Run tests | View reports | Manage members |
|------|-------------|-----------|--------------|----------------|
| Owner | Yes | Yes | Yes | Yes |
| Reviewer | No | Yes | Yes | No |
| Viewer | No | No | Yes | No |

### Report Serving

- `.matrix/reports/*.md` → API reads file, frontend renders via react-markdown
- `.matrix/book/` → served as static files (mdbook HTML site)
- `.matrix/data/*.json` → API provides structured queries (progress, defects, coverage)
- Concurrency: only one container per project at a time (task queuing)

## Section 4: Frontend Pages

### Route Structure

```
/login                          Login
/dashboard                      User dashboard (project list, recent tasks)
/projects/:id                   Project detail
  /projects/:id/chat            Matrix chat interface ★ core page
  /projects/:id/reports         Report list and viewer
  /projects/:id/progress        9-phase progress view
  /projects/:id/defects         Defect list
  /projects/:id/coverage        Coverage data
  /projects/:id/members         Member management
  /projects/:id/settings        Project config (matrix.jsonc visual editor)

/admin                          Admin console (admin only)
  /admin/tenants                Tenant management
  /admin/users                  User management
  /admin/usage                  Usage statistics and billing
  /admin/containers             Container monitoring (running/resource usage)
  /admin/audit                  Audit logs
  /admin/toolchains             Toolchain image management
  /admin/quotas                 Quota settings
```

### Chat Page Layout

```
┌──────────────────────────────────────────────────────────┐
│ Project: satellite-pcu          Phase: 3/8 Code Review   │
├──────────────────────────────┬───────────────────────────┤
│                              │                           │
│  ┌─ Agent: conductor ──────┐ │  9-Phase Progress Panel   │
│  │ Task classified → Ph. 1 │ │  ☑ Phase 0 Classification │
│  └─────────────────────────┘ │  ☑ Phase 1 Analysis       │
│                              │  ☑ Phase 2 Test Reqs      │
│  ┌─ Agent: analyst ────────┐ │  ▶ Phase 3 Code Review    │
│  │ Parsing src/mppt.c ...  │ │  ○ Phase 4 Unit Testing   │
│  │ [tool: code_parser]     │ │  ○ Phase 5 Test Env       │
│  │ Found 12 functions      │ │  ○ Phase 6 Test Design    │
│  └─────────────────────────┘ │  ○ Phase 7 Execution      │
│                              │  ○ Phase 8 Summary        │
│  ┌─ Agent: inspector ──────┐ │───────────────────────────│
│  │ Reviewing REQ-001 ...   │ │  Quick Actions            │
│  │ Defect: boundary check  │ │  [/matrix-status]         │
│  └─────────────────────────┘ │  [/matrix-report]         │
│                              │  [Stop Task]              │
├──────────────────────────────┤                           │
│ ▶ Type message or command... │                           │
│ [/matrix-start] [Send]       │                           │
└──────────────────────────────┴───────────────────────────┘
```

## Section 5: Platform API Endpoints

### Authentication
```
POST   /api/auth/login              Login
POST   /api/auth/logout             Logout
GET    /api/auth/me                 Current user info
```

### Project Management
```
GET    /api/projects                List projects
POST   /api/projects                Create project
GET    /api/projects/:id            Project detail
DELETE /api/projects/:id            Delete project
POST   /api/projects/:id/upload     Upload code archive
POST   /api/projects/:id/clone      Import from Git
GET    /api/projects/:id/members    List members
POST   /api/projects/:id/members    Invite member
```

### Matrix Interaction (proxy to container OpenCode serve)
```
POST   /api/projects/:id/sessions              Create session
GET    /api/projects/:id/sessions               List sessions
POST   /api/projects/:id/sessions/:sid/prompt   Send message
GET    /api/projects/:id/sessions/:sid/events   SSE event stream
GET    /api/projects/:id/sessions/:sid/messages Message history
```

### Reports & Data
```
GET    /api/projects/:id/reports                Report list
GET    /api/projects/:id/reports/:name          Report content
GET    /api/projects/:id/progress               Current phase progress
GET    /api/projects/:id/defects                Defect list
GET    /api/projects/:id/coverage               Coverage data
GET    /api/projects/:id/book/*                 mdbook static files
```

### Admin Console (admin only)
```
GET    /api/admin/tenants                       Tenant list
POST   /api/admin/tenants                       Create tenant
GET    /api/admin/tenants/:id/usage             Tenant usage
GET    /api/admin/users                         User list
GET    /api/admin/containers                    Running containers
DELETE /api/admin/containers/:id                Stop container
GET    /api/admin/usage/summary                 Usage summary
GET    /api/admin/audit                         Audit logs
PUT    /api/admin/quotas/:tenant_id             Set quotas
```

### Proxy Logic (pseudocode)

```typescript
async function proxyPrompt(req) {
  const user = await authenticate(req);
  const member = await checkProjectAccess(user, projectId, ['owner', 'reviewer']);
  const container = await ensureContainer(projectId);
  await checkQuota(user.tenantId);

  const response = await fetch(
    `http://${container.ip}:4096/session/${sessionId}/prompt`,
    { headers: { Authorization: `Basic ${container.password}` }, body: req.body }
  );

  await recordUsage(user, response.tokenUsage);
  return response;
}
```

## Section 6: Technology Stack

| Layer | Technology | Rationale |
|-------|-----------|-----------|
| Frontend | React + Vite + TailwindCSS | SPA, react-markdown for reports |
| API | Bun + Hono | Lightweight, same stack as Matrix plugin |
| Auth | JWT + bcrypt | Simple, sufficient for private deployment |
| Database | PostgreSQL | Structured data, usage metering |
| Cache/Queue | Redis | Session state cache, task queue |
| Container Mgmt | Dockerode | Programmatic Docker container lifecycle |
| File Storage | Host directories + Docker volumes | Simple, sufficient for private server |
| Deployment | Docker Compose | Platform + PostgreSQL + Redis one-click deploy |

## Project Structure

```
matrix-platform/
├── packages/
│   ├── web/                  ← React frontend
│   │   ├── src/
│   │   │   ├── pages/        (route pages)
│   │   │   ├── components/   (Chat UI, progress panel, report viewer)
│   │   │   └── api/          (API client)
│   │   └── package.json
│   │
│   ├── api/                  ← Bun + Hono backend
│   │   ├── src/
│   │   │   ├── routes/       (API routes)
│   │   │   ├── services/     (business logic)
│   │   │   ├── container/    (Docker container management)
│   │   │   ├── proxy/        (OpenCode API proxy)
│   │   │   ├── auth/         (authentication)
│   │   │   ├── db/           (PostgreSQL access)
│   │   │   └── metering/     (usage metering)
│   │   └── package.json
│   │
│   └── shared/               ← Shared types
│       └── types.ts
│
├── docker/
│   ├── Dockerfile.platform   ← Platform image
│   ├── Dockerfile.base       ← Matrix worker base image
│   ├── Dockerfile.arm        ← ARM toolchain image
│   ├── Dockerfile.8051       ← 8051 toolchain image
│   └── Dockerfile.generic    ← Generic C/C++ image
│
├── docker-compose.yml        ← One-click deployment
├── package.json              ← Monorepo root (workspace)
└── README.md
```
