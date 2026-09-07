# Docker Isolation — Owning the Socket, Then the Daemon

A filtering Docker socket that localmost owns, so container work is subject to
repository policy instead of escaping it.

> **Status:** design. Supersedes the access model in
> `docs/roadmap/docker-access.md`, which remains accurate for 0.3.0 as shipped.

## Problem

`docker:` as shipped in 0.3.0 is an honest description of a sandbox escape. The
job is handed the operator's real daemon socket, and the design says plainly what
follows ([docs/roadmap/docker-access.md](../../roadmap/docker-access.md)):

> For anything it does through a container, nothing.

Three consequences follow from handing over the raw socket:

1. **Host paths are reachable.** A container can bind-mount any path Docker
   Desktop shares — `/Users` by default — including paths the policy denies.
   `docker run -v ~/.ssh:/host-ssh alpine ls /host-ssh` is the documented case.
2. **Network policy is bypassed.** Container egress does not pass through the
   job's proxy, so the `network.allow` list does not apply to it.
3. **Granularity is stuck.** `docker:` is legal only in `shared:`, because the
   seatbelt profile is built at spawn, before the workflow is known. A
   `workflows:` entry is a validation error rather than a setting.

The level enum also leaks credentials by construction: `credentials` works by
letting the job read `~/.docker/config.json`, so the job sees registry secrets in
order to use them.

## Solution

localmost stops handing out the daemon socket and starts serving one.

Each worker gets its own unix socket, created by the app outside the sandbox,
inside that worker's ephemeral directory. `DOCKER_HOST` points the job at it. A
filtering proxy behind that socket parses every Docker API request, checks it
against the repository's approved policy, and forwards only what is permitted to
a backend daemon.

Because localmost owns the socket, three things become true at once: host reach
is decided per request rather than granted wholesale, policy can vary per
workflow because the socket is bound to a policy when the job is claimed, and the
daemon behind the socket becomes a swappable implementation detail.

### The progression

Each stage moves the trust boundary one layer down. Each is shippable alone, and
each adds controls the previous stage cannot express.

| Stage | We own | Boundary | Adds |
|---|---|---|---|
| 1 | The socket | The filter | Per-request mount, image, network and capability control; per-workflow policy; credentials never enter the sandbox |
| 2 | The daemon | A VM whose only mount is the workspace | Containment when the filter is wrong; container egress control; `privileged` becomes grantable |
| 3 | The runtime | A VM per container | Per-container isolation, Apple-maintained |

Stage 1 is the whole of this spec's implementation. Stage 2 is designed for and
seamed but not built. Stage 3 is documented as a backend that becomes viable if a
Docker-API implementation over Apple's Containerization framework stabilizes; we
do not write that implementation ourselves.

## Architecture

### The socket lives in the worker's ephemeral directory

The sandbox directory is rebuilt per job by `buildSandbox`
([src/main/runner-manager.ts](../../../src/main/runner-manager.ts)), so a socket
placed inside it is created and destroyed with the job. No shared runtime
directory accumulates stale sockets, and no cleanup path has to be maintained.

Isolation between jobs is a consequence of the filesystem policy rather than a
new rule: another worker's directory is denied by the profile, so another
worker's socket is unreachable. Seatbelt is the enforcement — filesystem
permissions are not, since every worker runs as the same user.

The socket sits in a subdirectory the profile grants `network-outbound` and
`file-read*` on while denying `file-write*`, so the job cannot unlink the socket
and bind its own in its place. The blast radius of that tampering is self-harm,
since nothing but the job connects, but the cost of preventing it is one rule.

Socket paths are capped at 104 bytes on macOS and truncate rather than error, so
the socket takes a short fixed name at the directory root.

### The profile gets simpler

Today the profile must punch a literal hole for the real daemon socket, and
because Docker Desktop's socket lives inside the wholesale-denied `~/.docker`,
that hole is emitted after the deny block so it wins on ordering
([src/main/process-sandbox.ts](../../../src/main/process-sandbox.ts)).

With localmost serving the socket, the profile grants one path we chose, and
`~/.docker` stays denied in full at every level. The rule-ordering subtlety and
its dedicated test disappear.

### Identity is the connection

The socket is minted per spawn with an unguessable name. Because the runner is
`--once`, one spawn is one job. The proxy therefore knows which worker it is
serving structurally: nothing in a request has to be parsed, trusted, or
correlated to attribute it.

