# Multi-Tenant Platform Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a multi-tenant web platform (matrix-platform) where 20-200 users interact with Matrix Embedded Agent via a browser-based Chat UI, with container-based isolation per test task and full admin management.

**Architecture:** Platform API (Bun + Hono) proxies user requests to ephemeral Docker containers running OpenCode serve + Matrix Plugin. PostgreSQL stores structured data (users, projects, metering). Host volumes persist project files and .matrix artifacts across container restarts. React SPA provides Chat UI and admin console.

**Tech Stack:** Bun, TypeScript, Hono, React, Vite, TailwindCSS, PostgreSQL, Redis, Dockerode, JWT, Docker Compose

**Design Doc:** `docs/plans/2026-02-25-multi-tenant-platform-design.md`

**New Project Location:** `../matrix-platform/` (sibling to matrix-embedded-agent)

---

## Task 1: Monorepo Scaffold + Shared Types

**Files:**
- Create: `matrix-platform/package.json`
- Create: `matrix-platform/tsconfig.json`
- Create: `matrix-platform/packages/api/package.json`
- Create: `matrix-platform/packages/api/tsconfig.json`
- Create: `matrix-platform/packages/api/src/index.ts`
- Create: `matrix-platform/packages/web/package.json`
- Create: `matrix-platform/packages/web/tsconfig.json`
- Create: `matrix-platform/packages/web/vite.config.ts`
- Create: `matrix-platform/packages/web/index.html`
- Create: `matrix-platform/packages/web/src/main.tsx`
- Create: `matrix-platform/packages/shared/package.json`
- Create: `matrix-platform/packages/shared/tsconfig.json`
- Create: `matrix-platform/packages/shared/src/index.ts`
- Create: `matrix-platform/packages/shared/src/types.ts`
- Create: `matrix-platform/.gitignore`

**Step 1: Create monorepo root**

```json
// matrix-platform/package.json
{
  "name": "matrix-platform",
  "private": true,
  "workspaces": ["packages/*"]
}
```

```json
// matrix-platform/tsconfig.json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  }
}
```

**Step 2: Create shared package with domain types**

```typescript
// packages/shared/src/types.ts

// --- Enums ---
export type UserRole = "admin" | "member";
export type ProjectMemberRole = "owner" | "reviewer" | "viewer";
export type TaskStatus = "queuing" | "running" | "completed" | "failed" | "timeout";
export type Toolchain = "arm" | "8051" | "generic";

// --- Entities ---
export interface Tenant {
  id: string;
  name: string;
  createdAt: string;
  quotaTokens: number;      // max tokens per month, 0 = unlimited
  quotaProjects: number;    // max active projects, 0 = unlimited
}

export interface User {
  id: string;
  tenantId: string;
  email: string;
  role: UserRole;
  createdAt: string;
}

export interface Project {
  id: string;
  tenantId: string;
  name: string;
  toolchain: Toolchain;
  gitUrl: string | null;
  createdAt: string;
  lastTaskAt: string | null;
}

export interface ProjectMember {
  projectId: string;
  userId: string;
  role: ProjectMemberRole;
  addedAt: string;
}

export interface Task {
  id: string;
  projectId: string;
  userId: string;
  containerId: string | null;
  status: TaskStatus;
  currentPhase: number | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface UsageLog {
  id: string;
  taskId: string;
  userId: string;
  tenantId: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  agentName: string | null;
  timestamp: string;
}

export interface AuditLog {
  id: string;
  userId: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  detail: string | null;
  ip: string | null;
  timestamp: string;
}

// --- API Request/Response ---
export interface LoginRequest {
  email: string;
  password: string;
}

export interface LoginResponse {
  token: string;
  user: User;
}

export interface CreateProjectRequest {
  name: string;
  toolchain: Toolchain;
  gitUrl?: string;
}

export interface InviteMemberRequest {
  email: string;
  role: ProjectMemberRole;
}

export interface CreateTenantRequest {
  name: string;
  quotaTokens?: number;
  quotaProjects?: number;
}

export interface UsageSummary {
  tenantId: string;
  tenantName: string;
  totalTokensIn: number;
  totalTokensOut: number;
  totalCostUsd: number;
  activeProjects: number;
  runningContainers: number;
}

export interface ContainerInfo {
  containerId: string;
  projectId: string;
  projectName: string;
  userId: string;
  userEmail: string;
  status: string;
  cpuPercent: number;
  memoryMb: number;
  startedAt: string;
}

// --- Matrix Data (read from .matrix/ files) ---
export interface PhaseProgress {
  currentPhase: number;
  phases: Array<{
    phase: number;
    name: string;
    status: "pending" | "in_progress" | "completed" | "failed" | "skipped";
  }>;
}

export interface DefectSummary {
  id: string;
  source: string;
  category: string;
  severity: string;
  description: string;
  file: string | null;
  line: number | null;
}
```

**Step 3: Create API package skeleton**

```typescript
// packages/api/src/index.ts
import { Hono } from "hono";
import { cors } from "hono/cors";

const app = new Hono();

app.use("/*", cors());

app.get("/health", (c) => c.json({ status: "ok" }));

export default {
  port: Number(process.env.PORT ?? 3000),
  fetch: app.fetch,
};
```

```json
// packages/api/package.json
{
  "name": "@matrix-platform/api",
  "private": true,
  "scripts": {
    "dev": "bun run --watch src/index.ts",
    "build": "bun build src/index.ts --outdir dist --target bun",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "hono": "^4",
    "@matrix-platform/shared": "workspace:*"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "typescript": "^5"
  }
}
```

**Step 4: Create Web package skeleton**

```tsx
// packages/web/src/main.tsx
import React from "react";
import ReactDOM from "react-dom/client";

function App() {
  return <div>Matrix Platform</div>;
}

ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
```

```json
// packages/web/package.json
{
  "name": "@matrix-platform/web",
  "private": true,
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "react": "^19",
    "react-dom": "^19",
    "react-router-dom": "^7",
    "@matrix-platform/shared": "workspace:*"
  },
  "devDependencies": {
    "@types/react": "^19",
    "@types/react-dom": "^19",
    "@vitejs/plugin-react": "^4",
    "vite": "^6",
    "typescript": "^5",
    "tailwindcss": "^4",
    "autoprefixer": "^10",
    "postcss": "^8"
  }
}
```

**Step 5: Install and verify**

Run: `cd matrix-platform && bun install`
Expected: dependencies installed, workspaces linked

Run: `cd packages/api && bun run dev &`
Run: `curl http://localhost:3000/health`
Expected: `{"status":"ok"}`

**Step 6: Commit**

```bash
git init && git add -A
git commit -m "feat: scaffold monorepo with api, web, shared packages"
```

---

## Task 2: Database Layer (PostgreSQL + Drizzle ORM)

**Files:**
- Create: `packages/api/src/db/schema.ts`
- Create: `packages/api/src/db/connection.ts`
- Create: `packages/api/src/db/migrate.ts`
- Create: `packages/api/drizzle.config.ts`
- Modify: `packages/api/package.json` (add drizzle deps)

**Step 1: Add database dependencies**

Add to `packages/api/package.json` dependencies:
```json
{
  "drizzle-orm": "^0.39",
  "postgres": "^3",
  "drizzle-kit": "^0.30"
}
```

Run: `cd packages/api && bun install`

**Step 2: Define schema with Drizzle**

```typescript
// packages/api/src/db/schema.ts
import { pgTable, text, timestamp, integer, real, uuid, uniqueIndex } from "drizzle-orm/pg-core";

export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  quotaTokens: integer("quota_tokens").default(0).notNull(),
  quotaProjects: integer("quota_projects").default(0).notNull(),
});

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: text("role", { enum: ["admin", "member"] }).default("member").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
  name: text("name").notNull(),
  toolchain: text("toolchain", { enum: ["arm", "8051", "generic"] }).default("generic").notNull(),
  gitUrl: text("git_url"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  lastTaskAt: timestamp("last_task_at"),
});

export const projectMembers = pgTable("project_members", {
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }).notNull(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  role: text("role", { enum: ["owner", "reviewer", "viewer"] }).default("viewer").notNull(),
  addedAt: timestamp("added_at").defaultNow().notNull(),
}, (t) => [
  uniqueIndex("project_members_pk").on(t.projectId, t.userId),
]);

export const tasks = pgTable("tasks", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").references(() => projects.id).notNull(),
  userId: uuid("user_id").references(() => users.id).notNull(),
  containerId: text("container_id"),
  status: text("status", { enum: ["queuing", "running", "completed", "failed", "timeout"] }).default("queuing").notNull(),
  currentPhase: integer("current_phase"),
  startedAt: timestamp("started_at").defaultNow().notNull(),
  finishedAt: timestamp("finished_at"),
});

export const usageLogs = pgTable("usage_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  taskId: uuid("task_id").references(() => tasks.id).notNull(),
  userId: uuid("user_id").references(() => users.id).notNull(),
  tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
  tokensIn: integer("tokens_in").default(0).notNull(),
  tokensOut: integer("tokens_out").default(0).notNull(),
  costUsd: real("cost_usd").default(0).notNull(),
  agentName: text("agent_name"),
  timestamp: timestamp("timestamp").defaultNow().notNull(),
});

export const auditLogs = pgTable("audit_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").references(() => users.id).notNull(),
  action: text("action").notNull(),
  resourceType: text("resource_type").notNull(),
  resourceId: text("resource_id"),
  detail: text("detail"),
  ip: text("ip"),
  timestamp: timestamp("timestamp").defaultNow().notNull(),
});
```

**Step 3: Create database connection module**

```typescript
// packages/api/src/db/connection.ts
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const connectionString = process.env.DATABASE_URL ?? "postgres://matrix:matrix@localhost:5432/matrix_platform";

const client = postgres(connectionString);
export const db = drizzle(client, { schema });
```

**Step 4: Create Drizzle config for migrations**

```typescript
// packages/api/drizzle.config.ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://matrix:matrix@localhost:5432/matrix_platform",
  },
});
```

**Step 5: Generate and run migration**

Run: `cd packages/api && bunx drizzle-kit generate`
Expected: SQL migration files created in `packages/api/drizzle/`

Run: `bunx drizzle-kit push`
Expected: Schema applied to database

**Step 6: Write test for database connection**

