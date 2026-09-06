/**
 * The SECURITY.md escapes as executable tests, run against the evaluator.
 *
 * Profile assertions cannot prove a filter works. Each case here is a request
 * a job could make through its docker socket, and the verdict it must get.
 */

import { describe, it, expect } from '@jest/globals';
import { evaluateDockerRequest, DockerEvalContext } from './docker-evaluator';
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
  return { policy, workspaceRoot: '/ws', supportsPrivileged: false, realpath: (p: string) => p, ...extra };
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
