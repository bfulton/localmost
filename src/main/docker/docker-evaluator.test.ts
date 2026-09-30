/**
 * The SECURITY.md escapes as executable tests, run against the evaluator.
 *
 * Profile assertions cannot prove a filter works. Each case here is a request
 * a job could make through its docker socket, and the verdict it must get.
 */

import { describe, it, expect } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { evaluateDockerRequest, DockerEvalContext, pullRequestOf } from './docker-evaluator';
import { parseDockerRequest, DockerRequest } from './docker-request';
import { DockerPolicy, mergeDockerPolicy, parseDockerPolicyHint } from '../../shared/docker-policy';

const mk = (method: string, url: string, body?: unknown) => parseDockerRequest({
  method, url, headers: body ? { 'content-type': 'application/json' } : {},
  body: body ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0),
});
const ctx = (
  policy: DockerPolicy | null,
  extraOrIds: Partial<DockerEvalContext> | string[] = {}
): DockerEvalContext => {
  const extra = Array.isArray(extraOrIds) ? { ownContainerIds: new Set(extraOrIds) } : extraOrIds;
  // Paths here are made up, so nothing on them is a symlink; the test that
  // walks a real tree passes lstat: undefined for the filesystem's own.
  return {
    policy, sandboxDir: '/ws', workspaceRoot: '/ws', supportsPrivileged: false,
    realpath: (p: string) => p, lstat: () => ({ isSymbolicLink: () => false }), ...extra,
  };
};

describe('evaluateDockerRequest', () => {
  it('permits the always-on baseline with no declaration', () => {
    for (const u of ['/v1.45/_ping', '/v1.45/version', '/v1.45/info']) {
      expect(evaluateDockerRequest(mk('GET', u), ctx({})).allowed).toBe(true);
    }
  });

  it('permits only the always-on baseline before a policy is bound', () => {
    expect(evaluateDockerRequest(mk('GET', '/v1.45/_ping'), ctx(null)).allowed).toBe(true);
    // Not a container read: the baseline is reads about the job's OWN
    // containers, and before a policy is bound the job owns none.
    expect(evaluateDockerRequest(mk('GET', '/v1.45/containers/json'), ctx(null)).allowed).toBe(false);
    expect(evaluateDockerRequest(mk('GET', '/v1.45/containers/abc/json'), ctx(null)).allowed).toBe(false);
  });

  it('never lists the host\'s containers, whatever the policy declares', () => {
    // `docker ps` would otherwise enumerate every container on the machine,
    // including other jobs' - a host metadata leak no policy key can grant.
    const bound = ctx({ run: { images: ['postgres:16'] } });
    expect(evaluateDockerRequest(mk('GET', '/v1.45/containers/json'), bound).allowed).toBe(false);
  });

  it('scopes container reads and writes to containers created through this socket', () => {
    const own = ctx({ run: { images: ['postgres:16'] } }, ['mine123']);
    const reqs: Array<[string, string]> = [
      ['GET', '/v1.45/containers/%s/json'],
      ['POST', '/v1.45/containers/%s/start'],
      ['POST', '/v1.45/containers/%s/attach'],
      ['POST', '/v1.45/containers/%s/wait'],
      ['DELETE', '/v1.45/containers/%s'],
    ];
    for (const [method, tpl] of reqs) {
      expect(evaluateDockerRequest(mk(method, tpl.replace('%s', 'mine123')), own).allowed).toBe(true);
      // Another job's container on the same daemon: reading it leaks, and
      // starting or removing it reaches outside this job entirely.
      expect(evaluateDockerRequest(mk(method, tpl.replace('%s', 'theirs999')), own).allowed).toBe(false);
    }
  });

  it('denies everything when no policy is bound', () => {
    expect(evaluateDockerRequest(mk('POST', '/v1.45/containers/create', { Image: 'postgres:16' }), ctx(null)).allowed).toBe(false);
    expect(evaluateDockerRequest(mk('POST', '/v1.45/images/create?fromImage=postgres&tag=16'), ctx(null)).allowed).toBe(false);
    expect(evaluateDockerRequest(mk('POST', '/v1.45/containers/abc/start'), ctx(null)).allowed).toBe(false);
    const v = evaluateDockerRequest(mk('POST', '/v1.45/build'), ctx(null));
    expect(v.allowed).toBe(false);
    expect(v.reason).toMatch(/no docker policy is bound/i);
  });
});