```typescript
// packages/api/src/db/__tests__/connection.test.ts
import { describe, test, expect } from "bun:test";
import { db } from "../connection";
import { tenants } from "../schema";

describe("database connection", () => {
  test("can query tenants table", async () => {
    const result = await db.select().from(tenants);
    expect(Array.isArray(result)).toBe(true);
  });
});
```

Run: `cd packages/api && bun test src/db/__tests__/connection.test.ts`
Expected: PASS

**Step 7: Commit**

```bash
git add -A && git commit -m "feat: add PostgreSQL schema with Drizzle ORM"
```

---

## Task 3: Authentication System (JWT + bcrypt)

**Files:**
- Create: `packages/api/src/auth/password.ts`
- Create: `packages/api/src/auth/jwt.ts`
- Create: `packages/api/src/auth/middleware.ts`
- Create: `packages/api/src/auth/__tests__/auth.test.ts`
- Create: `packages/api/src/routes/auth.ts`
- Create: `packages/api/src/services/audit.ts`
- Modify: `packages/api/src/index.ts` (mount auth routes)

**Step 1: Write failing test for password hashing**

```typescript
// packages/api/src/auth/__tests__/auth.test.ts
import { describe, test, expect } from "bun:test";
import { hashPassword, verifyPassword } from "../password";

describe("password", () => {
  test("hash and verify", async () => {
    const hash = await hashPassword("test123");
    expect(hash).not.toBe("test123");
    expect(await verifyPassword("test123", hash)).toBe(true);
    expect(await verifyPassword("wrong", hash)).toBe(false);
  });
});
```

Run: `bun test src/auth/__tests__/auth.test.ts`
Expected: FAIL (module not found)

**Step 2: Implement password module**

```typescript
// packages/api/src/auth/password.ts
export async function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, { algorithm: "bcrypt", cost: 10 });
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return Bun.password.verify(password, hash);
}
```

Run: `bun test src/auth/__tests__/auth.test.ts`
Expected: PASS

**Step 3: Implement JWT module**

```typescript
// packages/api/src/auth/jwt.ts
import { sign, verify } from "hono/jwt";

const JWT_SECRET = process.env.JWT_SECRET ?? "matrix-platform-dev-secret";
const JWT_EXPIRES_IN = 60 * 60 * 24; // 24 hours

export interface JwtPayload {
  sub: string;       // user id
  tenantId: string;
  role: string;
  exp: number;
}

export async function createToken(userId: string, tenantId: string, role: string): Promise<string> {
  const payload: JwtPayload = {
    sub: userId,
    tenantId,
    role,
    exp: Math.floor(Date.now() / 1000) + JWT_EXPIRES_IN,
  };
  return sign(payload, JWT_SECRET);
}

export async function verifyToken(token: string): Promise<JwtPayload> {
  return verify(token, JWT_SECRET) as Promise<JwtPayload>;
}
```

**Step 4: Implement auth middleware**

```typescript
// packages/api/src/auth/middleware.ts
import type { Context, Next } from "hono";
import { verifyToken, type JwtPayload } from "./jwt";

// Extend Hono context with user info
declare module "hono" {
  interface ContextVariableMap {
    user: JwtPayload;
  }
}

export async function authMiddleware(c: Context, next: Next) {
  const header = c.req.header("Authorization");
  if (!header?.startsWith("Bearer ")) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  try {
    const payload = await verifyToken(header.slice(7));
    c.set("user", payload);
    await next();
  } catch {
    return c.json({ error: "Invalid token" }, 401);
  }
}

export async function adminMiddleware(c: Context, next: Next) {
  const user = c.get("user");
  if (user.role !== "admin") {
    return c.json({ error: "Forbidden" }, 403);
  }
  await next();
}
```

**Step 5: Implement audit service**

```typescript
// packages/api/src/services/audit.ts
import { db } from "../db/connection";
import { auditLogs } from "../db/schema";

export async function logAudit(
  userId: string,
  action: string,
  resourceType: string,
  resourceId?: string,
  detail?: string,
  ip?: string,
) {
  await db.insert(auditLogs).values({
    userId,
    action,
    resourceType,
    resourceId: resourceId ?? null,
    detail: detail ?? null,
    ip: ip ?? null,
  });
}
```

**Step 6: Implement auth routes**

```typescript
// packages/api/src/routes/auth.ts
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db/connection";
import { users, tenants } from "../db/schema";
import { hashPassword, verifyPassword } from "../auth/password";
import { createToken } from "../auth/jwt";
import { authMiddleware } from "../auth/middleware";
import { logAudit } from "../services/audit";
import type { LoginRequest } from "@matrix-platform/shared";

const auth = new Hono();

auth.post("/login", async (c) => {
  const body = await c.req.json<LoginRequest>();
  const [user] = await db.select().from(users).where(eq(users.email, body.email)).limit(1);
  if (!user || !(await verifyPassword(body.password, user.passwordHash))) {
    return c.json({ error: "Invalid credentials" }, 401);
  }
  const token = await createToken(user.id, user.tenantId, user.role);
  await logAudit(user.id, "login", "user", user.id, null, c.req.header("x-forwarded-for"));
  return c.json({
    token,
    user: { id: user.id, tenantId: user.tenantId, email: user.email, role: user.role, createdAt: user.createdAt.toISOString() },
  });
});

auth.post("/logout", authMiddleware, async (c) => {
  const user = c.get("user");
  await logAudit(user.sub, "logout", "user", user.sub);
  return c.json({ ok: true });
});

auth.get("/me", authMiddleware, async (c) => {
  const payload = c.get("user");
  const [user] = await db.select().from(users).where(eq(users.id, payload.sub)).limit(1);
  if (!user) return c.json({ error: "User not found" }, 404);
  return c.json({
    id: user.id, tenantId: user.tenantId, email: user.email, role: user.role, createdAt: user.createdAt.toISOString(),
  });
});

export { auth };
```

**Step 7: Mount routes in index.ts**

```typescript
// packages/api/src/index.ts — replace content
import { Hono } from "hono";
import { cors } from "hono/cors";
import { auth } from "./routes/auth";

const app = new Hono();

app.use("/*", cors());
app.get("/health", (c) => c.json({ status: "ok" }));
app.route("/api/auth", auth);

export default {
  port: Number(process.env.PORT ?? 3000),
  fetch: app.fetch,
};
```

**Step 8: Commit**

```bash
git add -A && git commit -m "feat: add JWT auth system with login, logout, and middleware"
```

---

## Task 4: Container Management Service (Dockerode)

**Files:**
- Create: `packages/api/src/container/manager.ts`
- Create: `packages/api/src/container/config.ts`
- Create: `packages/api/src/container/__tests__/config.test.ts`
- Modify: `packages/api/package.json` (add dockerode)

**Step 1: Add Dockerode dependency**

Add to `packages/api/package.json`:
```json
{
  "dockerode": "^4",
  "@types/dockerode": "^3"
}
```

Run: `bun install`

**Step 2: Write failing test for container config**

```typescript
// packages/api/src/container/__tests__/config.test.ts
import { describe, test, expect } from "bun:test";
import { buildContainerConfig } from "../config";

describe("container config", () => {
  test("generates correct config for arm toolchain", () => {
    const config = buildContainerConfig({
      projectId: "proj-1",
      tenantId: "tenant-1",
      toolchain: "arm",
      projectPath: "/data/projects/tenant-1/proj-1",
      llmApiKey: "sk-test",
    });
    expect(config.Image).toBe("matrix-worker-arm:latest");
    expect(config.HostConfig?.Binds).toContain("/data/projects/tenant-1/proj-1:/workspace");
    expect(config.Env).toContain("MATRIX_PROJECT_ID=proj-1");
  });

  test("applies resource limits", () => {
    const config = buildContainerConfig({
      projectId: "proj-1",
      tenantId: "tenant-1",
      toolchain: "generic",
      projectPath: "/data/projects/tenant-1/proj-1",
      llmApiKey: "sk-test",
    });
    expect(config.HostConfig?.NanoCpus).toBe(2_000_000_000); // 2 CPUs
    expect(config.HostConfig?.Memory).toBe(4 * 1024 * 1024 * 1024); // 4GB
  });
});
```

Run: `bun test src/container/__tests__/config.test.ts`
Expected: FAIL

**Step 3: Implement container config builder**

```typescript
// packages/api/src/container/config.ts
import type { ContainerCreateOptions } from "dockerode";
import type { Toolchain } from "@matrix-platform/shared";
import crypto from "node:crypto";

const TOOLCHAIN_IMAGES: Record<Toolchain, string> = {
  arm: "matrix-worker-arm:latest",
  "8051": "matrix-worker-8051:latest",
  generic: "matrix-worker-generic:latest",
};

const RESOURCE_LIMITS = {
  nanoCpus: 2_000_000_000,            // 2 CPUs
  memory: 4 * 1024 * 1024 * 1024,     // 4 GB
  diskQuota: 10 * 1024 * 1024 * 1024,  // 10 GB
};

export interface ContainerConfigInput {
  projectId: string;
  tenantId: string;
  toolchain: Toolchain;
  projectPath: string;
  llmApiKey: string;
  outputLanguage?: string;
}

export function buildContainerConfig(input: ContainerConfigInput): ContainerCreateOptions {
  const password = crypto.randomBytes(16).toString("hex");
  return {
    Image: TOOLCHAIN_IMAGES[input.toolchain],
    Env: [
      `OPENCODE_SERVER_PASSWORD=${password}`,
      `OPENCODE_PROVIDER_API_KEY=${input.llmApiKey}`,
      `MATRIX_TENANT_ID=${input.tenantId}`,
      `MATRIX_PROJECT_ID=${input.projectId}`,
      `MATRIX_OUTPUT_LANGUAGE=${input.outputLanguage ?? "zh-CN"}`,
    ],
    HostConfig: {
      Binds: [`${input.projectPath}:/workspace`],
      NanoCpus: RESOURCE_LIMITS.nanoCpus,
      Memory: RESOURCE_LIMITS.memory,
      NetworkMode: "bridge",
    },
    WorkingDir: "/workspace",
    Labels: {
      "matrix.tenant": input.tenantId,
      "matrix.project": input.projectId,
    },
    ExposedPorts: { "4096/tcp": {} },
  };
}

export function extractPassword(env: string[]): string | undefined {
  const entry = env.find((e) => e.startsWith("OPENCODE_SERVER_PASSWORD="));
  return entry?.split("=")[1];
}
```

