# Docker Isolation Stage 1 — Owning the Socket Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `docker:` sandbox-escape access model with a per-worker filtering Docker socket that localmost owns, so container work is checked against the repository's approved policy instead of bypassing it.

**Architecture:** localmost mints a unix socket per worker inside that worker's ephemeral sandbox directory and points the job's `DOCKER_HOST` at it. A `DockerFilterProxy` behind the socket parses each Docker Engine API request, evaluates it against the worker's bound `DockerPolicy`, and forwards only permitted requests to a `DockerBackend`. Stage 1's only backend (`DesktopBackend`) forwards to the operator's existing daemon; the backend seam is where Stage 2 (a VM) later swaps in.

**Tech Stack:** TypeScript, Electron main process, Node `http`/`net` (unix socket server, like `ProxyServer`), `js-yaml`, Jest + ts-jest. macOS-only.

**Spec:** `docs/superpowers/specs/2026-09-05-docker-isolation-design.md` (read it alongside this plan; the plan argues from it).

## Global Constraints

- macOS only; no Windows/Linux support (CLAUDE.md).
- Prefer allowlists over blocklists; anything a policy does not name is denied (spec: "Anything not listed is denied").
- The filter fails closed: unknown endpoints, unknown API versions, unparseable bodies, and any request the proxy cannot fully understand are refused (spec: Failure Modes).
- `privileged` exists in the grammar but is rejected unless the backend is a managed VM; at Stage 1 it always fails at approval time with a message naming the backend requirement.
- Socket paths are capped at 104 bytes on macOS; the socket takes a short fixed name (`docker.sock`) at the sandbox directory root.
- TDD throughout: failing test first, watch it fail, minimal code, watch it pass, commit. Run `npm run test:main` for main-process tests; a single file with `npx jest --config test/jest.config.js <path>`.
- Follow existing test conventions: real temp dirs via `fs.mkdtempSync`, `jest.mock('./paths', …)` and `jest.mock('./app-state', …)` where needed (see `src/main/policy-cache.test.ts`), and the `RunnerManagerTestHelper` in `src/main/test-utils/runner-manager-helper.ts` for driving `RunnerManager` internals.
- Breaking policy change: `docker: socket | contexts | credentials | true` becomes a validation error naming the action that replaces it.

## File Structure

**New files**
- `src/shared/docker-policy.ts` — the `DockerPolicy` type, its validator, merge, diff, and serializer. Pure, shared (main + CLI).
- `src/shared/docker-policy.test.ts` — schema, validation, merge, diff, migration-error tests.
- `src/main/docker/docker-request.ts` — parse a raw Docker Engine API request line+headers+body into a typed `DockerRequest`; the verb→endpoint map.
- `src/main/docker/docker-request.test.ts`
- `src/main/docker/docker-evaluator.ts` — pure `evaluateDockerRequest(req, policy, ctx)` → allow/deny + reason + policy hint. The security core.
- `src/main/docker/docker-evaluator.test.ts` — the SECURITY.md escapes as executable tests, verb-to-endpoint assertions, fail-closed cases.
- `src/main/docker/docker-backend.ts` — `DockerBackend` interface + `DesktopBackend`.
- `src/main/docker/docker-backend.test.ts`
- `src/main/docker/docker-filter-proxy.ts` — the per-worker unix-socket server; mirrors `ProxyServer`'s shape.
- `src/main/docker/docker-filter-proxy.test.ts` — end-to-end request handling over a real unix socket, default-deny, repo-mismatch, version pinning, credential attachment.

**Modified files**
- `src/main/broker-proxy-service.ts` — parse `github.workflow`; add `githubWorkflow` to `GitHubJobInfo` and the `job-received` payload.
- `src/main/index.ts` — thread `githubWorkflow` into `setPendingTargetContext`; make `getRepoPolicy` return a `DockerPolicy`; construct the backend.
- `src/main/runner-manager.ts` — carry `githubWorkflow` on pending context and `currentJob`; use it (not the scraped job name) for per-workflow policy; mint the socket + `DockerFilterProxy` per spawn; bind policy on claim; drop the old `dockerGrants` socket wiring.
- `src/main/process-sandbox.ts` — grant the worker's `docker.sock` subdir `network-outbound` + `file-read*`, deny `file-write*`; remove the daemon-socket hole and its ordering subtlety; keep `~/.docker` denied in full.
- `src/shared/sandbox-profile.ts` — `SandboxPolicy.docker` becomes `DockerPolicy` instead of `DockerAccessLevel`.
- `src/shared/localmostrc.ts` — delegate docker validation/merge/diff/serialization to `docker-policy.ts`; allow `workflows.<name>.docker`.
- `src/main/runner-manager.ts` (`RepoPolicyRuntime`) — `docker: DockerPolicy` instead of `DockerAccessLevel`.
- `src/shared/docker-access.ts` — keep `resolveDockerEndpoint`/`DockerEndpoint`/`DockerFsProbe`; delete `DockerAccessLevel`, `DOCKER_ACCESS_LEVELS`, `isDockerAccessLevel`, `dockerSandboxGrants`, `DockerGrants` once no longer referenced.
- Docs: `docs/roadmap/localmostrc.md`, `README.md`, `SECURITY.md`, `CHANGELOG.md`.

---

## Task 1: Thread the real workflow name to policy binding

Prerequisite defect fix; independently shippable. Per-workflow policy currently keys on the scraped job name (`Running job: <name>`), not the workflow filename, so `workflows.<name>` sections rarely fire — and `workflows.<name>.docker` cannot work without this. The broker already receives `github.workflow` and drops it.

**Files:**
- Modify: `src/main/broker-proxy-service.ts` (`GitHubJobInfo` ~182-188; contextData parse ~472-480; `job-received` emit ~539-546)
- Modify: `src/main/index.ts` (`job-received` handler → `setPendingTargetContext('next', …)` ~486)
- Modify: `src/main/runner-manager.ts` (`setPendingTargetContext` signature ~348; `pendingTargetContext` map type ~184; `currentJob` build ~1392; `applyRepoPolicy` ~1698-1720)
- Test: `src/main/broker-proxy-service.test.ts`, `src/main/runner-manager.test.ts`

**Interfaces:**
- Consumes: broker `contextData.github.d[]` items (`{k, v}`), including `{k: 'workflow', v: <name>}`.
- Produces: `GitHubJobInfo.githubWorkflow?: string`; `setPendingTargetContext(runnerName, targetId, targetDisplayName, actionsUrl?, githubRunId?, githubJobId?, githubActor?, githubSha?, githubRef?, githubWorkflow?)`; `pendingTargetContext` entries gain `githubWorkflow?: string`; `RunnerInstance.currentJob.githubWorkflow?: string`.

- [ ] **Step 1: Write the failing test — broker extracts the workflow name**

