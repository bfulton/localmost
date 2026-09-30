/**
 * Call a module's export in a child node process, for a test of code that
 * may block the process it runs in.
 *
 * A synchronous read of /dev/zero or a FIFO never returns, and jest's test
 * timeout cannot interrupt synchronous code, so such a test run in-process
 * would hang the whole suite rather than fail. In a child it is killed at
 * the timeout, and the test reads that as the failure it is. The child
 * compiles each .ts module as it loads it, as ts-jest does.
 */

import { spawnSync } from 'child_process';

export interface ChildCallResult {
  /** The child's exit status, or null when a signal ended it. */
  status: number | null;
  /** True when the child was still running at the timeout and was killed. */
  timedOut: boolean;
  /** stdout and stderr together: the call's result as JSON, or the message it threw. */
  output: string;
}

const CHILD = `
const fs = require('fs');
const [typescript, modulePath, name, args] = process.argv.slice(1);
const ts = require(typescript);
require.extensions['.ts'] = (m, file) => {
  const source = fs.readFileSync(file, 'utf-8');
  const out = ts.transpileModule(source, {
    fileName: file,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  });
  m._compile(out.outputText, file);
};
Promise.resolve()
  .then(() => require(modulePath)[name](...JSON.parse(args)))
  .then((value) => {
    if (value !== undefined) console.log(JSON.stringify(value));
    process.exit(0);
  }, (err) => {
    console.error(err && err.message);
    process.exit(1);
  });
`;

export function callInChild(
  modulePath: string,
  exportName: string,
  args: unknown[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }
): ChildCallResult {
  // The child's own require resolves from its working directory, which is
  // the test's, so typescript is found from here and passed in.
  const typescript = require.resolve('typescript');
  const result = spawnSync(process.execPath, ['-e', CHILD, typescript, modulePath, exportName, JSON.stringify(args)], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: 'utf-8',
    timeout: options.timeoutMs ?? 10_000,
    killSignal: 'SIGKILL',
  });
  return {
    status: result.status,
    timedOut: result.signal === 'SIGKILL',
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}