Run: `bun test src/container/__tests__/config.test.ts`
Expected: PASS

**Step 4: Implement container manager**

```typescript
// packages/api/src/container/manager.ts
import Docker from "dockerode";
import { buildContainerConfig, extractPassword, type ContainerConfigInput } from "./config";

const docker = new Docker({ socketPath: process.env.DOCKER_SOCKET ?? "/var/run/docker.sock" });

const HEALTH_TIMEOUT_MS = 30_000;
const HEALTH_POLL_MS = 500;
const CONTAINER_TTL_MS = 24 * 60 * 60 * 1000; // 24h

// In-memory registry: projectId → container metadata
interface ContainerEntry {
  containerId: string;
  ip: string;
  port: number;
  password: string;
  startedAt: number;
}

const registry = new Map<string, ContainerEntry>();

export async function startContainer(input: ContainerConfigInput): Promise<ContainerEntry> {
  // Check if already running for this project
  const existing = registry.get(input.projectId);
  if (existing) {
    try {
      const container = docker.getContainer(existing.containerId);
      const info = await container.inspect();
      if (info.State.Running) return existing;
    } catch {
      registry.delete(input.projectId);
    }
  }

  const config = buildContainerConfig(input);
  const container = await docker.createContainer(config);
  await container.start();

  const info = await container.inspect();
  const ip = info.NetworkSettings.IPAddress;
  const password = extractPassword(config.Env as string[]) ?? "";

  const entry: ContainerEntry = {
    containerId: container.id,
    ip,
    port: 4096,
    password,
    startedAt: Date.now(),
  };
  registry.set(input.projectId, entry);

  // Wait for OpenCode serve to be healthy
  await waitForHealth(ip, 4096, HEALTH_TIMEOUT_MS);

  return entry;
}

export async function stopContainer(projectId: string): Promise<void> {
  const entry = registry.get(projectId);
  if (!entry) return;
  try {
    const container = docker.getContainer(entry.containerId);
    await container.stop({ t: 5 });
    await container.remove();
  } catch {
    // container may already be gone
  }
  registry.delete(projectId);
}

export function getContainer(projectId: string): ContainerEntry | undefined {
  return registry.get(projectId);
}

export async function listRunningContainers(): Promise<Array<{ containerId: string; labels: Record<string, string>; state: string; startedAt: number }>> {
  const containers = await docker.listContainers({ filters: { label: ["matrix.tenant"] } });
  return containers.map((c) => ({
    containerId: c.Id,
    labels: c.Labels,
    state: c.State,
    startedAt: c.Created * 1000,
  }));
}

export async function cleanupExpiredContainers(): Promise<void> {
  const now = Date.now();
  for (const [projectId, entry] of registry) {
    if (now - entry.startedAt > CONTAINER_TTL_MS) {
      await stopContainer(projectId);
    }
  }
}

async function waitForHealth(ip: string, port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://${ip}:${port}/health`);
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await Bun.sleep(HEALTH_POLL_MS);
  }
  throw new Error(`Container health check timed out after ${timeoutMs}ms`);
}
```

**Step 5: Commit**

```bash
git add -A && git commit -m "feat: add Docker container lifecycle management with Dockerode"
```

---

## Task 5: Worker Docker Images

**Files:**
- Create: `docker/Dockerfile.base`
- Create: `docker/Dockerfile.arm`
- Create: `docker/Dockerfile.8051`
- Create: `docker/Dockerfile.generic`
- Create: `docker/entrypoint.sh`

**Step 1: Create base image Dockerfile**

```dockerfile
# docker/Dockerfile.base
FROM oven/bun:1-debian AS base

