# Resource-Aware Scheduling Design

## Overview

Resource-aware scheduling enables localmost to automatically pause runners when the Mac is under resource constraints (battery power, active video calls, high CPU/memory usage) and resume them when conditions improve.

**Goal**: Be a good citizen on the user's Mac — don't drain battery, don't slow down video calls, and don't compete with user work.

## Design Principles

1. **Opt-in by default** — Resource awareness should be explicitly enabled; users expect the runner to stay running unless they've asked otherwise
2. **Finish in-progress jobs** — Never kill a running job; only prevent new jobs from starting
3. **Clear feedback** — Users should always know why the runner is paused and when it will resume
4. **Conservative detection** — Prefer false negatives (missing a pause opportunity) over false positives (pausing unnecessarily)

## Resource Conditions

### 1. Battery Power (High Priority)

**Condition**: Mac is running on battery (not plugged in)

**Detection (macOS)**:
```typescript
// Using Electron's powerMonitor
import { powerMonitor } from 'electron';

powerMonitor.isOnBatteryPower(); // true when on battery
powerMonitor.on('on-battery', () => { /* pause */ });
powerMonitor.on('on-ac', () => { /* resume */ });
```

**Configuration Options**:
- `pauseOnBattery`: `'no' | '<25%' | '<50%' | '<75%'` (default: `'no'`)
  - `'no'` — Never pause for battery
  - `'<25%'` — Pause when battery drops below 25%
  - `'<50%'` — Pause when battery drops below 50%
  - `'<75%'` — Pause when battery drops below 75%

**Edge Cases**:
- Desktop Macs (iMac, Mac Mini, Mac Pro) never run on battery — feature auto-disables
- External battery packs may report as AC power — no action needed

### 2. Video Calls (High Priority)

**Condition**: User is in an active video call

**Detection (macOS)** — Multiple approaches, from most to least reliable:

**Option A: Camera Usage (Recommended)**
```bash
# Check if any process is using the camera
system_profiler SPCameraDataType | grep "Connection State"
# or via IOKit framework for real-time monitoring
```

**Option B: Active App Detection**
```typescript
// Check if common video apps are frontmost/active
const VIDEO_APPS = [
  'zoom.us',
  'Slack',
  'Microsoft Teams',
  'FaceTime',
  'Google Chrome', // Meet
  'Discord',
  'Webex',
  'Skype',
];
```

**Option C: Audio Input Detection**
```bash
# Check if microphone is in use
ioreg -c AppleHDAEngineInput | grep IOAudioEngineState
```

**Configuration Options**:
- `pauseOnVideoCall`: `boolean` (default: `false`)
- `videoCallGracePeriod`: `number` (seconds, default: `60`) — wait before resuming after last call ends

### 3. System Under Load (Future)

**Condition**: CPU/Memory usage exceeds threshold

**Detection**:
```typescript
import os from 'os';
const loadAvg = os.loadavg()[0]; // 1-minute load average
const cpuCount = os.cpus().length;
const loadPercent = (loadAvg / cpuCount) * 100;
```

**Configuration Options**:
- `pauseOnHighLoad`: `boolean` (default: `false`)
- `loadThreshold`: `number` (0-100, default: `80`)
- `loadSampleDuration`: `number` (seconds, default: `60`) — average over this period

### 4. User-Defined Time Windows (Future)

**Condition**: Current time falls within "do not disturb" windows

**Configuration**:
- `quietHours`: `{ start: string, end: string }[]` — e.g., `[{ start: '09:00', end: '18:00' }]`

## Architecture

### New Components

```
src/main/
├── resource-monitor/
│   ├── index.ts              # ResourceMonitor class - orchestrates all monitors
│   ├── battery-monitor.ts    # Battery state detection
│   ├── video-call-monitor.ts # Video call detection
│   └── types.ts              # Shared types
```

### ResourceMonitor Class

```typescript
interface ResourceCondition {
  type: 'battery' | 'video-call' | 'low-battery' | 'high-load';
  active: boolean;
  reason: string;      // Human-readable explanation
  since?: Date;        // When condition became active
  priority: number;    // Higher = more important
}

interface ResourceMonitorEvents {
  'condition-changed': (conditions: ResourceCondition[]) => void;
  'should-pause': (reason: string) => void;
  'should-resume': () => void;
}

class ResourceMonitor extends EventEmitter<ResourceMonitorEvents> {
  private conditions: Map<string, ResourceCondition>;
  private config: ResourceAwareConfig;

  start(): void;
  stop(): void;
  getActiveConditions(): ResourceCondition[];
  isPauseRecommended(): boolean;
  getPauseReason(): string | null;
}
```

