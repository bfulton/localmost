/**
 * What the Docker VM backend puts in the app's Resources, and the checks the
 * build makes before it packages them: the helper (localmost-vm), the guest
 * image (guest/) and the docker CLI jobs run (docker-cli/docker). They come
 * from `npm run build:native` into build/. forge.config.js runs
 * checkVmResources in prePackage, so a build never ships without its VM, or
 * with anything beside it; scripts/fetch-docker-cli.mjs uses the Mach-O check
 * on the CLI it extracts.
 */

// The first four fields of a thin 64-bit Mach-O header, little-endian.
const MH_MAGIC_64 = 0xfeedfacf;
const CPU_TYPE_ARM64 = 0x0100000c;
const MH_EXECUTE = 2;

/**
 * Throw unless `bytes` begins a thin arm64 Mach-O executable: not a
 * universal file, not Intel, not a library or a script. `what` names the
 * file in the message.
 */
function checkArm64Executable(bytes, what) {
  const ok =
    bytes.length >= 16 &&
    bytes.readUInt32LE(0) === MH_MAGIC_64 &&
    bytes.readUInt32LE(4) === CPU_TYPE_ARM64 &&
    bytes.readUInt32LE(12) === MH_EXECUTE;
  if (!ok) {
    throw new Error(`${what} is not a thin arm64 Mach-O executable`);
  }
}

module.exports = { checkArm64Executable };
