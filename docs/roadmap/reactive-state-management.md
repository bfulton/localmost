# Reactive State Management

Unify disk state, React state, and state machine into a single reactive store to prevent synchronization bugs.

## Problem

The app currently has three separate state management systems that must stay synchronized:

### 1. Disk State (Main Process)

Persisted to `~/.localmost/`:
- `config.yaml` — App settings, auth tokens, preferences
- `job-history.json` — Historical job records
- `policies/*.json` — Per-repo sandbox policy cache

**Issues:**
- Synchronous `writeFileSync` in hot paths blocks the event loop
- No atomicity — crash during write corrupts files
- No file watching — external changes are ignored
- Silent failures on write can leave disk and memory out of sync

### 2. React State (Renderer Process)

Three Context providers manage UI state:
- `AppConfigContext` — Theme, logs, settings, power, notifications
- `RunnerContext` — Auth, repos, runner status, jobs, targets
- `UpdateContext` — Update status, auto-check settings

**Issues:**
- Optimistic updates persist asynchronously and may silently fail
- No rollback mechanism when disk writes fail
- Multiple contexts managing related state independently
- Manual IPC subscriptions for each state slice

### 3. XState Machine (Main Process)

`runner-state-machine.ts` manages runner lifecycle:
```
idle → starting → running (listening/busy/paused) → shuttingDown → idle
```

**Issues:**
- Machine state is ephemeral — lost on restart
- React components subscribe via separate IPC channel
- No unified view of machine state + app state

### The Sync Problem

```
┌─────────────────────────────────────────────────────────────┐
│                     MAIN PROCESS                            │
│  ┌────────────┐    ┌────────────┐    ┌────────────┐        │
│  │ Disk State │    │  XState    │    │  App State │        │
│  │ (config,   │◄──?│  Machine   │◄──?│  (runtime) │        │
│  │  history)  │    │            │    │            │        │
│  └────────────┘    └────────────┘    └────────────┘        │
│         ▲                │                  │               │
│         │                │ IPC              │ IPC           │
│         │           (manual)           (manual)             │
│         │                ▼                  ▼               │
├─────────┼───────────────────────────────────────────────────┤
│         │         RENDERER PROCESS                          │
│         │    ┌────────────────────────────────┐             │
│         │    │  3 separate Context providers  │             │
│         │    │  (may diverge from each other) │             │
│         └────│                                │             │
│              └────────────────────────────────┘             │
└─────────────────────────────────────────────────────────────┘
```

When these systems diverge, users see stale data, settings that don't persist, or UI that doesn't reflect reality.

## Solution

Replace the three systems with a single Zustand store in the main process that:
1. Persists to disk via middleware
2. Embeds the XState machine via middleware
3. Syncs to renderer via Electron bridge library

### Why Zustand

| Requirement | Zustand | Jotai | Pure XState |
|-------------|---------|-------|-------------|
| Keep existing XState machine | ✅ via middleware | ✅ via atomWithMachine | ❌ replace |
| Electron IPC sync | ✅ Zutron/zubridge | ⚠️ custom needed | ⚠️ custom needed |
| Disk persistence | ✅ built-in middleware | ⚠️ custom needed | ⚠️ getPersistedSnapshot |
| Simple mental model | ✅ "store + selectors" | ⚠️ atoms/graphs | ⚠️ statecharts |
| Gradual migration | ✅ run alongside Context | ⚠️ different paradigm | ❌ all or nothing |

### Target Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     MAIN PROCESS                            │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐ │
│  │              Zustand Store (source of truth)          │ │
│  │                                                       │ │
│  │  ┌─────────────────────────────────────────────────┐ │ │
│  │  │  persist middleware  ←→  config.yaml            │ │ │
│  │  │                      ←→  job-history.json       │ │ │
│  │  └─────────────────────────────────────────────────┘ │ │
│  │  ┌─────────────────────────────────────────────────┐ │ │
│  │  │  xstate middleware   ←→  runnerMachine          │ │ │
│  │  └─────────────────────────────────────────────────┘ │ │
│  │                                                       │ │
│  │  State slices:                                        │ │
│  │    config: { theme, logLevel, ... }                  │ │
│  │    auth: { user, tokens, ... }                       │ │
│  │    runner: { status, instances, ... }  ← from XState │ │
│  │    jobs: { history, current, ... }                   │ │
│  │    targets: { configs, status, ... }                 │ │
│  │                                                       │ │
│  └───────────────────────────────────────────────────────┘ │
│                            │                                │
│                    Zutron / zubridge                        │
│                     (automatic sync)                        │
│                            │                                │
├────────────────────────────┼────────────────────────────────┤
│                     RENDERER PROCESS                        │
│                            │                                │
│  ┌─────────────────────────┼─────────────────────────────┐ │
│  │         Synchronized Store (read + dispatch)          │ │
│  │                                                       │ │
│  │    const theme = useStore(s => s.config.theme)       │ │
│  │    const status = useStore(s => s.runner.status)     │ │
│  │    dispatch({ type: 'setTheme', payload: 'dark' })   │ │
│  │                                                       │ │
│  └───────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

