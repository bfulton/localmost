# Docker Filter — Three Endpoint Families a Real Consumer Needs

An addendum to
[2026-09-05-docker-isolation-design.md](./2026-09-05-docker-isolation-design.md).
Everything here extends the stage 1 filter; nothing here changes its shape.

> **Status:** design. Prompted by wiring a container-heavy repository (an agent
> eval harness) to the shipped filtering socket — the "end-to-end run on a
> repository that needs the daemon" the original Testing section asks for.

## Problem

`pull`, `run` and `build` covered that consumer's pulls, container lifecycle and
image builds unchanged, which is the encouraging part. Three families it needs
classify as `other` and hit `default: deny`:

1. **Networks.** The harness creates an `--internal` network — no route to
   anything — as its *sealing* mechanism: the agent under test runs with no
   egress except a broker that accounts for every request. It then reads and
   deletes that network.
2. **Image existence.** `docker image inspect` is the natural "do I already have
   this?" check, deciding build-vs-pull in a build-once-mount flow.
3. **Killing a container.** Enforcing a wall-clock budget on a container that
   overruns it.

The first is the one that matters most, because the direction is backwards. An
`--internal` network makes a container *less* reachable, not more. With networks
denied, the only containers a job can run are ones on the default bridge — the
filter currently **forces strictly weaker isolation than the workload wants**,
which is the opposite of what a sandbox should do. `run.network` does not help:
it constrains `NetworkMode` at create, and the network has to exist first.

## Solution

Three additions, each reusing a mechanism the filter already has.

### 1. Networks: a declared, owned, bridge-only network

```yaml
shared:
  docker:
    run:
      networks:
        - name: vk-*
          internal: true
```

`name` is a glob matched against the requested network name. `internal` is the
only other key, and it is a **requirement, not a default**: a policy that wants a
routable network must say `internal: false`, so the approval diff shows it.

**The driver is unnameable, and that is the point.** The dangerous value in a
network create is not `internal: false` — it is `Driver`. A `macvlan` or `ipvlan`
network puts the container directly on the physical LAN, which is worse than
`--network=host`, and `Options` can carry
`com.docker.network.bridge.host_binding_ipv4`. So the grammar cannot spell a
driver at all: the filter forces `bridge`, and **refuses any create body key it
does not recognise**. That is the same allowlist-of-the-grammar principle the
original spec applies to `HostConfig`, applied to a second body.

Recognised keys on `POST /networks/create`: `Name`, `Internal`, `CheckDuplicate`,
`Labels`. `Driver` is permitted only when absent or exactly `bridge`.

The rest — `Scope`, `IPAM`, `Options`, `Attachable`, `Ingress`, `ConfigOnly`,
`ConfigFrom`, `EnableIPv6` — are **gated by value rather than refused outright**,
the same way `HostConfig` treats the keys a plain `docker run` always sends. The
CLI sends all eight unconditionally with inert defaults, so refusing them made
the feature reachable only from a hand-written API client. The default passes;
anything meaningful (a subnet, a non-default IPAM driver, driver options, an
attachable or ingress or config-only network, a config source, a scope) is
refused, naming the key.

`GET /networks/{id}` and `DELETE /networks/{id}` are scoped to networks this
socket created, exactly as per-container endpoints are scoped to containers it
created. `GET /networks` (list) stays denied: it enumerates the daemon.

**`NetworkMode` must accept an owned network.** This is the part that is easy to
miss and makes the feature useless without it. Today `evaluateCreate` requires
`HostConfig.NetworkMode` to equal `policy.run.network`. A job that creates
`vk-abc` and runs a container with `--network vk-abc` would still be refused. So
the create gate permits a `NetworkMode` that names a network in the socket's
owned set, in addition to the declared `run.network`.

### 2. Image reads, scoped by the policy rather than by ownership

`GET /images/{name}/json` is permitted when the reference normalises to an entry
in `run.images`.

The consumer suggested scoping this the way containers are scoped — to images the
socket pulled or built. Policy-scoping is better here: an inspect of an image the
policy *already names* discloses nothing the policy has not already granted, and
it avoids a second ownership ledger. Ownership bookkeeping is not free — the
container ledger has already produced one defect (a prefix match that outlives
the container it described), and a second one would need to reconcile pulls by
tag with builds by id.

`GET /images/json` (list) and `DELETE /images/{name}` stay denied: both are
daemon-wide, and the consumer agrees.

### 3. Stopping a container the job owns

`POST /containers/{id}/kill` and `POST /containers/{id}/stop` join
`start`/`attach`/`wait`/`remove` under the `run` action, with the same
own-container scoping.

`stop` is not in the request but belongs in the same change: a timeout path that
can only `kill` is worse than one that can ask politely first, and both are the
same endpoint family with the same scoping.

`GET /containers/{id}/logs` joins them too. The original spec's baseline is
"reads about the job's own containers", and logs is exactly such a read; refusing
it contradicts the documented behaviour rather than implementing it.

## What stays denied

`GET /containers/json`, `GET /networks`, `GET /images/json` and
`DELETE /images/{name}` are daemon-wide by construction — they enumerate or
mutate things outside the job — and no policy key grants them.

## Not a filter change

Mounts and build contexts must resolve inside the job workspace. A consumer
building from `tempfile.mkdtemp()` (i.e. `/var/folders/...`) fails that check
**correctly**; pointing `TMPDIR` inside the workspace is the consumer's fix. It
is recorded here only because it reads like a filter bug from the outside, and
the denial message should make the reason obvious enough that it doesn't.

## Testing

Per family, and in the same executable-escape style as the original spec:

- A network create whose name matches no declared pattern is refused; one that
  matches is permitted.
- `internal: false` is refused unless declared; `Driver: macvlan`, `Options`,
  `IPAM` and any unrecognised key are each refused, naming the key.
- `GET`/`DELETE` of a network the socket did not create is refused.
- A container created with `NetworkMode` naming an owned network is permitted;
  one naming an arbitrary network is refused.
- `GET /images/{name}/json` is permitted for a declared image and refused for an
  undeclared one; `GET /images/json` is refused.
- `kill`, `stop` and `logs` are permitted on an owned container and refused on
  one the socket did not create.
- An end-to-end run that creates an internal network, runs a container on it,
  reads its logs, kills it, and deletes the network.

## Open questions

- Whether `name` globs should be anchored (`vk-*` matching `vk-abc` but not
  `other-vk-abc`). Leaning yes — anchored, with `*` matching within a segment —
  since an unanchored glob in a security grammar reads as more permissive than
  it looks.
- Whether an owned network should be deleted automatically when the job's worker
  exits, as the socket itself is. Leaning yes, for the same reason: nothing
  should outlive the job that created it.
