# Docker Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an approved repository reach the Docker daemon from inside the sandbox, at a level it declares in `.localmostrc`, with the same behaviour under `localmost test` and the background runner.

**Architecture:** One new module, `src/shared/docker-access.ts`, owns the level type, endpoint resolution and grant computation. Both sandbox profile builders — `src/main/process-sandbox.ts` for runner jobs and `src/shared/sandbox-profile.ts` for `localmost test` — ask it what to emit. The level travels from the approved policy through the existing `RepoPolicyRuntime` → `RunnerManager` → `spawnSandboxed` path, and is folded into the policy stamp so a change retires stale workers.

**Tech Stack:** TypeScript, Electron main process, Jest (`test/jest.config.js`, roots `src/`), macOS seatbelt (`sandbox-exec`) profiles, js-yaml.

**Spec:** `docs/roadmap/docker-access.md`

## Global Constraints

- macOS only. No Windows or Linux branches (CLAUDE.md).
- TDD: every step writes the failing test first and watches it fail before implementing.
- Levels are exactly `off | socket | contexts | credentials`, cumulative, default `off`.
- `docker:` is read from `shared:` only. A `docker:` key inside a `workflows:` block is a validation error.
- `docker: true` / `docker: false` are validation errors naming the four levels.
- Nothing under `~/.docker` is opened beyond the exact paths a level names — never the directory.
- Docker grants are emitted **after** the `deny file-read*` block in `process-sandbox.ts` so the specific literal wins over the subtree deny.
- No new runtime dependencies.
- Every task ends green on `npm run lint`, `npm run typecheck`, `npm test`.

---

### Task 1: Level type and schema validation

**Files:**
- Create: `src/shared/docker-access.ts`
- Create: `src/shared/docker-access.test.ts`
- Modify: `src/shared/localmostrc.ts` (`SandboxPolicy` import site, `validatePolicy` ~line 204, `validateSocketsPolicy` neighbourhood ~line 272)
- Modify: `src/shared/sandbox-profile.ts:37-42` (`SandboxPolicy` interface)
- Test: `src/shared/localmostrc.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type DockerAccessLevel = 'off' | 'socket' | 'contexts' | 'credentials'`, `const DOCKER_ACCESS_LEVELS: readonly DockerAccessLevel[]`, `function isDockerAccessLevel(value: unknown): value is DockerAccessLevel`. `SandboxPolicy` gains `docker?: DockerAccessLevel`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/shared/docker-access.test.ts
import { describe, it, expect } from '@jest/globals';
import { DOCKER_ACCESS_LEVELS, isDockerAccessLevel } from './docker-access';