describe('the SECURITY.md escapes', () => {
  const runPolicy: DockerPolicy = { run: { images: ['postgres:16'], mounts: [{ path: './', mode: 'ro' }], network: 'bridge' } };
  const create = (body: unknown, c: DockerEvalContext = ctx(runPolicy)) =>
    evaluateDockerRequest(mk('POST', '/v1.45/containers/create', body), c);

  it('refuses a host bind mount the policy did not declare', () => {
    const v = create({ Image: 'postgres:16', HostConfig: { Binds: ['/Users/me/.ssh:/host-ssh'] } });
    expect(v.allowed).toBe(false);
    expect(v.reason).toMatch(/outside the job workspace/i);
    expect(v.policyHint).toBeUndefined(); // nothing a policy could say permits it
  });

  it('refuses mounting the daemon socket into a container', () => {
    const v = create({ Image: 'postgres:16', HostConfig: { Binds: ['/var/run/docker.sock:/var/run/docker.sock'] } });
    expect(v.allowed).toBe(false);
    const m = create({ Image: 'postgres:16', HostConfig: { Mounts: [{ Type: 'bind', Source: '/var/run/docker.sock', Target: '/var/run/docker.sock' }] } });
    expect(m.allowed).toBe(false);
  });

  it('refuses privileged, --pid=host, --network=host, and --device', () => {
    const bodies = [
      { Image: 'postgres:16', HostConfig: { Privileged: true } },
      { Image: 'postgres:16', HostConfig: { PidMode: 'host' } },
      { Image: 'postgres:16', HostConfig: { NetworkMode: 'host' } },
      { Image: 'postgres:16', HostConfig: { Devices: [{ PathOnHost: '/dev/kmsg' }] } },
    ];
    for (const b of bodies) expect(create(b).allowed).toBe(false);
  });

  it('refuses the other namespace, device and capability escapes the grammar cannot spell', () => {
    const bodies = [
      { HostConfig: { IpcMode: 'host' } },
      { HostConfig: { IpcMode: 'container:abc' } },
      { HostConfig: { UTSMode: 'host' } },
      { HostConfig: { UsernsMode: 'host' } },
      { HostConfig: { CgroupnsMode: 'host' } },
      { HostConfig: { PidMode: 'container:abc' } },
      { HostConfig: { NetworkMode: 'container:abc' } },
      { HostConfig: { CgroupParent: '/host.slice' } },
      { HostConfig: { SecurityOpt: ['seccomp=unconfined'] } },
      { HostConfig: { CapAdd: ['SYS_ADMIN'] } },
      { HostConfig: { DeviceRequests: [{ Driver: 'nvidia', Count: -1 }] } },
      { HostConfig: { DeviceCgroupRules: ['c 1:3 rwm'] } },
      { HostConfig: { Sysctls: { 'kernel.shm_rmid_forced': '1' } } },
      { HostConfig: { Runtime: 'sysbox-runc' } },
      { HostConfig: { MaskedPaths: [] } },
      { HostConfig: { ReadonlyPaths: [] } },
      { HostConfig: { VolumesFrom: ['other'] } },
    ];
    for (const b of bodies) {
      const v = create({ Image: 'postgres:16', ...b });
      expect(v.allowed).toBe(false);
      expect(v.reason).toBeTruthy();
    }
  });

  it('passes the defaults the docker CLI always sends for those keys', () => {
    const v = create({
      Image: 'postgres:16',
      HostConfig: {
        Binds: null, NetworkMode: 'default', PidMode: '', IpcMode: 'private', UTSMode: '', UsernsMode: '',
        CgroupnsMode: 'private', Devices: [], DeviceRequests: null, DeviceCgroupRules: null, CgroupParent: '',
        SecurityOpt: null, CapAdd: null, CapDrop: null, Sysctls: {}, Runtime: '', VolumesFrom: null,
        Privileged: false, Isolation: '', LogConfig: { Type: '', Config: {} }, RestartPolicy: { Name: 'no' },
        AutoRemove: true, Memory: 0, NanoCpus: 0, Ulimits: null, Tmpfs: { '/run': '' },
      },
    });
    expect(v.allowed).toBe(true);
  });

  it('refuses a ../ traversal and a symlink that resolves outside the workspace', () => {
    const traversal = create({ Image: 'postgres:16', HostConfig: { Binds: ['/ws/../etc:/x'] } });
    expect(traversal.allowed).toBe(false);
    const symCtx = ctx(runPolicy, { realpath: (_p: string) => '/etc/passwd' }); // resolves outside /ws
    const symlink = create({ Image: 'postgres:16', HostConfig: { Binds: ['/ws/link:/x'] } }, symCtx);
    expect(symlink.allowed).toBe(false);
  });

  it('refuses a mount whose source cannot be resolved, rather than letting the daemon create it', () => {
    const missing = ctx(runPolicy, { realpath: (p: string) => { if (p.endsWith('/missing')) throw new Error('ENOENT'); return p; } });
    const v = create({ Image: 'postgres:16', HostConfig: { Binds: ['/ws/missing:/x'] } }, missing);
    expect(v.allowed).toBe(false);
    expect(v.reason).toMatch(/could not be resolved/i);
  });

  it('refuses a mount that passes through a symlink below the sandbox directory, whatever resolved it', () => {
    // A realpath answer is only as good as the moment it was taken: the job
    // can swap a link in on the way to the source right after. Each component
    // from the sandbox directory down is checked with lstat, on the real
    // filesystem, after resolving.
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deval-')));
    try {
      const sandbox = path.join(base, 's');
      const checkout = path.join(sandbox, '_work', 'repo', 'repo');
      fs.mkdirSync(path.join(checkout, 'data'), { recursive: true });
      const staged = path.join(base, 'staged', 'repo', 'repo');
      fs.mkdirSync(path.join(staged, 'data'), { recursive: true });
      const real = { sandboxDir: sandbox, workspaceRoot: checkout, realpath: (p: string) => p, lstat: undefined };
      const policy: DockerPolicy = { run: { images: ['postgres:16'], mounts: [{ path: './', mode: 'rw' }], network: 'bridge' } };
      const bind = { Image: 'postgres:16', HostConfig: { Binds: [`${checkout}/data:/d`] } };

      expect(create(bind, ctx(policy, real)).allowed).toBe(true);
      // A workspace outside the sandbox directory leaves nothing to walk down
      // from, so nothing in it is permitted.
      const elsewhere = path.join(base, 'elsewhere');
      fs.mkdirSync(elsewhere);
      expect(create(bind, ctx(policy, { ...real, sandboxDir: elsewhere })).allowed).toBe(false);

      fs.renameSync(path.join(sandbox, '_work'), path.join(sandbox, '_work.x'));
      fs.symlinkSync(path.join(base, 'staged'), path.join(sandbox, '_work'));
      const v = create(bind, ctx(policy, real));
      expect(v.allowed).toBe(false);
      expect(v.reason).toMatch(/symlink/);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('refuses undeclared image and registry; permits declared ones', () => {
    expect(create({ Image: 'redis:7' }).allowed).toBe(false);
    expect(create({ Image: 'postgres:16' }).allowed).toBe(true);
    const pullCtx = ctx({ pull: { registries: ['docker.io'] } });
    expect(evaluateDockerRequest(mk('POST', '/v1.45/images/create?fromImage=ghcr.io%2Ffoo&tag=1'), pullCtx).allowed).toBe(false);
    expect(evaluateDockerRequest(mk('POST', '/v1.45/images/create?fromImage=postgres&tag=16'), pullCtx).allowed).toBe(true);
  });

  it('refuses an undeclared mount, and permits a declared one at or below its mode', () => {
    const p: DockerPolicy = { run: { images: ['postgres:16'], mounts: [{ path: './', mode: 'ro' }, { path: './tmp/fixtures', mode: 'rw' }], network: 'bridge' } };
    const c = ctx(p);
    expect(create({ Image: 'postgres:16', HostConfig: { Binds: ['/ws:/src:ro'] } }, c).allowed).toBe(true);
    expect(create({ Image: 'postgres:16', HostConfig: { Binds: ['/ws/lib:/src:ro'] } }, c).allowed).toBe(true); // below a declared ro path
    expect(create({ Image: 'postgres:16', HostConfig: { Binds: ['/ws:/src'] } }, c).allowed).toBe(false); // rw where only ro is declared
    expect(create({ Image: 'postgres:16', HostConfig: { Binds: ['/ws/tmp/fixtures:/f'] } }, c).allowed).toBe(true);
    expect(create({ Image: 'postgres:16', HostConfig: { Binds: ['/ws/tmp/fixtures:/f:ro'] } }, c).allowed).toBe(true);
    expect(create({ Image: 'postgres:16', HostConfig: { Mounts: [{ Type: 'bind', Source: '/ws/tmp/fixtures', Target: '/f' }] } }, c).allowed).toBe(true);
    expect(create({ Image: 'postgres:16', HostConfig: { Mounts: [{ Type: 'bind', Source: '/ws', Target: '/src', ReadOnly: true }] } }, c).allowed).toBe(true);
    expect(create({ Image: 'postgres:16', HostConfig: { Mounts: [{ Type: 'bind', Source: '/ws', Target: '/src' }] } }, c).allowed).toBe(false);
    const undeclared = ctx({ run: { images: ['postgres:16'], network: 'bridge' } });
    expect(create({ Image: 'postgres:16', HostConfig: { Binds: ['/ws:/src:ro'] } }, undeclared).allowed).toBe(false);
  });

  it('refuses shared mount propagation and unknown bind options', () => {
    expect(create({ Image: 'postgres:16', HostConfig: { Binds: ['/ws:/src:ro,rshared'] } }).allowed).toBe(false);
    expect(create({ Image: 'postgres:16', HostConfig: { Binds: ['/ws:/src:ro,frobnicate'] } }).allowed).toBe(false);
    expect(create({ Image: 'postgres:16', HostConfig: { Mounts: [{ Type: 'bind', Source: '/ws', Target: '/src', ReadOnly: true, BindOptions: { Propagation: 'rshared' } }] } }).allowed).toBe(false);
    expect(create({ Image: 'postgres:16', HostConfig: { Binds: ['/ws:/src:ro,z,cached,rprivate'] } }).allowed).toBe(true);
  });

  it('refuses named volumes and non-bind mount types, since the policy cannot name them; permits tmpfs and anonymous volumes', () => {
    expect(create({ Image: 'postgres:16', HostConfig: { Binds: ['pgdata:/var/lib/postgresql/data'] } }).allowed).toBe(false);
    expect(create({ Image: 'postgres:16', HostConfig: { Mounts: [{ Type: 'volume', Source: 'pgdata', Target: '/data' }] } }).allowed).toBe(false);
    expect(create({ Image: 'postgres:16', HostConfig: { Mounts: [{ Type: 'image', Source: 'alpine', Target: '/data' }] } }).allowed).toBe(false);
    expect(create({ Image: 'postgres:16', HostConfig: { Mounts: [{ Type: 'tmpfs', Target: '/run' }] } }).allowed).toBe(true);
    expect(create({ Image: 'postgres:16', HostConfig: { Mounts: [{ Type: 'volume', Target: '/data' }] } }).allowed).toBe(true);
  });

  it('checks the network mode against the declaration, and never permits host', () => {
    expect(create({ Image: 'postgres:16', HostConfig: { NetworkMode: 'bridge' } }).allowed).toBe(true);
    expect(create({ Image: 'postgres:16', HostConfig: { NetworkMode: 'none' } }).allowed).toBe(true); // tighter is always fine
    expect(create({ Image: 'postgres:16', HostConfig: { NetworkMode: 'mynet' } }).allowed).toBe(false);
    const undeclared = ctx({ run: { images: ['postgres:16'] } });
    const v = create({ Image: 'postgres:16' }, undeclared);
    expect(v.allowed).toBe(false);
    expect(v.policyHint).toMatch(/network: "bridge"/);
    const hostDeclared = ctx({ run: { images: ['postgres:16'], network: 'host' } });
    expect(create({ Image: 'postgres:16', HostConfig: { NetworkMode: 'host' } }, hostDeclared).allowed).toBe(false);
  });

  it('matches an image by its normalized reference', () => {
    expect(create({ Image: 'docker.io/library/postgres:16' }).allowed).toBe(true);
    expect(create({ Image: 'postgres' }).allowed).toBe(false); // :latest is not :16
    const bare = ctx({ run: { images: ['alpine'], network: 'bridge' } });
    expect(create({ Image: 'alpine:latest' }, bare).allowed).toBe(true);
    expect(create({ Image: 'alpine:3.20' }, bare).allowed).toBe(false);
    const digest = 'postgres@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    expect(create({ Image: digest }, ctx({ run: { images: [digest], network: 'bridge' } })).allowed).toBe(true);
  });

  it('reads the pull registry the way the daemon does', () => {
    const pull = (fromImage: string, registries: string[]) =>
      evaluateDockerRequest(mk('POST', `/v1.45/images/create?fromImage=${encodeURIComponent(fromImage)}`), ctx({ pull: { registries } }));
    expect(pull('library/postgres', ['docker.io']).allowed).toBe(true);
    expect(pull('index.docker.io/library/postgres', ['docker.io']).allowed).toBe(true);
    expect(pull('localhost:5000/app', ['docker.io']).allowed).toBe(false);
    expect(pull('localhost:5000/app', ['localhost:5000']).allowed).toBe(true);
    expect(pull('ghcr.io/owner/app:1', ['ghcr.io']).allowed).toBe(true);
    expect(pull('myregistry:5000/postgres:16', ['docker.io']).allowed).toBe(false);
    // distribution/reference reads a first component with an uppercase letter
    // as a registry host, never a Docker Hub namespace: `LOCALHOST/x` pulls
    // from the daemon's loopback, and `Evil/x` from a host named Evil.
    expect(pull('Evil/x', ['docker.io']).allowed).toBe(false);
    expect(pull('LOCALHOST/x', ['docker.io']).allowed).toBe(false);
    expect(pull('0X7F000001/x', ['docker.io']).allowed).toBe(false);
    expect(pull('LOCALHOST/x', ['LOCALHOST']).allowed).toBe(true);
    // Lowercase namespaces are still Docker Hub's.
    expect(pull('owner/app', ['docker.io']).allowed).toBe(true);
  });

  it('refuses a query another daemon\'s decoder could read differently', () => {
    // Podman decodes the query with gorilla/schema, which keeps the last value
    // of a repeated key and reads past a ";" or a bad escape: each of these is
    // a pull of evil.example.com/x there, judged here as postgres.
    const c = ctx({ pull: { registries: ['docker.io'] } });
    for (const url of [
      '/v1.45/images/create?fromImage=postgres&fromImage=evil.example.com%2Fx',
      '/v1.45/images/create?fromImage=postgres;&fromImage=evil.example.com%2Fx',
      '/v1.45/images/create?fromImage=postgres%zz&fromImage=evil.example.com%2Fx',
      '/v1.45/images/create?fromImage=postgres&FROMIMAGE=evil.example.com%2Fx',
    ]) {
      const v = evaluateDockerRequest(mk('POST', url), c);
      expect(v.allowed).toBe(false);
    }
    // Refused whatever the action: the baseline is no exception.
    expect(evaluateDockerRequest(mk('GET', '/v1.45/version?a=1&a=2'), c).allowed).toBe(false);
    expect(evaluateDockerRequest(mk('POST', '/v1.45/images/create?fromImage=postgres&tag=16'), c).allowed).toBe(true);
  });

  it('refuses a pull tag that is not a tag or a digest, since Podman appends it to fromImage', () => {
    // Podman's compat pull joins fromImage and tag with ":" (mergeNameAndTagOrDigest),
    // so a tag with a slash in it turns the image's name into a registry host:
    // `localhost` + `5000/x` is localhost:5000/x, pulled on the docker.io
    // credential this filter attached for `localhost`. Podman matches `TAG` too.
    const c = ctx({ pull: { registries: ['docker.io'] } });
    for (const query of [
      'fromImage=localhost&tag=5000%2Fx',
      'fromImage=evil.example.com&TAG=443%2Fx',
      'fromImage=evil.example.com&Tag=443%2Fx',
      'fromImage=postgres&tag=16%40sha256%3A0123456789abcdef0123456789abcdef',
      'fromImage=postgres&tag=-16',
      'fromImage=postgres&tag=16%3A1',
      `fromImage=postgres&tag=${'a'.repeat(129)}`,
    ]) {
      const url = `/v1.45/images/create?${query}`;
      expect([url, evaluateDockerRequest(mk('POST', url), c).allowed]).toEqual([url, false]);
    }
    // A tag, a digest, or no tag at all is what every client sends.
    const hex = '0123456789abcdef'.repeat(4);
    for (const query of [
      'fromImage=postgres',
      'fromImage=postgres&tag=',
      'fromImage=postgres&tag=latest',
      'fromImage=postgres&tag=v1.2.3',
      'fromImage=postgres&tag=16_alpine-3.20',
      `fromImage=postgres&tag=sha256%3A${hex}`,
      `fromImage=postgres&tag=${'a'.repeat(128)}`,
      'fromImage=localhost&tag=5000',
    ]) {
      const url = `/v1.45/images/create?${query}`;
      expect([url, evaluateDockerRequest(mk('POST', url), c).allowed]).toEqual([url, true]);
    }
  });

  it('refuses a pull that is an import, or names no image', () => {
    const c = ctx({ pull: { registries: ['docker.io'] } });
    expect(evaluateDockerRequest(mk('POST', '/v1.45/images/create?fromSrc=http%3A%2F%2Fevil%2Fimg.tar'), c).allowed).toBe(false);
    expect(evaluateDockerRequest(mk('POST', '/v1.45/images/create?fromImage=postgres&fromSrc=-'), c).allowed).toBe(false);
    expect(evaluateDockerRequest(mk('POST', '/v1.45/images/create'), c).allowed).toBe(false);
  });

  it('refuses an import however fromSrc is cased, since Podman matches the name in any case', () => {
    const c = ctx({ pull: { registries: ['docker.io'] } });
    for (const key of ['FROMSRC', 'fromsrc', 'FromSrc']) {
      const url = `/v1.45/images/create?fromImage=postgres&${key}=-`;
      expect([url, evaluateDockerRequest(mk('POST', url), c).allowed]).toEqual([url, false]);
    }
  });

  it('rejects privileged even when declared, unless the backend supports it', () => {
    const v = create({ Image: 'postgres:16', HostConfig: { Privileged: true } },
      { policy: { run: { images: ['postgres:16'], network: 'bridge' }, privileged: true }, sandboxDir: '/ws', workspaceRoot: '/ws', supportsPrivileged: false, realpath: (p) => p });
    expect(v.allowed).toBe(false);
    expect(v.reason).toBe("privileged containers are not granted: they reach the Docker VM's kernel");
    const unsupportedUndeclared = create({ Image: 'postgres:16', HostConfig: { Privileged: true } },
      { policy: { run: { images: ['postgres:16'], network: 'bridge' } }, sandboxDir: '/ws', workspaceRoot: '/ws', supportsPrivileged: false, realpath: (p) => p });
    expect(unsupportedUndeclared.reason).toBe("privileged containers are not granted: they reach the Docker VM's kernel");
    expect(unsupportedUndeclared.policyHint).toBeUndefined();
    const vm = create({ Image: 'postgres:16', HostConfig: { Privileged: true } },
      { policy: { run: { images: ['postgres:16'], network: 'bridge' }, privileged: true }, sandboxDir: '/ws', workspaceRoot: '/ws', supportsPrivileged: true, realpath: (p) => p });
    expect(vm.allowed).toBe(true);
    const undeclared = create({ Image: 'postgres:16', HostConfig: { Privileged: true } },
      { policy: { run: { images: ['postgres:16'], network: 'bridge' } }, sandboxDir: '/ws', workspaceRoot: '/ws', supportsPrivileged: true, realpath: (p) => p });
    expect(undeclared.allowed).toBe(false);
    expect(undeclared.policyHint).toMatch(/privileged: true/);
  });

  it('gates build on the build action and refuses a remote context', () => {
    expect(evaluateDockerRequest(mk('POST', '/v1.45/build?t=app'), ctx(runPolicy)).allowed).toBe(false);
    const b = ctx({ build: { context: './' } });
    expect(evaluateDockerRequest(mk('POST', '/v1.45/build?t=app'), b).allowed).toBe(true);
    expect(evaluateDockerRequest(mk('POST', '/v1.45/build?t=app&remote=https%3A%2F%2Fexample.com%2Frepo.git'), b).allowed).toBe(false);
    expect(evaluateDockerRequest(mk('POST', '/v1.45/build?t=app&remote=%2Fetc'), b).allowed).toBe(false);
  });

  it('fails closed on an unknown endpoint and a malformed body', () => {
    expect(evaluateDockerRequest(mk('POST', '/v1.45/networks/create', { Name: 'x' }), ctx(runPolicy)).allowed).toBe(false);
    expect(evaluateDockerRequest(mk('POST', '/v1.45/containers/abc/exec', { Cmd: ['sh'] }), ctx(runPolicy)).allowed).toBe(false);
    const bad = parseDockerRequest({ method: 'POST', url: '/v1.45/containers/create', headers: { 'content-type': 'application/json' }, body: Buffer.from('{not json') });
    expect(evaluateDockerRequest(bad, ctx(runPolicy)).allowed).toBe(false);
    const nobody = parseDockerRequest({ method: 'POST', url: '/v1.45/containers/create', headers: {}, body: Buffer.alloc(0) });
    expect(evaluateDockerRequest(nobody, ctx(runPolicy)).allowed).toBe(false);
    const wrongType = parseDockerRequest({ method: 'POST', url: '/v1.45/containers/create', headers: { 'content-type': 'text/plain' }, body: Buffer.from('{"Image":"postgres:16"}') });
    expect(evaluateDockerRequest(wrongType, ctx(runPolicy)).allowed).toBe(false);
    expect(create({ Image: 'postgres:16', HostConfig: 'yes' }).allowed).toBe(false);
    expect(create({ Image: 42 }).allowed).toBe(false);
    expect(create(['postgres:16']).allowed).toBe(false);
  });

  it('provides a policy hint naming what would permit a denied request', () => {
    const v = create({ Image: 'redis:7' });
    expect(v.policyHint).toMatch(/run:\s*\n?\s*images/);
    expect(v.policyHint).toContain('"redis:7"');
    const mount = create({ Image: 'postgres:16', HostConfig: { Binds: ['/ws/tmp/fixtures:/f'] } });
    expect(mount.policyHint).toMatch(/mounts:\s*\n\s*- path: "\.\/tmp\/fixtures"\s*\n\s*mode: rw/);
    const pull = evaluateDockerRequest(mk('POST', '/v1.45/images/create?fromImage=ghcr.io%2Ffoo&tag=1'), ctx({ pull: { registries: ['docker.io'] } }));
    expect(pull.policyHint).toMatch(/pull:\s*\n\s*registries:\s*\n\s*- ghcr\.io/);
    const build = evaluateDockerRequest(mk('POST', '/v1.45/build'), ctx({}));
    expect(build.policyHint).toMatch(/build:/);
  });
});

describe('verb-to-endpoint mapping', () => {
  it('maps each run sub-verb to the run policy', () => {
    // Owned: this test is about the verb-to-policy mapping, not about
    // ownership, which is asserted separately.
    const p = ctx({ run: { images: ['postgres:16'] } }, ['abc']);
    for (const [m, u] of [['POST', '/v1.45/containers/abc/start'], ['POST', '/v1.45/containers/abc/attach?stream=1'], ['POST', '/v1.45/containers/abc/wait'], ['DELETE', '/v1.45/containers/abc?v=1']] as const) {
      expect(evaluateDockerRequest(mk(m, u), p).allowed).toBe(true);
    }
    // ...and denies them when run is absent
    const none = ctx({ pull: { registries: ['docker.io'] } });
    const v = evaluateDockerRequest(mk('POST', '/v1.45/containers/abc/start'), none);
    expect(v.allowed).toBe(false);
    expect(v.policyHint).toMatch(/run:/);
    expect(evaluateDockerRequest(mk('DELETE', '/v1.45/containers/abc'), none).allowed).toBe(false);
  });

  it('maps pull to the pull policy and build to the build policy, not to run', () => {
    const runOnly = ctx({ run: { images: ['postgres:16'], network: 'bridge' } });
    expect(evaluateDockerRequest(mk('POST', '/v1.45/images/create?fromImage=postgres&tag=16'), runOnly).allowed).toBe(false);
    expect(evaluateDockerRequest(mk('POST', '/v1.45/build'), runOnly).allowed).toBe(false);
    const pullOnly = ctx({ pull: { registries: ['docker.io'] } });
    expect(evaluateDockerRequest(mk('POST', '/v1.45/containers/create', { Image: 'postgres:16' }), pullOnly).allowed).toBe(false);
  });
});

describe('policy hints', () => {
  // The hint is what --updaterc writes, so it has to be the policy that would
  // have permitted the request - no more, no less - in the shape the parser reads.
  it('name exactly the policy that permits the denied request, in the shape --updaterc reads', () => {
    const cases: Array<{ req: DockerRequest; policy: DockerPolicy }> = [
      { req: mk('POST', '/v1.45/containers/create', { Image: 'redis:7' }), policy: { run: { network: 'bridge' } } },
      { req: mk('POST', '/v1.45/containers/create', { Image: 'redis:7' }), policy: { run: { images: ['redis:7'] } } },
      { req: mk('POST', '/v1.45/containers/create', { Image: 'postgres:16', HostConfig: { Binds: ['/ws/tmp/fixtures:/f'] } }), policy: { run: { images: ['postgres:16'], network: 'bridge' } } },
      { req: mk('POST', '/v1.45/containers/create', { Image: 'postgres:16', HostConfig: { NetworkMode: 'ci-net' } }), policy: { run: { images: ['postgres:16'], network: 'bridge' } } },
      { req: mk('POST', '/v1.45/images/create?fromImage=ghcr.io%2Ffoo&tag=1'), policy: { pull: { registries: ['docker.io'] } } },
      { req: mk('POST', '/v1.45/images/create?fromImage=postgres&tag=16'), policy: {} },
      { req: mk('POST', '/v1.45/build'), policy: {} },
      { req: mk('POST', '/v1.45/containers/abc/start'), policy: { pull: { registries: ['docker.io'] } } },
    ];
    for (const { req, policy } of cases) {
      // Owned throughout: a hint names the POLICY that would permit a request,
      // and ownership is a separate gate no policy key can grant.
      const denied = evaluateDockerRequest(req, ctx(policy, ['abc']));
      expect([req.raw.url, denied.allowed]).toEqual([req.raw.url, false]);
      const hinted = parseDockerPolicyHint(denied.policyHint ?? '');
      expect([req.raw.url, hinted]).not.toEqual([req.raw.url, undefined]);
      const permitted = evaluateDockerRequest(req, ctx(mergeDockerPolicy(policy, hinted) ?? {}, ['abc']));
      expect([req.raw.url, permitted.allowed]).toEqual([req.raw.url, true]);
    }
  });
});

describe('Go case-insensitive JSON decoding', () => {
  // The daemon decodes the create body with Go's encoding/json, which matches
  // struct fields case-insensitively as a documented fallback. So a key the
  // filter reads as absent is honoured by the daemon: every HostConfig gate is
  // bypassed by changing one letter.
  const p = { run: { images: ['postgres:16'], mounts: [{ path: './', mode: 'ro' as const }], network: 'bridge' } };

  it('refuses a lowercased HostConfig carrying privileged and a root bind', () => {
    const v = evaluateDockerRequest(
      mk('POST', '/v1.45/containers/create', {
        Image: 'postgres:16',
        hostconfig: { privileged: true, binds: ['/:/host:rw'], pidmode: 'host' },
      }),
      ctx(p)
    );
    expect(v.allowed).toBe(false);
  });

  it('refuses odd casings of the gated keys inside a correctly-cased HostConfig', () => {
    for (const hostConfig of [
      { Privileged: true },
      { PRIVILEGED: true },
      { privileged: true },
      { BINDS: ['/etc:/x'] },
      { binds: ['/etc:/x'] },
      { networkmode: 'host' },
      { NETWORKMODE: 'host' },
      { pidMode: 'host' },
      { devices: [{ PathOnHost: '/dev/kmsg' }] },
    ]) {
      const v = evaluateDockerRequest(
        mk('POST', '/v1.45/containers/create', { Image: 'postgres:16', HostConfig: hostConfig }),
        ctx(p)
      );
      expect([JSON.stringify(hostConfig), v.allowed]).toEqual([JSON.stringify(hostConfig), false]);
    }
  });

  it('still permits a correctly-cased create the policy allows', () => {
    expect(evaluateDockerRequest(mk('POST', '/v1.45/containers/create', { Image: 'postgres:16' }), ctx(p)).allowed).toBe(true);
  });
});

describe('kill, stop and logs on the job\'s own container', () => {
  const p = { run: { images: ['postgres:16'], network: 'bridge' } };

  it('permits them on an owned container and refuses them on one it did not create', () => {
    const own = ctx(p, ['mine123']);
    for (const [method, tpl] of [
      ['POST', '/v1.45/containers/%s/kill'],
      ['POST', '/v1.45/containers/%s/stop'],
      ['GET', '/v1.45/containers/%s/logs?stdout=1&stderr=1'],
    ] as const) {
      expect([tpl, evaluateDockerRequest(mk(method, tpl.replace('%s', 'mine123')), own).allowed]).toEqual([tpl, true]);
      expect([tpl, evaluateDockerRequest(mk(method, tpl.replace('%s', 'theirs999')), own).allowed]).toEqual([tpl, false]);
    }
  });

  it('refuses kill and stop when the policy declares no run action', () => {
    const noRun = ctx({ pull: { registries: ['docker.io'] } }, ['mine123']);
    expect(evaluateDockerRequest(mk('POST', '/v1.45/containers/mine123/kill'), noRun).allowed).toBe(false);
    expect(evaluateDockerRequest(mk('POST', '/v1.45/containers/mine123/stop'), noRun).allowed).toBe(false);
  });
});

describe('volume mounts that are really bind mounts', () => {
  const p = { run: { images: ['postgres:16'], mounts: [{ path: './', mode: 'ro' as const }], network: 'bridge' } };

  it('refuses an anonymous volume whose local-driver options bind a host path', () => {
    // The local driver with type=none,o=bind,device=<path> IS a bind mount -
    // the same thing compose exposes as driver_opts. The entry has no Source,
    // so it looked like container-lifecycle storage and skipped every check.
    const v = evaluateDockerRequest(
      mk('POST', '/v1.45/containers/create', {
        Image: 'postgres:16',
        HostConfig: {
          Mounts: [{
            Type: 'volume',
            Target: '/host',
            VolumeOptions: { DriverConfig: { Name: 'local', Options: { type: 'none', o: 'bind', device: '/Users/me/.ssh' } } },
          }],
        },
      }),
      ctx(p)
    );
    expect(v.allowed).toBe(false);
  });

  it('refuses it whatever the casing of the driver keys', () => {
    const v = evaluateDockerRequest(
      mk('POST', '/v1.45/containers/create', {
        Image: 'postgres:16',
        HostConfig: { Mounts: [{ type: 'volume', target: '/host', volumeoptions: { driverconfig: { Name: 'local', Options: { device: '/' } } } }] },
      }),
      ctx(p)
    );
    expect(v.allowed).toBe(false);
  });

  it('still permits a plain anonymous volume and a tmpfs, which reach no host path', () => {
    for (const m of [{ Type: 'volume', Target: '/data' }, { Type: 'tmpfs', Target: '/tmp' }]) {
      expect([m.Type, evaluateDockerRequest(mk('POST', '/v1.45/containers/create', { Image: 'postgres:16', HostConfig: { Mounts: [m] } }), ctx(p)).allowed])
        .toEqual([m.Type, true]);
    }
  });
});

describe('HostConfig is an allowlist, not a blocklist', () => {
  const p = { run: { images: ['postgres:16'], mounts: [{ path: './', mode: 'ro' as const }], network: 'bridge' } };
  const create = (hostConfig: Record<string, unknown>) =>
    evaluateDockerRequest(mk('POST', '/v1.45/containers/create', { Image: 'postgres:16', HostConfig: hostConfig }), ctx(p));

  it('refuses publishing container ports onto the operator host', () => {
    // -p 8080:80. Nothing in the grammar can name it, and it exposes a
    // service on the operator's interfaces, outside the proxy's egress control.
    expect(create({ PortBindings: { '80/tcp': [{ HostPort: '8080' }] } }).allowed).toBe(false);
    expect(create({ PublishAllPorts: true }).allowed).toBe(false);
  });

  it('refuses any HostConfig key the grammar cannot name, even one invented later', () => {
    for (const key of ['StorageOpt', 'SomeFutureEscape', 'Anything', 'NextApiVersionKey']) {
      expect([key, create({ [key]: ['x'] }).allowed]).toEqual([key, false]);
    }
  });

  it('refuses the keys that only reach outside the container when non-empty', () => {
    expect(create({ Links: ['other:db'] }).allowed).toBe(false);
    expect(create({ VolumeDriver: 'local' }).allowed).toBe(false);
    expect(create({ ExtraHosts: ['evil:1.2.3.4'] }).allowed).toBe(false);
    expect(create({ GroupAdd: ['staff'] }).allowed).toBe(false);
    expect(create({ Cgroup: '/other' }).allowed).toBe(false);
  });

  it('refuses a --cidfile that would write to a host path, while allowing the empty default', () => {
    expect(create({ ContainerIDFile: '/tmp/pwned.cid' }).allowed).toBe(false);
    expect(create({ ContainerIDFile: '' }).allowed).toBe(true);
  });

  it('refuses a restart policy that would outlive the job', () => {
    // docker run -d --restart=always: the daemon brings the container back
    // after the job ends, and again after the daemon itself restarts.
    for (const name of ['always', 'unless-stopped', 'on-failure']) {
      const verdict = create({ RestartPolicy: { Name: name, MaximumRetryCount: 0 } });
      expect([name, verdict.allowed]).toEqual([name, false]);
      expect(verdict.reason).toMatch(/--restart/);
    }
    expect(create({ RestartPolicy: { Name: 'on-failure', MaximumRetryCount: 3 } }).allowed).toBe(false);
    // Any casing of either key, since the daemon decodes both case-insensitively.
    expect(create({ restartpolicy: { Name: 'always' } }).allowed).toBe(false);
    expect(create({ RestartPolicy: { name: 'unless-stopped' } }).allowed).toBe(false);
    // A shape the filter cannot read is not one it can vouch for.
    expect(create({ RestartPolicy: 'always' }).allowed).toBe(false);
    expect(create({ RestartPolicy: { Name: 'no', SomeFutureKey: 'always' } }).allowed).toBe(false);
    // What the CLI sends when no --restart is given: "no", or "" from older ones.
    expect(create({ RestartPolicy: { Name: 'no', MaximumRetryCount: 0 } }).allowed).toBe(true);
    expect(create({ RestartPolicy: { Name: '', MaximumRetryCount: 0 } }).allowed).toBe(true);
    expect(create({ RestartPolicy: {} }).allowed).toBe(true);
  });

  it('still permits the keys a plain docker run actually sends', () => {
    expect(create({}).allowed).toBe(true);
    expect(create({ AutoRemove: true, NetworkMode: 'bridge', Binds: [], RestartPolicy: { Name: '', MaximumRetryCount: 0 }, LogConfig: { Type: '', Config: {} }, ConsoleSize: [0, 0] }).allowed).toBe(true);
  });
});

describe('build query parameters', () => {
  const p = { run: { images: ['postgres:16'], network: 'bridge' }, build: { context: './' } };
  const build = (qs: string, policy: DockerPolicy = p) =>
    evaluateDockerRequest(mk('POST', `/v1.45/build${qs}`), ctx(policy));

  it('refuses host and container networking, which the run path already forbids', () => {
    expect(build('?networkmode=host').allowed).toBe(false);
    expect(build('?networkmode=container%3Aabc').allowed).toBe(false);
  });

  it('judges the build network however its name is cased, since Podman matches it in any case', () => {
    for (const qs of ['?NETWORKMODE=host', '?networkMode=host', '?Networkmode=host', '?NetworkMode=container%3Aabc', '?NETWORKMODE=some-other-net']) {
      expect([qs, build(qs).allowed]).toEqual([qs, false]);
    }
    expect(build('?NETWORKMODE=bridge').allowed).toBe(true);
  });

  it('refuses an undeclared build network, and permits the declared one', () => {
    expect(build('?networkmode=some-other-net').allowed).toBe(false);
    expect(build('?networkmode=bridge').allowed).toBe(true);
    expect(build('?networkmode=none').allowed).toBe(true);
  });

  it('refuses build parameters that reach the host or the daemon config', () => {
    for (const qs of ['?remote=https%3A%2F%2Fevil%2Fctx', '?extrahosts=evil%3A1.2.3.4', '?cachefrom=%5B%22other%3Alatest%22%5D', '?ulimits=x', '?securityopt=seccomp%3Dunconfined', '?outputs=type%3Dlocal%2Cdest%3D%2Ftmp']) {
      expect([qs, build(qs).allowed]).toEqual([qs, false]);
    }
  });

  it('permits the parameters an ordinary docker build sends', () => {
    expect(build('?t=app%3Alatest&dockerfile=Dockerfile&rm=1&buildargs=%7B%7D&labels=%7B%7D&shmsize=0&version=1').allowed).toBe(true);
  });
});

describe('networks', () => {
  const p: DockerPolicy = { run: { images: ['alpine:3'], network: 'bridge', networks: [{ name: 'vk-*', internal: true }] } };
  const create = (body: unknown, c = ctx(p)) => evaluateDockerRequest(mk('POST', '/v1.45/networks/create', body), c);

  it('permits creating a declared internal network', () => {
    expect(create({ Name: 'vk-run1', Internal: true, CheckDuplicate: true }).allowed).toBe(true);
  });

  it('refuses a name no declaration matches, anchoring the glob', () => {
    expect(create({ Name: 'other', Internal: true }).allowed).toBe(false);
    expect(create({ Name: 'not-vk-run1', Internal: true }).allowed).toBe(false);
  });

  it('refuses a routable network where the declaration says internal', () => {
    expect(create({ Name: 'vk-run1', Internal: false }).allowed).toBe(false);
    expect(create({ Name: 'vk-run1' }).allowed).toBe(false);
  });

  it('refuses any create key the grammar cannot spell, driver above all', () => {
    for (const extra of [{ Driver: 'macvlan' }, { Options: { parent: 'en0' } }, { IPAM: { Config: [{ Subnet: '10.0.0.0/8' }] } }, { Attachable: true }, { Ingress: true }, { ConfigOnly: true }]) {
      const body = { Name: 'vk-run1', Internal: true, ...extra };
      expect([Object.keys(extra)[0], create(body).allowed]).toEqual([Object.keys(extra)[0], false]);
    }
    // The default driver, stated explicitly, is the one the filter would use anyway.
    expect(create({ Name: 'vk-run1', Internal: true, Driver: 'bridge' }).allowed).toBe(true);
  });

  it('never lists the daemon\'s networks', () => {
    expect(evaluateDockerRequest(mk('GET', '/v1.45/networks'), ctx(p)).allowed).toBe(false);
  });

  it('scopes reading and deleting a network to ones this socket created', () => {
    const own = ctx(p, { ownNetworkIds: new Set(['net123']) });
    expect(evaluateDockerRequest(mk('GET', '/v1.45/networks/net123'), own).allowed).toBe(true);
    expect(evaluateDockerRequest(mk('DELETE', '/v1.45/networks/net123'), own).allowed).toBe(true);
    expect(evaluateDockerRequest(mk('GET', '/v1.45/networks/theirs'), own).allowed).toBe(false);
    expect(evaluateDockerRequest(mk('DELETE', '/v1.45/networks/theirs'), own).allowed).toBe(false);
  });

  it('lets a container join a network this job created, which is the point of declaring one', () => {
    const own = ctx(p, { ownNetworkIds: new Set(['vk-run1']) });
    const body = { Image: 'alpine:3', HostConfig: { NetworkMode: 'vk-run1' } };
    expect(evaluateDockerRequest(mk('POST', '/v1.45/containers/create', body), own).allowed).toBe(true);
    // An arbitrary network the job did not create is still refused.
    const other = { Image: 'alpine:3', HostConfig: { NetworkMode: 'someone-elses' } };
    expect(evaluateDockerRequest(mk('POST', '/v1.45/containers/create', other), own).allowed).toBe(false);
  });
});

describe('image inspect', () => {
  const p: DockerPolicy = { run: { images: ['alpine:3', 'ghcr.io/o/app:1'], network: 'bridge' }, pull: { registries: ['docker.io'] } };
  const inspect = (ref: string, c = ctx(p)) =>
    evaluateDockerRequest(mk('GET', `/v1.45/images/${encodeURIComponent(ref)}/json`), c);

  it('permits inspecting an image the policy already names', () => {
    // Scoped by the policy rather than by a second ownership ledger: an
    // inspect of an image run.images already grants discloses nothing new.
    expect(inspect('alpine:3').allowed).toBe(true);
    expect(inspect('docker.io/library/alpine:3').allowed).toBe(true);
    expect(inspect('ghcr.io/o/app:1').allowed).toBe(true);
  });

  it('refuses an image the policy does not name', () => {
    expect(inspect('postgres:16').allowed).toBe(false);
    expect(inspect('ghcr.io/o/other:1').allowed).toBe(false);
  });

  it('refuses it when the policy declares no run action at all', () => {
    expect(inspect('alpine:3', ctx({ pull: { registries: ['docker.io'] } })).allowed).toBe(false);
  });

  it('never lists or deletes images, which are daemon-wide', () => {
    expect(evaluateDockerRequest(mk('GET', '/v1.45/images/json'), ctx(p)).allowed).toBe(false);
    expect(evaluateDockerRequest(mk('DELETE', '/v1.45/images/alpine:3'), ctx(p)).allowed).toBe(false);
  });
});

describe('network create as the real CLI sends it', () => {
  const p: DockerPolicy = { run: { images: ['alpine:3'], network: 'bridge', networks: [{ name: 'vk-*', internal: true }] } };
  // Captured off the wire from docker CLI 29.3.1. Every one of these keys is
  // sent unconditionally, with an inert default.
  const cliBody = (over: Record<string, unknown> = {}) => ({
    Name: 'vk-probe-net', Driver: 'bridge', Scope: '',
    IPAM: { Driver: 'default', Options: {}, Config: [] },
    Internal: true, Attachable: false, Ingress: false, ConfigOnly: false,
    ConfigFrom: null, Options: {}, Labels: {}, ...over,
  });
  const create = (body: unknown, c = ctx(p)) => evaluateDockerRequest(mk('POST', '/v1.45/networks/create', body), c);

  it('permits what `docker network create --internal` actually sends', () => {
    expect(create(cliBody()).allowed).toBe(true);
  });

  it('still refuses those same keys when they carry a meaningful value', () => {
    for (const over of [
      { Scope: 'swarm' },
      { IPAM: { Driver: 'default', Options: {}, Config: [{ Subnet: '10.0.0.0/8' }] } },
      { IPAM: { Driver: 'macvlan', Options: {}, Config: [] } },
      { IPAM: { Driver: 'default', Options: { parent: 'en0' }, Config: [] } },
      { Attachable: true }, { Ingress: true }, { ConfigOnly: true },
      { ConfigFrom: { Network: 'other' } },
      { Options: { 'com.docker.network.bridge.host_binding_ipv4': '0.0.0.0' } },
      { EnableIPv6: true },
    ]) {
      expect([Object.keys(over)[0], create(cliBody(over)).allowed]).toEqual([Object.keys(over)[0], false]);
    }
  });

  it('is fail-closed when casings disagree, as Go would decode them', () => {
    // Go matches struct fields case-insensitively, so a second casing with a
    // different value may be the one the daemon honours.
    expect(create({ ...cliBody(), internal: false }).allowed).toBe(false);
    expect(create({ ...cliBody(), name: 'not-declared' }).allowed).toBe(false);
    expect(create({ ...cliBody(), driver: 'macvlan' }).allowed).toBe(false);
  });
});

describe('image globs', () => {
  // A content-addressed tag cannot be known when the policy is written.
  const p: DockerPolicy = { run: { images: ['vk/grader:*', 'alpine:3'], network: 'bridge' } };

  it('permits creating and inspecting an image matching a declared glob', () => {
    const body = { Image: 'vk/grader:7f2-0123456789ab' };
    expect(evaluateDockerRequest(mk('POST', '/v1.45/containers/create', body), ctx(p)).allowed).toBe(true);
    expect(evaluateDockerRequest(mk('GET', '/v1.45/images/vk%2Fgrader%3A7f2-0123456789ab/json'), ctx(p)).allowed).toBe(true);
  });

  it('anchors the glob, so a lookalike repository does not match', () => {
    for (const image of ['evil/vk/grader:x', 'notvk/grader:x', 'vk/grader-evil:x']) {
      expect([image, evaluateDockerRequest(mk('POST', '/v1.45/containers/create', { Image: image }), ctx(p)).allowed])
        .toEqual([image, false]);
    }
  });

  it('leaves an exact declaration exact', () => {
    expect(evaluateDockerRequest(mk('POST', '/v1.45/containers/create', { Image: 'alpine:3' }), ctx(p)).allowed).toBe(true);
    expect(evaluateDockerRequest(mk('POST', '/v1.45/containers/create', { Image: 'alpine:4' }), ctx(p)).allowed).toBe(false);
  });
});

describe('what * spans in a declared glob', () => {
  const withImages = (images: string[]) => ctx({ run: { images, network: 'bridge' } });
  const create = (image: string, images: string[]) =>
    evaluateDockerRequest(mk('POST', '/v1.45/containers/create', { Image: image }), withImages(images)).allowed;

  it('spans a tag but not a path separator', () => {
    // The spec left this open. Decided here: `*` stops at `/`, so a declared
    // repository cannot be widened into deeper paths by a reference that adds
    // segments. A tag glob - the content-addressed case - is unaffected,
    // because a tag cannot contain a slash.
    expect(create('vk/grader:7f2-0123456789ab', ['vk/grader:*'])).toBe(true);
    expect(create('vk/grader:a/b', ['vk/grader:*'])).toBe(false);
  });

  it('still anchors, so a lookalike repository never matches', () => {
    expect(create('evil/vk/grader:x', ['vk/grader:*'])).toBe(false);
  });

  it('needs a segment of its own to span one', () => {
    // `vk/*:*` reaches one level under vk, and no further.
    expect(create('vk/app:1', ['vk/*:*'])).toBe(true);
    expect(create('vk/team/app:1', ['vk/*:*'])).toBe(false);
  });

  it('is bounded by the tag too, which is why a tagless glob is refused upstream', () => {
    // Normalisation appends :latest to a tagless reference on both sides, so a
    // tagless glob is matched as `vk/*:latest` - it covers latest and nothing
    // else, however wide it reads. validateDockerPolicy rejects the form for
    // that reason; this pins the behaviour the rejection exists to prevent.
    expect(create('vk/app', ['vk/*'])).toBe(true);
    expect(create('vk/app:1', ['vk/*'])).toBe(false);
    expect(create('vk/app:1', ['vk/*:*'])).toBe(true);
  });
});

describe('inspecting the network the policy declares', () => {
  // Reading a declared network's gateway is read-only and discloses nothing a
  // job cannot already reach: it is on that network. Refusing it meant
  // `docker network inspect bridge` returned nothing for a job whose policy
  // says `network: bridge`, which reads as a broken daemon rather than policy.
  const p: DockerPolicy = { run: { images: ['alpine:3'], network: 'bridge', networks: [{ name: 'vk-*', internal: true }] } };

  it('refuses it, because the response names every container on that network', () => {
    // This was briefly allowed as a convenience: a job is on the network, so
    // reading its gateway looks harmless. The response carries a Containers
    // map with the names and addresses of everything attached - on a shared
    // network, other jobs' containers and the operator's own. Nothing in the
    // policy grants that, and the job cannot otherwise see it.
    expect(evaluateDockerRequest(mk('GET', '/v1.45/networks/bridge'), ctx(p)).allowed).toBe(false);
  });

  it('still refuses a network that is neither declared nor created here', () => {
    const v = evaluateDockerRequest(mk('GET', '/v1.45/networks/someone-elses'), ctx(p));
    expect(v.allowed).toBe(false);
    expect(v.reason).toMatch(/was not created through this job/);
  });

  it('does not turn inspect into a way to delete it', () => {
    expect(evaluateDockerRequest(mk('DELETE', '/v1.45/networks/bridge'), ctx(p)).allowed).toBe(false);
  });

  it('grants nothing when the policy declares no network', () => {
    const bare: DockerPolicy = { run: { images: ['alpine:3'] } };
    expect(evaluateDockerRequest(mk('GET', '/v1.45/networks/bridge'), ctx(bare)).allowed).toBe(false);
  });
});

describe('BuildKit endpoints', () => {
  const p: DockerPolicy = { run: { images: ['alpine:3'], network: 'bridge' }, build: { context: './' } };

  it('refuses a BuildKit session, and says why rather than shrugging', () => {
    // A real `docker build` on a default install issues zero POST /build: it
    // negotiates a session and streams over /grpc. Denying it generically read
    // as "unknown endpoint" when the real answer is "that builder cannot be
    // filtered, and we pinned you off it".
    for (const url of ['/v1.45/grpc', '/v1.45/session']) {
      const v = evaluateDockerRequest(mk('POST', url), ctx(p));
      expect([url, v.allowed]).toEqual([url, false]);
      expect(v.reason).toMatch(/BuildKit/i);
      expect(v.reason).toMatch(/DOCKER_BUILDKIT/);
    }
  });

  it('still permits the classic build the policy describes', () => {
    expect(evaluateDockerRequest(mk('POST', '/v1.45/build?t=app%3A1'), ctx(p)).allowed).toBe(true);
  });
});

describe('duplicate keys that differ only in case', () => {
  const runPolicy: DockerPolicy = { run: { images: ['alpine:3'], network: 'bridge' } };

  it('refuses a body carrying two casings of the same key, rather than guessing which one counts', () => {
    // Measured against a real daemon: with `HostConfig`, `hostconfig` and
    // `HOSTCONFIG` all present, Go's decoder MERGED all three into one struct
    // (AutoRemove from the first, Memory from the second, OomScoreAdj from the
    // third). Scalars and arrays inside one object are last-wins instead.
    // No filter can read one of those objects and know what the daemon will
    // do, and picking the last is as wrong as picking the first - the merge
    // keeps fields from both. Go's encoder never emits case-variant duplicates,
    // so a body containing them is not a client we model.
    const v = evaluateDockerRequest(
      mk('POST', '/v1.45/containers/create', {
        Image: 'alpine:3',
        HostConfig: { NetworkMode: 'bridge' },
        hostconfig: { Binds: ['/etc:/host-etc'] },
      }),
      ctx(runPolicy)
    );
    expect(v.allowed).toBe(false);
    expect(v.reason).toMatch(/case/i);
    expect(v.reason).toMatch(/HostConfig|hostconfig/);
  });

  it('finds them however deep they are nested', () => {
    const v = evaluateDockerRequest(
      mk('POST', '/v1.45/containers/create', {
        Image: 'alpine:3',
        HostConfig: { NetworkMode: 'bridge', Mounts: [{ Type: 'bind', Source: '/ws', type: 'tmpfs' }] },
      }),
      ctx(runPolicy)
    );
    expect(v.allowed).toBe(false);
    expect(v.reason).toMatch(/case/i);
  });

  it('leaves an ordinary body alone, including keys that merely resemble each other', () => {
    const v = evaluateDockerRequest(
      mk('POST', '/v1.45/containers/create', {
        Image: 'alpine:3',
        HostConfig: { NetworkMode: 'bridge', Memory: 0, MemorySwap: 0, Binds: [] },
      }),
      ctx(runPolicy)
    );
    expect(v.allowed).toBe(true);
  });

  it('applies to every action with a body, not just create', () => {
    const p: DockerPolicy = { run: { images: ['alpine:3'], network: 'bridge', networks: [{ name: 'vk-1', internal: true }] } };
    const v = evaluateDockerRequest(
      mk('POST', '/v1.45/networks/create', { Name: 'vk-1', Internal: true, internal: false }),
      ctx(p)
    );
    expect(v.allowed).toBe(false);
    expect(v.reason).toMatch(/case/i);
  });
});

describe('networks attached by NetworkingConfig rather than NetworkMode', () => {
  // A container can join a network two ways at create: HostConfig.NetworkMode,
  // which was checked, and NetworkingConfig.EndpointsConfig, which was not -
  // so the ownership rule could be walked around by naming the network in the
  // other field. Joining another job's internal network, or any network the
  // operator created, reaches whatever that network reaches.
  const p: DockerPolicy = { run: { images: ['alpine:3'], network: 'bridge', networks: [{ name: 'vk-*', internal: true }] } };
  const create = (body: unknown, c = ctx(p)) => evaluateDockerRequest(mk('POST', '/v1.45/containers/create', body), c);

  it('refuses an endpoint naming a network the job neither declared nor created', () => {
    const v = create({
      Image: 'alpine:3',
      HostConfig: { NetworkMode: 'bridge' },
      NetworkingConfig: { EndpointsConfig: { 'someone-elses-net': {} } },
    });
    expect(v.allowed).toBe(false);
    expect(v.reason).toMatch(/someone-elses-net/);
  });

  it('permits an endpoint naming a network this job created, which is the dual-homed case', () => {
    // A broker container bridging a sealed network to a routable one joins
    // both: NetworkMode for one, EndpointsConfig for the other.
    const owned = ctx(p, { ownNetworkIds: new Set(['vk-1']) });
    const v = create({
      Image: 'alpine:3',
      HostConfig: { NetworkMode: 'bridge' },
      NetworkingConfig: { EndpointsConfig: { 'vk-1': {} } },
    }, owned);
    expect(v.allowed).toBe(true);
  });

  it('refuses an endpoint whose NetworkID names a different network than its key', () => {
    // Security review: the key was the only part checked, but moby's
    // getNetworkID returns epConfig.NetworkID over the key whenever the key is
    // a user-defined network, and FindNetwork takes a name, id or id prefix.
    // So an owned key with a foreign NetworkID joined the foreign network.
    const owned = ctx(p, { ownNetworkIds: new Set(['vk-1']) });
    const v = create({
      Image: 'alpine:3',
      HostConfig: { NetworkMode: 'vk-1' },
      NetworkingConfig: { EndpointsConfig: { 'vk-1': { NetworkID: 'someone-elses-net' } } },
    }, owned);
    expect(v.allowed).toBe(false);
    expect(v.reason).toMatch(/NetworkID/);
  });

  it('refuses it in any casing, since the daemon decodes keys case-insensitively', () => {
    const owned = ctx(p, { ownNetworkIds: new Set(['vk-1']) });
    const v = create({
      Image: 'alpine:3',
      HostConfig: { NetworkMode: 'vk-1' },
      NetworkingConfig: { EndpointsConfig: { 'vk-1': { networkid: 'abc123' } } },
    }, owned);
    expect(v.allowed).toBe(false);
  });

  it('allows the empty NetworkID the CLI sends, and a NetworkID naming the key itself', () => {
    const owned = ctx(p, { ownNetworkIds: new Set(['vk-1']) });
    for (const NetworkID of ['', 'vk-1']) {
      expect(create({
        Image: 'alpine:3',
        HostConfig: { NetworkMode: 'vk-1' },
        NetworkingConfig: { EndpointsConfig: { 'vk-1': { NetworkID } } },
      }, owned).allowed).toBe(true);
    }
  });

  it('refuses an endpoint value that is not an object', () => {
    const v = create({ Image: 'alpine:3', NetworkingConfig: { EndpointsConfig: { bridge: 'x' } } });
    expect(v.allowed).toBe(false);
  });

  it('permits "default", which is what the real CLI sends for an ordinary docker run', () => {
    // Captured from the wire: `docker run --rm -v ... alpine:3` sends
    // NetworkingConfig.EndpointsConfig {"default": {}}. Judging that name
    // literally refused every container the CLI creates.
    expect(create({ Image: 'alpine:3', NetworkingConfig: { EndpointsConfig: { default: {} } } }).allowed).toBe(true);
    expect(create({ Image: 'alpine:3', NetworkingConfig: { EndpointsConfig: { '': {} } } }).allowed).toBe(true);
  });

  it('permits the declared network, and an absent or empty NetworkingConfig', () => {
    expect(create({ Image: 'alpine:3', NetworkingConfig: { EndpointsConfig: { bridge: {} } } }).allowed).toBe(true);
    expect(create({ Image: 'alpine:3', NetworkingConfig: {} }).allowed).toBe(true);
    expect(create({ Image: 'alpine:3' }).allowed).toBe(true);
  });

  it('is not fooled by casing, since the daemon reads these keys case-insensitively', () => {
    const v = create({
      Image: 'alpine:3',
      networkingconfig: { endpointsconfig: { 'someone-elses-net': {} } },
    });
    expect(v.allowed).toBe(false);
  });
});

describe('host networking is refused whatever the case', () => {
  // The daemon may treat a case variant of a special mode as host; the policy
  // validator would accept a declared network named "HOST", so the special-mode
  // check must be case-insensitive or a container could reach the host network.
  const runPolicy: DockerPolicy = { run: { images: ['postgres:16'], network: 'bridge' }, build: {} };
  const create = (body: unknown) =>
    evaluateDockerRequest(mk('POST', '/v1.45/containers/create', body), ctx(runPolicy));

  it('refuses HostConfig.NetworkMode "HOST"', () => {
    const v = create({ Image: 'postgres:16', HostConfig: { NetworkMode: 'HOST' } });
    expect(v.allowed).toBe(false);
    expect(v.reason).toMatch(/reaches the host/i);
  });

  it('refuses an EndpointsConfig key "Host"', () => {
    const v = create({ Image: 'postgres:16', NetworkingConfig: { EndpointsConfig: { Host: {} } } });
    expect(v.allowed).toBe(false);
    expect(v.reason).toMatch(/reaches the host/i);
  });

  it('refuses the build networkmode query param "Host"', () => {
    const v = evaluateDockerRequest(mk('POST', '/v1.45/build?networkmode=Host'), ctx(runPolicy));
    expect(v.allowed).toBe(false);
    expect(v.reason).toMatch(/reaches the host/i);
  });
});

describe('keys the daemon would read as other keys', () => {
  // Go's encoding/json matches a key to a struct field under Unicode simple
  // folding, not just ASCII case: U+017F (long s) reads as s and U+212A
  // (Kelvin sign) as k, escaped or not (checked against go1.25.1). A key the
  // filter reads as some unknown key, the daemon can read as HostConfig. Every
  // key the CLI sends is plain ASCII, so any other key is refused.
  const LONG_S = '\u017f';
  const KELVIN = '\u212a';
  const runPolicy: DockerPolicy = { run: { images: ['postgres:16'], mounts: [{ path: './', mode: 'ro' }], network: 'bridge' } };
  const create = (body: unknown) => evaluateDockerRequest(mk('POST', '/v1.45/containers/create', body), ctx(runPolicy));
  const raw = (method: string, url: string, json: string) =>
    parseDockerRequest({ method, url, headers: { 'content-type': 'application/json' }, body: Buffer.from(json) });

  it('refuses a HostConfig spelled with a long s, whatever it carries', () => {
    const hostConfig = `Ho${LONG_S}tConfig`;
    for (const carried of [
      { Privileged: true },
      { Binds: ['/:/host'] },
      { Mounts: [{ Type: 'bind', Source: '/', Target: '/host' }] },
    ]) {
      const v = create({ Image: 'postgres:16', [hostConfig]: carried });
      expect([JSON.stringify(carried), v.allowed]).toEqual([JSON.stringify(carried), false]);
      expect(v.reason).toMatch(/ASCII/);
      // Named escaped, so the refusal does not show a key that passes for HostConfig.
      expect(v.reason).toContain('"Ho\\u017ftConfig"');
    }
  });

  it('refuses the same key when the long s arrives as a JSON escape', () => {
    const v = evaluateDockerRequest(
      raw('POST', '/v1.45/containers/create', '{"Image":"postgres:16","Ho\\u017ftConfig":{"Privileged":true}}'),
      ctx(runPolicy)
    );
    expect(v.allowed).toBe(false);
    expect(v.reason).toMatch(/ASCII/);
  });

  // The first three were refused before the ASCII rule too - the NetworkingConfig
  // case fold (JS lowercases the Kelvin sign to k) and the HostConfig allowlist
  // caught them - so for those the rows pin only the reason. The last two
  // reached the daemon.
  it.each<[string, unknown]>([
    // A second NetworkingConfig the daemon reads, joining the host network.
    ['NetworkingConfig with a Kelvin sign', { Image: 'postgres:16', [`Networ${KELVIN}ingConfig`]: { EndpointsConfig: { host: {} } } }],
    ['HostConfig.Binds with a long s', { Image: 'postgres:16', HostConfig: { [`Bind${LONG_S}`]: ['/:/host'] } }],
    ['HostConfig.Privileged with a long s', { Image: 'postgres:16', HostConfig: { [`Privi${LONG_S}eged`]: true } }],
    // A declared read-only mount, with a propagation the filter never reads
    // and the daemon honours.
    ['Mounts[].BindOptions with a long s', {
      Image: 'postgres:16',
      HostConfig: {
        Mounts: [{ Type: 'bind', Source: '/ws', Target: '/x', ReadOnly: true, [`BindOption${LONG_S}`]: { Propagation: 'rshared' } }],
      },
    }],
    // Judged as a tmpfs. Go assigns fields in key order and keeps the last
    // value, so the daemon reads Type as "bind": a bind of the host's root.
    ['Mounts[].Type with a long s, after Type', {
      Image: 'postgres:16',
      HostConfig: { Mounts: [{ Type: 'tmpfs', Target: '/x', [`Ty${LONG_S}e`]: 'bind', Source: '/' }] },
    }],
  ])('refuses such a key at depth: %s', (_name, body) => {
    const v = create(body);
    expect(v.allowed).toBe(false);
    expect(v.reason).toMatch(/ASCII/);
  });

  it('names where in the body the key is', () => {
    const v = create({ Image: 'postgres:16', HostConfig: { Mounts: [{ Type: 'tmpfs', Target: '/x', [`Ty${LONG_S}e`]: 'bind' }] } });
    expect(v.reason).toMatch(/^the request body at HostConfig\.Mounts\[0\] has a key "Ty\\u017fe"/);
  });

  it('refuses a body nested deeper than any the daemon takes, rather than overflowing the stack', () => {
    // JSON.parse takes this in its stride; a recursive walk of it does not.
    const depth = 100_000;
    const json = '{"a":'.repeat(depth) + '1' + '}'.repeat(depth);
    const v = evaluateDockerRequest(raw('POST', '/v1.45/containers/create', json), ctx(runPolicy));
    expect(v.allowed).toBe(false);
    expect(v.reason).toMatch(/nested more than \d+ levels/);
    // A body as deep as a real one still passes the walk.
    expect(create({
      Image: 'postgres:16',
      HostConfig: { Mounts: [{ Type: 'volume', Target: '/x', VolumeOptions: { DriverConfig: { Options: { a: 'b' } } } }] },
    }).reason ?? '').not.toMatch(/nested/);
  });

  it('refuses such a key in a network create body, including inside IPAM', () => {
    const p: DockerPolicy = { run: { images: ['alpine:3'], network: 'bridge', networks: [{ name: 'vk-*', internal: true }] } };
    const v = evaluateDockerRequest(
      mk('POST', '/v1.45/networks/create', {
        Name: 'vk-1', Internal: true,
        IPAM: { Driver: 'default', Config: [], [`Option${LONG_S}`]: { 'com.example': 'x' } },
      }),
      ctx(p)
    );
    expect(v.allowed).toBe(false);
    expect(v.reason).toMatch(/ASCII/);
  });

  it('refuses a query parameter whose name is not plain ASCII', () => {
    const p: DockerPolicy = { run: { images: ['postgres:16'], network: 'bridge' }, pull: { registries: ['docker.io'] } };
    const v = evaluateDockerRequest(mk('POST', `/v1.45/images/create?fromImage=postgres&tag=16&from${LONG_S}rc=x`), ctx(p));
    expect(v.allowed).toBe(false);
    expect(v.reason).toMatch(/ASCII/);
  });

  it('still permits what the real CLI sends, whatever the values say', () => {
    // The plain `docker run` keys, and NetworkingConfig as the CLI fills it.
    // Values are not keys: an accented label value or env var passes.
    expect(create({
      Image: 'postgres:16',
      Env: ['K=v\u00e9'],
      Labels: { purpose: 'caf\u00e9' },
      HostConfig: {
        AutoRemove: true, NetworkMode: 'bridge', Binds: [],
        RestartPolicy: { Name: '', MaximumRetryCount: 0 }, LogConfig: { Type: '', Config: {} }, ConsoleSize: [0, 0],
      },
      NetworkingConfig: { EndpointsConfig: { default: {} } },
    }).allowed).toBe(true);
    // Captured from docker CLI 29.3.1 `docker network create --internal`.
    const p: DockerPolicy = { run: { images: ['alpine:3'], network: 'bridge', networks: [{ name: 'vk-*', internal: true }] } };
    expect(evaluateDockerRequest(mk('POST', '/v1.45/networks/create', {
      Name: 'vk-probe-net', Driver: 'bridge', Scope: '',
      IPAM: { Driver: 'default', Options: {}, Config: [] },
      Internal: true, Attachable: false, Ingress: false, ConfigOnly: false,
      ConfigFrom: null, Options: {}, Labels: {},
    }), ctx(p)).allowed).toBe(true);
    const pull: DockerPolicy = { pull: { registries: ['docker.io'] } };
    expect(evaluateDockerRequest(mk('POST', '/v1.45/images/create?fromImage=postgres&tag=16'), ctx(pull)).allowed).toBe(true);
  });
});

describe('bodies the daemon reads as a form', () => {
  // Go's net/http reads parameters from an application/x-www-form-urlencoded
  // or multipart/form-data body as well as from the URL, and FormValue prefers
  // the body's. Moby's image-create and build handlers read theirs that way,
  // from a body the filter streams through unread.
  const withType = (method: string, url: string, contentType: string | undefined, body = '') =>
    parseDockerRequest({
      method, url,
      headers: contentType === undefined ? {} : { 'content-type': contentType },
      body: Buffer.from(body),
    });
  const p: DockerPolicy = {
    run: { images: ['postgres:16'], network: 'bridge' }, pull: { registries: ['docker.io'] }, build: { context: './' },
  };

  it.each([
    ['application/x-www-form-urlencoded'],
    ['Application/X-WWW-Form-Urlencoded ; charset=utf-8'],
    ['multipart/form-data; boundary=x'],
    ['application/octet-stream'],
  ])('refuses a pull whose body is sent as %s', (contentType) => {
    const v = evaluateDockerRequest(
      withType('POST', '/v1.45/images/create?fromImage=postgres&tag=16', contentType, 'fromImage=evil.example.com%2Fx'),
      ctx(p)
    );
    expect(v.allowed).toBe(false);
    expect(v.reason).toMatch(/content type/i);
  });

  it('refuses a build whose parameters could come from a form body', () => {
    for (const contentType of ['application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
      const v = evaluateDockerRequest(withType('POST', '/v1.45/build?t=app', contentType, 'networkmode=host'), ctx(p));
      expect([contentType, v.allowed]).toEqual([contentType, false]);
    }
  });

  it('refuses a create that is not sent as JSON', () => {
    const v = evaluateDockerRequest(
      withType('POST', '/v1.45/containers/create', 'application/x-www-form-urlencoded', 'Image=postgres%3A16'),
      ctx(p)
    );
    expect(v.allowed).toBe(false);
    expect(v.reason).toMatch(/content type/i);
  });

  it('permits the types the real clients send', () => {
    // Captured from docker CLI 29.1.3: a pull, start, wait and stop carry no
    // type; attach carries text/plain; a build carries application/x-tar.
    const allowed = (req: DockerRequest, c = ctx(p, ['abc'])) => evaluateDockerRequest(req, c).allowed;
    expect(allowed(withType('POST', '/v1.45/images/create?fromImage=postgres&tag=16', undefined))).toBe(true);
    expect(allowed(withType('POST', '/v1.45/images/create?fromImage=postgres&tag=16', 'text/plain'))).toBe(true);
    expect(allowed(withType('POST', '/v1.45/containers/abc/attach?stream=1', 'text/plain'))).toBe(true);
    expect(allowed(withType('POST', '/v1.45/containers/abc/start', undefined))).toBe(true);
    expect(allowed(withType('POST', '/v1.45/build?t=app', 'application/x-tar', 'tar'))).toBe(true);
    expect(allowed(withType('POST', '/v1.45/build?t=app', 'application/tar', 'tar'))).toBe(true);
    expect(allowed(withType('POST', '/v1.45/containers/create', 'application/json; charset=utf-8', '{"Image":"postgres:16"}'))).toBe(true);
  });
});

describe('the binds an allowed create approves for the VM', () => {
  // Every bind the filter lets through is reported to the guest agent, which
  // lm-bindpin checks each share-backed mount against before the container
  // starts. Both sides normalise the same way (contract §3.7): the source is
  // the pinned host path, byte for byte; the destination is cleaned; readOnly
  // comes from the mode. These are the vectors of the Go side's
  // guest/internal/mountinfo/testdata/binds.json, spelled as create bodies.
  const policy: DockerPolicy = {
    run: { images: ['alpine:3'], mounts: [{ path: './', mode: 'rw' }], network: 'bridge' },
  };
  const create = (hostConfig: Record<string, unknown>, c: DockerEvalContext = ctx(policy)) =>
    evaluateDockerRequest(mk('POST', '/v1.45/containers/create', { Image: 'alpine:3', HostConfig: hostConfig }), c);

  const vectors: Array<{
    name: string;
    hostConfig: Record<string, unknown>;
    binds: Array<{ source: string; destination: string; readOnly: boolean }>;
  }> = [
    {
      name: 'a plain bind is approved read-write at its destination',
      hostConfig: { Binds: ['/ws/data:/data'] },
      binds: [{ source: '/ws/data', destination: '/data', readOnly: false }],
    },
    {
      name: "ro in a bind's options makes it read-only, among other options",
      hostConfig: { Binds: ['/ws/data:/data:z,ro'] },
      binds: [{ source: '/ws/data', destination: '/data', readOnly: true }],
    },
    {
      name: 'a trailing slash on the destination is dropped, as dockerd drops it',
      hostConfig: { Binds: ['/ws/data:/data/'] },
      binds: [{ source: '/ws/data', destination: '/data', readOnly: false }],
    },
    {
      name: 'a doubled slash and a dot in the destination are cleaned',
      hostConfig: { Binds: ['/ws/data:/srv//app/./x'] },
      binds: [{ source: '/ws/data', destination: '/srv/app/x', readOnly: false }],
    },
    {
      name: 'a destination of / itself stays /',
      hostConfig: { Binds: ['/ws/data:/'] },
      binds: [{ source: '/ws/data', destination: '/', readOnly: false }],
    },
    {
      name: 'a Mounts entry is approved from its Source, Target and ReadOnly',
      hostConfig: { Mounts: [{ Type: 'bind', Source: '/ws/data', Target: '/d/', ReadOnly: true }] },
      binds: [{ source: '/ws/data', destination: '/d', readOnly: true }],
    },
    {
      name: 'the same source twice at two destinations is two approvals',
      hostConfig: { Binds: ['/ws/data:/a:ro', '/ws/data:/b'] },
      binds: [
        { source: '/ws/data', destination: '/a', readOnly: true },
        { source: '/ws/data', destination: '/b', readOnly: false },
      ],
    },
    {
      name: 'tmpfs and anonymous volumes are not binds, and approve nothing',
      hostConfig: { Mounts: [{ Type: 'tmpfs', Target: '/run' }, { Type: 'volume', Target: '/v' }] },
      binds: [],
    },
  ];

  it.each(vectors)('$name', ({ hostConfig, binds }) => {
    const verdict = create(hostConfig);
    expect(verdict.allowed).toBe(true);
    expect(verdict.approvedBinds).toEqual(binds);
  });

  it('is empty for a create with no mounts at all', () => {
    const verdict = evaluateDockerRequest(mk('POST', '/v1.45/containers/create', { Image: 'alpine:3' }), ctx(policy));
    expect(verdict.allowed).toBe(true);
    expect(verdict.approvedBinds).toEqual([]);
  });

  it('approves the pinned source the daemon is sent, never the spelling the job used', () => {
    // A source reached through a link inside the workspace is pinned to where
    // it resolves, and that pinned path is what the hook must see.
    const c = ctx(policy, { realpath: (p: string) => (p === '/ws/link' ? '/ws/real' : p) });
    const verdict = create({ Binds: ['/ws/link:/data:ro'] }, c);
    expect(verdict.allowed).toBe(true);
    expect(verdict.approvedBinds).toEqual([{ source: '/ws/real', destination: '/data', readOnly: true }]);
    const body = verdict.rewrittenBody as { HostConfig: { Binds: string[] } };
    expect(body.HostConfig.Binds).toEqual(['/ws/real:/data:ro']);
  });

  it('refuses a relative destination, which no approval could match', () => {
    for (const hostConfig of [
      { Binds: ['/ws/data:data'] },
      { Binds: ['/ws/data:./data:ro'] },
      { Mounts: [{ Type: 'bind', Source: '/ws/data', Target: 'data' }] },
      { Mounts: [{ Type: 'bind', Source: '/ws/data' }] },
    ]) {
      const verdict = create(hostConfig);
      expect([hostConfig, verdict.allowed]).toEqual([hostConfig, false]);
      expect(verdict.reason).toMatch(/destination/);
    }
  });

  it('refuses two binds to one destination, as dockerd does, however it is spelled', () => {
    for (const hostConfig of [
      { Binds: ['/ws/a:/data', '/ws/b:/data'] },
      { Binds: ['/ws/a:/data', '/ws/b:/data/'] },
      { Binds: ['/ws/a:/data:ro'], Mounts: [{ Type: 'bind', Source: '/ws/b', Target: '//data' }] },
    ]) {
      const verdict = create(hostConfig);
      expect([hostConfig, verdict.allowed]).toEqual([hostConfig, false]);
      expect(verdict.reason).toMatch(/more than one mount/);
    }
  });

  it('approves nothing on a refused create', () => {
    const verdict = create({ Binds: ['/Users/me/.ssh:/ssh'] });
    expect(verdict.allowed).toBe(false);
    expect(verdict.approvedBinds).toBeUndefined();
  });
});

describe('pullRequestOf: what the worker pulls on the Mac', () => {
  const hex = 'a'.repeat(64);

  it('reads a name, a tag and a digest as the daemon does', () => {
    expect(pullRequestOf({ fromImage: 'postgres', tag: '16' })).toEqual({ registry: 'docker.io', repositoryPath: 'library/postgres', tag: '16' });
    expect(pullRequestOf({ fromImage: `ghcr.io/owner/app@sha256:${hex}` })).toEqual({
      registry: 'ghcr.io', repositoryPath: 'owner/app', digest: `sha256:${hex}`,
    });
    expect(pullRequestOf({ fromImage: 'alpine', tag: `sha256:${hex}` })).toEqual({
      registry: 'docker.io', repositoryPath: 'library/alpine', digest: `sha256:${hex}`,
    });
  });

  it('ignores a tag written before a digest, as the docker CLI does', () => {
    expect(pullRequestOf({ fromImage: `alpine:3.20@sha256:${hex}` })).toEqual({
      registry: 'docker.io', repositoryPath: 'library/alpine', digest: `sha256:${hex}`,
    });
    expect(pullRequestOf({ fromImage: `localhost:5000/team/app:1@sha256:${hex}` })).toEqual({
      registry: 'localhost:5000', repositoryPath: 'team/app', digest: `sha256:${hex}`,
    });
  });

  it('refuses every digest but a lower-case sha256 one, from the name or the tag parameter', () => {
    // A digest from the job is outside input that the Mac-side store builds
    // paths from; only the one form contract §1 allows reaches it.
    for (const digest of [`sha256:${'A'.repeat(64)}`, `sha512:${'a'.repeat(128)}`, `sha256:${'a'.repeat(32)}`, `sha256:${'a'.repeat(65)}`]) {
      const queries: Array<Record<string, string>> = [{ fromImage: `alpine@${digest}` }, { fromImage: 'alpine', tag: digest }];
      for (const query of queries) {
        const result = pullRequestOf(query);
        expect([digest, typeof result === 'string' && result.includes('only sha256 digests can be pulled')]).toEqual([digest, true]);
      }
    }
  });

  it('passes the platforms the VM runs, and refuses any other', () => {
    for (const platform of ['linux/arm64', 'linux/amd64', 'linux/arm64/v8', 'Linux/AMD64']) {
      expect(pullRequestOf({ fromImage: 'alpine', platform })).toMatchObject({ platform: platform.toLowerCase() });
    }
    expect(pullRequestOf({ fromImage: 'alpine', platform: '' })).not.toHaveProperty('platform');
    for (const platform of ['windows/amd64', 'linux/riscv64', 'linux/arm64/v8/x', 'linux/arm64/../../x', 'linux/arm64\u001b[2J', 'x'.repeat(300)]) {
      const result = pullRequestOf({ fromImage: 'alpine', platform });
      expect([platform, typeof result === 'string' && result.startsWith("localmost's Docker VM runs linux/arm64 and linux/amd64 images, not ")]).toEqual([platform, true]);
      expect((result as string).length).toBeLessThan(200);
      expect(result).not.toContain('\u001b');
    }
  });
});
