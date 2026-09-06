/**
 * The SECURITY.md escapes as executable tests, run against the evaluator.
 *
 * Profile assertions cannot prove a filter works. Each case here is a request
 * a job could make through its docker socket, and the verdict it must get.
 */

import { describe, it, expect } from '@jest/globals';
import { evaluateDockerRequest, DockerEvalContext } from './docker-evaluator';
import { parseDockerRequest } from './docker-request';
import { DockerPolicy } from '../../shared/docker-policy';

const mk = (method: string, url: string, body?: unknown) => parseDockerRequest({
  method, url, headers: body ? { 'content-type': 'application/json' } : {},
  body: body ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0),
});
const ctx = (policy: DockerPolicy | null, extra: Partial<DockerEvalContext> = {}): DockerEvalContext => ({
  policy, workspaceRoot: '/ws', supportsPrivileged: false, realpath: (p: string) => p, ...extra,
});

describe('evaluateDockerRequest', () => {
  it('permits the always-on baseline with no declaration', () => {
    for (const u of ['/v1.45/_ping', '/v1.45/version', '/v1.45/info']) {
      expect(evaluateDockerRequest(mk('GET', u), ctx({})).allowed).toBe(true);
    }
  });

  it('permits reads about containers as part of the baseline, even before a policy is bound', () => {
    expect(evaluateDockerRequest(mk('GET', '/v1.45/containers/json'), ctx(null)).allowed).toBe(true);
    expect(evaluateDockerRequest(mk('GET', '/v1.45/containers/abc/json'), ctx(null)).allowed).toBe(true);
    expect(evaluateDockerRequest(mk('GET', '/v1.45/_ping'), ctx(null)).allowed).toBe(true);
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
    expect(v.policyHint).toMatch(/network: bridge/);
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
  });

  it('refuses a pull that is an import, or names no image', () => {
    const c = ctx({ pull: { registries: ['docker.io'] } });
    expect(evaluateDockerRequest(mk('POST', '/v1.45/images/create?fromSrc=http%3A%2F%2Fevil%2Fimg.tar'), c).allowed).toBe(false);
    expect(evaluateDockerRequest(mk('POST', '/v1.45/images/create?fromImage=postgres&fromSrc=-'), c).allowed).toBe(false);
    expect(evaluateDockerRequest(mk('POST', '/v1.45/images/create'), c).allowed).toBe(false);
  });

  it('rejects privileged even when declared, unless the backend supports it', () => {
    const v = create({ Image: 'postgres:16', HostConfig: { Privileged: true } },
      { policy: { run: { images: ['postgres:16'], network: 'bridge' }, privileged: true }, workspaceRoot: '/ws', supportsPrivileged: false, realpath: (p) => p });
    expect(v.allowed).toBe(false);
    expect(v.reason).toMatch(/managed VM/i);
    const vm = create({ Image: 'postgres:16', HostConfig: { Privileged: true } },
      { policy: { run: { images: ['postgres:16'], network: 'bridge' }, privileged: true }, workspaceRoot: '/ws', supportsPrivileged: true, realpath: (p) => p });
    expect(vm.allowed).toBe(true);
    const undeclared = create({ Image: 'postgres:16', HostConfig: { Privileged: true } },
      { policy: { run: { images: ['postgres:16'], network: 'bridge' } }, workspaceRoot: '/ws', supportsPrivileged: true, realpath: (p) => p });
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
    const p = ctx({ run: { images: ['postgres:16'] } });
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