### Integration with RunnerManager

The `RunnerManager` will be updated to:

1. Accept a `ResourceMonitor` instance
2. Listen for `should-pause` / `should-resume` events
3. Track whether pause was user-initiated vs resource-initiated
4. Prevent resource-resume from overriding user pause

```typescript
// In RunnerManager
private resourcePaused: boolean = false;
private userPaused: boolean = false;

// Resource-initiated pause
onResourcePause(reason: string) {
  if (this.userPaused) return; // User pause takes precedence
  this.resourcePaused = true;
  this.pause(reason);
}

// Resource-initiated resume
onResourceResume() {
  if (this.userPaused) return; // Don't resume if user explicitly paused
  if (!this.resourcePaused) return;
  this.resourcePaused = false;
  this.resume();
}

// User-initiated pause (via CLI or UI)
userPause() {
  this.userPaused = true;
  this.resourcePaused = false;
  this.pause('User requested pause');
}

// User-initiated resume
userResume() {
  this.userPaused = false;
  this.resume();
}
```

### Pause Behavior

When pausing due to resource conditions:

1. **Stop heartbeat** — This signals to GitHub that the runner is unavailable, causing workflows to fall back to hosted runners
2. **Let in-progress jobs complete** — Don't kill running jobs
3. **Prevent new jobs** — The runner won't pick up new jobs
4. **Show status** — UI and CLI show why the runner is paused

## Configuration Schema

Add to `AppSettings` in `src/shared/types.ts`:

```typescript
interface ResourceAwareConfig {
  /** Pause when on battery power below threshold */
  pauseOnBattery: 'no' | '<25%' | '<50%' | '<75%';

  /** Pause during video calls (camera detection) */
  pauseOnVideoCall: boolean;

  /** Seconds to wait after call ends before resuming */
  videoCallGracePeriod: number;

  /** Show notifications when auto-pausing/resuming */
  notifyOnPause: boolean;
}

// Defaults
const DEFAULT_RESOURCE_CONFIG: ResourceAwareConfig = {
  pauseOnBattery: 'no',
  pauseOnVideoCall: false,
  videoCallGracePeriod: 60,
  notifyOnPause: false,
};
```

## UI Design

### Settings Page

Add a "Resource Awareness" section to Settings:

```
┌─────────────────────────────────────────────────────────────┐
│ Resource Awareness                                          │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│ Pause when using battery                                    │
│ [Dropdown: No / < 25% / < 50% / < 75%]                      │
│                                                             │
│ [Toggle] Pause during video calls                           │
│                                                             │
│ [Toggle] Notify when pausing/resuming                       │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Status Indicator

When resource-paused, show in the status area:

```
┌─────────────────────────────────────────────────────────────┐
│ 🔋 Runner paused — battery below 50%                        │
│    Will resume when plugged in                              │
└─────────────────────────────────────────────────────────────┘
```

Or for video calls:

```
┌─────────────────────────────────────────────────────────────┐
│ 📹 Runner paused — video call detected                      │
│    Will resume 60s after call ends                          │
└─────────────────────────────────────────────────────────────┘
```

### CLI Output

```bash
$ localmost status

localmost is running

  Repository: bfulton/localmost
  Runner:     localmost-macbook-pro (4 instances configured)
  Status:     ⏸ Paused (on battery - 45%)
              Will resume when plugged in
  Jobs today: 12 completed