Add to `src/main/broker-proxy-service.test.ts` (follow the file's existing pattern for building a `contextData.github` payload; if none exists, test the extraction against a `parsed.contextData.github.d` array shaped as below):

```typescript
it('extracts github.workflow into the job info', () => {
  const github = { d: [
    { k: 'run_id', v: '123' },
    { k: 'repository', v: 'owner/repo' },
    { k: 'workflow', v: 'integration' },
  ] };
  const info = extractGitHubJobInfo(github); // exported helper (extract from the inline parse)
  expect(info.githubWorkflow).toBe('integration');
});
```

If the parse is currently inline in `handleAcquireJob`, first extract it into an exported pure `extractGitHubJobInfo(github: { d?: Array<{k: string; v: string}> }): GitHubJobInfo` and have the caller use it — this is the "make it testable" refactor and should be its own commit if the file has no seam.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest --config test/jest.config.js src/main/broker-proxy-service.test.ts -t "github.workflow"`
Expected: FAIL — `githubWorkflow` is `undefined` (the loop never reads `workflow`).

- [ ] **Step 3: Add the field and parse it**

In `GitHubJobInfo` add `githubWorkflow?: string;`. In the extraction loop add:

```typescript
if (item.k === 'workflow') githubWorkflow = item.v;
```

Declare `let githubWorkflow: string | undefined;` alongside the other locals and include `githubWorkflow` in the returned/emitted `GitHubJobInfo`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest --config test/jest.config.js src/main/broker-proxy-service.test.ts -t "github.workflow"`
Expected: PASS.

- [ ] **Step 5: Write the failing test — per-workflow policy uses the workflow name, not the job name**

Add to `src/main/runner-manager.test.ts`:

```typescript
it('binds per-workflow policy by the github workflow name, not the scraped job name', async () => {
  const seen: string[] = [];
  const manager = new RunnerManager({
    onLog: mockOnLog, onStatusChange: mockOnStatusChange, onJobHistoryUpdate: mockOnJobHistoryUpdate,
    getRepoPolicy: async (_o, _r, _sha, workflowName) => {
      seen.push(workflowName);
      return { hosts: [], level: 'strict', readPaths: [], writePaths: [], docker: {} };
    },
  });
  const helper = new RunnerManagerTestHelper(manager);
  helper.setInstance(1, { name: 'runner-1', status: 'listening' });
  helper.setProxy(1, { setPolicyAllowedHosts: jest.fn(), setPolicyLevel: jest.fn() });
  helper.setPendingTargetContext('1', {
    targetId: 't1', targetDisplayName: 'owner/repo', githubSha: 'abc1234', githubWorkflow: 'integration',
  });

  await helper.parseRunnerOutput(1, 'Running job: Build and test'); // job name != workflow name

  expect(seen).toContain('integration');
  expect(seen).not.toContain('Build and test');
});
```

(`RepoPolicyRuntime.docker` becomes `DockerPolicy` in Task 8; for this task a `{}` value type-checks once Task 8 lands. If executing strictly in order, temporarily type the test's `docker` as `'off'` to match the current `DockerAccessLevel` and update it in Task 8's commit. Note the temporary value so the Task 8 self-review catches it.)

- [ ] **Step 6: Run test to verify it fails**

Run: `npx jest --config test/jest.config.js src/main/runner-manager.test.ts -t "github workflow name"`
Expected: FAIL — `seen` contains `'Build and test'` (the job name), not `'integration'`.

- [ ] **Step 7: Thread `githubWorkflow` through spawn context and use it**

- Add `githubWorkflow?: string` to the `pendingTargetContext` map value type (~184) and to `currentJob` (~1392, set `githubWorkflow: targetContext?.githubWorkflow`).
- Extend `setPendingTargetContext` (~348) with a trailing `githubWorkflow?: string` param stored in the entry.
- In `index.ts` (~486) pass `githubInfo.githubWorkflow` as the new trailing argument.
- In `applyRepoPolicy` (~1718) replace `instance.currentJob.name` with `instance.currentJob.githubWorkflow ?? instance.currentJob.name` (fall back to the job name only when the workflow name is absent).

- [ ] **Step 8: Run test to verify it passes, plus the suite**

Run: `npx jest --config test/jest.config.js src/main/runner-manager.test.ts src/main/broker-proxy-service.test.ts`
Expected: PASS, no regressions.

- [ ] **Step 9: Commit**

```bash
git add src/main/broker-proxy-service.ts src/main/broker-proxy-service.test.ts src/main/index.ts src/main/runner-manager.ts src/main/runner-manager.test.ts
git commit -m "Bind per-workflow policy to the real workflow name"
```

---

## Task 2: The `DockerPolicy` type and its schema

**Files:**
- Create: `src/shared/docker-policy.ts`
- Test: `src/shared/docker-policy.test.ts`

**Interfaces:**
- Produces:

```typescript
export type MountMode = 'ro' | 'rw';
export interface DockerMount { path: string; mode: MountMode }
export interface DockerRunPolicy { images?: string[]; mounts?: DockerMount[]; network?: string }
export interface DockerPullPolicy { registries: string[] }
export interface DockerBuildPolicy { context?: string }
export interface DockerPolicy {
  pull?: DockerPullPolicy;
  run?: DockerRunPolicy;
  build?: DockerBuildPolicy;
  /** Grammar-present but rejected at approval unless the backend is a managed VM. */
  privileged?: boolean;
}
/** True when the policy grants nothing (used to keep `off` == `{}`/absent). */
export const isEmptyDockerPolicy = (p?: DockerPolicy): boolean =>
  !p || (!p.pull && !p.run && !p.build && !p.privileged);
```

- [ ] **Step 1: Write the failing test**

```typescript
import { isEmptyDockerPolicy, DockerPolicy } from './docker-policy';

it('treats an absent or all-empty docker policy as empty', () => {
  expect(isEmptyDockerPolicy(undefined)).toBe(true);
  expect(isEmptyDockerPolicy({})).toBe(true);
  expect(isEmptyDockerPolicy({ run: { images: ['postgres:16'] } })).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest --config test/jest.config.js src/shared/docker-policy.test.ts`
Expected: FAIL — module not found / `isEmptyDockerPolicy` not exported.

- [ ] **Step 3: Write the type module**

Create `src/shared/docker-policy.ts` with the interfaces and `isEmptyDockerPolicy` above.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest --config test/jest.config.js src/shared/docker-policy.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/docker-policy.ts src/shared/docker-policy.test.ts
git commit -m "Add the docker policy grammar types"
```

---

## Task 3: Validate the docker policy and reject the old enum

**Files:**
- Modify: `src/shared/docker-policy.ts` (add `validateDockerPolicy`)
- Modify: `src/shared/localmostrc.ts` (replace the enum branch ~245-256 with a call into `validateDockerPolicy`; allow docker under `workflows.<name>`)
- Test: `src/shared/docker-policy.test.ts`

**Interfaces:**
- Consumes: `ParseError` shape `{ message: string; line?: number }` from `localmostrc.ts` — accept a `push: (message: string) => void` so this module stays free of a localmostrc import cycle.
- Produces: `validateDockerPolicy(value: unknown, path: string, push: (message: string) => void): void`.

- [ ] **Step 1: Write the failing tests**

```typescript
import { validateDockerPolicy } from './docker-policy';

const collect = (value: unknown, path = 'shared.docker') => {
  const errs: string[] = [];
  validateDockerPolicy(value, path, (m) => errs.push(m));
  return errs;
};

it('rejects the old string levels with a message naming the new actions', () => {
  for (const level of ['socket', 'contexts', 'credentials', 'true']) {
    const errs = collect(level);
    expect(errs.join('\n')).toMatch(/no longer.*use `pull`, `run`, `build`/i);
  }
});

it('accepts a run policy with images, mounts and network', () => {
  expect(collect({ run: { images: ['postgres:16'], mounts: [{ path: './', mode: 'ro' }], network: 'bridge' } })).toEqual([]);
});

it('rejects an unknown docker action', () => {
  expect(collect({ exec: {} }).join('\n')).toMatch(/unknown docker action.*exec/i);
});

it('rejects a mount without a valid mode', () => {
  expect(collect({ run: { mounts: [{ path: './', mode: 'write' }] } }).join('\n')).toMatch(/mount mode must be 'ro' or 'rw'/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest --config test/jest.config.js src/shared/docker-policy.test.ts -t "docker"`
Expected: FAIL — `validateDockerPolicy` not exported.

- [ ] **Step 3: Implement `validateDockerPolicy`**

```typescript
const KNOWN_ACTIONS = ['pull', 'run', 'build', 'privileged'] as const;

export function validateDockerPolicy(value: unknown, path: string, push: (m: string) => void): void {
  if (typeof value === 'string' || typeof value === 'boolean') {
    push(`${path} is no longer a level; use \`pull\`, \`run\`, and \`build\` actions instead (was: ${value})`);
    return;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    push(`${path} must be an object of docker actions (pull, run, build)`);
    return;
  }
  const v = value as Record<string, unknown>;
  for (const key of Object.keys(v)) {
    if (!(KNOWN_ACTIONS as readonly string[]).includes(key)) {
      push(`${path}: unknown docker action "${key}" (expected one of: ${KNOWN_ACTIONS.join(', ')})`);
    }
  }
  if (v.run !== undefined) validateRun(v.run, `${path}.run`, push);
  if (v.pull !== undefined) validatePull(v.pull, `${path}.pull`, push);
  if (v.build !== undefined) validateBuild(v.build, `${path}.build`, push);
  if (v.privileged !== undefined && typeof v.privileged !== 'boolean') {
    push(`${path}.privileged must be a boolean`);
  }
}
```

Add `validateRun` (checks `images` is a string[], `mounts` is an array of `{ path: string; mode: 'ro'|'rw' }` with the message `mount mode must be 'ro' or 'rw'`, `network` is a string), `validatePull` (`registries` required string[]), `validateBuild` (`context` optional string). In `localmostrc.ts` `validatePolicy`, replace the enum branch (~245-256) with `if (p.docker !== undefined) validateDockerPolicy(p.docker, \`${path}.docker\`, (m) => errors.push({ message: m }));` and remove the `workflows.<name>.docker is not supported` special case so it validates the same at both scopes.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest --config test/jest.config.js src/shared/docker-policy.test.ts src/shared/localmostrc.test.ts`
Expected: PASS. Update any existing `localmostrc.test.ts` case that asserted the old enum message (change it to expect the new "no longer a level" message) — this is intended by the migration.

- [ ] **Step 5: Commit**

```bash
git add src/shared/docker-policy.ts src/shared/docker-policy.test.ts src/shared/localmostrc.ts src/shared/localmostrc.test.ts
git commit -m "Validate the docker action grammar and reject the old levels"
```

---

## Task 4: `SandboxPolicy.docker` becomes `DockerPolicy`; merge composes additively

**Files:**
- Modify: `src/shared/sandbox-profile.ts` (`SandboxPolicy.docker` type ~41)
- Modify: `src/shared/localmostrc.ts` (`mergePolicies` docker branch ~416-424)
- Modify: `src/shared/docker-policy.ts` (add `mergeDockerPolicy`)
- Test: `src/shared/docker-policy.test.ts`

**Interfaces:**
- Produces: `mergeDockerPolicy(base?: DockerPolicy, override?: DockerPolicy): DockerPolicy | undefined` — additive: `shared` and `workflows.<name>` compose; arrays concatenate (deduped), `network`/`context` override, `privileged` ORs.
- Changes: `SandboxPolicy.docker?: DockerPolicy` (was `DockerAccessLevel`).

- [ ] **Step 1: Write the failing test**

```typescript
import { mergeDockerPolicy } from './docker-policy';

it('composes shared and workflow docker policy additively', () => {
  const merged = mergeDockerPolicy(
    { run: { images: ['postgres:16'], mounts: [{ path: './', mode: 'ro' }] } },
    { run: { mounts: [{ path: './tmp/fixtures', mode: 'rw' }] } },
  );
  expect(merged?.run?.images).toEqual(['postgres:16']);
  expect(merged?.run?.mounts).toEqual([
    { path: './', mode: 'ro' },
    { path: './tmp/fixtures', mode: 'rw' },
  ]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest --config test/jest.config.js src/shared/docker-policy.test.ts -t "composes shared and workflow"`
Expected: FAIL — `mergeDockerPolicy` not exported.

- [ ] **Step 3: Implement merge and switch the type**

Implement `mergeDockerPolicy` (concat+dedupe `images`, `registries`, `mounts`; `override.run.network ?? base.run.network`; `override.build.context ?? base.build.context`; `privileged` = `base || override`; return `undefined` when both empty). Change `SandboxPolicy.docker` to `DockerPolicy` in `sandbox-profile.ts` (import from `./docker-policy`). In `mergePolicies`, replace `docker: base.docker` with `docker: mergeDockerPolicy(base.docker, override.docker)`.

- [ ] **Step 4: Run test to verify it passes, and typecheck**

Run: `npx jest --config test/jest.config.js src/shared/docker-policy.test.ts && npx tsc --noEmit`
Expected: PASS; tsc will now flag every remaining `DockerAccessLevel` consumer — those are Tasks 8, 11, 12. Note them; do not fix out of order here beyond what this task owns.

- [ ] **Step 5: Commit**

```bash
git add src/shared/docker-policy.ts src/shared/docker-policy.test.ts src/shared/sandbox-profile.ts src/shared/localmostrc.ts
git commit -m "Make docker policy compose across shared and workflow"
```

---

## Task 5: Diff, serialize, and migrate the docker block

**Files:**
- Modify: `src/shared/docker-policy.ts` (add `diffDockerPolicy`, `serializeDockerPolicy`)
- Modify: `src/shared/localmostrc.ts` (`diffPolicies` docker branch ~610-624; `serializePolicy` ~487)
- Test: `src/shared/docker-policy.test.ts`, `src/shared/localmostrc.test.ts`

**Interfaces:**
- Consumes: `PolicyDiff` `{ path; type: 'added'|'removed'|'changed'; oldValue?; newValue? }`.
- Produces: `diffDockerPolicy(oldP: DockerPolicy | undefined, newP: DockerPolicy | undefined, prefix: string): PolicyDiff[]`; `serializeDockerPolicy(policy: DockerPolicy, indent: string): string[]`.

- [ ] **Step 1: Write the failing test**

```typescript
import { diffDockerPolicy } from './docker-policy';

it('reports each added docker grant so the approval diff shows it', () => {
  const diffs = diffDockerPolicy(undefined, { run: { images: ['postgres:16'] }, pull: { registries: ['docker.io'] } }, 'shared.docker');
  const paths = diffs.map((d) => d.path);
  expect(paths).toContain('shared.docker.run.images');
  expect(paths).toContain('shared.docker.pull.registries');
  expect(diffs.every((d) => d.type === 'added')).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest --config test/jest.config.js src/shared/docker-policy.test.ts -t "approval diff"`
Expected: FAIL — `diffDockerPolicy` not exported.

- [ ] **Step 3: Implement diff + serialize; wire into localmostrc**

Implement `diffDockerPolicy` (array diffs for `run.images`, `run.mounts` (compare as `path:mode` strings), `pull.registries`; scalar diffs for `run.network`, `build.context`, `privileged`) and `serializeDockerPolicy`. In `localmostrc.ts` `diffPolicies`, replace the scalar docker branch with `diffs.push(...diffDockerPolicy(oldPolicy.docker, newPolicy.docker, \`${prefix}.docker\`))`. In `serializePolicy`, replace the docker scalar line with `if (policy.docker) lines.push(...serializeDockerPolicy(policy.docker, indent))`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest --config test/jest.config.js src/shared/docker-policy.test.ts src/shared/localmostrc.test.ts`
Expected: PASS. Add a round-trip test: `parseLocalmostrcContent(serializeLocalmostrc(config))` preserves a docker block.

- [ ] **Step 5: Commit**

```bash
git add src/shared/docker-policy.ts src/shared/docker-policy.test.ts src/shared/localmostrc.ts src/shared/localmostrc.test.ts
git commit -m "Diff and serialize the docker policy block"
```

---

## Task 6: The `DockerBackend` seam and `DesktopBackend`

**Files:**
- Create: `src/main/docker/docker-backend.ts`
- Test: `src/main/docker/docker-backend.test.ts`

**Interfaces:**
- Consumes: `resolveDockerEndpoint`, `DockerEndpoint` from `src/shared/docker-access.ts`.
- Produces:

```typescript
export interface DockerBackend {
  /** Human name for logs. */
  readonly name: string;
  /** Whether `privileged` may be granted on this backend. Stage 1: false. */
  readonly supportsPrivileged: boolean;
  /** The daemon endpoint to forward approved requests to, or null when none. */
  resolveEndpoint(): DockerEndpoint | null;
  /** Absolute host path that job mounts must resolve inside (the job workspace). */
  workspaceMountRoot(sandboxDir: string): string;
}

export class DesktopBackend implements DockerBackend {
  readonly name = 'docker-desktop';
  readonly supportsPrivileged = false;
  constructor(private opts?: { resolve?: () => DockerEndpoint | null; workspaceSubdir?: string }) {}
  resolveEndpoint(): DockerEndpoint | null { /* resolveDockerEndpoint() */ }
  workspaceMountRoot(sandboxDir: string): string { /* path.join(sandboxDir, this.opts?.workspaceSubdir ?? 'work') */ }
}
```

- [ ] **Step 1: Write the failing test**

```typescript
import { DesktopBackend } from './docker-backend';

it('resolves the operator daemon endpoint and never permits privileged', () => {
  const backend = new DesktopBackend({ resolve: () => ({ socketPath: '/var/run/docker.sock' }) });
  expect(backend.supportsPrivileged).toBe(false);
  expect(backend.resolveEndpoint()).toEqual({ socketPath: '/var/run/docker.sock' });
  expect(backend.workspaceMountRoot('/tmp/sandbox/1')).toBe('/tmp/sandbox/1/work');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest --config test/jest.config.js src/main/docker/docker-backend.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `DockerBackend` + `DesktopBackend`**

`resolveEndpoint` defaults to `resolveDockerEndpoint()`; `workspaceMountRoot` joins the sandbox dir with the workspace subdir (align the subdir with what `buildSandbox` uses for the checkout — confirm in `src/main/process-sandbox.ts`; if the checkout root differs, use that exact name).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest --config test/jest.config.js src/main/docker/docker-backend.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/docker/docker-backend.ts src/main/docker/docker-backend.test.ts
git commit -m "Add the DockerBackend seam and the desktop backend"
```

---

## Task 7: Parse a Docker Engine API request

**Files:**
- Create: `src/main/docker/docker-request.ts`
- Test: `src/main/docker/docker-request.test.ts`

**Interfaces:**
- Produces:

```typescript
export type DockerAction = 'ping' | 'version' | 'info' | 'inspect' | 'pull' | 'create' | 'start'
  | 'attach' | 'wait' | 'remove' | 'build' | 'other';

export interface DockerRequest {
  method: string;              // GET, POST, DELETE
  path: string;                // path without the /vX.YY version prefix
  apiVersion?: string;         // the vX.YY prefix if present
  query: Record<string, string>;
  body?: unknown;              // parsed JSON body when Content-Type is JSON
  raw: { method: string; url: string; headers: Record<string, string>; body: Buffer };
}

/** The reviewed verb→endpoint map: which actions each API path+method represents. */
export function classifyDockerRequest(req: DockerRequest): DockerAction;
export function parseDockerRequest(raw: DockerRequest['raw']): DockerRequest;
```

- [ ] **Step 1: Write the failing test**

```typescript
import { parseDockerRequest, classifyDockerRequest } from './docker-request';

it('strips the version prefix and classifies container create as run', () => {
  const req = parseDockerRequest({
    method: 'POST', url: '/v1.45/containers/create?name=x',
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({ Image: 'postgres:16' })),
  });
  expect(req.apiVersion).toBe('v1.45');
  expect(req.path).toBe('/containers/create');
  expect(req.query.name).toBe('x');
  expect((req.body as { Image: string }).Image).toBe('postgres:16');
  expect(classifyDockerRequest(req)).toBe('create');
});

it('classifies ping, image create (pull) and build', () => {
  const mk = (m: string, u: string) => parseDockerRequest({ method: m, url: u, headers: {}, body: Buffer.alloc(0) });
  expect(classifyDockerRequest(mk('GET', '/v1.45/_ping'))).toBe('ping');
  expect(classifyDockerRequest(mk('POST', '/v1.45/images/create?fromImage=postgres&tag=16'))).toBe('pull');
  expect(classifyDockerRequest(mk('POST', '/v1.45/build'))).toBe('build');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest --config test/jest.config.js src/main/docker/docker-request.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the parser and classifier**

Parse the version prefix with `/^\/(v\d+\.\d+)(\/.*)$/`, `URL`-parse the query, JSON-parse the body only when the content-type is JSON (leave `body` undefined otherwise). Implement `classifyDockerRequest` as an explicit table (this is the reviewed surface — spec: "asserted in tests, not left implicit"):

```typescript
// method + path-pattern → action
// GET  /_ping                        → ping
// GET  /version                      → version
// GET  /info                         → info
// GET  /containers/{id}/json         → inspect
// GET  /containers/json              → inspect (list)
// POST /images/create                → pull
// POST /containers/create            → create
// POST /containers/{id}/start        → start
// POST /containers/{id}/attach       → attach
// POST /containers/{id}/wait         → wait
// DELETE /containers/{id}            → remove
// POST /build                        → build
// anything else                      → other
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest --config test/jest.config.js src/main/docker/docker-request.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/docker/docker-request.ts src/main/docker/docker-request.test.ts
git commit -m "Parse and classify Docker Engine API requests"
```

---

## Task 8: The policy evaluator — the security core

This is where the SECURITY.md escapes become executable tests.

**Files:**
- Create: `src/main/docker/docker-evaluator.ts`
- Test: `src/main/docker/docker-evaluator.test.ts`
- Modify: `src/main/runner-manager.ts` (`RepoPolicyRuntime.docker` → `DockerPolicy`); `src/main/index.ts` `getRepoPolicy` returns the docker policy object.

**Interfaces:**
- Consumes: `DockerRequest`, `DockerAction`, `DockerPolicy`, `DockerBackend`.
- Produces:

```typescript
export interface DockerEvalContext {
  policy: DockerPolicy | null;      // null when no policy is bound yet → deny all
  workspaceRoot: string;            // absolute; mounts must resolve inside this
  supportsPrivileged: boolean;      // from the backend
  realpath?: (p: string) => string; // injected for tests; defaults to fs.realpathSync
}
export interface DockerVerdict {
  allowed: boolean;
  reason?: string;      // why it was refused (Docker-API error message)
  policyHint?: string;  // the exact policy line that would permit it (for --updaterc discovery)
}
export function evaluateDockerRequest(req: DockerRequest, ctx: DockerEvalContext): DockerVerdict;
```

- [ ] **Step 1: Write the failing tests — baseline + default-deny**

```typescript
import { evaluateDockerRequest } from './docker-evaluator';
import { parseDockerRequest } from './docker-request';

const mk = (method: string, url: string, body?: unknown) => parseDockerRequest({
  method, url, headers: body ? { 'content-type': 'application/json' } : {},
  body: body ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0),
});
const ctx = (policy: any) => ({ policy, workspaceRoot: '/ws', supportsPrivileged: false, realpath: (p: string) => p });

it('permits the always-on baseline with no declaration', () => {
  for (const u of ['/v1.45/_ping', '/v1.45/version', '/v1.45/info']) {
    expect(evaluateDockerRequest(mk('GET', u), ctx({})).allowed).toBe(true);
  }
});

it('denies everything when no policy is bound', () => {
  expect(evaluateDockerRequest(mk('POST', '/v1.45/containers/create', { Image: 'postgres:16' }), ctx(null)).allowed).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest --config test/jest.config.js src/main/docker/docker-evaluator.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the failing tests — the SECURITY.md escapes**

```typescript
const runPolicy = { run: { images: ['postgres:16'], mounts: [{ path: './', mode: 'ro' as const }], network: 'bridge' } };

it('refuses a host bind mount the policy did not declare', () => {
  const v = evaluateDockerRequest(mk('POST', '/v1.45/containers/create',
    { Image: 'postgres:16', HostConfig: { Binds: ['/Users/me/.ssh:/host-ssh'] } }), ctx(runPolicy));
  expect(v.allowed).toBe(false);
});
it('refuses mounting the daemon socket into a container', () => {
  const v = evaluateDockerRequest(mk('POST', '/v1.45/containers/create',
    { Image: 'postgres:16', HostConfig: { Binds: ['/var/run/docker.sock:/var/run/docker.sock'] } }), ctx(runPolicy));
  expect(v.allowed).toBe(false);
});
it('refuses privileged, --pid=host, --network=host, and --device', () => {
  const bodies = [
    { Image: 'postgres:16', HostConfig: { Privileged: true } },
    { Image: 'postgres:16', HostConfig: { PidMode: 'host' } },
    { Image: 'postgres:16', HostConfig: { NetworkMode: 'host' } },
    { Image: 'postgres:16', HostConfig: { Devices: [{ PathOnHost: '/dev/kmsg' }] } },
  ];
  for (const b of bodies) expect(evaluateDockerRequest(mk('POST', '/v1.45/containers/create', b), ctx(runPolicy)).allowed).toBe(false);
});
it('refuses a ../ traversal and a symlink that resolves outside the workspace', () => {
  const traversal = evaluateDockerRequest(mk('POST', '/v1.45/containers/create',
    { Image: 'postgres:16', HostConfig: { Binds: ['/ws/../etc:/x'] } }), ctx(runPolicy));
  expect(traversal.allowed).toBe(false);
  const symCtx = { ...ctx(runPolicy), realpath: (_p: string) => '/etc/passwd' }; // resolves outside /ws
  const symlink = evaluateDockerRequest(mk('POST', '/v1.45/containers/create',
    { Image: 'postgres:16', HostConfig: { Binds: ['/ws/link:/x'] } }), symCtx);
  expect(symlink.allowed).toBe(false);
});
it('refuses undeclared image and registry; permits declared ones', () => {
  expect(evaluateDockerRequest(mk('POST', '/v1.45/containers/create', { Image: 'redis:7' }), ctx(runPolicy)).allowed).toBe(false);
  expect(evaluateDockerRequest(mk('POST', '/v1.45/containers/create', { Image: 'postgres:16' }), ctx(runPolicy)).allowed).toBe(true);
  const pullCtx = ctx({ pull: { registries: ['docker.io'] } });
  expect(evaluateDockerRequest(mk('POST', '/v1.45/images/create?fromImage=ghcr.io%2Ffoo&tag=1'), pullCtx).allowed).toBe(false);
  expect(evaluateDockerRequest(mk('POST', '/v1.45/images/create?fromImage=postgres&tag=16'), pullCtx).allowed).toBe(true);
});
it('rejects privileged even when declared, unless the backend supports it', () => {
  const v = evaluateDockerRequest(mk('POST', '/v1.45/containers/create',
    { Image: 'postgres:16', HostConfig: { Privileged: true } }),
    { policy: { run: { images: ['postgres:16'] }, privileged: true }, workspaceRoot: '/ws', supportsPrivileged: false, realpath: (p) => p });
  expect(v.allowed).toBe(false);
  expect(v.reason).toMatch(/managed VM/i);
});
it('fails closed on an unknown endpoint and a malformed body', () => {
  expect(evaluateDockerRequest(mk('POST', '/v1.45/networks/create', { Name: 'x' }), ctx(runPolicy)).allowed).toBe(false);
  const bad = parseDockerRequest({ method: 'POST', url: '/v1.45/containers/create', headers: { 'content-type': 'application/json' }, body: Buffer.from('{not json') });
  expect(evaluateDockerRequest(bad, ctx(runPolicy)).allowed).toBe(false);
});
it('provides a policy hint naming what would permit a denied request', () => {
  const v = evaluateDockerRequest(mk('POST', '/v1.45/containers/create', { Image: 'redis:7' }), ctx(runPolicy));
  expect(v.policyHint).toMatch(/run:\s*\n?\s*images/);
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `npx jest --config test/jest.config.js src/main/docker/docker-evaluator.test.ts`
Expected: FAIL (assertions on an unimplemented evaluator).

- [ ] **Step 5: Implement the evaluator**

Structure:
1. `if (BASELINE.has(action))` (`ping`, `version`, `info`, `inspect`) → allow. `version` is also range-checked by the proxy (Task 9), not here.
2. `if (!ctx.policy)` → deny "no docker policy is bound to this socket".
3. `if (parse produced no usable body for an action that needs one)` → deny (fail closed).
4. Per action:
   - `create`: check `HostConfig` against a **forbidden-keys allowlist gate** — deny if any of `Privileged` (unless `ctx.supportsPrivileged && policy.privileged`, else deny with "requires a managed VM backend"), `PidMode`, `IpcMode`, `UtsMode`, `UsernsMode`, `Devices`, `CgroupParent`, `SecurityOpt`, or `NetworkMode === 'host'` is present. Then check `Image` ∈ `policy.run.images`; each `HostConfig.Binds`/`Mounts` source path resolves (via `ctx.realpath` after `path.resolve`) inside `ctx.workspaceRoot` and its `mode` is permitted (`rw` requires a declared `rw` mount); `NetworkMode` ∈ allowed. A bind whose source is a socket or any path outside the workspace is denied structurally.
   - `start`/`attach`/`wait`/`remove`: allowed when `policy.run` is present (they operate on a container the create gate already vetted).
   - `pull`: registry of `fromImage` ∈ `policy.pull.registries`.
   - `build`: `context` resolves inside the workspace; requires `policy.build`.
   - default → deny (fail closed).

Every deny sets `reason` (a Docker-API-shaped message) and `policyHint` (the YAML line that would permit it). Change `RepoPolicyRuntime.docker` to `DockerPolicy` and update `index.ts` `getRepoPolicy` to return `docker: getEffectivePolicy(cached.config, workflowName).docker ?? {}` (docker now merges shared+workflow, so drop the "shared only" comment there).

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx jest --config test/jest.config.js src/main/docker/docker-evaluator.test.ts`
Expected: PASS (all escapes refused, declared operations permitted).

- [ ] **Step 7: Write the failing test — verb-to-endpoint mapping is asserted**

```typescript
it('maps each run sub-verb to the run policy', () => {
  const p = ctx({ run: { images: ['postgres:16'] } });
  for (const [m, u] of [['POST','/v1.45/containers/abc/start'],['POST','/v1.45/containers/abc/wait'],['DELETE','/v1.45/containers/abc']] as const) {
    expect(evaluateDockerRequest(mk(m, u), p).allowed).toBe(true);
  }
  // ...and denies them when run is absent
  const none = ctx({ pull: { registries: ['docker.io'] } });
  expect(evaluateDockerRequest(mk('POST', '/v1.45/containers/abc/start'), none).allowed).toBe(false);
});
```

- [ ] **Step 8: Run to verify pass**

Run: `npx jest --config test/jest.config.js src/main/docker/docker-evaluator.test.ts -t "run sub-verb"`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/main/docker/docker-evaluator.ts src/main/docker/docker-evaluator.test.ts src/main/runner-manager.ts src/main/index.ts
git commit -m "Filter Docker requests against the repository's docker policy"
```

---

## Task 9: The `DockerFilterProxy` over a unix socket

**Files:**
- Create: `src/main/docker/docker-filter-proxy.ts`
- Test: `src/main/docker/docker-filter-proxy.test.ts`

**Interfaces:**
- Consumes: `DockerBackend`, `parseDockerRequest`, `classifyDockerRequest`, `evaluateDockerRequest`, `DockerPolicy`.
- Produces:

```typescript
export interface DockerFilterProxyOptions {
  backend: DockerBackend;
  onLog?: (entry: { level: 'info' | 'warn' | 'debug'; message: string; policyHint?: string }) => void;
  minApiVersion?: string;  // default 'v1.24'
  maxApiVersion?: string;  // default the version we test against, e.g. 'v1.45'
  attachRegistryAuth?: (registry: string) => string | undefined; // X-Registry-Auth header value
}
export class DockerFilterProxy {
  constructor(opts: DockerFilterProxyOptions);
  /** Bind the socket to a repository + policy. Until called, the socket denies all. */
  bind(repository: string, policy: DockerPolicy): void;
  /** The repository this socket is bound to, or undefined. */
  boundRepository(): string | undefined;
  /** Create and listen on the unix socket at socketPath. */
  start(socketPath: string): Promise<void>;
  stop(): Promise<void>;
}
```

The proxy starts **default-deny**: constructed with no policy, `boundRepository()` undefined, every non-baseline request refused (spec: "A socket is born denying everything").

- [ ] **Step 1: Write the failing test — default-deny over a real socket**

```typescript
import * as os from 'os'; import * as path from 'path'; import * as fs from 'fs'; import * as http from 'http';
import { DockerFilterProxy } from './docker-filter-proxy';

const request = (socketPath: string, method: string, p: string, body?: unknown): Promise<{ status: number }> =>
  new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: p, method, headers: body ? { 'content-type': 'application/json' } : {} },
      (res) => { res.resume(); res.on('end', () => resolve({ status: res.statusCode! })); });
    req.on('error', reject); if (body) req.write(JSON.stringify(body)); req.end();
  });

it('refuses container create until a policy is bound', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dfp-'));
  const sock = path.join(dir, 'docker.sock');
  const proxy = new DockerFilterProxy({ backend: { name: 'test', supportsPrivileged: false, resolveEndpoint: () => null, workspaceMountRoot: () => dir } });
  await proxy.start(sock);
  const denied = await request(sock, 'POST', '/v1.45/containers/create', { Image: 'postgres:16' });
  expect(denied.status).toBeGreaterThanOrEqual(400);
  await proxy.stop();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest --config test/jest.config.js src/main/docker/docker-filter-proxy.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the socket server and the deny path**

`start(socketPath)` creates an `http.Server` listening on the unix socket. Each request: buffer the body, `parseDockerRequest`, then `evaluateDockerRequest(req, { policy: this.policy, workspaceRoot: backend.workspaceMountRoot(dir), supportsPrivileged: backend.supportsPrivileged, realpath })`. On deny, write a Docker-API JSON error `{ message }` with status 403 and log the `policyHint` at info (discovery). Version-gate at `/version` and refuse `apiVersion` above `maxApiVersion` or below `minApiVersion` (fail closed). Do not forward yet.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest --config test/jest.config.js src/main/docker/docker-filter-proxy.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing tests — forward on allow, repo-mismatch, attach auth**

```typescript
it('forwards an approved request to the backend endpoint', async () => {
  // Stand up a fake daemon on a second unix socket that returns 201 for /containers/create.
  // backend.resolveEndpoint() returns { socketPath: fakeDaemonSock }.
  // bind('owner/repo', { run: { images: ['postgres:16'] } }); expect create → 201.
});
it('refuses everything when the socket is bound to a different repository than claimed', () => {
  const proxy = new DockerFilterProxy({ backend });
  proxy.bind('owner/repo', { run: { images: ['postgres:16'] } });
  expect(proxy.boundRepository()).toBe('owner/repo');
  // A mismatch is enforced by the caller (runner-manager) refusing to run; assert boundRepository is the single source of truth here.
});
it('attaches registry auth on a pull so the job never holds the secret', async () => {
  // attachRegistryAuth returns a token for docker.io; assert the forwarded /images/create carried X-Registry-Auth and the inbound request did not.
});
```

- [ ] **Step 6: Run to verify fail**

Run: `npx jest --config test/jest.config.js src/main/docker/docker-filter-proxy.test.ts`
Expected: FAIL on the new cases.

- [ ] **Step 7: Implement forwarding + auth attach**

On allow, open a client request to `backend.resolveEndpoint().socketPath`, copy method/path/headers/body, and for `pull` set `X-Registry-Auth` from `attachRegistryAuth(registry)` (stripping any inbound value). Pipe the daemon response back. If `resolveEndpoint()` is null, return a clean Docker-API error (no daemon) rather than hang.

- [ ] **Step 8: Run to verify pass**

Run: `npx jest --config test/jest.config.js src/main/docker/docker-filter-proxy.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/main/docker/docker-filter-proxy.ts src/main/docker/docker-filter-proxy.test.ts
git commit -m "Serve a filtering Docker socket per worker"
```

---

## Task 10: Mint the socket per spawn and wire `DOCKER_HOST`

**Files:**
- Modify: `src/main/runner-manager.ts` (spawn path ~925-950; add a `dockerProxies: Map<number, DockerFilterProxy>` beside `proxyServers`; construct backend once in the constructor from options)
- Modify: `src/main/index.ts` (pass a `DesktopBackend` and an `attachRegistryAuth` callback into `RunnerManager`)
- Test: `src/main/runner-manager.test.ts`

**Interfaces:**
- Consumes: `DockerFilterProxy`, `DesktopBackend`, sandbox dir from `getSandboxDir(instanceNum)`.
- Produces: a per-instance `DockerFilterProxy` started at `<sandboxDir>/docker.sock`; the worker env carries `DOCKER_HOST=unix://<sandboxDir>/docker.sock`; the proxy is `bind`-ed on claim in `applyPolicyForTarget`.

- [ ] **Step 1: Write the failing test**

```typescript
it('starts a default-deny docker socket for a spawned worker and points DOCKER_HOST at it', async () => {
  // Arrange a manager with a stub backend; drive the spawn path (as existing spawn tests do).
  // Assert: a DockerFilterProxy exists for the instance, boundRepository() is undefined (default-deny),
  // and the env passed to spawnSandboxed has DOCKER_HOST === `unix://${sandboxDir}/docker.sock`.
});
```

Model the arrangement on the existing spawn tests in `runner-manager.test.ts` that assert on `mockSpawnSandboxed` calls.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest --config test/jest.config.js src/main/runner-manager.test.ts -t "default-deny docker socket"`
Expected: FAIL — no docker proxy is created; `DOCKER_HOST` unset.

- [ ] **Step 3: Implement socket minting + env**

In the spawn path: create a `DockerFilterProxy` with the manager's backend, `start(path.join(sandboxDir, 'docker.sock'))`, store in `dockerProxies`. Replace the old `resolveDockerEndpoint()`/`dockerSandboxGrants()`/`dockerGrants.env` block with `env: { ...env, DOCKER_HOST: \`unix://${socketPath}\` }`. Stop passing `dockerGrants` to `spawnSandboxed`. On claim, in `applyPolicyForTarget`, call `this.dockerProxies.get(instanceNum)?.bind(targetDisplayName, policy.docker)`. On worker teardown, `await this.dockerProxies.get(n)?.stop()` and delete the entry.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest --config test/jest.config.js src/main/runner-manager.test.ts`
Expected: PASS (and the manager suite still green).

- [ ] **Step 5: Write the failing test — bind on claim, refuse on repo mismatch**

```typescript
it('binds the docker policy for the claimed repository and leaves a mismatched claim denying', async () => {
  // setPendingTargetContext('1', { targetDisplayName: 'owner/repo', githubSha, githubWorkflow })
  // getRepoPolicy returns docker: { run: { images: ['postgres:16'] } }
  // parseRunnerOutput('Running job: ...') → the instance's DockerFilterProxy.boundRepository() === 'owner/repo'
  // If the claim's repository differs from context, the proxy stays unbound (default-deny).
});
```

- [ ] **Step 6-7: Fail, then implement bind-on-claim** (covered by Step 3's `applyPolicyForTarget` change; add the mismatch guard: only `bind` when the claimed repository matches `targetDisplayName`).

- [ ] **Step 8: Run to verify pass**

Run: `npx jest --config test/jest.config.js src/main/runner-manager.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/main/runner-manager.ts src/main/index.ts src/main/runner-manager.test.ts
git commit -m "Mint a per-worker docker socket and bind it on claim"
```

---

## Task 11: Simplify the sandbox profile

**Files:**
- Modify: `src/main/process-sandbox.ts` (`dockerRules` ~155-180; the deny block ~349)
- Modify: `src/main/process-sandbox.ts` `RunnerProfileOptions` (replace `dockerGrants?: DockerGrants` with `dockerSocketDir?: string`)
- Test: `src/main/process-sandbox.test.ts`

**Interfaces:**
- Consumes: `dockerSocketDir` — the sandbox subdir holding `docker.sock`.
- Produces: profile rules granting `network-outbound` + `file-read*` on `dockerSocketDir` while `file-write*` stays denied there; `~/.docker` denied in full with no post-deny exception.

- [ ] **Step 1: Write the failing test**

```typescript
it('grants the worker docker socket dir read+connect but not write, and keeps ~/.docker fully denied', () => {
  const profile = generateSandboxProfile({ instanceDir: '/tmp/s/1', dockerSocketDir: '/tmp/s/1' });
  expect(profile).toContain('(allow network-outbound (literal "/tmp/s/1/docker.sock"))');
  expect(profile).toContain('(allow file-read* (literal "/tmp/s/1/docker.sock"))');
  expect(profile).not.toContain('(allow file-write* (literal "/tmp/s/1/docker.sock"))');
  // No leftover daemon-socket hole punched after the deny block:
  expect(profile).not.toMatch(/\.docker\/run\/docker\.sock/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest --config test/jest.config.js src/main/process-sandbox.test.ts -t "docker socket dir"`
Expected: FAIL — profile still emits `dockerGrants` socket literals / the old option shape.

- [ ] **Step 3: Rewrite `dockerRules`**

Replace the `dockerGrants` block with, when `dockerSocketDir` is set, `(allow network-outbound (literal "<dir>/docker.sock"))` and `(allow file-read* (literal "<dir>/docker.sock"))` — no `file-write*` grant. Keep the escaping helper. Remove the old post-deny ordering comment; `~/.docker` in the deny block is now unconditional. Delete the now-dead ordering test.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest --config test/jest.config.js src/main/process-sandbox.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/process-sandbox.ts src/main/process-sandbox.test.ts
git commit -m "Grant the worker's own docker socket, drop the daemon-socket hole"
```

---

## Task 12: Remove the dead `docker-access` level API

**Files:**
- Modify: `src/shared/docker-access.ts` (delete `DockerAccessLevel`, `DOCKER_ACCESS_LEVELS`, `isDockerAccessLevel`, `dockerSandboxGrants`, `DockerGrants`; keep `resolveDockerEndpoint`, `DockerEndpoint`, `DockerFsProbe`)
- Modify: `src/shared/docker-access.test.ts`, `src/shared/docker-access.sandbox.test.ts` (drop level/grants cases; keep endpoint resolution)
- Modify: any remaining importers surfaced by tsc

- [ ] **Step 1: Find remaining references**

Run: `grep -rn "DockerAccessLevel\|dockerSandboxGrants\|DOCKER_ACCESS_LEVELS\|DockerGrants\|isDockerAccessLevel" src --include='*.ts' | grep -v docker-policy`
Expected: only the definitions and their tests remain (all consumers migrated in Tasks 4, 8, 10, 11).

- [ ] **Step 2: Delete the dead exports and their tests; run tsc**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 3: Run the full main + shared suites**

Run: `npm run test:main`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add src/shared/docker-access.ts src/shared/docker-access.test.ts src/shared/docker-access.sandbox.test.ts
git commit -m "Remove the superseded docker access-level API"
```

---

## Task 13: Discovery — write docker policy from denials

**Files:**
- Modify: `src/cli/policy.ts` and/or `src/cli/test.ts` (wherever `--updaterc` assembles network/filesystem suggestions)
- Modify: `src/main/docker/docker-filter-proxy.ts` (ensure each deny logs `policyHint` in the shape `--updaterc` consumes)
- Test: the CLI test that covers `--updaterc`

**Interfaces:**
- Consumes: proxy deny logs carrying `policyHint` (the YAML fragment that would permit the request).
- Produces: `localmost test --updaterc` merges docker suggestions into the written `.localmostrc`, the same way it merges `network.allow`.

- [ ] **Step 1: Write the failing test**

```typescript
it('turns a denied docker request into a docker policy suggestion in --updaterc output', () => {
  // Given a captured deny with policyHint for run.images: ['postgres:16'],
  // the updaterc merge produces shared.docker.run.images including 'postgres:16'.
});
```

Model it on the existing `--updaterc` test for network hosts.

- [ ] **Step 2-4: Fail, implement the merge, pass**

Run: the CLI test file for `--updaterc`.
Expected: FAIL → implement docker-hint merging alongside the network merge → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/policy.ts src/cli/test.ts src/main/docker/docker-filter-proxy.ts <cli test file>
git commit -m "Suggest docker policy from filtered denials in --updaterc"
```

---

## Task 14: End-to-end — a real workflow that uses the daemon

**Files:**
- Create: an e2e/integration test under the existing e2e harness (see `npm run test:e2e`), guarded to skip when no daemon is present.

**Interfaces:**
- Consumes: a running `DesktopBackend` daemon on the developer machine.

- [ ] **Step 1: Write the failing/skipped test**

Drive a minimal workflow (or a direct `DockerFilterProxy` + real backend) that: pulls a declared image, runs a container with a declared `ro` workspace mount, and asserts the container ran and an undeclared bind was refused. `it.skip` (or a daemon-presence guard) when `resolveDockerEndpoint()` is null, logging what was skipped (Global Constraint: no silent caps).

- [ ] **Step 2: Run it**

Run: `npm run test:e2e` (or the guarded integration file).
Expected: PASS on a machine with Docker; SKIP with a logged reason otherwise.

- [ ] **Step 3: Commit**

```bash
git add <e2e test file>
git commit -m "End-to-end test a workflow through the filtering socket"
```

---

## Task 15: Documentation and changelog

**Files:**
- Modify: `docs/roadmap/localmostrc.md` (docker actions, conditions, schema)
- Modify: `README.md` (policy section)
- Modify: `SECURITY.md` (rewrite the docker section: what the filter does and does not contain — no more "reads and writes host paths through a bind mount")
- Modify: `CHANGELOG.md` (breaking policy change + migration note)
- Modify: `docs/roadmap/docker-access.md` (mark superseded by the spec, as the spec's status note says)

- [ ] **Step 1: Update `docs/roadmap/localmostrc.md`**

Document `docker.pull/run/build`, the conditions (`images`, `mounts` with `ro`/`rw`, `network`, `registries`, `context`), the always-on baseline, that anything unlisted is denied, and that `privileged` requires a managed VM (Stage 2).

- [ ] **Step 2: Update `README.md`** — replace the docker level description with the action grammar; note credentials no longer enter the sandbox.

- [ ] **Step 3: Rewrite `SECURITY.md`** — state plainly that container work goes through a filtering socket localmost owns; list what Stage 1 contains (host reach via bind mount, daemon-socket mount, `privileged`/`--pid=host`/`--network=host`/`--device`, undeclared images/registries/mounts) and what it does not (container egress and containment, which arrive with the Stage 2 VM).

- [ ] **Step 4: Update `CHANGELOG.md`** — a breaking change entry: `docker: <level>` → `docker:` actions, with the migration mapping (`socket`/`contexts`/`credentials` → declare `run`/`pull` as needed) and the note that credentials are no longer read by the job.

- [ ] **Step 5: Mark `docs/roadmap/docker-access.md` superseded** — a top note pointing to the spec, matching the spec's own status line.

- [ ] **Step 6: Commit**

```bash
git add docs/roadmap/localmostrc.md README.md SECURITY.md CHANGELOG.md docs/roadmap/docker-access.md
git commit -m "Document the filtering docker socket and the policy migration"
```

---

## Self-Review

**Spec coverage:**
- Socket in the worker's ephemeral dir → Tasks 10, 11. Profile grants the socket dir, denies write, `~/.docker` fully denied → Task 11. Short fixed socket name (`docker.sock`) → Tasks 9, 10.
- Profile simplification / ordering subtlety removed → Task 11.
- Identity is the connection / per-job socket / default-deny on spawn → Tasks 9, 10. Repo-mismatch refusal → Tasks 9, 10.
- `DockerFilterProxy` component → Task 9. `DockerBackend`/`DesktopBackend` seam → Task 6.
- Workflow-name fix (policy binding prerequisite) → Task 1.
- Policy schema (pull/run/build + conditions), capability grammar absent, `privileged` rejected at Stage 1, baseline endpoints, credentials attached at proxy, discovery → Tasks 2, 3, 8, 9, 13.
- Failure modes (fail closed, clean denials, no daemon, repo mismatch, API version negotiation) → Tasks 8, 9, 10.
- Testing (escapes as executable tests, verb→endpoint, fail-closed, no-policy denies, cross-repo refuse, schema/migration, additive compose, e2e) → Tasks 1, 3, 7, 8, 9, 14.
- Migration (`diffConfigs` prominence, old-level errors) → Tasks 3, 5.
- Documentation → Task 15.
- Out of scope by the spec: Stage 2 `ManagedVmBackend` (seamed via `DockerBackend`, not built), Stage 3 runtime, container egress control. Not planned — correct.

**Type consistency:** `DockerPolicy` shape (Task 2) is consumed unchanged by validate (3), merge/`SandboxPolicy.docker` (4), diff/serialize (5), evaluator + `RepoPolicyRuntime.docker`/`getRepoPolicy` (8), proxy `bind` (9), runner-manager bind-on-claim (10). `DockerRequest`/`DockerAction`/`classifyDockerRequest` (7) are consumed by the evaluator (8) and proxy (9). `DockerBackend` (6) is consumed by the proxy (9) and runner-manager (10). The Task 1 test's temporary `docker` value is reconciled in Task 8 (flagged there).

**Placeholder scan:** Tasks 9, 10, 13, 14 describe some test arrangements in prose rather than full code because they stand up real unix sockets / drive existing multi-step spawn harnesses; each names the exact file to model on (`ProxyServer` socket handling, existing `mockSpawnSandboxed` spawn tests, the `--updaterc` network test) and the exact assertion. Executors should expand these against those references, not invent behavior.