# System dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl ca-certificates build-essential cmake make \
    && rm -rf /var/lib/apt/lists/*

# Install OpenCode CLI
RUN curl -fsSL https://opencode.ai/install.sh | bash

# Install Matrix plugin globally
# (Assumes matrix-embedded-agent is published to npm or installed from local tarball)
RUN bun add -g matrix-embedded-agent

# Install cppcheck
RUN apt-get update && apt-get install -y --no-install-recommends cppcheck \
    && rm -rf /var/lib/apt/lists/*

# Configure OpenCode to load matrix plugin
RUN mkdir -p /root/.config/opencode && \
    echo '{ "plugins": ["matrix-embedded-agent"] }' > /root/.config/opencode/config.json

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

WORKDIR /workspace

EXPOSE 4096

ENTRYPOINT ["/entrypoint.sh"]
```

```bash
# docker/entrypoint.sh
#!/bin/bash
set -e

# Start OpenCode in serve mode
exec opencode serve \
  --port 4096 \
  --hostname 0.0.0.0 \
  --cors "*"
```

**Step 2: Create toolchain-specific images**

```dockerfile
# docker/Dockerfile.arm
FROM matrix-worker-base:latest

RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc-arm-none-eabi \
    libnewlib-arm-none-eabi \
    && rm -rf /var/lib/apt/lists/*
```

```dockerfile
# docker/Dockerfile.8051
FROM matrix-worker-base:latest

RUN apt-get update && apt-get install -y --no-install-recommends \
    sdcc \
    && rm -rf /var/lib/apt/lists/*
```

```dockerfile
# docker/Dockerfile.generic
FROM matrix-worker-base:latest

RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc g++ gdb valgrind \
    && rm -rf /var/lib/apt/lists/*
```

**Step 3: Build images**

Run: `cd docker && docker build -f Dockerfile.base -t matrix-worker-base:latest .`
Run: `docker build -f Dockerfile.arm -t matrix-worker-arm:latest .`
Run: `docker build -f Dockerfile.8051 -t matrix-worker-8051:latest .`
Run: `docker build -f Dockerfile.generic -t matrix-worker-generic:latest .`

**Step 4: Verify base image works**

Run: `docker run --rm -p 4096:4096 matrix-worker-generic:latest &`
Run: `sleep 10 && curl http://localhost:4096/health`
Expected: OK response from OpenCode serve

**Step 5: Commit**

```bash
git add -A && git commit -m "feat: add Docker images for Matrix worker containers"
```

---

## Task 6: Project Management API

**Files:**
- Create: `packages/api/src/routes/projects.ts`
- Create: `packages/api/src/services/project.ts`
- Create: `packages/api/src/services/storage.ts`
- Create: `packages/api/src/services/__tests__/storage.test.ts`
- Modify: `packages/api/src/index.ts` (mount project routes)

**Step 1: Write failing test for storage service**

```typescript
// packages/api/src/services/__tests__/storage.test.ts
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ensureProjectDir, getProjectPath } from "../storage";
import { existsSync, rmSync } from "node:fs";

const TEST_ROOT = "/tmp/matrix-test-storage";

describe("storage", () => {
  beforeAll(() => { process.env.DATA_ROOT = TEST_ROOT; });
  afterAll(() => { rmSync(TEST_ROOT, { recursive: true, force: true }); });

  test("creates project directory structure", () => {
    ensureProjectDir("t1", "p1");
    expect(existsSync(`${TEST_ROOT}/projects/t1/p1/source`)).toBe(true);
  });

  test("returns correct project path", () => {
    expect(getProjectPath("t1", "p1")).toBe(`${TEST_ROOT}/projects/t1/p1`);
  });
});
```

Run: `bun test src/services/__tests__/storage.test.ts`
Expected: FAIL

**Step 2: Implement storage service**

```typescript
// packages/api/src/services/storage.ts
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

function getDataRoot(): string {
  return process.env.DATA_ROOT ?? "/data";
}

export function getProjectPath(tenantId: string, projectId: string): string {
  return join(getDataRoot(), "projects", tenantId, projectId);
}

export function getSourcePath(tenantId: string, projectId: string): string {
  return join(getProjectPath(tenantId, projectId), "source");
}

export function ensureProjectDir(tenantId: string, projectId: string): void {
  const sourcePath = getSourcePath(tenantId, projectId);
  if (!existsSync(sourcePath)) {
    mkdirSync(sourcePath, { recursive: true });
  }
}

export function getMatrixDataPath(tenantId: string, projectId: string): string {
  return join(getProjectPath(tenantId, projectId), "source", ".matrix");
}
```

Run: `bun test src/services/__tests__/storage.test.ts`
Expected: PASS

**Step 3: Implement project service**

```typescript
// packages/api/src/services/project.ts
import { db } from "../db/connection";
import { projects, projectMembers } from "../db/schema";
import { eq, and } from "drizzle-orm";
import { ensureProjectDir } from "./storage";
import { logAudit } from "./audit";
import type { CreateProjectRequest, ProjectMemberRole } from "@matrix-platform/shared";

export async function createProject(tenantId: string, userId: string, input: CreateProjectRequest) {
  const [project] = await db.insert(projects).values({
    tenantId,
    name: input.name,
    toolchain: input.toolchain,
    gitUrl: input.gitUrl ?? null,
  }).returning();

  // Add creator as owner
  await db.insert(projectMembers).values({
    projectId: project.id,
    userId,
    role: "owner",
  });

  // Create filesystem directory
  ensureProjectDir(tenantId, project.id);

  await logAudit(userId, "create", "project", project.id);
  return project;
}

export async function listUserProjects(userId: string) {
  return db
    .select({ project: projects, role: projectMembers.role })
    .from(projectMembers)
    .innerJoin(projects, eq(projectMembers.projectId, projects.id))
    .where(eq(projectMembers.userId, userId));
}

export async function getProjectIfMember(projectId: string, userId: string, requiredRoles?: ProjectMemberRole[]) {
  const [row] = await db
    .select({ project: projects, role: projectMembers.role })
    .from(projectMembers)
    .innerJoin(projects, eq(projectMembers.projectId, projects.id))
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)))
    .limit(1);

  if (!row) return null;
  if (requiredRoles && !requiredRoles.includes(row.role as ProjectMemberRole)) return null;
  return row;
}

export async function addMember(projectId: string, userId: string, role: ProjectMemberRole, addedByUserId: string) {
  await db.insert(projectMembers).values({ projectId, userId, role });
  await logAudit(addedByUserId, "invite_member", "project", projectId, `userId=${userId},role=${role}`);
}
```

**Step 4: Implement project routes**

```typescript
// packages/api/src/routes/projects.ts
import { Hono } from "hono";
import { authMiddleware } from "../auth/middleware";
import { createProject, listUserProjects, getProjectIfMember, addMember } from "../services/project";
import { getSourcePath } from "../services/storage";
import { db } from "../db/connection";
import { users } from "../db/schema";
import { eq } from "drizzle-orm";
import { execSync } from "node:child_process";
import { mkdirSync, createWriteStream } from "node:fs";
import { join } from "node:path";
import type { CreateProjectRequest, InviteMemberRequest } from "@matrix-platform/shared";

const projectRoutes = new Hono();

projectRoutes.use("/*", authMiddleware);

// List user's projects
projectRoutes.get("/", async (c) => {
  const user = c.get("user");
  const rows = await listUserProjects(user.sub);
  return c.json(rows.map((r) => ({ ...r.project, role: r.role })));
});

// Create project
projectRoutes.post("/", async (c) => {
  const user = c.get("user");
  const body = await c.req.json<CreateProjectRequest>();
  const project = await createProject(user.tenantId, user.sub, body);
  return c.json(project, 201);
});

// Upload code archive
projectRoutes.post("/:id/upload", async (c) => {
  const user = c.get("user");
  const projectId = c.req.param("id");
  const membership = await getProjectIfMember(projectId, user.sub, ["owner"]);
  if (!membership) return c.json({ error: "Forbidden" }, 403);

  const formData = await c.req.formData();
  const file = formData.get("file") as File;
  if (!file) return c.json({ error: "No file uploaded" }, 400);

  const sourcePath = getSourcePath(membership.project.tenantId, projectId);
  const archivePath = join(sourcePath, "..", "upload.tar.gz");

  // Save uploaded file
  const buffer = await file.arrayBuffer();
  await Bun.write(archivePath, buffer);

  // Extract to source directory
  execSync(`tar -xzf "${archivePath}" -C "${sourcePath}"`, { stdio: "pipe" });

  return c.json({ ok: true, path: sourcePath });
});

// Clone from Git
projectRoutes.post("/:id/clone", async (c) => {
  const user = c.get("user");
  const projectId = c.req.param("id");
  const membership = await getProjectIfMember(projectId, user.sub, ["owner"]);
  if (!membership) return c.json({ error: "Forbidden" }, 403);

  const body = await c.req.json<{ gitUrl: string }>();
  const sourcePath = getSourcePath(membership.project.tenantId, projectId);

  execSync(`git clone "${body.gitUrl}" "${sourcePath}"`, { stdio: "pipe" });

  return c.json({ ok: true, path: sourcePath });
});

// Invite member
projectRoutes.post("/:id/members", async (c) => {
  const user = c.get("user");
  const projectId = c.req.param("id");
  const membership = await getProjectIfMember(projectId, user.sub, ["owner"]);
  if (!membership) return c.json({ error: "Forbidden" }, 403);

  const body = await c.req.json<InviteMemberRequest>();
  const [invitee] = await db.select().from(users).where(eq(users.email, body.email)).limit(1);
  if (!invitee) return c.json({ error: "User not found" }, 404);

  await addMember(projectId, invitee.id, body.role, user.sub);
  return c.json({ ok: true }, 201);
});

export { projectRoutes };
```

**Step 5: Mount in index.ts**

Add to `packages/api/src/index.ts`:
```typescript
import { projectRoutes } from "./routes/projects";
app.route("/api/projects", projectRoutes);
```

**Step 6: Commit**

```bash
git add -A && git commit -m "feat: add project CRUD, code upload, Git clone, and member management"
```

---

## Task 7: OpenCode Proxy + SSE Passthrough

**Files:**
- Create: `packages/api/src/proxy/opencode.ts`
- Create: `packages/api/src/proxy/__tests__/opencode.test.ts`
- Create: `packages/api/src/routes/sessions.ts`
- Create: `packages/api/src/services/metering.ts`
- Modify: `packages/api/src/index.ts` (mount session routes)

**Step 1: Implement metering service**

```typescript
// packages/api/src/services/metering.ts
import { db } from "../db/connection";
import { usageLogs, tenants } from "../db/schema";
import { eq, sql, and, gte } from "drizzle-orm";

export async function recordUsage(
  taskId: string, userId: string, tenantId: string,
  tokensIn: number, tokensOut: number, costUsd: number, agentName?: string,
) {
  await db.insert(usageLogs).values({
    taskId, userId, tenantId, tokensIn, tokensOut, costUsd, agentName: agentName ?? null,
  });
}

export async function checkQuota(tenantId: string): Promise<boolean> {
  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  if (!tenant || tenant.quotaTokens === 0) return true; // 0 = unlimited

  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const [result] = await db
    .select({ total: sql<number>`COALESCE(SUM(${usageLogs.tokensIn} + ${usageLogs.tokensOut}), 0)` })
    .from(usageLogs)
    .where(and(eq(usageLogs.tenantId, tenantId), gte(usageLogs.timestamp, monthStart)));

  return (result?.total ?? 0) < tenant.quotaTokens;
}
```

**Step 2: Implement OpenCode proxy module**

```typescript
// packages/api/src/proxy/opencode.ts

interface ContainerTarget {
  ip: string;
  port: number;
  password: string;
}

function basicAuth(password: string): string {
  return "Basic " + Buffer.from(`opencode:${password}`).toString("base64");
}

export async function proxyRequest(target: ContainerTarget, path: string, init?: RequestInit): Promise<Response> {
  const url = `http://${target.ip}:${target.port}${path}`;
  return fetch(url, {
    ...init,
    headers: {
      ...init?.headers,
      Authorization: basicAuth(target.password),
    },
  });
}

export function proxySSE(target: ContainerTarget, path: string): ReadableStream {
  const url = `http://${target.ip}:${target.port}${path}`;

  return new ReadableStream({
    async start(controller) {
      try {
        const res = await fetch(url, {
          headers: { Authorization: basicAuth(target.password) },
        });
        if (!res.body) {
          controller.close();
          return;
        }
        const reader = res.body.getReader();
        const pump = async () => {
          while (true) {
            const { done, value } = await reader.read();
            if (done) { controller.close(); break; }
            controller.enqueue(value);
          }
        };
        pump().catch(() => controller.close());
      } catch {
        controller.close();
      }
    },
  });
}
```

**Step 3: Implement session routes**

```typescript
// packages/api/src/routes/sessions.ts
import { Hono } from "hono";
import { authMiddleware } from "../auth/middleware";
import { getProjectIfMember } from "../services/project";
import { getProjectPath } from "../services/storage";
import { checkQuota } from "../services/metering";
import { startContainer, getContainer } from "../container/manager";
import { proxyRequest, proxySSE } from "../proxy/opencode";
import { db } from "../db/connection";
import { tasks } from "../db/schema";
import { eq } from "drizzle-orm";

const sessionRoutes = new Hono();

sessionRoutes.use("/*", authMiddleware);

// Ensure container is running, return its target info
async function ensureContainerForProject(projectId: string, tenantId: string, userId: string, toolchain: string) {
  let entry = getContainer(projectId);
  if (entry) return entry;

  const projectPath = getProjectPath(tenantId, projectId);
  const llmApiKey = process.env.LLM_API_KEY ?? "";

  entry = await startContainer({
    projectId,
    tenantId,
    toolchain: toolchain as "arm" | "8051" | "generic",
    projectPath,
    llmApiKey,
  });

  // Record task in DB
  await db.insert(tasks).values({
    projectId,
    userId,
    containerId: entry.containerId,
    status: "running",
  });

  return entry;
}

// Create session
sessionRoutes.post("/:projectId/sessions", async (c) => {
  const user = c.get("user");
  const projectId = c.req.param("projectId");
  const membership = await getProjectIfMember(projectId, user.sub, ["owner", "reviewer"]);
  if (!membership) return c.json({ error: "Forbidden" }, 403);
  if (!(await checkQuota(user.tenantId))) return c.json({ error: "Quota exceeded" }, 429);

  const container = await ensureContainerForProject(projectId, membership.project.tenantId, user.sub, membership.project.toolchain);
  const res = await proxyRequest(container, "/session", { method: "POST", body: c.req.raw.body });
  return new Response(res.body, { status: res.status, headers: res.headers });
});

// List sessions
sessionRoutes.get("/:projectId/sessions", async (c) => {
  const user = c.get("user");
  const projectId = c.req.param("projectId");
  const membership = await getProjectIfMember(projectId, user.sub);
  if (!membership) return c.json({ error: "Forbidden" }, 403);

  const container = getContainer(projectId);
  if (!container) return c.json([]);

  const res = await proxyRequest(container, "/session", { method: "GET" });
  return new Response(res.body, { status: res.status, headers: res.headers });
});

// Send prompt
sessionRoutes.post("/:projectId/sessions/:sid/prompt", async (c) => {
  const user = c.get("user");
  const projectId = c.req.param("projectId");
  const sid = c.req.param("sid");
  const membership = await getProjectIfMember(projectId, user.sub, ["owner", "reviewer"]);
  if (!membership) return c.json({ error: "Forbidden" }, 403);
  if (!(await checkQuota(user.tenantId))) return c.json({ error: "Quota exceeded" }, 429);

  const container = getContainer(projectId);
  if (!container) return c.json({ error: "No active container" }, 404);

  const res = await proxyRequest(container, `/session/${sid}/prompt`, {
    method: "POST",
    body: c.req.raw.body,
    headers: { "Content-Type": "application/json" },
  });
  return new Response(res.body, { status: res.status, headers: res.headers });
});

// SSE event stream
sessionRoutes.get("/:projectId/sessions/:sid/events", async (c) => {
  const user = c.get("user");
  const projectId = c.req.param("projectId");
  const membership = await getProjectIfMember(projectId, user.sub);
  if (!membership) return c.json({ error: "Forbidden" }, 403);

  const container = getContainer(projectId);
  if (!container) return c.json({ error: "No active container" }, 404);

  const stream = proxySSE(container, "/event");
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
});

// Get messages
sessionRoutes.get("/:projectId/sessions/:sid/messages", async (c) => {
  const user = c.get("user");
  const projectId = c.req.param("projectId");
  const sid = c.req.param("sid");
  const membership = await getProjectIfMember(projectId, user.sub);
  if (!membership) return c.json({ error: "Forbidden" }, 403);

  const container = getContainer(projectId);
  if (!container) return c.json({ error: "No active container" }, 404);

  const res = await proxyRequest(container, `/session/${sid}/message`, { method: "GET" });
  return new Response(res.body, { status: res.status, headers: res.headers });
});

export { sessionRoutes };
```

**Step 4: Mount in index.ts**

Add to `packages/api/src/index.ts`:
```typescript
import { sessionRoutes } from "./routes/sessions";
app.route("/api/projects", sessionRoutes);
```

**Step 5: Commit**

```bash
git add -A && git commit -m "feat: add OpenCode serve proxy with SSE passthrough and metering"
```

---

## Task 8: Report & Data Serving API

**Files:**
- Create: `packages/api/src/routes/reports.ts`
- Create: `packages/api/src/services/matrix-data.ts`
- Create: `packages/api/src/services/__tests__/matrix-data.test.ts`
- Modify: `packages/api/src/index.ts`

**Step 1: Write failing test for matrix data reader**

```typescript
// packages/api/src/services/__tests__/matrix-data.test.ts
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { readMatrixFile, listReports, readProgress } from "../matrix-data";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";

const TEST_ROOT = "/tmp/matrix-test-data";
const PROJECT_PATH = `${TEST_ROOT}/projects/t1/p1/source`;

describe("matrix-data", () => {
  beforeAll(() => {
    process.env.DATA_ROOT = TEST_ROOT;
    mkdirSync(`${PROJECT_PATH}/.matrix/reports`, { recursive: true });
    mkdirSync(`${PROJECT_PATH}/.matrix/state`, { recursive: true });
    mkdirSync(`${PROJECT_PATH}/.matrix/data`, { recursive: true });
    writeFileSync(`${PROJECT_PATH}/.matrix/reports/test-summary.md`, "# Test Summary\nAll pass");
    writeFileSync(`${PROJECT_PATH}/.matrix/state/progress.json`, JSON.stringify({ currentPhase: 3 }));
    writeFileSync(`${PROJECT_PATH}/.matrix/data/defects.json`, JSON.stringify([{ id: "d1", severity: "major" }]));
  });
  afterAll(() => { rmSync(TEST_ROOT, { recursive: true, force: true }); });

  test("lists report files", () => {
    const reports = listReports("t1", "p1");
    expect(reports).toContain("test-summary.md");
  });

  test("reads report content", () => {
    const content = readMatrixFile("t1", "p1", "reports/test-summary.md");
    expect(content).toContain("# Test Summary");
  });

  test("reads progress", () => {
    const progress = readProgress("t1", "p1");
    expect(progress.currentPhase).toBe(3);
  });
});
```

Run: `bun test src/services/__tests__/matrix-data.test.ts`
Expected: FAIL

**Step 2: Implement matrix data service**

```typescript
// packages/api/src/services/matrix-data.ts
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getProjectPath } from "./storage";

function matrixPath(tenantId: string, projectId: string, ...segments: string[]): string {
  return join(getProjectPath(tenantId, projectId), "source", ".matrix", ...segments);
}

export function listReports(tenantId: string, projectId: string): string[] {
  const dir = matrixPath(tenantId, projectId, "reports");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith(".md"));
}

export function readMatrixFile(tenantId: string, projectId: string, relativePath: string): string {
  const path = matrixPath(tenantId, projectId, relativePath);
  if (!existsSync(path)) throw new Error("File not found");
  return readFileSync(path, "utf-8");
}

export function readProgress(tenantId: string, projectId: string): Record<string, unknown> {
  const path = matrixPath(tenantId, projectId, "state", "progress.json");
  if (!existsSync(path)) return { currentPhase: -1 };
  return JSON.parse(readFileSync(path, "utf-8"));
}

export function readDefects(tenantId: string, projectId: string): unknown[] {
  const path = matrixPath(tenantId, projectId, "data", "defects.json");
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, "utf-8"));
}

export function readJsonData(tenantId: string, projectId: string, filename: string): unknown {
  const path = matrixPath(tenantId, projectId, "data", filename);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8"));
}

export function getBookPath(tenantId: string, projectId: string): string {
  return matrixPath(tenantId, projectId, "book");
}
```

Run: `bun test src/services/__tests__/matrix-data.test.ts`
Expected: PASS

**Step 3: Implement report routes**

```typescript
// packages/api/src/routes/reports.ts
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { authMiddleware } from "../auth/middleware";
import { getProjectIfMember } from "../services/project";
import { listReports, readMatrixFile, readProgress, readDefects, readJsonData, getBookPath } from "../services/matrix-data";

const reportRoutes = new Hono();

reportRoutes.use("/*", authMiddleware);

// List reports
reportRoutes.get("/:id/reports", async (c) => {
  const user = c.get("user");
  const projectId = c.req.param("id");
  const membership = await getProjectIfMember(projectId, user.sub);
  if (!membership) return c.json({ error: "Forbidden" }, 403);
  return c.json(listReports(membership.project.tenantId, projectId));
});

// Get report content (markdown)
reportRoutes.get("/:id/reports/:name{.+}", async (c) => {
  const user = c.get("user");
  const projectId = c.req.param("id");
  const name = c.req.param("name");
  const membership = await getProjectIfMember(projectId, user.sub);
  if (!membership) return c.json({ error: "Forbidden" }, 403);
  try {
    const content = readMatrixFile(membership.project.tenantId, projectId, `reports/${name}`);
    return c.text(content);
  } catch {
    return c.json({ error: "Report not found" }, 404);
  }
});

// Get phase progress
reportRoutes.get("/:id/progress", async (c) => {
  const user = c.get("user");
  const projectId = c.req.param("id");
  const membership = await getProjectIfMember(projectId, user.sub);
  if (!membership) return c.json({ error: "Forbidden" }, 403);
  return c.json(readProgress(membership.project.tenantId, projectId));
});

// Get defects
reportRoutes.get("/:id/defects", async (c) => {
  const user = c.get("user");
  const projectId = c.req.param("id");
  const membership = await getProjectIfMember(projectId, user.sub);
  if (!membership) return c.json({ error: "Forbidden" }, 403);
  return c.json(readDefects(membership.project.tenantId, projectId));
});

// Get coverage or other JSON data
reportRoutes.get("/:id/data/:filename", async (c) => {
  const user = c.get("user");
  const projectId = c.req.param("id");
  const filename = c.req.param("filename");
  const membership = await getProjectIfMember(projectId, user.sub);
  if (!membership) return c.json({ error: "Forbidden" }, 403);
  const data = readJsonData(membership.project.tenantId, projectId, filename);
  if (data === null) return c.json({ error: "Not found" }, 404);
  return c.json(data);
});

export { reportRoutes };
```

**Step 4: Mount in index.ts**

Add to `packages/api/src/index.ts`:
```typescript
import { reportRoutes } from "./routes/reports";
app.route("/api/projects", reportRoutes);
```

**Step 5: Commit**

```bash
git add -A && git commit -m "feat: add report and matrix data serving API"
```

---

## Task 9: Admin API (Tenants, Users, Containers, Audit, Quotas)

**Files:**
- Create: `packages/api/src/routes/admin.ts`
- Create: `packages/api/src/services/admin.ts`
- Modify: `packages/api/src/index.ts`

**Step 1: Implement admin service**

```typescript
// packages/api/src/services/admin.ts
import { db } from "../db/connection";
import { tenants, users, usageLogs, auditLogs, projects, tasks } from "../db/schema";
import { eq, sql, desc, and, gte } from "drizzle-orm";
import { hashPassword } from "../auth/password";
import type { UsageSummary } from "@matrix-platform/shared";

export async function createTenant(name: string, quotaTokens = 0, quotaProjects = 0) {
  const [tenant] = await db.insert(tenants).values({ name, quotaTokens, quotaProjects }).returning();
  return tenant;
}

export async function listTenants() {
  return db.select().from(tenants);
}

export async function createUser(tenantId: string, email: string, password: string, role: "admin" | "member" = "member") {
  const passwordHash = await hashPassword(password);
  const [user] = await db.insert(users).values({ tenantId, email, passwordHash, role }).returning();
  return { id: user.id, tenantId: user.tenantId, email: user.email, role: user.role, createdAt: user.createdAt };
}

export async function listUsers() {
  return db.select({ id: users.id, tenantId: users.tenantId, email: users.email, role: users.role, createdAt: users.createdAt }).from(users);
}

export async function getTenantUsage(tenantId: string, since?: Date): Promise<UsageSummary> {
  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  const monthStart = since ?? new Date(new Date().getFullYear(), new Date().getMonth(), 1);

  const [usage] = await db
    .select({
      totalTokensIn: sql<number>`COALESCE(SUM(${usageLogs.tokensIn}), 0)`,
      totalTokensOut: sql<number>`COALESCE(SUM(${usageLogs.tokensOut}), 0)`,
      totalCostUsd: sql<number>`COALESCE(SUM(${usageLogs.costUsd}), 0)`,
    })
    .from(usageLogs)
    .where(and(eq(usageLogs.tenantId, tenantId), gte(usageLogs.timestamp, monthStart)));

  const [projectCount] = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(projects)
    .where(eq(projects.tenantId, tenantId));

  const [containerCount] = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(tasks)
    .where(and(eq(tasks.status, "running")));

  return {
    tenantId,
    tenantName: tenant?.name ?? "",
    totalTokensIn: usage?.totalTokensIn ?? 0,
    totalTokensOut: usage?.totalTokensOut ?? 0,
    totalCostUsd: usage?.totalCostUsd ?? 0,
    activeProjects: projectCount?.count ?? 0,
    runningContainers: containerCount?.count ?? 0,
  };
}

export async function listAuditLogs(limit = 100, offset = 0) {
  return db.select().from(auditLogs).orderBy(desc(auditLogs.timestamp)).limit(limit).offset(offset);
}

export async function updateQuota(tenantId: string, quotaTokens?: number, quotaProjects?: number) {
  const updates: Partial<typeof tenants.$inferInsert> = {};
  if (quotaTokens !== undefined) updates.quotaTokens = quotaTokens;
  if (quotaProjects !== undefined) updates.quotaProjects = quotaProjects;
  const [updated] = await db.update(tenants).set(updates).where(eq(tenants.id, tenantId)).returning();
  return updated;
}
```

**Step 2: Implement admin routes**

```typescript
// packages/api/src/routes/admin.ts
import { Hono } from "hono";
import { authMiddleware, adminMiddleware } from "../auth/middleware";
import { createTenant, listTenants, createUser, listUsers, getTenantUsage, listAuditLogs, updateQuota } from "../services/admin";
import { listRunningContainers, stopContainer } from "../container/manager";

const adminRoutes = new Hono();

adminRoutes.use("/*", authMiddleware, adminMiddleware);

// Tenants
adminRoutes.get("/tenants", async (c) => {
  return c.json(await listTenants());
});

adminRoutes.post("/tenants", async (c) => {
  const body = await c.req.json<{ name: string; quotaTokens?: number; quotaProjects?: number }>();
  const tenant = await createTenant(body.name, body.quotaTokens, body.quotaProjects);
  return c.json(tenant, 201);
});

adminRoutes.get("/tenants/:id/usage", async (c) => {
  const id = c.req.param("id");
  return c.json(await getTenantUsage(id));
});

// Users
adminRoutes.get("/users", async (c) => {
  return c.json(await listUsers());
});

adminRoutes.post("/users", async (c) => {
  const body = await c.req.json<{ tenantId: string; email: string; password: string; role?: "admin" | "member" }>();
  const user = await createUser(body.tenantId, body.email, body.password, body.role);
  return c.json(user, 201);
});

// Containers
adminRoutes.get("/containers", async (c) => {
  return c.json(await listRunningContainers());
});

adminRoutes.delete("/containers/:projectId", async (c) => {
  const projectId = c.req.param("projectId");
  await stopContainer(projectId);
  return c.json({ ok: true });
});

// Usage
adminRoutes.get("/usage/summary", async (c) => {
  const tenantList = await listTenants();
  const summaries = await Promise.all(tenantList.map((t) => getTenantUsage(t.id)));
  return c.json(summaries);
});

// Audit
adminRoutes.get("/audit", async (c) => {
  const limit = Number(c.req.query("limit") ?? 100);
  const offset = Number(c.req.query("offset") ?? 0);
  return c.json(await listAuditLogs(limit, offset));
});

// Quotas
adminRoutes.put("/quotas/:tenantId", async (c) => {
  const tenantId = c.req.param("tenantId");
  const body = await c.req.json<{ quotaTokens?: number; quotaProjects?: number }>();
  const updated = await updateQuota(tenantId, body.quotaTokens, body.quotaProjects);
  return c.json(updated);
});

export { adminRoutes };
```

**Step 3: Mount in index.ts**

Add to `packages/api/src/index.ts`:
```typescript
import { adminRoutes } from "./routes/admin";
app.route("/api/admin", adminRoutes);
```

**Step 4: Commit**

```bash
git add -A && git commit -m "feat: add admin API for tenants, users, containers, audit, and quotas"
```

---

## Task 10: Frontend — Scaffold, Auth, and Layout

**Files:**
- Create: `packages/web/src/api/client.ts`
- Create: `packages/web/src/api/auth.ts`
- Create: `packages/web/src/hooks/useAuth.ts`
- Create: `packages/web/src/pages/Login.tsx`
- Create: `packages/web/src/pages/Dashboard.tsx`
- Create: `packages/web/src/components/Layout.tsx`
- Create: `packages/web/src/components/Sidebar.tsx`
- Modify: `packages/web/src/main.tsx` (routing)
- Create: `packages/web/src/app.css` (Tailwind base)

**Step 1: Create API client**

```typescript
// packages/web/src/api/client.ts
const API_BASE = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

function getToken(): string | null {
  return localStorage.getItem("token");
}

export function setToken(token: string) {
  localStorage.setItem("token", token);
}

export function clearToken() {
  localStorage.removeItem("token");
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  });
  if (res.status === 401) {
    clearToken();
    window.location.href = "/login";
    throw new Error("Unauthorized");
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

export function sseStream(path: string): EventSource {
  const token = getToken();
  // EventSource doesn't support custom headers; use query param as fallback
  return new EventSource(`${API_BASE}${path}?token=${token}`);
}
```

**Step 2: Create auth hook**

```typescript
// packages/web/src/hooks/useAuth.ts
import { useState, useEffect, createContext, useContext } from "react";
import type { User } from "@matrix-platform/shared";
import { apiFetch, setToken, clearToken } from "../api/client";

interface AuthState {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthState>(null!);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiFetch<User>("/api/auth/me")
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  const login = async (email: string, password: string) => {
    const res = await apiFetch<{ token: string; user: User }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    setToken(res.token);
    setUser(res.user);
  };

  const logout = () => {
    clearToken();
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
```

**Step 3: Create Login page**

```tsx
// packages/web/src/pages/Login.tsx
import { useState } from "react";
import { useAuth } from "../hooks/useAuth";
import { useNavigate } from "react-router-dom";

export function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      await login(email, password);
      navigate("/dashboard");
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <form onSubmit={handleSubmit} className="bg-white p-8 rounded-lg shadow-md w-96">
        <h1 className="text-2xl font-bold mb-6 text-center">Matrix Platform</h1>
        {error && <p className="text-red-500 text-sm mb-4">{error}</p>}
        <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)}
          className="w-full p-2 border rounded mb-4" required />
        <input type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)}
          className="w-full p-2 border rounded mb-4" required />
        <button type="submit" className="w-full bg-blue-600 text-white p-2 rounded hover:bg-blue-700">
          Login
        </button>
      </form>
    </div>
  );
}
```

**Step 4: Create Layout and Sidebar**

```tsx
// packages/web/src/components/Layout.tsx
import { Outlet, Navigate } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { Sidebar } from "./Sidebar";

export function Layout() {
  const { user, loading } = useAuth();
  if (loading) return <div className="flex items-center justify-center h-screen">Loading...</div>;
  if (!user) return <Navigate to="/login" />;

  return (
    <div className="flex h-screen">
      <Sidebar />
      <main className="flex-1 overflow-auto bg-gray-50 p-6">
        <Outlet />
      </main>
    </div>
  );
}
```

```tsx
// packages/web/src/components/Sidebar.tsx
import { Link, useLocation } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";

const NAV_ITEMS = [
  { path: "/dashboard", label: "Dashboard" },
  { path: "/admin", label: "Admin", adminOnly: true },
];

export function Sidebar() {
  const { user, logout } = useAuth();
  const location = useLocation();

  return (
    <div className="w-56 bg-gray-900 text-gray-200 flex flex-col">
      <div className="p-4 font-bold text-lg border-b border-gray-700">Matrix</div>
      <nav className="flex-1 p-2">
        {NAV_ITEMS.filter((item) => !item.adminOnly || user?.role === "admin").map((item) => (
          <Link key={item.path} to={item.path}
            className={`block px-3 py-2 rounded ${location.pathname.startsWith(item.path) ? "bg-gray-700" : "hover:bg-gray-800"}`}>
            {item.label}
          </Link>
        ))}
      </nav>
      <div className="p-4 border-t border-gray-700">
        <p className="text-sm truncate">{user?.email}</p>
        <button onClick={logout} className="text-sm text-gray-400 hover:text-white mt-1">Logout</button>
      </div>
    </div>
  );
}
```

**Step 5: Create Dashboard page (placeholder)**

```tsx
// packages/web/src/pages/Dashboard.tsx
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiFetch } from "../api/client";
import type { Project } from "@matrix-platform/shared";

export function Dashboard() {
  const [projects, setProjects] = useState<(Project & { role: string })[]>([]);

  useEffect(() => {
    apiFetch<(Project & { role: string })[]>("/api/projects").then(setProjects);
  }, []);

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold">Projects</h1>
        <Link to="/projects/new" className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700">
          New Project
        </Link>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {projects.map((p) => (
          <Link key={p.id} to={`/projects/${p.id}/chat`}
            className="bg-white p-4 rounded-lg shadow hover:shadow-md transition">
            <h2 className="font-semibold">{p.name}</h2>
            <p className="text-sm text-gray-500">Toolchain: {p.toolchain}</p>
            <p className="text-xs text-gray-400 mt-2">Role: {p.role}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
```

**Step 6: Wire up routing in main.tsx**

```tsx
// packages/web/src/main.tsx
import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider } from "./hooks/useAuth";
import { Layout } from "./components/Layout";
import { Login } from "./pages/Login";
import { Dashboard } from "./pages/Dashboard";
import "./app.css";

function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route element={<Layout />}>
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/" element={<Navigate to="/dashboard" />} />
          </Route>
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
```

**Step 7: Verify**

Run: `cd packages/web && bun run dev`
Expected: Vite dev server starts, login page renders at http://localhost:5173/login

**Step 8: Commit**

```bash
git add -A && git commit -m "feat: add frontend scaffold with auth, layout, sidebar, and dashboard"
```

---

## Task 11: Frontend — Chat UI (Core Page)

**Files:**
- Create: `packages/web/src/pages/ProjectChat.tsx`
- Create: `packages/web/src/components/ChatMessage.tsx`
- Create: `packages/web/src/components/PhaseProgress.tsx`
- Create: `packages/web/src/components/ChatInput.tsx`
- Create: `packages/web/src/hooks/useSSE.ts`
- Modify: `packages/web/src/main.tsx` (add route)

**Step 1: Create SSE hook**

```typescript
// packages/web/src/hooks/useSSE.ts
import { useEffect, useRef, useState } from "react";

interface SSEMessage {
  type: string;
  data: unknown;
}

export function useSSE(url: string | null) {
  const [messages, setMessages] = useState<SSEMessage[]>([]);
  const [connected, setConnected] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!url) return;

    const token = localStorage.getItem("token");
    const es = new EventSource(`${url}${url.includes("?") ? "&" : "?"}token=${token}`);
    esRef.current = es;

    es.onopen = () => setConnected(true);
    es.onmessage = (e) => {
      try {
        const parsed = JSON.parse(e.data);
        setMessages((prev) => [...prev, { type: parsed.type ?? "message", data: parsed }]);
      } catch {
        setMessages((prev) => [...prev, { type: "raw", data: e.data }]);
      }
    };
    es.onerror = () => setConnected(false);

    return () => { es.close(); };
  }, [url]);

  return { messages, connected, clear: () => setMessages([]) };
}
```

**Step 2: Create ChatMessage component**

```tsx
// packages/web/src/components/ChatMessage.tsx
interface ChatMessageProps {
  role: "user" | "assistant";
  content: string;
  agentName?: string;
  toolCalls?: Array<{ name: string; status: string }>;
}

export function ChatMessage({ role, content, agentName, toolCalls }: ChatMessageProps) {
  return (
    <div className={`mb-4 ${role === "user" ? "flex justify-end" : ""}`}>
      <div className={`max-w-2xl rounded-lg p-3 ${
        role === "user" ? "bg-blue-600 text-white" : "bg-white border"
      }`}>
        {agentName && (
          <div className="text-xs font-mono text-gray-500 mb-1">Agent: {agentName}</div>
        )}
        <div className="whitespace-pre-wrap text-sm">{content}</div>
        {toolCalls && toolCalls.length > 0 && (
          <div className="mt-2 space-y-1">
            {toolCalls.map((tc, i) => (
              <div key={i} className="text-xs bg-gray-50 px-2 py-1 rounded font-mono">
                [{tc.status}] {tc.name}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
```

**Step 3: Create PhaseProgress panel**

```tsx
// packages/web/src/components/PhaseProgress.tsx
const PHASES = [
  "Task Classification",
  "Software Analysis",
  "Code Wiki Generation",
  "Test Requirements",
  "Code Review & Static",
  "Unit Testing",
  "Test Environment",
  "Confirmation Test Design",
  "Test Execution",
  "Test Summary",
];

interface PhaseProgressProps {
  currentPhase: number;
  phaseStatuses?: Record<number, string>;
}

export function PhaseProgress({ currentPhase, phaseStatuses = {} }: PhaseProgressProps) {
  return (
    <div className="bg-white rounded-lg p-4 shadow">
      <h3 className="font-semibold mb-3">9-Phase Progress</h3>
      <div className="space-y-2">
        {PHASES.map((name, i) => {
          const status = phaseStatuses[i] ?? (i < currentPhase ? "completed" : i === currentPhase ? "in_progress" : "pending");
          const icon = status === "completed" ? "\u2611" : status === "in_progress" ? "\u25B6" : "\u25CB";
          return (
            <div key={i} className={`text-sm flex items-center gap-2 ${
              status === "in_progress" ? "font-semibold text-blue-600" : status === "completed" ? "text-green-600" : "text-gray-400"
            }`}>
              <span>{icon}</span>
              <span>Phase {i}: {name}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

**Step 4: Create ChatInput**

```tsx
// packages/web/src/components/ChatInput.tsx
import { useState } from "react";

const QUICK_COMMANDS = ["/matrix-start", "/matrix-status", "/matrix-report", "/matrix-review"];

interface ChatInputProps {
  onSend: (message: string) => void;
  disabled?: boolean;
}

export function ChatInput({ onSend, disabled }: ChatInputProps) {
  const [value, setValue] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!value.trim() || disabled) return;
    onSend(value.trim());
    setValue("");
  };

  return (
    <div className="border-t bg-white p-3">
      <div className="flex gap-2 mb-2">
        {QUICK_COMMANDS.map((cmd) => (
          <button key={cmd} onClick={() => onSend(cmd)}
            className="text-xs bg-gray-100 hover:bg-gray-200 px-2 py-1 rounded" disabled={disabled}>
            {cmd}
          </button>
        ))}
      </div>
      <form onSubmit={handleSubmit} className="flex gap-2">
        <input value={value} onChange={(e) => setValue(e.target.value)}
          placeholder="Type a message or slash command..."
          className="flex-1 border rounded px-3 py-2 text-sm" disabled={disabled} />
        <button type="submit" className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700"
          disabled={disabled || !value.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}
```

**Step 5: Create ProjectChat page (combines everything)**

```tsx
// packages/web/src/pages/ProjectChat.tsx
import { useState, useEffect, useRef } from "react";
import { useParams } from "react-router-dom";
import { apiFetch } from "../api/client";
import { useSSE } from "../hooks/useSSE";
import { ChatMessage } from "../components/ChatMessage";
import { PhaseProgress } from "../components/PhaseProgress";
import { ChatInput } from "../components/ChatInput";

const API_BASE = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

interface Message {
  role: "user" | "assistant";
  content: string;
  agentName?: string;
}

export function ProjectChat() {
  const { id: projectId } = useParams<{ id: string }>();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [currentPhase, setCurrentPhase] = useState(-1);
  const [sending, setSending] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const sseUrl = sessionId ? `${API_BASE}/api/projects/${projectId}/sessions/${sessionId}/events` : null;
  const { messages: sseEvents } = useSSE(sseUrl);

  // Process SSE events into chat messages
  useEffect(() => {
    for (const event of sseEvents) {
      const data = event.data as Record<string, unknown>;
      if (data.type === "message" && data.content) {
        setMessages((prev) => [...prev, {
          role: "assistant",
          content: String(data.content),
          agentName: data.agent as string | undefined,
        }]);
      }
      if (data.type === "phase_update" && typeof data.phase === "number") {
        setCurrentPhase(data.phase as number);
      }
    }
  }, [sseEvents]);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Create session on mount
  useEffect(() => {
    if (!projectId) return;
    apiFetch<{ id: string }>(`/api/projects/${projectId}/sessions`, { method: "POST" })
      .then((res) => setSessionId(res.id))
      .catch(console.error);
  }, [projectId]);

  // Load progress
  useEffect(() => {
    if (!projectId) return;
    apiFetch<{ currentPhase?: number }>(`/api/projects/${projectId}/progress`)
      .then((p) => setCurrentPhase(p.currentPhase ?? -1))
      .catch(() => {});
  }, [projectId]);

  const handleSend = async (content: string) => {
    if (!sessionId) return;
    setMessages((prev) => [...prev, { role: "user", content }]);
    setSending(true);
    try {
      await apiFetch(`/api/projects/${projectId}/sessions/${sessionId}/prompt`, {
        method: "POST",
        body: JSON.stringify({ content }),
      });
    } catch (err) {
      setMessages((prev) => [...prev, { role: "assistant", content: `Error: ${(err as Error).message}` }]);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex h-full -m-6">
      {/* Chat area */}
      <div className="flex-1 flex flex-col">
        <div className="flex-1 overflow-auto p-4 space-y-2">
          {messages.map((msg, i) => (
            <ChatMessage key={i} role={msg.role} content={msg.content} agentName={msg.agentName} />
          ))}
          <div ref={messagesEndRef} />
        </div>
        <ChatInput onSend={handleSend} disabled={sending || !sessionId} />
      </div>

      {/* Right panel */}
      <div className="w-72 border-l bg-gray-50 p-4 overflow-auto space-y-4">
        <PhaseProgress currentPhase={currentPhase} />
      </div>
    </div>
  );
}
```

**Step 6: Add route in main.tsx**

Add inside `<Route element={<Layout />}>`:
```tsx
<Route path="/projects/:id/chat" element={<ProjectChat />} />
```

**Step 7: Verify**

Run: `cd packages/web && bun run dev`
Expected: Chat page renders at /projects/:id/chat with message panel, input, and progress sidebar.

**Step 8: Commit**

```bash
git add -A && git commit -m "feat: add Chat UI with SSE streaming, phase progress panel, and quick commands"
```

---

## Task 12: Frontend — Reports & Project Pages

**Files:**
- Create: `packages/web/src/pages/ProjectReports.tsx`
- Create: `packages/web/src/pages/ProjectDefects.tsx`
- Create: `packages/web/src/pages/ProjectSettings.tsx`
- Create: `packages/web/src/pages/ProjectMembers.tsx`
- Create: `packages/web/src/pages/NewProject.tsx`
- Create: `packages/web/src/components/ProjectLayout.tsx`
- Create: `packages/web/src/components/MarkdownRenderer.tsx`
- Modify: `packages/web/src/main.tsx` (add routes)

**Step 1: Create MarkdownRenderer (for rendering .matrix/reports/*.md)**

```tsx
// packages/web/src/components/MarkdownRenderer.tsx
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function MarkdownRenderer({ content }: { content: string }) {
  return (
    <div className="prose prose-sm max-w-none">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}
```

Add deps: `react-markdown`, `remark-gfm` to `packages/web/package.json`.

**Step 2: Create ProjectLayout (sub-nav for project pages)**

```tsx
// packages/web/src/components/ProjectLayout.tsx
import { Outlet, Link, useParams, useLocation } from "react-router-dom";

const TABS = [
  { path: "chat", label: "Chat" },
  { path: "reports", label: "Reports" },
  { path: "defects", label: "Defects" },
  { path: "members", label: "Members" },
  { path: "settings", label: "Settings" },
];

export function ProjectLayout() {
  const { id } = useParams();
  const location = useLocation();

  return (
    <div className="h-full flex flex-col">
      <div className="flex gap-1 border-b bg-white px-4">
        {TABS.map((tab) => (
          <Link key={tab.path} to={`/projects/${id}/${tab.path}`}
            className={`px-3 py-2 text-sm border-b-2 ${
              location.pathname.includes(tab.path) ? "border-blue-600 text-blue-600" : "border-transparent text-gray-500 hover:text-gray-700"
            }`}>
            {tab.label}
          </Link>
        ))}
      </div>
      <div className="flex-1 overflow-auto p-6">
        <Outlet />
      </div>
    </div>
  );
}
```

**Step 3: Create ProjectReports page**

```tsx
// packages/web/src/pages/ProjectReports.tsx
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { apiFetch } from "../api/client";
import { MarkdownRenderer } from "../components/MarkdownRenderer";

export function ProjectReports() {
  const { id } = useParams();
  const [reports, setReports] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState("");

  useEffect(() => {
    if (!id) return;
    apiFetch<string[]>(`/api/projects/${id}/reports`).then(setReports);
  }, [id]);

  useEffect(() => {
    if (!id || !selected) return;
    fetch(`${import.meta.env.VITE_API_URL ?? "http://localhost:3000"}/api/projects/${id}/reports/${selected}`, {
      headers: { Authorization: `Bearer ${localStorage.getItem("token")}` },
    }).then((r) => r.text()).then(setContent);
  }, [id, selected]);

  return (
    <div className="flex gap-4 h-full">
      <div className="w-56 space-y-1">
        <h3 className="font-semibold mb-2">Reports</h3>
        {reports.map((r) => (
          <button key={r} onClick={() => setSelected(r)}
            className={`block w-full text-left text-sm px-2 py-1 rounded ${selected === r ? "bg-blue-100 text-blue-700" : "hover:bg-gray-100"}`}>
            {r.replace(".md", "")}
          </button>
        ))}
      </div>
      <div className="flex-1 bg-white rounded-lg p-6 shadow overflow-auto">
        {selected ? <MarkdownRenderer content={content} /> : <p className="text-gray-400">Select a report</p>}
      </div>
    </div>
  );
}
```

**Step 4: Create ProjectDefects, ProjectMembers, ProjectSettings, NewProject pages**

These are standard CRUD pages. Each follows the same pattern: fetch data from API, render table/form, handle actions. Implementation follows the same React + apiFetch pattern as above. (Code omitted for brevity — each is a ~60 line component.)

**Step 5: Update routing in main.tsx**

```tsx
<Route path="/projects/new" element={<NewProject />} />
<Route path="/projects/:id" element={<ProjectLayout />}>
  <Route index element={<Navigate to="chat" />} />
  <Route path="chat" element={<ProjectChat />} />
  <Route path="reports" element={<ProjectReports />} />
  <Route path="defects" element={<ProjectDefects />} />
  <Route path="members" element={<ProjectMembers />} />
  <Route path="settings" element={<ProjectSettings />} />
</Route>
```

**Step 6: Commit**

```bash
git add -A && git commit -m "feat: add project reports, defects, members, settings, and new project pages"
```

---

## Task 13: Frontend — Admin Console

**Files:**
- Create: `packages/web/src/pages/admin/AdminLayout.tsx`
- Create: `packages/web/src/pages/admin/Tenants.tsx`
- Create: `packages/web/src/pages/admin/Users.tsx`
- Create: `packages/web/src/pages/admin/Usage.tsx`
- Create: `packages/web/src/pages/admin/Containers.tsx`
- Create: `packages/web/src/pages/admin/AuditLog.tsx`
- Create: `packages/web/src/pages/admin/Quotas.tsx`
- Modify: `packages/web/src/main.tsx` (add admin routes)

**Step 1: Create AdminLayout**

```tsx
// packages/web/src/pages/admin/AdminLayout.tsx
import { Outlet, Link, useLocation, Navigate } from "react-router-dom";
import { useAuth } from "../../hooks/useAuth";

const ADMIN_TABS = [
  { path: "tenants", label: "Tenants" },
  { path: "users", label: "Users" },
  { path: "usage", label: "Usage" },
  { path: "containers", label: "Containers" },
  { path: "audit", label: "Audit Log" },
  { path: "quotas", label: "Quotas" },
];

export function AdminLayout() {
  const { user } = useAuth();
  const location = useLocation();
  if (user?.role !== "admin") return <Navigate to="/dashboard" />;

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">Admin Console</h1>
      <div className="flex gap-1 border-b mb-6">
        {ADMIN_TABS.map((tab) => (
          <Link key={tab.path} to={`/admin/${tab.path}`}
            className={`px-3 py-2 text-sm border-b-2 ${
              location.pathname.includes(tab.path) ? "border-blue-600 text-blue-600" : "border-transparent text-gray-500"
            }`}>
            {tab.label}
          </Link>
        ))}
      </div>
      <Outlet />
    </div>
  );
}
```

**Step 2: Create admin pages (Tenants, Users, Usage, Containers, AuditLog, Quotas)**

Each page follows the pattern: fetch from `/api/admin/*`, render table, handle create/delete actions. Usage page includes a chart of token consumption per tenant (use a simple bar chart with CSS or recharts). Containers page has "Stop" button per container.

(Code for each page follows the same React pattern — ~50-80 lines per file. Details omitted for DRY.)

**Step 3: Add admin routes in main.tsx**

```tsx
<Route path="/admin" element={<AdminLayout />}>
  <Route index element={<Navigate to="tenants" />} />
  <Route path="tenants" element={<Tenants />} />
  <Route path="users" element={<Users />} />
  <Route path="usage" element={<Usage />} />
  <Route path="containers" element={<Containers />} />
  <Route path="audit" element={<AuditLog />} />
  <Route path="quotas" element={<Quotas />} />
</Route>
```

**Step 4: Commit**

```bash
git add -A && git commit -m "feat: add admin console with tenant, user, usage, container, and audit management"
```

---

## Task 14: Docker Compose Deployment

**Files:**
- Create: `docker-compose.yml`
- Create: `docker/Dockerfile.platform`
- Create: `.env.example`
- Create: `scripts/seed.ts` (create initial admin user)

**Step 1: Create platform Dockerfile**

```dockerfile
# docker/Dockerfile.platform
FROM oven/bun:1-debian

WORKDIR /app

COPY package.json bun.lockb ./
COPY packages/shared/package.json packages/shared/
COPY packages/api/package.json packages/api/

RUN bun install --frozen-lockfile

COPY packages/shared/ packages/shared/
COPY packages/api/ packages/api/

# Build frontend
COPY packages/web/ packages/web/
RUN cd packages/web && bun run build

EXPOSE 3000

CMD ["bun", "run", "packages/api/src/index.ts"]
```

**Step 2: Create docker-compose.yml**

```yaml
# docker-compose.yml
version: "3.8"

services:
  platform:
    build:
      context: .
      dockerfile: docker/Dockerfile.platform
    ports:
      - "3000:3000"
    environment:
      DATABASE_URL: postgres://matrix:matrix@postgres:5432/matrix_platform
      REDIS_URL: redis://redis:6379
      JWT_SECRET: ${JWT_SECRET:-change-me-in-production}
      LLM_API_KEY: ${LLM_API_KEY}
      DATA_ROOT: /data
      DOCKER_SOCKET: /var/run/docker.sock
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - platform-data:/data
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_started

  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: matrix
      POSTGRES_PASSWORD: matrix
      POSTGRES_DB: matrix_platform
    volumes:
      - pg-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U matrix"]
      interval: 5s
      timeout: 3s
      retries: 5

  redis:
    image: redis:7-alpine
    volumes:
      - redis-data:/data

volumes:
  platform-data:
  pg-data:
  redis-data:
```

**Step 3: Create .env.example**

```bash
# .env.example
JWT_SECRET=your-secret-key-here
LLM_API_KEY=your-llm-api-key-here
```

**Step 4: Create seed script**

```typescript
// scripts/seed.ts
import { db } from "../packages/api/src/db/connection";
import { tenants, users } from "../packages/api/src/db/schema";
import { hashPassword } from "../packages/api/src/auth/password";

async function seed() {
  // Create default tenant
  const [tenant] = await db.insert(tenants).values({
    name: "Default",
    quotaTokens: 0,
    quotaProjects: 0,
  }).returning();

  // Create admin user
  const passwordHash = await hashPassword("admin123");
  const [admin] = await db.insert(users).values({
    tenantId: tenant.id,
    email: "admin@matrix.local",
    passwordHash,
    role: "admin",
  }).returning();

  console.log(`Tenant created: ${tenant.id}`);
  console.log(`Admin user created: ${admin.email} / admin123`);
  process.exit(0);
}

seed().catch(console.error);
```

**Step 5: Build and test deployment**

Run: `docker compose up --build -d`
Run: `sleep 15 && bun run scripts/seed.ts`
Run: `curl http://localhost:3000/health`
Expected: `{"status":"ok"}`

Run: `curl -X POST http://localhost:3000/api/auth/login -H 'Content-Type: application/json' -d '{"email":"admin@matrix.local","password":"admin123"}'`
Expected: JWT token returned

**Step 6: Commit**

```bash
git add -A && git commit -m "feat: add Docker Compose deployment with PostgreSQL, Redis, and seed script"
```

---

## Task 15: End-to-End Integration Test

**Files:**
- Create: `packages/api/src/__tests__/e2e.test.ts`

**Step 1: Write integration test**

```typescript
// packages/api/src/__tests__/e2e.test.ts
import { describe, test, expect, beforeAll } from "bun:test";

const BASE = "http://localhost:3000";
let token: string;
let projectId: string;

describe("e2e: full platform flow", () => {
  test("health check", async () => {
    const res = await fetch(`${BASE}/health`);
    expect(res.ok).toBe(true);
  });

  test("login as admin", async () => {
    const res = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin@matrix.local", password: "admin123" }),
    });
    expect(res.ok).toBe(true);
    const body = await res.json();
    token = body.token;
    expect(token).toBeTruthy();
  });

  test("create project", async () => {
    const res = await fetch(`${BASE}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: "test-project", toolchain: "generic" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    projectId = body.id;
    expect(projectId).toBeTruthy();
  });

  test("list projects includes new project", async () => {
    const res = await fetch(`${BASE}/api/projects`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await res.json();
    expect(body.some((p: { id: string }) => p.id === projectId)).toBe(true);
  });

  test("get progress returns default", async () => {
    const res = await fetch(`${BASE}/api/projects/${projectId}/progress`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await res.json();
    expect(body.currentPhase).toBe(-1);
  });

  test("admin: list tenants", async () => {
    const res = await fetch(`${BASE}/api/admin/tenants`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.ok).toBe(true);
    const body = await res.json();
    expect(body.length).toBeGreaterThan(0);
  });

  test("admin: usage summary", async () => {
    const res = await fetch(`${BASE}/api/admin/usage/summary`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.ok).toBe(true);
  });
});
```

**Step 2: Run tests**

Run: `cd packages/api && bun test src/__tests__/e2e.test.ts`
Expected: All tests PASS

**Step 3: Commit**

```bash
git add -A && git commit -m "test: add end-to-end integration tests for platform API"
```

---

## Summary of Tasks

| # | Task | Scope |
|---|------|-------|
| 1 | Monorepo scaffold + shared types | Project structure, TypeScript types |
| 2 | Database layer (Drizzle + PostgreSQL) | Schema, migrations, connection |
| 3 | Authentication (JWT + bcrypt) | Login, middleware, audit logging |
| 4 | Container management (Dockerode) | Container config, lifecycle, registry |
| 5 | Worker Docker images | Base + ARM + 8051 + Generic Dockerfiles |
| 6 | Project management API | CRUD, upload, Git clone, members |
| 7 | OpenCode proxy + SSE | Proxy to container serve API, metering |
| 8 | Report & data serving API | Read .matrix/ files, serve reports |
| 9 | Admin API | Tenants, users, containers, audit, quotas |
| 10 | Frontend: scaffold + auth + layout | React, routing, login, dashboard |
| 11 | Frontend: Chat UI | Core chat page with SSE streaming |
| 12 | Frontend: reports & project pages | Reports, defects, members, settings |
| 13 | Frontend: admin console | All admin management pages |
| 14 | Docker Compose deployment | Full deployment config, seed script |
| 15 | End-to-end integration test | Full API flow validation |