$ localmost status --json
{
  "running": true,
  "paused": true,
  "pauseReason": "battery",
  "pauseDetails": "Running on battery (45%)",
  "resourceConditions": [
    { "type": "battery", "active": true, "reason": "On battery power (45%)" }
  ]
}
```

## Implementation Plan

### Phase 1: Battery Awareness (MVP)

1. Create `BatteryMonitor` using Electron's `powerMonitor`
2. Create `ResourceMonitor` orchestrator
3. Integrate with `RunnerManager` pause/resume
4. Add configuration to settings
5. Update CLI status output
6. Add UI indicators
7. Write tests

**Deliverables**:
- Battery-based auto-pause working
- Settings UI for enabling/configuring
- Status shows pause reason

### Phase 2: Video Call Detection

1. Create `VideoCallMonitor` with camera detection
2. Add grace period logic (resets on new calls)
3. Extend settings UI

**Deliverables**:
- Camera-based video call detection
- Grace period with reset on new calls

### Phase 3: Polish & Edge Cases

1. Handle edge cases (desktop Macs, multiple conditions)
2. Add notification support (optional, default off)
3. Improve detection reliability
4. Add analytics/logging for debugging

### Future Phases

- System load awareness
- Quiet hours / scheduling
- Integration with macOS Focus modes

## Testing Strategy

### Unit Tests

- `BatteryMonitor`: Mock `powerMonitor`, verify events
- `VideoCallMonitor`: Mock camera detection, test grace period
- `ResourceMonitor`: Test condition aggregation, priority

### Integration Tests

- Verify pause/resume integrates correctly with `RunnerManager`
- Test that user pause takes precedence over resource pause
- Test that in-progress jobs complete before pause takes effect

### Manual Testing

- Test on MacBook (battery available)
- Test on desktop Mac (no battery)
- Test with actual video calls (Zoom, FaceTime, etc.)
- Test edge cases (plug in during job, video call ends during job)

## Design Decisions

1. **No "Run Anyway" override** — User can simply turn off auto-pause in settings; no need for a separate override button.

2. **Video call detection**: Camera-only. Simple and reliable.

3. **Grace period resets**: If a new call starts during the grace period, the timer resets. Always 60s after the *last* call ends.

4. **Multiple conditions**: Show the highest-priority active condition only.

5. **Notifications**: Notify on pause and resume, but controlled by a separate setting (default: off).

## Security Considerations

- Camera detection only checks if camera is in use; we don't access camera data. As built, it runs the `is-camera-on` package's helper with `--watch`, which reads CoreMediaIO's is-running-somewhere property of each camera and prints `true`/`false` on each change; reading it needs no camera permission. The helper ships in the app's Resources, signed with the app and with no entitlements, and is run from there (from the installed package in development)
- No network calls required for resource monitoring
- All detection is local and privacy-preserving

## Appendix: macOS Detection Code Samples

### Battery Detection (using powerMonitor)

```typescript
import { powerMonitor } from 'electron';

class BatteryMonitor {
  private onBatteryPower: boolean = false;

  start() {
    this.onBatteryPower = powerMonitor.isOnBatteryPower();

    powerMonitor.on('on-battery', () => {
      this.onBatteryPower = true;
      this.emit('battery-state-changed', true);
    });

    powerMonitor.on('on-ac', () => {
      this.onBatteryPower = false;
      this.emit('battery-state-changed', false);
    });
  }

  isOnBattery(): boolean {
    return this.onBatteryPower;
  }
}
```

### Battery Level (using native module or shell)

```typescript
import { exec } from 'child_process';

async function getBatteryLevel(): Promise<number | null> {
  return new Promise((resolve) => {
    exec(
      "pmset -g batt | grep -Eo '\\d+%' | head -1 | tr -d '%'",
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        const level = parseInt(stdout.trim(), 10);
        resolve(isNaN(level) ? null : level);
      }
    );
  });
}
```

### Camera Detection

```typescript
import { exec } from 'child_process';

async function isCameraInUse(): Promise<boolean> {
  return new Promise((resolve) => {
    // Check if VDCAssistant (camera daemon) is running with clients
    exec(
      "lsof | grep -i 'VDCAssistant\\|AppleCamera' | wc -l",
      (error, stdout) => {
        if (error) {
          resolve(false);
          return;
        }
        resolve(parseInt(stdout.trim(), 10) > 0);
      }
    );
  });
}

// Alternative: Check for green camera indicator
async function isCameraInUseViaLog(): Promise<boolean> {
  return new Promise((resolve) => {
    exec(
      "log show --predicate 'subsystem == \"com.apple.camera\"' --last 5s | grep -i 'started\\|active' | wc -l",
      (error, stdout) => {
        resolve(parseInt(stdout.trim(), 10) > 0);
      }
    );
  });
}
```

### Active Application Check

```typescript
import { exec } from 'child_process';

const VIDEO_APPS = new Set([
  'zoom.us',
  'Slack',
  'Microsoft Teams',
  'FaceTime',
  'Discord',
  'Webex Meetings',
  'Skype',
]);

async function isVideoAppActive(): Promise<string | null> {
  return new Promise((resolve) => {
    exec(
      "osascript -e 'tell application \"System Events\" to name of first process whose frontmost is true'",
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        const appName = stdout.trim();
        resolve(VIDEO_APPS.has(appName) ? appName : null);
      }
    );
  });
}
```