## Key Design Decisions

### 1. Main process owns the store

The main process is the single source of truth. Renderer processes get synchronized read-only copies with the ability to dispatch actions.

**Rationale:** Disk I/O and XState machine must live in main process. Having main own the store means no ambiguity about which process is authoritative.

### 2. Keep the existing XState machine

The `runner-state-machine.ts` is well-tested (100+ tests) and models complex state correctly. We embed it in Zustand via `zustand-middleware-xstate` rather than rewriting.

```typescript
import { xstate } from 'zustand-middleware-xstate';
import { runnerMachine } from './runner-state-machine';

const useStore = create(
  xstate(runnerMachine, {
    // Map machine context to store state
    select: (state) => ({
      runner: {
        status: selectRunnerStatus(state),
        instances: state.context.instances,
        currentJob: state.context.currentJob,
      }
    })
  })
);
```

### 3. Custom YAML storage adapter

The default Zustand persist middleware uses JSON. We need a custom storage adapter for `config.yaml`:

```typescript
const yamlStorage: StateStorage = {
  getItem: (name) => {
    const path = getConfigPath();
    if (!fs.existsSync(path)) return null;
    const yaml = fs.readFileSync(path, 'utf-8');
    return YAML.stringify(YAML.parse(yaml));
  },
  setItem: (name, value) => {
    const path = getConfigPath();
    const data = JSON.parse(value);
    // Atomic write: write to temp, then rename
    const temp = `${path}.tmp`;
    fs.writeFileSync(temp, YAML.stringify(data));
    fs.renameSync(temp, path);
  },
  removeItem: (name) => {
    fs.unlinkSync(getConfigPath());
  }
};
```

### 4. Selective persistence

Not all state should persist to disk:

| State | Persist | Reason |
|-------|---------|--------|
| `config.theme` | ✅ | User preference |
| `config.logLevel` | ✅ | User preference |
| `auth.tokens` | ✅ (encrypted) | Survive restart |
| `runner.status` | ❌ | Derived from machine |
| `runner.instances` | ❌ | Runtime only |
| `jobs.current` | ❌ | Runtime only |
| `jobs.history` | ✅ | Separate file |

Use Zustand's `partialize` option:

```typescript
persist(storeCreator, {
  partialize: (state) => ({
    config: state.config,
    auth: {
      user: state.auth.user,
      // tokens handled separately with encryption
    }
  })
})
```

### 5. Async persistence with debouncing

Replace synchronous writes with debounced async writes:

```typescript
const debouncedPersist = debounce(async (state) => {
  try {
    await writeAtomically(getConfigPath(), YAML.stringify(state));
  } catch (err) {
    // Emit error to store for UI to display
    useStore.setState({ lastPersistError: err });
  }
}, 500);
```

### 6. Electron bridge selection

Two main options:

| Library | Approach | Pros | Cons |
|---------|----------|------|------|
| [Zutron](https://github.com/goosewobbler/zutron) | Main → renderer sync | Simple setup, one-way | Actions need manual IPC |
| [zubridge](https://www.npmjs.com/package/@zubridge/electron) | Bidirectional bridge | Full Zustand API in renderer | More complex setup |

**Recommendation:** Start with Zutron for simplicity. If we need renderer-initiated actions, evaluate zubridge.

## Migration Plan

### Phase 1: Create Store (No Behavior Change)

1. Create `src/main/store/index.ts` with Zustand store
2. Mirror current state shape from Context providers
3. Add persist middleware writing to new file (`config-v2.yaml`)
4. Run both systems in parallel, log any divergence

### Phase 2: Migrate AppConfigContext

1. Replace `AppConfigContext` state with Zustand selectors
2. Keep Context wrapper for API compatibility
3. Remove manual IPC subscriptions for settings
4. Verify persistence works correctly

### Phase 3: Migrate RunnerContext

1. Integrate XState machine via middleware
2. Replace `RunnerContext` state with selectors
3. Remove manual `onStatusUpdate` IPC handling
4. Verify all runner states propagate correctly

### Phase 4: Migrate UpdateContext

1. Move update state to store
2. Remove `UpdateContext` provider
3. Simplify update notification component

### Phase 5: Cleanup

1. Remove old Context providers
2. Remove manual IPC subscription code
3. Migrate `config.yaml` → schema with version field
4. Add config migration from v1 → v2

## Store Shape

```typescript
interface AppStore {
  // Config (persisted to config.yaml)
  config: {
    theme: 'light' | 'dark' | 'system';
    logLevel: LogLevel;
    runnerLogLevel: LogLevel;
    maxLogScrollback: number;
    maxJobHistory: number;
    sleepProtection: SleepProtection;
    sleepProtectionConsented: boolean;
    preserveWorkDir: boolean;
    toolCacheLocation: string;
    userFilter: UserFilterConfig;
    power: PowerConfig;
    notifications: NotificationConfig;
    launchAtLogin: boolean;
    hideOnStart: boolean;
  };

  // Auth (tokens encrypted, persisted separately)
  auth: {
    user: GitHubUser | null;
    status: AuthStatus;
    deviceCode: DeviceCodeInfo | null;
  };

  // Runner (from XState machine, not persisted)
  runner: {
    status: RunnerStatus;
    startedAt: string | null;
    error: string | null;
    isPaused: boolean;
    pauseReason: string | null;
    instances: Map<number, InstanceState>;
    busyInstances: Set<number>;
    currentJob: JobInfo | null;
  };

  // Jobs (history persisted to job-history.json)
  jobs: {
    history: JobHistoryEntry[];
    current: JobHistoryEntry | null;
  };

  // Targets (config persisted, status not)
  targets: {
    configs: TargetConfig[];
    status: Map<string, RunnerProxyStatus>;
  };

  // Download state (not persisted)
  download: {
    status: DownloadStatus;
    progress: DownloadProgress | null;
    availableVersions: string[];
    selectedVersion: string;
    installedVersion: string | null;
  };

  // Update state (not persisted)
  update: {
    status: UpdateStatus;
    autoCheck: boolean;
    checkInterval: number;
    isChecking: boolean;
    isDismissed: boolean;
    lastChecked: string | null;
  };

  // UI state (not persisted)
  ui: {
    isOnline: boolean;
    logs: LogEntry[];
    lastPersistError: Error | null;
  };

  // Actions
  actions: {
    setTheme: (theme: Theme) => void;
    setLogLevel: (level: LogLevel) => void;
    // ... other actions
    sendRunnerEvent: (event: RunnerEvent) => void;
  };
}
```

## Edge Cases

### App crashes during write

**Current:** File may be corrupted (partial write).

**Solution:** Atomic writes via temp file + rename:
```typescript
const temp = `${path}.tmp`;
fs.writeFileSync(temp, content);
fs.renameSync(temp, path);  // Atomic on POSIX
```

### Renderer starts before main store ready

**Current:** N/A (IPC waits for response).

**Solution:** Zutron/zubridge handle this — renderer store stays empty until first sync.

### Multiple windows

**Current:** Each window has own Context state, synced via IPC.

**Solution:** Zutron syncs all renderer windows from single main store automatically.

### Store version mismatch after update

**Solution:** Add schema version and migration:
```typescript
persist(store, {
  version: 2,
  migrate: (persisted, version) => {
    if (version === 1) {
      // Migrate from v1 schema
      return migrateV1ToV2(persisted);
    }
    return persisted;
  }
})
```

### Encryption key unavailable

**Current:** `encryptValue()` throws, save fails entirely.

**Solution:** Separate auth token persistence with graceful degradation:
```typescript
try {
  await persistEncryptedTokens(tokens);
} catch (err) {
  // Store in memory only, warn user
  store.setState({
    auth: { ...auth, persistenceWarning: 'Tokens not saved' }
  });
}
```

### XState machine reset on restart

**Current:** Machine starts in `idle`, job history persists separately.

**Solution:** Optionally persist machine snapshot:
```typescript
// On shutdown
const snapshot = actor.getPersistedSnapshot();
await persistSnapshot(snapshot);

// On startup
const snapshot = await loadSnapshot();
createActor(machine, { snapshot }).start();
```

**Trade-off:** May not want to restore mid-job state after crash. Could selectively restore only certain states (e.g., `paused` but not `busy`).

## Out of Scope

- **Redux DevTools integration** — Nice to have, not essential
- **Undo/redo** — Not needed for this app
- **Offline-first sync** — Single-machine app, not distributed
- **Server-side state** — All state is local

## Open Questions

1. **Zutron vs zubridge?** Zutron is simpler but one-way. Do we need renderer-initiated actions beyond what IPC handlers already provide?

2. **Persist XState snapshot?** Restoring runner state after crash could be confusing if the job is gone. Maybe only persist `userPaused` flag?

3. **Config file format?** Keep YAML for human readability, or switch to JSON for simplicity? YAML allows comments which users appreciate.

4. **Job history location?** Keep separate `job-history.json` or merge into main config? Separate file means less frequent config writes.

## Dependencies

- [zustand](https://github.com/pmndrs/zustand) — Core store (~3KB)
- [zustand-middleware-xstate](https://github.com/biowaffeln/zustand-middleware-xstate) — XState integration (~1KB)
- [zutron](https://github.com/goosewobbler/zutron) or [@zubridge/electron](https://www.npmjs.com/package/@zubridge/electron) — Electron sync

## Success Criteria

1. Single source of truth: All state flows from main process Zustand store
2. No manual IPC subscriptions for state updates in renderer
3. Atomic disk writes: No corrupted config on crash
4. XState machine state visible alongside app state in one place
5. Gradual migration: Can run old and new systems in parallel during transition
