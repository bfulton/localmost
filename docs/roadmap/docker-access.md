# Docker Access — Opt-In Daemon Reachability

A `.localmostrc` key that lets an approved repository reach the Docker daemon, at
a declared level, from inside the runner sandbox.

> **Status:** implemented in 0.3.0. This document describes the design; where the
> shipped behaviour differs it is noted inline.

## Problem

A job that needs Docker — integration tests against a containerised service, a
container build — cannot reach the daemon under the sandbox at any policy level,
and there is no way to ask for it:

1. **The socket is unreachable.** The job profile allows TCP to `localhost:*` but
   grants no `network-outbound` to any unix socket, so a connection to
   `/var/run/docker.sock` is denied.
2. **The Docker CLI cannot read its own configuration.** `~/.docker` sits on the
   unconditional deny-read list in `process-sandbox.ts`, alongside `~/.ssh`,
   `~/.aws`, `~/.gnupg` and `Library/Keychains`, so the CLI cannot resolve its
   endpoint or read `config.json`.
3. **The mechanism that exists is half-wired.** `SocketsPolicy` in
   `src/shared/sandbox-profile.ts` emits `network-bind`, `network-outbound` and
   `file-write*` for a declared socket path, and names `/var/run/docker.sock` as
   its example. `shared.sockets.allow` is a validated key that already reaches
   the `localmost test` profile (`src/cli/test.ts`), but the runner profile is
   built by `process-sandbox.ts`, a different code path that ignores it. So the
   one existing way to ask for a socket works locally, does nothing on the
   runner, and accepts arbitrary paths.

The result is silent degradation: container-based workflows find the daemon
unreachable, tests that need it skip, and the operator has no way to opt in even
on their own machine.

## Solution

A repository declares the access it needs, and localmost honours it once the
policy is approved:

```yaml
# .localmostrc
version: 1
level: strict

shared:
  docker: socket        # off (default) | socket | contexts | credentials
```

Each level names the thing it opens, so the level is legible in an approval diff
rather than requiring a trip to the docs:

| Level | What it grants |
|---|---|
| `off` (or absent) | Nothing. Current behaviour. |
| `socket` | The resolved daemon socket: `network-outbound`, `file-read*` and `file-write*` on that one literal path, plus `DOCKER_HOST=unix://<socket>` in the job environment. |
| `contexts` | The above, plus `file-read*` on `~/.docker/contexts`, so the job can resolve and switch contexts itself. |
| `credentials` | The above, plus `file-read*` on `~/.docker/config.json`, so pulls from private registries can authenticate. |

Levels are cumulative, and nothing under `~/.docker` is opened beyond the paths
named above — no level grants the directory itself.

## What This Actually Grants

**Above `off`, the sandbox is no longer the boundary for container work.** This
is the fact that shapes the feature and belongs anywhere it is documented.

The network and filesystem allowlists widen what the sandboxed process may do,
and the seatbelt profile still contains it. Docker access is different in kind,
because the container is not subject to the profile at all. A job that can reach
the daemon can

- bind-mount host paths into a container and read or write them, including paths
  this same policy denies. Verified on a default Docker Desktop install, which
  shares `/Users`: with `docker: socket`, `docker run -v ~/.ssh:/host-ssh alpine
  ls /host-ssh` lists private keys the profile denies outright;
- make arbitrary outbound connections from inside a container, which do not pass
  through the job's proxy and so are not subject to the network allowlist.

So `docker:` is not another entry in the allowlist. It decides whether the rest
of the file is enforceable at all for anything routed through a container - the
`filesystem.deny` list and the network allowlist included.

Two separate questions are easy to run together here, so to be explicit:

- **What grants it.** Only an approved `.localmostrc`. There is no second,
  machine-level switch (see the decision below), so the approval diff is the
  whole of the access control.
- **What is still enforced once granted.** For the job process itself, the
  profile applies as before. For anything it does through a container, nothing.

The design does not try to soften that behind a mechanism. It makes the level
visible at approval time and states the consequence in the docs.

## Key Design Decisions

### The repository policy is the only gate

An approved `.localmostrc` is sufficient authority — there is no second,
machine-level switch. This matches how network and filesystem allowances already
work, and keeps one mechanism instead of two.

The consequence is that policy approval carries more weight than it did: it is
the only thing between a repository and host file access. That places the burden
on the approval surface, below.

### A closed enum, not a socket list

The key takes one of four known values. It does not take a path, and there is no
general `sockets:` list.

A path-taking form would let a repository name any unix socket on the machine —
the SSH agent, `~/.gnupg/S.gpg-agent`, a database socket — which is a much larger
capability than "can use Docker" and one that is hard to review in a diff. Since
the repository is the only gate, the narrowest expressible request is the right
one.

