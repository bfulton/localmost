'use strict';

// Building and running vzrun (scripts/guest/vzrun.swift), the guest build's
// VM runner and the guest's development harness (contract §4.3 steps 6 and 7).

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const TOOLS = path.join(ROOT, 'build', 'guest-tools');

// The same single entitlement as packaging/entitlements.virtualization.plist
// (contract §7.1). Written here so that the guest build does not depend on
// the packaging work, and never shipped.
const ENTITLEMENTS = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.virtualization</key>
  <true/>
</dict>
</plist>
`;

/**
 * Compiles vzrun with `swiftc -O` and signs it ad hoc with the
 * virtualization entitlement, unless the binary for this source is already
 * built. Returns its path.
 */
function buildVzrun() {
  const src = path.join(__dirname, 'vzrun.swift');
  const hash = crypto.createHash('sha256').update(fs.readFileSync(src)).update(ENTITLEMENTS).digest('hex');
  const bin = path.join(TOOLS, 'vzrun');
  const stamp = path.join(TOOLS, 'vzrun.sha256');
  if (fs.existsSync(bin) && fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === hash) return bin;
  fs.mkdirSync(TOOLS, { recursive: true });
  const plist = path.join(TOOLS, 'entitlements.virtualization.plist');
  fs.writeFileSync(plist, ENTITLEMENTS);
  execFileSync('swiftc', ['-O', '-o', bin, src], { stdio: 'inherit' });
  execFileSync('codesign', ['-f', '-s', '-', '--entitlements', plist, bin], { stdio: 'inherit' });
  fs.writeFileSync(stamp, hash);
  return bin;
}

/**
 * Boots a VM. `opts` mirrors vzrun's flags: kernel, initrd, cmdline, cpus,
 * memoryMiB, console, timeoutSec, shares [{tag, path, ro}], disks
 * [{path, ro, sync}], vsock [{port, path, dir}], rosetta.
 * Returns `{ events, started, exited, stop() }`: `started` resolves with the
 * started event, `exited` with `{ code, events }`. Closing stdin (stop())
 * makes vzrun stop the VM.
 */
function runVm(opts) {
  const bin = buildVzrun();
  const args = ['--kernel', opts.kernel, '--initrd', opts.initrd];
  if (opts.cmdline) args.push('--cmdline', opts.cmdline);
  if (opts.cpus) args.push('--cpus', String(opts.cpus));
  if (opts.memoryMiB) args.push('--memory-mib', String(opts.memoryMiB));
  if (opts.console) args.push('--console', opts.console);
  if (opts.timeoutSec) args.push('--timeout', String(opts.timeoutSec));
  for (const s of opts.shares ?? []) args.push('--share', `${s.tag}=${s.path}:${s.ro ? 'ro' : 'rw'}`);
  for (const d of opts.disks ?? []) args.push('--disk', `${d.path}:${d.ro ? 'ro' : 'rw'}:${d.sync ?? 'none'}`);
  for (const v of opts.vsock ?? []) args.push('--vsock-unix', `${v.port}:${v.path}:${v.dir ?? 'to-guest'}`);
  if (opts.rosetta) args.push('--rosetta');
  const child = spawn(bin, args, { stdio: ['pipe', 'pipe', opts.stderr ?? 'inherit'] });
  const events = [];
  let onStarted;
  let onStartFail;
  const started = new Promise((resolve, reject) => {
    onStarted = resolve;
    onStartFail = reject;
  });
  started.catch(() => {});
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      try {
        const ev = JSON.parse(line);
        events.push(ev);
        if (ev.event === 'started') onStarted(ev);
      } catch {
        // vzrun writes only JSON to stdout; anything else is ignored.
      }
    }
  });
  const exited = new Promise((resolve) => {
    child.on('exit', (code, signal) => {
      onStartFail(new Error(`vzrun exited (${code ?? signal}) before the VM started`));
      resolve({ code, signal, events });
    });
  });
  return {
    events,
    started,
    exited,
    pid: child.pid,
    stop() {
      child.stdin.end();
      return exited;
    },
    kill(sig = 'SIGTERM') {
      child.kill(sig);
      return exited;
    },
  };
}

module.exports = { buildVzrun, runVm, ENTITLEMENTS };
