/**
 * A job's own bin directory, first on its PATH: `<sandbox>/localmost/bin`.
 *
 * It holds the bundled docker CLI, linked, and - unless the toolShims
 * preference is off - shims for `swift` and `xcodebuild` that turn off
 * SwiftPM's and Xcode's own sandbox. Those run every package manifest, and
 * every package plugin, under a sandbox of their own, by calling
 * /usr/bin/sandbox-exec by its absolute path. A job already runs under one,
 * and macOS refuses to apply a sandbox inside another, so a manifest the job
 * has not compiled before - every one, in a job whose HOME is new - fails
 * with "sandbox_apply: Operation not permitted". Neither tool has a switch
 * in the environment; each has an argument, which the shim adds. The job's
 * own sandbox still confines the manifest. See docs/roadmap/job-environment.md.
 */

import * as fs from 'fs';
import * as path from 'path';

/** The job's bin directory, relative to its sandbox. */
export const JOB_BIN_DIR = path.join('localmost', 'bin');

/** A value quoted for a POSIX shell. */
const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * The start of every shim: find the named tool on PATH, skipping the shim
 * itself wherever PATH lists its directory, and leave its path in $real, or
 * fail as a missing command does. The shim is known by the file, not by how
 * PATH spells its directory: matched by spelling, a trailing slash or a
 * route through `..` had it find itself and exec itself forever. PATH is
 * split on ':' alone, with globbing off, and an empty entry - the current
 * directory - is skipped.
 */
const findReal = (binDir: string, tool: string): string[] => [
  '#!/bin/sh',
  `shim_dir=${shellQuote(binDir)}`,
  'real=',
  'set -f',
  'old_ifs=$IFS',
  'IFS=:',
  'for dir in $PATH; do',
  `  [ -n "$dir" ] && ! [ "$dir/${tool}" -ef "$shim_dir/${tool}" ] || continue`,
  `  if [ -f "$dir/${tool}" ] && [ -x "$dir/${tool}" ]; then real="$dir/${tool}"; break; fi`,
  'done',
  'IFS=$old_ifs',
  'set +f',
  `[ -n "$real" ] || { echo "${tool}: command not found (localmost's shim found no other on PATH)" >&2; exit 127; }`,
];

/**
 * `swift`: for build, test, run and package, `--disable-sandbox` right after
 * the subcommand - for package, that is where its own options go - unless
 * the job already gave it before a `--`. Everything else as it is, and so
 * is `swift package --version`: package refuses --version after
 * --disable-sandbox ("Unknown option"), where build, test and run take it.
 */
export function swiftShim(binDir: string): string {
  return [
    ...findReal(binDir, 'swift'),
    '# localmost: SwiftPM\'s own sandbox off. The job already runs under one, and',
    '# macOS refuses to start a sandbox inside another, so SwiftPM could not compile',
    '# a package manifest. Turn this off in Settings > Job Environment (toolShims).',
    'case "$1" in',
    '  build|test|run|package)',
    '    for arg in "$@"; do',
    '      [ "$arg" = "--" ] && break',
    '      [ "$arg" = "--disable-sandbox" ] && exec "$real" "$@"',
    '      [ "$1" = package ] && [ "$arg" = "--version" ] && exec "$real" "$@"',
    '    done',
    '    sub=$1',
    '    shift',
    '    exec "$real" "$sub" --disable-sandbox "$@"',
    '    ;;',
    'esac',
    'exec "$real" "$@"',
    '',
  ].join('\n');
}

/**
 * What makes an xcodebuild call one that resolves a project's packages, and
 * so one that takes the setting: a build action, a query of the project, or
 * a project, workspace, scheme or target named - a call with no action
 * builds. A call with none of these, and one that makes an XCFramework, is
 * left as it is: some modes refuse an argument they do not know, and
 * `-create-xcframework` given the setting exits 70 with "invalid argument".
 */
const XCODEBUILD_RESOLVING_ARGS = [
  'build', 'build-for-testing', 'test', 'test-without-building', 'archive', 'analyze',
  'install', 'installsrc', 'clean', 'docbuild',
  '-resolvePackageDependencies', '-list', '-showBuildSettings', '-showBuildSettingsForIndex',
  '-showdestinations', '-showTestPlans',
  '-project', '-workspace', '-scheme', '-target', '-alltargets',
];

/**
 * `xcodebuild`: `-IDEPackageSupportDisableManifestSandbox=YES` at the end
 * of a call that resolves packages (XCODEBUILD_RESOLVING_ARGS) or names
 * nothing at all, unless the job already set it either way.
 */
export function xcodebuildShim(binDir: string): string {
  return [
    ...findReal(binDir, 'xcodebuild'),
    '# localmost: Xcode\'s package manifest sandbox off. The job already runs under',
    '# one, and macOS refuses to start a sandbox inside another, so Xcode could not',
    '# resolve a package. Turn this off in Settings > Job Environment (toolShims).',
    'resolves=',
    '[ $# -eq 0 ] && resolves=1',
    'for arg in "$@"; do',
    '  case "$arg" in',
    '    -IDEPackageSupportDisableManifestSandbox=*|-create-xcframework) exec "$real" "$@" ;;',
    `    ${XCODEBUILD_RESOLVING_ARGS.join('|')}) resolves=1 ;;`,
    '  esac',
    'done',
    '[ -n "$resolves" ] && exec "$real" "$@" -IDEPackageSupportDisableManifestSandbox=YES',
    'exec "$real" "$@"',
    '',
  ].join('\n');
}

/**
 * The mode of the bin directory, the directory above it, and each shim:
 * the user's alone. Only the job runs them, as the user, and a job's
 * sandbox is the user's alone too. Set explicitly, not left to the umask -
 * the app runs with 077, a development build or a test with whatever its
 * shell has - so a job gets the same bin directory either way.
 */
export const JOB_BIN_MODE = 0o700;

/** Write `content` to a new file at `file`, exclusively, with exactly `mode`. */
function writeNewFile(file: string, content: string, mode: number): void {
  const fd = fs.openSync(file, 'wx', mode);
  try {
    fs.fchmodSync(fd, mode);
    fs.writeFileSync(fd, content);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Make a sandbox's bin directory and fill it: a link to the bundled docker
 * CLI, and the shims when `shims` is set. Made with plain mkdirs and
 * exclusive writes before anything runs in the sandbox, so nothing at a
 * name is followed, and each given JOB_BIN_MODE whatever the umask.
 * Returns the directory, for the front of PATH.
 */
export function writeJobBin(sandboxDir: string, options: { dockerCli?: string; shims: boolean }): string {
  const binDir = path.join(sandboxDir, JOB_BIN_DIR);
  for (const dir of [path.dirname(binDir), binDir]) {
    fs.mkdirSync(dir, { mode: JOB_BIN_MODE });
    // Just made by this mkdir, which refuses a name already there, and
    // nothing runs in the sandbox yet: the chmod reaches this directory.
    fs.chmodSync(dir, JOB_BIN_MODE);
  }
  if (options.dockerCli) fs.symlinkSync(options.dockerCli, path.join(binDir, 'docker'));
  if (options.shims) {
    writeNewFile(path.join(binDir, 'swift'), swiftShim(binDir), JOB_BIN_MODE);
    writeNewFile(path.join(binDir, 'xcodebuild'), xcodebuildShim(binDir), JOB_BIN_MODE);
  }
  return binDir;
}