This removes an existing bug class. `ProxyServer` is per-slot and reused across
jobs, carrying mutable policy that must be manually reset — the hazard is
admitted in a comment at its reset site: "A reused proxy still holds the last
job's hosts until this runs." A per-job socket has no state to reset. It also
closes the case where an idle worker spawned for one repository claims a job from
another and inherits the first repository's grant.

**A socket is born denying everything.** A speculatively spawned worker has a
socket before it has a job. Default-deny is the state the socket starts in, not a
state we set afterwards; the scale-up path is otherwise a hole.

### Components

**`DockerFilterProxy`** — one per worker, mirroring `ProxyServer`'s shape. Parses
Docker API requests, applies the bound policy, forwards what passes. It is a
checkpoint, not an implementation: it decides about container semantics without
implementing them.

**`DockerBackend`** — the seam that makes the progression a swap rather than a
rewrite. Resolves an endpoint, declares the workspace mount root, and handles
per-job setup and teardown.

- `DesktopBackend` (stage 1) resolves the operator's daemon exactly as
  `resolveDockerEndpoint` does today, and forwards approved requests verbatim.
- `ManagedVmBackend` (stage 2) runs a real `dockerd` inside a VM whose only mount
  is the job workspace.

Both speak the genuine Docker API, so no translation layer exists at either
stage. That is the reason stage 2 is a backend swap and stage 3 is a different
project: Apple's runtime deliberately does not serve the Engine API, so sitting
in front of it means reimplementing the API rather than filtering it.

### Policy binding requires the workflow name fix

`getEffectivePolicy(config, workflowName)` looks up `config.workflows?.[name]`
([src/shared/localmostrc.ts](../../../src/shared/localmostrc.ts)), and the
documented contract is that those keys match the workflow filename. The value
supplied at runtime is the **job** name, scraped from the runner's stdout
(`Running job: <name>`). Per-workflow policy therefore fires only when a job name
coincides with a workflow filename.

This is a live defect in per-workflow network policy today, and a blocker for
`workflows.<name>.docker`. The broker already parses the job's `contextData.github`
payload for run id, repository, actor, sha and ref
([src/main/broker-proxy-service.ts](../../../src/main/broker-proxy-service.ts));
`github.workflow` is available there and unread. Fixing this is in scope.

## Policy Schema

The four-level enum is replaced by actions that name what the job does, each
carrying the conditions the proxy checks.

```yaml
shared:
  docker:
    pull:
      registries: [docker.io, ghcr.io]
    run:
      images: ["postgres:16", "redis:7"]
      mounts:
        - path: ./
          mode: ro
      network: bridge
    build:
      context: ./

workflows:
  integration:
    docker:
      run:
        mounts:
          - path: ./tmp/fixtures
            mode: rw
```

Actions are CLI-shaped rather than resource-shaped — `run`, `build`, `pull` —
because that is how a workflow author thinks and how an approval diff reads. The
cost is that localmost owns the mapping from verb to endpoint set, and that
mapping is part of the reviewed surface: it is asserted in tests, not left
implicit.

`run` covers container create, start, attach, wait and remove. Conditions are
checked against the request body:

- **`mounts`** against `HostConfig.Binds` and `HostConfig.Mounts`. Paths resolve
  through symlinks and must stay inside the job workspace, so `../` traversal and
  absolute host paths fail structurally rather than by pattern match. `mode`
  distinguishes `ro` from `rw`.
- **`network`** against `NetworkMode`.
- **`images`** against the image reference in the create request.
- **`registries`** against the registry of a pull.
- **`context`** documents which directory the workflow builds from. It is not
  checked against the request, because there is nothing in the request to check
  it against: the Engine API carries a build context as a tar the client already
  assembled, so the filter never sees a path. What confines a local context is
  the seatbelt profile - the job can only read what the profile grants, so the
  tar can only contain workspace content. The filter's job here is to refuse a
  *remote* context, which would have the daemon fetch the context itself and so
  bypass the profile entirely.

Anything not listed is denied.

### Dangerous capabilities are absent from the grammar

