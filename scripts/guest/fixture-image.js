'use strict';

// Builds `docker load`-shaped OCI image archives on the Mac for the guest's
// acceptance harness (a busybox rootfs from a static busybox apk). Not part
// of the product; the real puller (WP-D) builds these from registries.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { readApk } = require('./apk');
const { writeTar } = require('./tar');

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

const APPLETS = ['sh', 'cat', 'ls', 'echo', 'sleep', 'ip', 'wget', 'nslookup', 'nc', 'true', 'id', 'mount', 'cp', 'ln', 'rm', 'mkdir', 'stat', 'grep', 'dd', 'uname', 'env', 'printenv', 'hostname'];

/** The layer tar: busybox and its applet links, plus any extra files. */
function layer(busybox, extra = []) {
  const items = [
    { name: 'bin', type: 'dir', mode: 0o755 },
    { name: 'bin/busybox', type: 'file', mode: 0o755, data: busybox },
    ...APPLETS.map((a) => ({ name: `bin/${a}`, type: 'symlink', mode: 0o777, linkname: 'busybox' })),
    { name: 'tmp', type: 'dir', mode: 0o1777 },
    ...extra,
  ];
  return writeTar(items);
}

/**
 * Writes a docker-archive tar to `dest` for arch ("arm64" or "amd64") from
 * the static busybox at `busyboxApk`. Returns the config digest, which is
 * the loaded image id. `cmd` defaults to a shell.
 */
function buildImage({ busyboxApk, dest, arch, name, cmd = ['/bin/sh'], extra = [] }) {
  const busybox = readApk(fs.readFileSync(busyboxApk)).entries.find((e) => e.name === 'bin/busybox.static').data;
  const lay = layer(busybox, extra);
  const diffId = 'sha256:' + sha256(lay);
  const config = Buffer.from(
    JSON.stringify({
      architecture: arch,
      os: 'linux',
      config: { Cmd: cmd, Env: ['PATH=/bin'] },
      rootfs: { type: 'layers', diff_ids: [diffId] },
    }),
  );
  const configDigest = 'sha256:' + sha256(config);
  const manifest = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      config: { mediaType: 'application/vnd.oci.image.config.v1+json', digest: configDigest, size: config.length },
      layers: [{ mediaType: 'application/vnd.oci.image.layer.v1.tar', digest: diffId, size: lay.length }],
    }),
  );
  const manifestDigest = 'sha256:' + sha256(manifest);
  const index = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.index.v1+json',
      manifests: [
        {
          mediaType: 'application/vnd.oci.image.manifest.v1+json',
          digest: manifestDigest,
          size: manifest.length,
          annotations: { 'io.containerd.image.name': name, 'org.opencontainers.image.ref.name': name },
        },
      ],
    }),
  );
  const legacy = Buffer.from(
    JSON.stringify([{ Config: 'blobs/sha256/' + configDigest.slice(7), RepoTags: [name], Layers: ['blobs/sha256/' + diffId.slice(7)] }]),
  );
  const blob = (d, data) => ({ name: 'blobs/sha256/' + d.slice(7), type: 'file', mode: 0o644, data });
  const archive = writeTar([
    { name: 'oci-layout', type: 'file', mode: 0o644, data: Buffer.from('{"imageLayoutVersion":"1.0.0"}') },
    { name: 'index.json', type: 'file', mode: 0o644, data: index },
    { name: 'manifest.json', type: 'file', mode: 0o644, data: legacy },
    { name: 'blobs', type: 'dir', mode: 0o755 },
    { name: 'blobs/sha256', type: 'dir', mode: 0o755 },
    blob(configDigest, config),
    blob(manifestDigest, manifest),
    blob(diffId, lay),
  ]);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, archive);
  return { configDigest, manifestDigest, diffId, name };
}

module.exports = { buildImage, layer, sha256, gzip: zlib.gzipSync };
