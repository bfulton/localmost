/**
 * The macOS VM's guest agent, faked for the CLI's tests: a directory on this
 * machine stands in for the guest's test root. Uploads are unpacked into it
 * with tar, as the agent does, and each step runs here - its guest paths
 * pointed into the directory - with its output and GITHUB_OUTPUT coming back
 * as the agent sends them.
 */

import { EventEmitter } from 'events';
import { spawn, execFileSync, type ChildProcess } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { GUEST_TEST_ROOT, type PutDest, type StepRequest } from '../../main/isolation/macos-vm/agent-client';
import type { GuestAgent } from '../test-vm';

const PROGRAMS: Record<StepRequest['program'], string> = {
  bash: '/bin/bash',
  sh: '/bin/sh',
  zsh: '/bin/zsh',
  node: process.execPath,
};

export class FakeGuest extends EventEmitter implements GuestAgent {
  readonly puts: Array<{ dest: PutDest; bytes: number }> = [];
  readonly steps: StepRequest[] = [];
  readonly signals: string[] = [];
  closed = false;
  private readonly running = new Set<ChildProcess>();
  private count = 0;

  /** `root` stands in for GUEST_TEST_ROOT. */
  constructor(readonly root: string) {
    super();
  }

  /** A guest path as it is here. */
  local(guestPath: string): string {
    return guestPath.split(GUEST_TEST_ROOT).join(this.root);
  }

  async put(dest: PutDest, bytes: Buffer, sha256: string): Promise<void> {
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== sha256) throw new Error("the upload's bytes do not match their sha256");
    this.puts.push({ dest, bytes: bytes.length });
    const dir = path.join(this.root, dest);
    fs.mkdirSync(dir, { recursive: true });
    execFileSync('/usr/bin/tar', ['-x', '-f', '-', '-C', dir], { input: bytes });
  }

  async step(req: StepRequest): Promise<number> {
    this.steps.push(req);
    const n = ++this.count;
    const scratch = path.join(this.root, '.agent');
    fs.mkdirSync(scratch, { recursive: true });
    const outputs = path.join(scratch, `output-${n}`);
    fs.writeFileSync(outputs, '');
    let arg: string;
    if (req.script !== undefined) {
      arg = path.join(scratch, `step-${n}.sh`);
      fs.writeFileSync(arg, req.script);
    } else {
      arg = path.join(this.root, req.entry!);
    }
    const env: Record<string, string> = { PATH: '/usr/bin:/bin', HOME: path.join(this.root, 'home') };
    for (const [name, value] of Object.entries(req.env)) env[name] = this.local(value);
    env.GITHUB_OUTPUT = outputs;
    const child = spawn(PROGRAMS[req.program], [arg], { cwd: path.join(this.root, req.cwd), env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.running.add(child);
    for (const stream of ['stdout', 'stderr'] as const) {
      readline.createInterface({ input: child[stream]! }).on('line', (line) => this.emit('output', stream, line));
    }
    child.on('close', (code, signal) => {
      this.running.delete(child);
      // A step killed at the end of its test can close after the test removed its root.
      const text = fs.existsSync(outputs) ? fs.readFileSync(outputs, 'utf8') : '';
      setImmediate(() => this.emit('stepExit', code, signal, text));
    });
    return child.pid!;
  }

  async signal(signal: 'TERM' | 'INT' | 'KILL'): Promise<void> {
    this.signals.push(signal);
    this.kill(signal);
  }

  private kill(signal: 'TERM' | 'INT' | 'KILL'): void {
    for (const child of this.running) {
      try {
        process.kill(-child.pid!, `SIG${signal}` as NodeJS.Signals);
      } catch {
        // Gone already.
      }
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    // As the agent does when its connection closes.
    this.kill('KILL');
    this.emit('closed', new Error('the connection to the guest agent was closed'));
  }
}