There is no key at any level that spells `PidMode`, `IpcMode`, `UtsMode`,
`UsernsMode`, `Devices`, `CgroupParent`, `SecurityOpt`, `NetworkMode: host`, or
mounting the daemon socket into a container. A capability that cannot be named
cannot be requested, which is the allowlist principle applied to the schema
itself and is what makes the diff safe to skim: nothing dangerous can hide in a
value.

`privileged` is the single exception, because real work needs it —
docker-in-docker, buildx with qemu emulation. It exists in the grammar and is
**rejected unless the backend is a managed VM**. At stage 1 it is a policy that
cannot be satisfied and fails at approval time with a message saying why. This
keeps the capability gap honest rather than silently unsupported, and ties the
escape to the stage that contains it.

### An always-on baseline

`/_ping`, `/version`, `/info`, and reads about the job's own containers are
permitted with no declaration. Every client needs them to start, and none reach
the host.

### Credentials stop entering the sandbox

Registry authentication moves to the proxy, which attaches auth to pulls on the
job's behalf. The job never reads `~/.docker/config.json` and never holds the
secret. The capability that used to require handing over credentials now requires
only naming a registry.

### Discovery

Each denial logs the exact policy line that would have permitted the request,
which is what lets `localmost test --updaterc` write docker policy the same way
it writes network and filesystem policy today.

## Failure Modes

**The filter fails closed.** Unknown endpoints, unknown API versions,
unparseable bodies, and any request the proxy cannot fully understand are
refused. A filter that fails open is worse than no filter, because it is trusted.

**Denials are clean failures.** The proxy returns a real Docker API error, so the
job fails at the CLI with a message naming the policy that would allow it, rather
than hanging or timing out.

**No daemon behind the backend.** Warn in the job log and run with docker
unavailable, as the current design does. A declaration is a permission, not a
requirement.

**Repository mismatch on claim.** If the repository the worker claims does not
match the policy bound to its socket, the socket refuses everything. This is the
idle-worker case made explicit.

**API version negotiation.** Clients negotiate a version at `/version`. The proxy
pins the versions it understands and refuses above them rather than passing
unknown shapes through.

## Testing

Profile assertions cannot prove a filter works, so the escapes in `SECURITY.md`
become executable tests run against the proxy:

- `docker run -v ~/.ssh:/host-ssh` is refused.
- Mounting the daemon socket into a container is refused.
- `--privileged`, `--pid=host`, `--network=host`, `--device` are refused.
- A `../` traversal and a symlinked workspace path that resolves outside the
  workspace are both refused.
- An undeclared registry, an undeclared image, and an undeclared mount are
  refused; declared ones succeed.

Beyond the escapes:

- Verb-to-endpoint mapping is asserted per action.
- A socket with no bound policy refuses everything.
- A socket bound to repository A refuses a job claimed for repository B.
- Unknown endpoint, unknown API version and malformed body each fail closed.
- Schema validation: the four old levels are rejected with a message naming the
  new actions; `privileged` is rejected at stage 1 with a message naming the
  backend requirement.
- `shared` and `workflows.<name>` compose additively, resolved against the real
  workflow name rather than the scraped job name.
- An end-to-end run of a workflow that uses the daemon, since request-level
  assertions cannot prove a real job works.

## Migration

`docker: socket | contexts | credentials` is a validation error naming the action
that replaces it, on the same reasoning the current design rejects `docker: true`
— guessing which grant a coarse level meant is worse than failing in a key that
governs a sandbox escape.

`diffConfigs` treats any change under `docker:` with the prominence it currently
gives the scalar, since with the repository as the only gate the approval diff
remains the whole of the access control.

## Documentation

- `docs/roadmap/localmostrc.md` — the actions, conditions and schema.
- `README.md` — the policy section.
- `SECURITY.md` — rewritten. The current text states that a job at any level from
  `socket` upward can read and write host paths through a bind mount. That stops
  being true at stage 1, and the replacement should be equally plain about what
  the filter does and does not contain.
- `CHANGELOG.md` — a breaking policy change with a migration note.

## Open Questions

- Whether stage 2's VM is Lima/Colima shelled out to, or an embedded
  Virtualization.framework helper. Deferred deliberately: both sit behind
  `DockerBackend`, and the choice is better made with stage 1 usage in hand.
- Per-container memory floor under a VM-per-container runtime, which stage 3
  would need in order to feed the existing resource-aware scheduler.