Alternative runtimes are still supported, because localmost resolves the endpoint
from the operator's own Docker configuration rather than from anything the
repository says. Colima and Podman work without the repository naming a path.

`docker: true` and `docker: false` are rejected with an error naming the four
levels. In a key that governs a sandbox escape, guessing which level a truthy
value meant is worse than failing.

### The socket needs a hole in the deny, even at `socket`

On macOS with Docker Desktop, `/var/run/docker.sock` is a symlink to
`~/.docker/run/docker.sock` — inside the directory that is denied as a credential
store. Seatbelt matches on the resolved path, so the grant has to name that
literal.

The rules are therefore emitted after the deny block in `process-sandbox.ts`, so
the specific literal wins over the subtree deny, and the grant is a single
literal path rather than a subtree. `~/.docker/config.json` remains denied at
`socket` and `contexts`, and that is worth an explicit test rather than an
assumption about rule ordering.

### One resolver, both sandboxes

A new `src/shared/docker-access.ts` owns the level type, endpoint resolution and
the grant computation. Both `process-sandbox.ts` (runner jobs) and
`sandbox-profile.ts` (`localmost test`) call it.

`localmost test` exists to predict what the runner will do. Two Docker code paths
would break that prediction for exactly the workflows most likely to behave
differently between the two — and the orphaned `SocketsPolicy` is what a second,
unshared path looks like after a while. That existing mechanism becomes the
internal primitive, driven only by `docker:`, rather than being exposed as its
own key.

### Endpoint resolution happens outside the sandbox

localmost resolves the socket in the app, before the profile is built:
`DOCKER_HOST` if the operator has set one, then `/var/run/docker.sock` followed
through its symlink, then Docker Desktop's per-user path.

The job never has to discover the endpoint, which is why `socket` can inject
`DOCKER_HOST` and keep `~/.docker` closed.

## Edge Cases

**Declared but no daemon.** The socket does not resolve, or resolves to a path
that does not exist. Warn in the job log and run without the grant. The key is a
permission, not a requirement, and container tests that check for a reachable
daemon already skip. The job must not silently appear to have had access.

**A dangling socket symlink.** `/var/run/docker.sock` exists as a symlink even
when Docker Desktop is stopped, so the path being present does not mean the
daemon is running. Resolution follows the link and checks the target.

**A context pointing somewhere unexpected.** At `contexts`, a job can select a
context whose endpoint is a socket that was not granted. The connection is denied
by the profile and fails at connect — a clean failure, not a hang. Documented
rather than prevented; granting whatever a context names would defeat the closed
enum.

**Shared section only.** `docker:` is read from `shared:`, not from a
`workflows:` block. The runner's sandbox profile is built before the workflow is
known, which is already why per-workflow `filesystem:` sections are not applied
(`src/main/index.ts`). Docker access changes the same profile, so a workflow-level
value could only be honoured by `localmost test` — reintroducing exactly the
runner/test divergence this design set out to avoid. A `docker:` key inside a
`workflows:` block is a validation error rather than a silently ignored setting.

**Policy changes require re-approval.** Adding or raising `docker:` changes the
policy, so the existing approval flow holds the job and cancels the run until the
new policy is approved. No separate mechanism is needed — but see below.

## Approval Surface

`diffConfigs` already treats a change to `level:` as the largest change a policy
can make. A change to `docker:` gets equal prominence, so `docker: off →
credentials` cannot slide past in a diff that is otherwise routine.

This is load-bearing rather than cosmetic: with the repository as the only gate,
the diff an operator reads at approval time is the whole of the access control.

## Testing

- Profile generation, per level, for **both** builders: the socket literal is
  allowed; at `socket` and `contexts`, `~/.docker/config.json` is still denied.
  The rule-ordering behaviour is asserted, not assumed.
- Endpoint resolution: `DOCKER_HOST` set, symlink followed, dangling symlink,
  nothing found.
- Schema validation: the four levels accepted, `true`/`false` rejected with a
  message naming them, workflow-level override applied.
- Diff output: a `docker:` change is surfaced with level-change prominence.
- An end-to-end run on a repository that needs the daemon, since profile
  assertions cannot prove the daemon is actually reachable.

## Documentation

The capability is documented where its consequences are, not only where its
syntax is:

- `docs/roadmap/localmostrc.md` — the key, the levels, the schema.
- `README.md` — the policy section.
- `SECURITY.md` — plainly, that a job at any level from `socket` upward can read
  and write host paths through a bind mount, outside the sandbox.
- `CHANGELOG.md` — a new opt-in capability, default off.