describe('docker access levels', () => {
  it('lists the four levels in increasing order of access', () => {
    expect(DOCKER_ACCESS_LEVELS).toEqual(['off', 'socket', 'contexts', 'credentials']);
  });

  it('accepts every declared level', () => {
    for (const level of DOCKER_ACCESS_LEVELS) {
      expect(isDockerAccessLevel(level)).toBe(true);
    }
  });

  it('rejects a boolean, which is ambiguous about which level was meant', () => {
    expect(isDockerAccessLevel(true)).toBe(false);
    expect(isDockerAccessLevel(false)).toBe(false);
  });

  it('rejects an unknown string', () => {
    expect(isDockerAccessLevel('daemon')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest --config test/jest.config.js src/shared/docker-access.test.ts`
Expected: FAIL — `Cannot find module './docker-access'`

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/shared/docker-access.ts
/**
 * Docker daemon access, declared per repository in .localmostrc.
 *
 * A job that can reach the daemon is not sandboxed: containers are not subject
 * to the seatbelt profile, so a bind mount reaches host paths the profile
 * denies. See docs/roadmap/docker-access.md.
 */

/** How much Docker surface a repository's policy opens. Cumulative. */
export type DockerAccessLevel = 'off' | 'socket' | 'contexts' | 'credentials';

/** In increasing order of access. */
export const DOCKER_ACCESS_LEVELS: readonly DockerAccessLevel[] = [
  'off',
  'socket',
  'contexts',
  'credentials',
];

export function isDockerAccessLevel(value: unknown): value is DockerAccessLevel {
  return typeof value === 'string' && (DOCKER_ACCESS_LEVELS as readonly string[]).includes(value);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest --config test/jest.config.js src/shared/docker-access.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Write the failing schema-validation test**

```typescript
// src/shared/localmostrc.test.ts — add to the existing describe for parseLocalmostrcContent
it('accepts a declared docker level', () => {
  const result = parseLocalmostrcContent('version: 1\nshared:\n  docker: socket\n');
  expect(result.success).toBe(true);
  expect(result.config?.shared?.docker).toBe('socket');
});

it('rejects docker: true, which does not say which level was meant', () => {
  const result = parseLocalmostrcContent('version: 1\nshared:\n  docker: true\n');
  expect(result.success).toBe(false);
  expect(result.errors[0].message).toMatch(/off, socket, contexts, credentials/);
});

it('rejects an unknown docker level', () => {
  const result = parseLocalmostrcContent('version: 1\nshared:\n  docker: daemon\n');
  expect(result.success).toBe(false);
});

it('rejects docker inside a workflows block', () => {
  const result = parseLocalmostrcContent(
    'version: 1\nworkflows:\n  build:\n    docker: socket\n'
  );
  expect(result.success).toBe(false);
  expect(result.errors[0].message).toMatch(/shared/);
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx jest --config test/jest.config.js src/shared/localmostrc.test.ts -t docker`
Expected: FAIL — the first assertion gets `undefined` for `shared.docker`; the rejection cases pass validation instead of erroring.

- [ ] **Step 7: Implement validation**

In `src/shared/sandbox-profile.ts`, extend the policy interface (line 37):

```typescript
import type { DockerAccessLevel } from './docker-access';

export interface SandboxPolicy {
  network?: NetworkPolicy;
  filesystem?: FilesystemPolicy;
  sockets?: SocketsPolicy;
  env?: EnvPolicy;
  /** Docker daemon access. Read from `shared:` only - see docker-access.ts. */
  docker?: DockerAccessLevel;
}
```

In `src/shared/localmostrc.ts`, import the guard and add a branch to `validatePolicy` (after the `sockets` branch, ~line 229). `validatePolicy` is called for both shared and workflow policies, so it takes the path it was given and refuses the key outside `shared`:

```typescript
import { DOCKER_ACCESS_LEVELS, isDockerAccessLevel } from './docker-access';

  // Validate docker access level
  if (p.docker !== undefined) {
    if (path !== 'shared') {
      errors.push({
        message:
          `${path}.docker is not supported: docker access is declared in shared, ` +
          'because the sandbox profile is built before the workflow is known',
      });
    } else if (!isDockerAccessLevel(p.docker)) {
      errors.push({
        message: `${path}.docker must be one of: ${DOCKER_ACCESS_LEVELS.join(', ')}`,
      });
    }
  }
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npx jest --config test/jest.config.js src/shared/localmostrc.test.ts src/shared/docker-access.test.ts`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/shared/docker-access.ts src/shared/docker-access.test.ts src/shared/localmostrc.ts src/shared/localmostrc.test.ts src/shared/sandbox-profile.ts
git commit -m "Add docker access level to the policy schema"
```

---

### Task 2: Endpoint resolution

**Files:**
- Modify: `src/shared/docker-access.ts`
- Test: `src/shared/docker-access.test.ts`

**Interfaces:**
- Consumes: `DockerAccessLevel` from Task 1.
- Produces: `interface DockerEndpoint { socketPath: string }`, `interface DockerFsProbe { exists(p: string): boolean; realpath(p: string): string }`, `function resolveDockerEndpoint(options?: { env?: NodeJS.ProcessEnv; homeDir?: string; fs?: DockerFsProbe }): DockerEndpoint | null`.

Resolution runs in the app, outside the sandbox, so the job never has to discover the endpoint. Order: an operator-set `DOCKER_HOST`, then `/var/run/docker.sock` followed through its symlink, then Docker Desktop's per-user path. The filesystem is injected rather than mocked so the tests state the machine shape directly.

- [ ] **Step 1: Write the failing test**

```typescript
// src/shared/docker-access.test.ts
import { resolveDockerEndpoint, DockerFsProbe } from './docker-access';

/** A fake machine: paths that exist, and where symlinks point. */
const probe = (paths: Record<string, string>): DockerFsProbe => ({
  exists: p => p in paths,
  realpath: p => {
    if (!(p in paths)) throw new Error(`ENOENT: ${p}`);
    return paths[p];
  },
});

describe('resolveDockerEndpoint', () => {
  const homeDir = '/Users/dev';

  it('follows /var/run/docker.sock to the Docker Desktop socket it links to', () => {
    const fs = probe({
      '/var/run/docker.sock': '/Users/dev/.docker/run/docker.sock',
      '/Users/dev/.docker/run/docker.sock': '/Users/dev/.docker/run/docker.sock',
    });

    expect(resolveDockerEndpoint({ env: {}, homeDir, fs })).toEqual({
      socketPath: '/Users/dev/.docker/run/docker.sock',
    });
  });

  it('prefers an operator-set DOCKER_HOST', () => {
    const fs = probe({
      '/var/run/docker.sock': '/var/run/docker.sock',
      '/Users/dev/.colima/default/docker.sock': '/Users/dev/.colima/default/docker.sock',
    });
    const env = { DOCKER_HOST: 'unix:///Users/dev/.colima/default/docker.sock' };

    expect(resolveDockerEndpoint({ env, homeDir, fs })).toEqual({
      socketPath: '/Users/dev/.colima/default/docker.sock',
    });
  });

  it('ignores a DOCKER_HOST that is not a unix socket', () => {
    const fs = probe({ '/var/run/docker.sock': '/var/run/docker.sock' });
    const env = { DOCKER_HOST: 'tcp://127.0.0.1:2375' };

    expect(resolveDockerEndpoint({ env, homeDir, fs })).toEqual({
      socketPath: '/var/run/docker.sock',
    });
  });

  it('falls back to the per-user path when /var/run/docker.sock is absent', () => {
    const fs = probe({
      '/Users/dev/.docker/run/docker.sock': '/Users/dev/.docker/run/docker.sock',
    });

    expect(resolveDockerEndpoint({ env: {}, homeDir, fs })).toEqual({
      socketPath: '/Users/dev/.docker/run/docker.sock',
    });
  });

  it('returns null for a dangling symlink, which is what a stopped daemon leaves', () => {
    // /var/run/docker.sock survives Docker Desktop quitting; its target does not.
    const fs: DockerFsProbe = {
      exists: p => p === '/var/run/docker.sock',
      realpath: () => {
        throw new Error('ENOENT');
      },
    };

    expect(resolveDockerEndpoint({ env: {}, homeDir, fs })).toBeNull();
  });

  it('returns null when nothing is present', () => {
    expect(resolveDockerEndpoint({ env: {}, homeDir, fs: probe({}) })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest --config test/jest.config.js src/shared/docker-access.test.ts -t resolveDockerEndpoint`
Expected: FAIL — `resolveDockerEndpoint is not a function`

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/shared/docker-access.ts
import * as fsNode from 'fs';
import * as os from 'os';

/** The daemon socket, as a resolved real path. */
export interface DockerEndpoint {
  socketPath: string;
}

/** The filesystem questions endpoint resolution asks, injected for testing. */
export interface DockerFsProbe {
  exists(p: string): boolean;
  realpath(p: string): string;
}

const nodeProbe: DockerFsProbe = {
  exists: p => fsNode.existsSync(p),
  realpath: p => fsNode.realpathSync(p),
};

/** Docker Desktop's per-user socket, which /var/run/docker.sock links to. */
const perUserSocket = (homeDir: string): string => `${homeDir}/.docker/run/docker.sock`;

const SYSTEM_SOCKET = '/var/run/docker.sock';

/**
 * Find the daemon socket, resolving symlinks. Returns null when no socket is
 * present - including the common case of a dangling /var/run/docker.sock left
 * behind by a stopped Docker Desktop.
 */
export function resolveDockerEndpoint(options?: {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  fs?: DockerFsProbe;
}): DockerEndpoint | null {
  const env = options?.env ?? process.env;
  const homeDir = options?.homeDir ?? os.homedir();
  const fs = options?.fs ?? nodeProbe;

  const candidates: string[] = [];

  const dockerHost = env.DOCKER_HOST;
  if (dockerHost && dockerHost.startsWith('unix://')) {
    candidates.push(dockerHost.slice('unix://'.length));
  }
  candidates.push(SYSTEM_SOCKET, perUserSocket(homeDir));

  for (const candidate of candidates) {
    if (!fs.exists(candidate)) continue;
    try {
      return { socketPath: fs.realpath(candidate) };
    } catch {
      // A dangling symlink: the path exists, its target does not.
      continue;
    }
  }

  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest --config test/jest.config.js src/shared/docker-access.test.ts`
Expected: PASS (10 tests)

- [ ] **Step 5: Commit**

```bash
git add src/shared/docker-access.ts src/shared/docker-access.test.ts
git commit -m "Resolve the Docker endpoint outside the sandbox"
```

---

### Task 3: Grant computation

**Files:**
- Modify: `src/shared/docker-access.ts`
- Test: `src/shared/docker-access.test.ts`

**Interfaces:**
- Consumes: `DockerAccessLevel`, `DockerEndpoint` from Tasks 1-2.
- Produces: `interface DockerGrants { socketLiterals: string[]; readLiterals: string[]; readSubpaths: string[]; env: Record<string, string> }`, `function dockerSandboxGrants(level: DockerAccessLevel | undefined, endpoint: DockerEndpoint | null, homeDir: string): DockerGrants`.

Both profile builders consume this, so the level-to-path mapping exists once.

- [ ] **Step 1: Write the failing test**

```typescript
// src/shared/docker-access.test.ts
import { dockerSandboxGrants, DockerGrants } from './docker-access';

describe('dockerSandboxGrants', () => {
  const homeDir = '/Users/dev';
  const endpoint = { socketPath: '/Users/dev/.docker/run/docker.sock' };
  const empty: DockerGrants = { socketLiterals: [], readLiterals: [], readSubpaths: [], env: {} };

  it('grants nothing when the level is off', () => {
    expect(dockerSandboxGrants('off', endpoint, homeDir)).toEqual(empty);
  });

  it('grants nothing when no level is declared', () => {
    expect(dockerSandboxGrants(undefined, endpoint, homeDir)).toEqual(empty);
  });

  it('grants nothing when no daemon socket resolved', () => {
    expect(dockerSandboxGrants('credentials', null, homeDir)).toEqual(empty);
  });

  it('grants the socket and injects DOCKER_HOST at socket level', () => {
    expect(dockerSandboxGrants('socket', endpoint, homeDir)).toEqual({
      socketLiterals: ['/Users/dev/.docker/run/docker.sock'],
      readLiterals: [],
      readSubpaths: [],
      env: { DOCKER_HOST: 'unix:///Users/dev/.docker/run/docker.sock' },
    });
  });

  it('does not open config.json at socket level', () => {
    const grants = dockerSandboxGrants('socket', endpoint, homeDir);
    expect(grants.readLiterals).not.toContain('/Users/dev/.docker/config.json');
  });

  it('adds the contexts directory at contexts level', () => {
    const grants = dockerSandboxGrants('contexts', endpoint, homeDir);
    expect(grants.readSubpaths).toEqual(['/Users/dev/.docker/contexts']);
    expect(grants.readLiterals).toEqual([]);
  });

  it('adds config.json at credentials level, keeping the lower grants', () => {
    const grants = dockerSandboxGrants('credentials', endpoint, homeDir);
    expect(grants.socketLiterals).toEqual(['/Users/dev/.docker/run/docker.sock']);
    expect(grants.readSubpaths).toEqual(['/Users/dev/.docker/contexts']);
    expect(grants.readLiterals).toEqual(['/Users/dev/.docker/config.json']);
  });

  it('never grants the ~/.docker directory itself', () => {
    for (const level of ['socket', 'contexts', 'credentials'] as const) {
      const grants = dockerSandboxGrants(level, endpoint, homeDir);
      expect(grants.readSubpaths).not.toContain('/Users/dev/.docker');
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest --config test/jest.config.js src/shared/docker-access.test.ts -t dockerSandboxGrants`
Expected: FAIL — `dockerSandboxGrants is not a function`

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/shared/docker-access.ts

/** What a level opens in a sandbox profile. */
export interface DockerGrants {
  /** Socket paths to allow network-outbound, file-read* and file-write* on. */
  socketLiterals: string[];
  /** Single files to allow file-read* on. */
  readLiterals: string[];
  /** Directories to allow file-read* on. */
  readSubpaths: string[];
  /** Environment to inject into the job. */
  env: Record<string, string>;
}

const NO_GRANTS: DockerGrants = {
  socketLiterals: [],
  readLiterals: [],
  readSubpaths: [],
  env: {},
};

/** Rank a level so cumulative comparisons read as comparisons. */
const rank = (level: DockerAccessLevel): number => DOCKER_ACCESS_LEVELS.indexOf(level);

/**
 * What a declared level opens, given the resolved endpoint. Empty when the
 * level is off or absent, or when no daemon socket was found - the declaration
 * is a permission, not a requirement.
 */
export function dockerSandboxGrants(
  level: DockerAccessLevel | undefined,
  endpoint: DockerEndpoint | null,
  homeDir: string
): DockerGrants {
  if (!level || level === 'off' || !endpoint) {
    return { ...NO_GRANTS };
  }

  const grants: DockerGrants = {
    socketLiterals: [endpoint.socketPath],
    readLiterals: [],
    readSubpaths: [],
    // The job never has to discover the endpoint, which is what lets the rest
    // of ~/.docker stay closed at socket level.
    env: { DOCKER_HOST: `unix://${endpoint.socketPath}` },
  };

  if (rank(level) >= rank('contexts')) {
    grants.readSubpaths.push(`${homeDir}/.docker/contexts`);
  }
  if (rank(level) >= rank('credentials')) {
    grants.readLiterals.push(`${homeDir}/.docker/config.json`);
  }

  return grants;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest --config test/jest.config.js src/shared/docker-access.test.ts`
Expected: PASS (18 tests)

- [ ] **Step 5: Commit**

```bash
git add src/shared/docker-access.ts src/shared/docker-access.test.ts
git commit -m "Map each docker level to the paths it opens"
```

---

### Task 4: Runner profile emission

**Files:**
- Modify: `src/main/process-sandbox.ts` (`RunnerProfileOptions` ~line 130, profile builder ~line 146, after the `deny file-read*` block ~line 309)
- Test: `src/main/process-sandbox.test.ts`

**Interfaces:**
- Consumes: `dockerSandboxGrants`, `DockerAccessLevel` from Task 3.
- Produces: `RunnerProfileOptions` gains `dockerGrants?: DockerGrants`. The builder emits the rules.

Grants are passed in rather than resolved here, so the profile builder stays a pure function of its options and the tests do not need a real Docker install.

- [ ] **Step 1: Write the failing test**

```typescript
// src/main/process-sandbox.test.ts — follow the existing profile-building describe
import { dockerSandboxGrants } from '../shared/docker-access';

describe('docker access in the runner profile', () => {
  const endpoint = { socketPath: '/Users/dev/.docker/run/docker.sock' };
  const homeDir = '/Users/dev';

  const profileWith = (level: 'off' | 'socket' | 'contexts' | 'credentials') =>
    buildRunnerProfile({
      instanceDir: '/Users/dev/.localmost/runner/sandbox/1',
      dockerGrants: dockerSandboxGrants(level, endpoint, homeDir),
    });

  it('emits no docker rules when the level is off', () => {
    expect(profileWith('off')).not.toContain('docker.sock');
  });

  it('allows the resolved socket at socket level', () => {
    const profile = profileWith('socket');
    expect(profile).toContain(
      '(allow network-outbound (literal "/Users/dev/.docker/run/docker.sock"))'
    );
    expect(profile).toContain(
      '(allow file-write* (literal "/Users/dev/.docker/run/docker.sock"))'
    );
  });

  it('emits the socket allow after the deny block, so the literal wins', () => {
    const profile = profileWith('socket');
    const deny = profile.indexOf('(deny file-read*');
    const allow = profile.indexOf('(allow file-read* (literal "/Users/dev/.docker/run/docker.sock"))');
    expect(deny).toBeGreaterThan(-1);
    expect(allow).toBeGreaterThan(deny);
  });

  it('keeps config.json denied at socket level', () => {
    const profile = profileWith('socket');
    expect(profile).not.toContain('config.json');
  });

  it('keeps config.json denied at contexts level, adding only the directory', () => {
    const profile = profileWith('contexts');
    expect(profile).toContain('(allow file-read* (subpath "/Users/dev/.docker/contexts"))');
    expect(profile).not.toContain('config.json');
  });

  it('allows config.json at credentials level', () => {
    expect(profileWith('credentials')).toContain(
      '(allow file-read* (literal "/Users/dev/.docker/config.json"))'
    );
  });

  it('never grants the ~/.docker directory itself', () => {
    for (const level of ['socket', 'contexts', 'credentials'] as const) {
      expect(profileWith(level)).not.toContain('(allow file-read* (subpath "/Users/dev/.docker"))');
    }
  });
});
```

If the profile builder is not exported, export it for the test rather than testing through `spawnSandboxed` — the test needs the profile text, not a spawned process.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest --config test/jest.config.js src/main/process-sandbox.test.ts -t "docker access"`
Expected: FAIL — `dockerGrants` is not an accepted option and no docker rules are emitted.

- [ ] **Step 3: Write minimal implementation**

Extend the options interface (`process-sandbox.ts:130`):

```typescript
import type { DockerGrants } from '../shared/docker-access';

interface RunnerProfileOptions {
  instanceDir: string;
  brokerPort?: number;
  allowDirectNetwork?: boolean;
  filesystemPolicy?: SandboxFilesystemPolicy;
  /** What the repository's declared docker level opens; empty when off. */
  dockerGrants?: DockerGrants;
}
```

Build the rule block, and interpolate it **after** the `deny file-read*` block so the literals win over the subtree deny:

```typescript
const dockerRules = ((grants?: DockerGrants): string => {
  if (!grants) return '';
  const lines: string[] = [];

  for (const socket of grants.socketLiterals) {
    // The Docker Desktop socket lives inside the denied ~/.docker, so these
    // literals have to come after the deny block above: last match wins.
    lines.push(`(allow network-outbound (literal "${socket}"))`);
    lines.push(`(allow file-read* (literal "${socket}"))`);
    lines.push(`(allow file-write* (literal "${socket}"))`);
  }
  for (const file of grants.readLiterals) {
    lines.push(`(allow file-read* (literal "${file}"))`);
  }
  for (const dir of grants.readSubpaths) {
    lines.push(`(allow file-read* (subpath "${dir}"))`);
  }

  if (lines.length === 0) return '';
  return [
    '',
    ';; Docker access, declared by the repository policy and approved. A job',
    ';; that can reach the daemon can bind-mount host paths into a container,',
    ';; which this profile cannot constrain. See docs/roadmap/docker-access.md.',
    ...lines,
    '',
  ].join('\n');
})(dockerGrants);
```

Insert `${dockerRules}` into the profile template immediately after the closing paren of the `deny file-read*` block.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest --config test/jest.config.js src/main/process-sandbox.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/process-sandbox.ts src/main/process-sandbox.test.ts
git commit -m "Emit docker grants in the runner sandbox profile"
```

---

### Task 5: Test-mode profile emission

**Files:**
- Modify: `src/shared/sandbox-profile.ts` (socket emission ~line 360)
- Test: `src/shared/sandbox-profile.test.ts`

**Interfaces:**
- Consumes: `dockerSandboxGrants` from Task 3; `SandboxPolicy.docker` from Task 1.
- Produces: `SandboxProfileOptions` gains `dockerEndpoint?: DockerEndpoint | null` and `homeDir?: string`; the builder derives grants from `policy.docker`.

`localmost test` knows the workflow, but the level is read from `shared:` exactly as the runner reads it, so the two agree.

- [ ] **Step 1: Write the failing test**

```typescript
// src/shared/sandbox-profile.test.ts
describe('docker access in the test-mode profile', () => {
  const base = {
    workDir: '/Users/dev/project',
    proxyPort: 8080,
    homeDir: '/Users/dev',
    dockerEndpoint: { socketPath: '/Users/dev/.docker/run/docker.sock' },
  };

  it('emits no docker rules without a declared level', () => {
    const profile = buildSandboxProfile({ ...base, policy: {} });
    expect(profile).not.toContain('docker.sock');
  });

  it('allows the socket at socket level', () => {
    const profile = buildSandboxProfile({ ...base, policy: { docker: 'socket' } });
    expect(profile).toContain(
      '(allow network-outbound (literal "/Users/dev/.docker/run/docker.sock"))'
    );
  });

  it('allows config.json only at credentials level', () => {
    const contexts = buildSandboxProfile({ ...base, policy: { docker: 'contexts' } });
    const credentials = buildSandboxProfile({ ...base, policy: { docker: 'credentials' } });
    expect(contexts).not.toContain('config.json');
    expect(credentials).toContain(
      '(allow file-read* (literal "/Users/dev/.docker/config.json"))'
    );
  });

  it('emits nothing when no daemon socket resolved', () => {
    const profile = buildSandboxProfile({
      ...base,
      dockerEndpoint: null,
      policy: { docker: 'credentials' },
    });
    expect(profile).not.toContain('docker.sock');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest --config test/jest.config.js src/shared/sandbox-profile.test.ts -t "docker access"`
Expected: FAIL — no docker rules emitted.

- [ ] **Step 3: Write minimal implementation**

In `SandboxProfileOptions` add:

```typescript
  /** Resolved Docker endpoint, or null when none was found. */
  dockerEndpoint?: DockerEndpoint | null;
  /** Home directory, for the ~/.docker paths a level opens. */
  homeDir?: string;
```

In the builder, after the existing "Policy-defined socket access" block, emit from the level. The existing `sockets:` emission stays as it is — Task 7 deals with that key:

```typescript
  // Docker access, from the policy's declared level
  const dockerGrants = dockerSandboxGrants(
    policy?.docker,
    options.dockerEndpoint ?? null,
    options.homeDir ?? os.homedir()
  );
  if (dockerGrants.socketLiterals.length > 0) {
    lines.push(';; Docker access declared by the repository policy');
    for (const socket of dockerGrants.socketLiterals) {
      const escaped = escapePath(socket);
      lines.push(`(allow network-outbound (literal "${escaped}"))`);
      lines.push(`(allow file-read* (literal "${escaped}"))`);
      lines.push(`(allow file-write* (literal "${escaped}"))`);
    }
    for (const file of dockerGrants.readLiterals) {
      lines.push(`(allow file-read* (literal "${escapePath(file)}"))`);
    }
    for (const dir of dockerGrants.readSubpaths) {
      lines.push(`(allow file-read* (subpath "${escapePath(dir)}"))`);
    }
    lines.push('');
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest --config test/jest.config.js src/shared/sandbox-profile.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/sandbox-profile.ts src/shared/sandbox-profile.test.ts
git commit -m "Emit docker grants in the localmost test profile"
```

---

### Task 6: Thread the level from the approved policy to the runner

**Files:**
- Modify: `src/main/index.ts:313-330` (the `getRepoPolicy` closure)
- Modify: `src/main/runner-manager.ts:1446-1450` (`stampFor`), `:1494-1523` (`resolveFilesystemPolicy`), `:911-921` (spawn)
- Modify: `src/main/process-sandbox.ts` (`spawnSandboxed` options → profile)
- Modify: `src/shared/types.ts` (`RepoPolicyRuntime`)
- Test: `src/main/runner-manager.test.ts`

**Interfaces:**
- Consumes: `DockerAccessLevel` (Task 1), `dockerSandboxGrants` and `resolveDockerEndpoint` (Tasks 2-3), `RunnerProfileOptions.dockerGrants` (Task 4).
- Produces: `RepoPolicyRuntime` gains `docker: DockerAccessLevel`; `SandboxFilesystemPolicy` gains `docker: DockerAccessLevel`; the stamp covers it.

The stamp matters: a worker spawned under one level must not claim a job approved under another. `stampFor` currently hashes `[level, readPaths, writePaths]`, and the docker level is baked into the profile the same way.

- [ ] **Step 1: Write the failing test**

```typescript
// src/main/runner-manager.test.ts
describe('policy stamp', () => {
  it('changes when the docker level changes', () => {
    const manager = new RunnerManager({});
    const stamp = (docker: 'off' | 'socket') =>
      // @ts-expect-error - exercising the private stamp directly
      manager.stampFor({ level: 'strict', readPaths: [], writePaths: [], docker });

    expect(stamp('off')).not.toEqual(stamp('socket'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest --config test/jest.config.js src/main/runner-manager.test.ts -t "policy stamp"`
Expected: FAIL — both stamps are equal, because `stampFor` ignores the level.

- [ ] **Step 3: Write minimal implementation**

`src/shared/types.ts` — extend the runtime policy:

```typescript
  /** Docker access the repository declared, 'off' when it declared none. */
  docker: DockerAccessLevel;
```

`src/main/index.ts` — return it from both the unapproved and approved branches:

```typescript
      if (!cached?.approved) {
        return { hosts: [], level: 'strict' as const, readPaths: [], writePaths: [], docker: 'off' as const };
      }
      ...
        // Docker access, like filesystem, comes from the shared section only:
        // the profile is built before the workflow is known.
        docker: cached.config.shared?.docker ?? 'off',
```

`src/main/runner-manager.ts` — include it in the stamp and pass it to spawn:

```typescript
  private stampFor(
    policy: Pick<RepoPolicyRuntime, 'level' | 'readPaths' | 'writePaths' | 'docker'>
  ): string {
    return createHash('sha256')
      .update(JSON.stringify([policy.level, policy.readPaths, policy.writePaths, policy.docker]))
      .digest('hex');
  }
```

In `resolveFilesystemPolicy`, add `docker: 'off'` to the `closed` fallback and `docker: policy.docker` to the resolved return.

At line 911, resolve the grants once and pass them to spawn. Task 7 adds the env
spread to this same call, so bind it to a const now:

```typescript
      const filesystemPolicy = await this.resolveFilesystemPolicy(startupContextForPolicy);
      const dockerGrants = dockerSandboxGrants(
        filesystemPolicy.docker,
        resolveDockerEndpoint(),
        os.homedir()
      );

      instance.process = spawnSandboxed(runnerBinary, ['--once'], {
        cwd: sandboxDir,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
        filesystemPolicy,
        dockerGrants,
      });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest --config test/jest.config.js src/main/runner-manager.test.ts`
Expected: PASS

- [ ] **Step 5: Write the failing test for the no-daemon warning**

The spec requires that a declared level with no reachable daemon warns and runs
without the grant, rather than appearing to have had access.

```typescript
// src/main/runner-manager.test.ts
it('warns when a policy declares docker but no daemon socket resolved', () => {
  const logged: string[] = [];
  const manager = new RunnerManager({ onLog: (_level, message) => logged.push(message) });

  // @ts-expect-error - exercising the private helper directly
  manager.warnIfDockerUnavailable('socket', null);

  expect(logged.join('\n')).toMatch(/docker/i);
  expect(logged.join('\n')).toMatch(/no daemon socket/i);
});

it('says nothing when no docker level was declared', () => {
  const logged: string[] = [];
  const manager = new RunnerManager({ onLog: (_level, message) => logged.push(message) });

  // @ts-expect-error - exercising the private helper directly
  manager.warnIfDockerUnavailable('off', null);

  expect(logged).toEqual([]);
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx jest --config test/jest.config.js src/main/runner-manager.test.ts -t "no daemon"`
Expected: FAIL — `manager.warnIfDockerUnavailable is not a function`

- [ ] **Step 7: Implement the warning**

```typescript
  /**
   * A declared level with no reachable daemon runs without the grant. Say so:
   * the job must not look like it had access it did not get.
   */
  private warnIfDockerUnavailable(
    level: DockerAccessLevel,
    endpoint: DockerEndpoint | null
  ): void {
    if (level === 'off' || endpoint) return;
    this.log(
      'warn',
      `Policy declares docker: ${level}, but no daemon socket resolved - ` +
        'running without Docker access'
    );
  }
```

Call it from the spawn path, next to the `dockerGrants` const added in Step 3.

- [ ] **Step 8: Run tests to verify they pass**

Run: `npx jest --config test/jest.config.js src/main/runner-manager.test.ts`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/shared/types.ts src/main/index.ts src/main/runner-manager.ts src/main/process-sandbox.ts src/main/runner-manager.test.ts
git commit -m "Carry the docker level from approved policy into the worker profile"
```

---

### Task 7: Inject DOCKER_HOST, and settle the legacy sockets key

**Files:**
- Modify: `src/main/runner-manager.ts:913-915` (the `env` passed to `spawnSandboxed`)
- Modify: `src/cli/test.ts:265` (effective policy → profile options)
- Modify: `src/shared/localmostrc.ts` (`validateSocketsPolicy` ~line 272)
- Test: `src/main/runner-manager.test.ts`, `src/shared/localmostrc.test.ts`

**Interfaces:**
- Consumes: `DockerGrants.env` from Task 3.
- Produces: no new exports.

`shared.sockets.allow` is a validated key that already reaches the `localmost test` profile and is ignored by the runner, accepting arbitrary socket paths. It keeps working — removing a shipped key is a breaking policy change — but it warns and points at `docker:`, and it is not wired into the runner path.

- [ ] **Step 1: Write the failing test**

```typescript
// src/shared/localmostrc.test.ts
it('warns that sockets is superseded by docker and is test-mode only', () => {
  const result = parseLocalmostrcContent(
    'version: 1\nshared:\n  sockets:\n    allow:\n      - /var/run/docker.sock\n'
  );
  expect(result.success).toBe(true);
  expect(result.warnings.join('\n')).toMatch(/docker:/);
  expect(result.warnings.join('\n')).toMatch(/localmost test/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest --config test/jest.config.js src/shared/localmostrc.test.ts -t sockets`
Expected: FAIL — no warning is produced.

- [ ] **Step 3: Write minimal implementation**

`validatePolicy` collects warnings alongside errors; pass the warnings array into `validateSocketsPolicy` and push:

```typescript
    warnings.push(
      `${path}.sockets is honoured by "localmost test" only and is not applied to ` +
      'runner jobs. Declare docker access with `docker:` instead, which the runner ' +
      'and test mode both apply.'
    );
```

Inject the env in `runner-manager.ts`, where `env` is built for `spawnSandboxed`:

```typescript
      const dockerGrants = dockerSandboxGrants(
        filesystemPolicy.docker,
        resolveDockerEndpoint(),
        os.homedir()
      );

      instance.process = spawnSandboxed(runnerBinary, ['--once'], {
        cwd: sandboxDir,
        env: { ...env, ...dockerGrants.env },
        ...
        dockerGrants,
      });
```

In `src/cli/test.ts`, pass the endpoint through to the profile options:

```typescript
      policy = getEffectivePolicy(config, workflow.name);
      // ... where the profile is built:
      dockerEndpoint: resolveDockerEndpoint(),
      homeDir: os.homedir(),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest --config test/jest.config.js src/shared/localmostrc.test.ts src/main/runner-manager.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/runner-manager.ts src/cli/test.ts src/shared/localmostrc.ts src/shared/localmostrc.test.ts
git commit -m "Inject DOCKER_HOST and mark the sockets key test-mode only"
```

---

### Task 8: Approval diff prominence and policy round-trip

**Files:**
- Modify: `src/shared/localmostrc.ts` (`diffConfigs` ~line 567, `diffPolicies` ~line 579, `serializePolicy` ~line 461)
- Test: `src/shared/localmostrc.test.ts`

**Interfaces:**
- Consumes: `SandboxPolicy.docker` from Task 1.
- Produces: no new exports.

With the repository policy as the only gate, the diff an operator reads at approval time is the whole of the access control, so a docker change carries the same weight as a `level:` change.

- [ ] **Step 1: Write the failing test**

```typescript
// src/shared/localmostrc.test.ts
it('reports a docker level change as its own diff entry', () => {
  const before = { version: 1, shared: { docker: 'off' as const } };
  const after = { version: 1, shared: { docker: 'credentials' as const } };

  const diffs = diffConfigs(before, after);
  const docker = diffs.find(d => d.path === 'shared.docker');

  expect(docker).toEqual({
    path: 'shared.docker',
    type: 'changed',
    oldValue: 'off',
    newValue: 'credentials',
  });
});

it('reports newly declared docker access as added', () => {
  const diffs = diffConfigs({ version: 1 }, { version: 1, shared: { docker: 'socket' as const } });
  expect(diffs.find(d => d.path === 'shared.docker')?.type).toBe('added');
});

it('round-trips a docker level through serialization', () => {
  const config = { version: 1, shared: { docker: 'contexts' as const } };
  const reparsed = parseLocalmostrcContent(serializeLocalmostrc(config));
  expect(reparsed.config?.shared?.docker).toBe('contexts');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest --config test/jest.config.js src/shared/localmostrc.test.ts -t docker`
Expected: FAIL — no `shared.docker` diff entry; serialization drops the key.

- [ ] **Step 3: Write minimal implementation**

In `diffPolicies`, compare the scalar the way `level` is compared:

```typescript
  if (oldPolicy.docker !== newPolicy.docker) {
    diffs.push({
      path: `${pathPrefix}.docker`,
      type: oldPolicy.docker === undefined ? 'added' : newPolicy.docker === undefined ? 'removed' : 'changed',
      oldValue: oldPolicy.docker,
      newValue: newPolicy.docker,
    });
  }
```

In `serializePolicy`, emit it before the nested sections:

```typescript
  if (policy.docker !== undefined) {
    lines.push(`${indent}docker: ${policy.docker}`);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest --config test/jest.config.js src/shared/localmostrc.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/localmostrc.ts src/shared/localmostrc.test.ts
git commit -m "Surface docker level changes in the policy diff"
```

---

### Task 9: Documentation

**Files:**
- Modify: `docs/roadmap/localmostrc.md` (schema section ~line 103)
- Modify: `README.md` (policy section; roadmap entry now implemented)
- Modify: `SECURITY.md` (sandbox section)
- Modify: `CHANGELOG.md` (0.3.0 Added)
- Modify: `docs/roadmap/docker-access.md` (status line)

**Interfaces:**
- Consumes: the behaviour built in Tasks 1-8.
- Produces: no code.

- [ ] **Step 1: Update the policy reference**

In `docs/roadmap/localmostrc.md`, add to the full schema block:

```yaml
shared:
  # Docker daemon access. Cumulative; default off.
  #   socket      - the daemon socket, with DOCKER_HOST set for the job
  #   contexts    - the above, plus ~/.docker/contexts
  #   credentials - the above, plus ~/.docker/config.json
  # A job that can reach the daemon is not sandboxed: see docs/roadmap/docker-access.md
  docker: socket
```

Note in the same section that at `contexts`, a job selecting a context whose
endpoint is a different socket gets a connection refused by the sandbox - the
grant covers the resolved daemon socket, not whatever a context names.

- [ ] **Step 2: Write the SECURITY.md statement**

Under the sandbox section:

```markdown
### Docker Access

A repository may declare `docker:` in its approved `.localmostrc`. At any level
from `socket` upward, jobs from that repository are **not sandboxed**: containers
are not subject to the seatbelt profile, so a job can bind-mount host paths into
a container and read or write them - including paths the profile denies - and
make network connections that bypass the policy's allowlist.

Default is off. It takes effect only through the normal policy approval, so the
diff shown at approval time is what grants it.
```

- [ ] **Step 3: Add the changelog entry**

```markdown
- **Opt-in Docker access**: an approved `.localmostrc` may declare
  `docker: socket | contexts | credentials` to let jobs reach the Docker daemon.
  Default off. A job with Docker access is not sandboxed - see
  `docs/roadmap/docker-access.md`
```

- [ ] **Step 4: Flip the design doc status and the roadmap entry**

Change the status line in `docs/roadmap/docker-access.md` to `implemented in <version>`, and move the README roadmap bullet out of "Future feature ideas" into the current release list.

- [ ] **Step 5: Commit**

```bash
git add docs README.md SECURITY.md CHANGELOG.md
git commit -m "Document docker access and what it gives up"
```

---

### Task 10: End-to-end verification

**Files:** none — this task changes no code.

**Interfaces:**
- Consumes: everything above.

Profile assertions cannot prove the daemon is reachable. This runs the real thing.

- [ ] **Step 1: Verify the full suite is green**

Run: `npm run lint && npm run typecheck && npm test`
Expected: no lint or type errors; all suites pass.

- [ ] **Step 2: Check the endpoint resolves to the symlink target**

With Docker Desktop running:

```bash
readlink /var/run/docker.sock
npx ts-node -e "import {resolveDockerEndpoint} from './src/shared/docker-access'; console.log(resolveDockerEndpoint())"
```

Expected: both print the same per-user path under `~/.docker/run/docker.sock`. If
the resolver returns `/var/run/docker.sock` instead, the symlink is not being
followed and every profile assertion above is testing the wrong path.

- [ ] **Step 3: Run a Docker workflow through `localmost test`**

In a repository whose `.localmostrc` declares `docker: socket`, run `localmost test`. Expected: `docker info` succeeds inside the job; `cat ~/.docker/config.json` is denied.

- [ ] **Step 4: Run the same workflow on the runner**

Approve the policy (`localmost policy approve`), push, and let the runner take the job. Expected: same result as Step 3 — that agreement is the point of the shared resolver.

- [ ] **Step 5: Verify the negative case**

Quit Docker Desktop, leaving the dangling `/var/run/docker.sock`, and re-run. Expected: the job logs a warning that no daemon socket resolved, runs without the grant, and the container tests skip rather than the job failing.

- [ ] **Step 6: Commit any fixes**

```bash
git commit -am "Fix issues found in end-to-end docker verification"
```
