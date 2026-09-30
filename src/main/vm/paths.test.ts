/**
 * The VM backend's identifiers and host paths (contract §1).
 *
 * Every path the VM backend uses is built here, from ids that are checked
 * first, so nothing a registry, the guest or a job chooses can steer a path
 * outside the directory it belongs in.
 */

import { describe, it, expect, afterEach, jest } from '@jest/globals';
import * as path from 'path';
import { app } from 'electron';
import {
  DIGEST_RE,
  REPO_KEY_RE,
  SANDBOX_ID_RE,
  VM_ID_RE,
  blobPath,
  cacheFiles,
  digestHex,
  dockerCliPath,
  getVmResourcesDir,
  guestDir,
  placeBlob,
  helperPath,
  imageStoreDir,
  newVmId,
  refsJsonPath,
  repoKeyOf,
  sandboxDirOf,
  sandboxFiles,
  vmDir,
  vmIdSlot,
  vmJobFiles,
} from './paths';

const DATA = '/Users/someone/.localmost';
const HEX = 'aa31e9a65c08e067c231903acf9071cf18cfc4d7c5951641d8dc40457c25c94b';
const VM_ID = '3-0123456789ab';
const REPO_KEY = 'aa31e9a65c08e067';

/** Inputs shaped to escape a directory, or to look like an id and not be one. */
const HOSTILE = [
  '',
  '.',
  '..',
  '../../etc/passwd',
  '../../../../../etc/passwd',
  '/etc/passwd',
  'a/b',
  'a\\b',
  'a\0b',
  `${HEX}/..`,
  `../${HEX.slice(3)}`,
  `sha256:${HEX}`,
  HEX.toUpperCase(),
  HEX.slice(1),
  `${HEX}0`,
  `${HEX}\n`,
  ` ${HEX}`,
];

const setPackaged = (packaged: boolean) => {
  (app as { isPackaged: boolean }).isPackaged = packaged;
};

const setResourcesPath = (value: string | undefined) => {
  Object.defineProperty(process, 'resourcesPath', { value, configurable: true });
};

const isUnder = (root: string, p: string) => {
  const rel = path.relative(path.resolve(root), p);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};

describe('repoKeyOf', () => {
  it('is the first 16 hex of the SHA-256 of the lower-cased owner/name', () => {
    // printf 'bfulton/localmost' | shasum -a 256
    expect(repoKeyOf('bfulton/localmost')).toBe('aa31e9a65c08e067');
    // printf 'octo-org/hello-world' | shasum -a 256
    expect(repoKeyOf('octo-org/hello-world')).toBe('c59c3c06193d4e83');
  });

  it('gives one key whatever the case the name is written in', () => {
    expect(repoKeyOf('BFulton/LocalMost')).toBe(repoKeyOf('bfulton/localmost'));
    expect(repoKeyOf('BFulton/LocalMost')).toMatch(REPO_KEY_RE);
  });
});

describe('the id forms', () => {
  it('accepts a vm id for slots 0 to 99 and nothing else', () => {
    for (const id of ['0-0123456789ab', '1-0123456789ab', '42-fedcba987654', '99-000000000000']) {
      expect(id).toMatch(VM_ID_RE);
    }
    for (const id of [
      '100-0123456789ab',
      '00-0123456789ab',
      '05-0123456789ab',
      '-0123456789ab',
      '1-0123456789AB',
      '1-0123456789a',
      '1-0123456789abc',
      '1_0123456789ab',
      '1-0123456789ab\n',
      '../1-0123456789ab',
      'a-0123456789ab',
    ]) {
      expect(id).not.toMatch(VM_ID_RE);
    }
  });

  it('shapes a sandbox id as buildSandbox makes it', () => {
    expect('7-a1b2c3d4e5f6').toMatch(SANDBOX_ID_RE);
    expect('10-a1b2c3d4e5f6').toMatch(SANDBOX_ID_RE);
    expect('7-a1b2c3d4e5f').not.toMatch(SANDBOX_ID_RE);
    expect('07-a1b2c3d4e5f6').not.toMatch(SANDBOX_ID_RE);
    expect('7-a1b2c3d4e5f6/..').not.toMatch(SANDBOX_ID_RE);
  });

  it('accepts only a sha256 digest of 64 lower-case hex', () => {
    expect(`sha256:${HEX}`).toMatch(DIGEST_RE);
    for (const digest of [
      HEX,
      `sha256:${HEX.toUpperCase()}`,
      `sha256:${HEX.slice(1)}`,
      `sha512:${HEX}${HEX}`,
      'sha256:../../../etc/passwd',
      `sha256:${HEX}\n`,
      `SHA256:${HEX}`,
    ]) {
      expect(digest).not.toMatch(DIGEST_RE);
    }
  });

  it('takes the hex from a valid digest and refuses every other form', () => {
    expect(digestHex(`sha256:${HEX}`)).toBe(HEX);
    expect(digestHex(`sha512:${HEX}${HEX}`)).toBeNull();
    expect(digestHex('sha256:../../x')).toBeNull();
    expect(digestHex(HEX)).toBeNull();
    expect(digestHex(undefined as unknown as string)).toBeNull();
    expect(digestHex({ toString: () => `sha256:${HEX}` } as unknown as string)).toBeNull();
  });

  it('accepts only 16 lower-case hex as a repository key', () => {
    expect(REPO_KEY).toMatch(REPO_KEY_RE);
    expect(REPO_KEY.toUpperCase()).not.toMatch(REPO_KEY_RE);
    expect(`${REPO_KEY}0`).not.toMatch(REPO_KEY_RE);
    expect('../../../../abcd').not.toMatch(REPO_KEY_RE);
  });
});

describe('newVmId and vmIdSlot', () => {
  it('makes a job vm id from its slot and twelve random hex', () => {
    const id = newVmId(7);
    expect(id).toMatch(VM_ID_RE);
    expect(id).toMatch(/^7-/);
    expect(vmIdSlot(id)).toBe(7);
    expect(newVmId(7)).not.toBe(id);
  });

  it('gives a refresh vm slot 0', () => {
    const id = newVmId(0);
    expect(id).toMatch(/^0-[0-9a-f]{12}$/);
    expect(vmIdSlot(id)).toBe(0);
  });

  it('refuses a slot outside 0 to 99', () => {
    for (const slot of [-1, 100, 1.5, NaN, Infinity]) {
      expect(() => newVmId(slot)).toThrow(/slot/);
    }
  });

  it('reads no slot from something that is not a vm id', () => {
    expect(vmIdSlot('100-0123456789ab')).toBeNull();
    expect(vmIdSlot('../0-0123456789ab')).toBeNull();
    // Nothing makes a slot with a leading zero, so '00-' is not read as a refresh VM.
    expect(vmIdSlot('00-0123456789ab')).toBeNull();
  });
});

describe('blobPath', () => {
  const root = path.join(DATA, 'vm', 'images', REPO_KEY);

  it('places a blob at blobs/sha256/<hex> under its store root', () => {
    expect(blobPath(root, HEX)).toBe(path.join(root, 'blobs', 'sha256', HEX));
  });

  it('refuses anything that is not 64 lower-case hex', () => {
    for (const hex of HOSTILE) {
      expect(() => blobPath(root, hex)).toThrow(/digest/);
    }
    expect(() => blobPath(root, 42 as unknown as string)).toThrow(/digest/);
  });

  it('never returns a path outside its root', () => {
    for (const storeRoot of [root, `${root}/`, `${root}/../${REPO_KEY}`, '/']) {
      for (const hex of [HEX, ...HOSTILE]) {
        let result: string;
        try {
          result = blobPath(storeRoot, hex);
        } catch {
          continue;
        }
        expect(isUnder(storeRoot, result)).toBe(true);
      }
    }
  });

  it('places nothing but a direct child of blobs/sha256, even without the hex check', () => {
    // The second layer on its own. A per-job store's root is the VM's own
    // directory, so "somewhere under the root" would still reach helper.sb or
    // data.img beside the store.
    const vmRoot = path.join(DATA, 'vm', 'jobs', VM_ID);
    for (const storeRoot of [root, vmRoot, `${vmRoot}/`, '/']) {
      const blobs = path.join(path.resolve(storeRoot), 'blobs', 'sha256');
      for (const hex of [HEX, ...HOSTILE, '../../helper.sb', '../../data.img', '../x', 'x/..']) {
        let result: string;
        try {
          result = placeBlob(storeRoot, hex);
        } catch {
          continue;
        }
        expect(path.dirname(result)).toBe(blobs);
        expect(path.basename(result)).toBe(hex);
      }
    }
    expect(() => placeBlob(vmRoot, '../../helper.sb')).toThrow(/outside/);
  });

  it('refuses a relative store root', () => {
    expect(() => blobPath('images/x', HEX)).toThrow(/absolute/);
    expect(() => blobPath('', HEX)).toThrow(/absolute/);
  });
});

describe('the data paths', () => {
  it('puts the VM directory at <data>/vm', () => {
    expect(vmDir(DATA)).toBe(`${DATA}/vm`);
  });

  it("names every file of a VM's own directory", () => {
    const dir = `${DATA}/vm/jobs/${VM_ID}`;
    expect(vmJobFiles(DATA, VM_ID)).toEqual({
      dir,
      profile: `${dir}/helper.sb`,
      dataDisk: `${dir}/data.img`,
      pidFile: `${dir}/helper.pid`,
      consoleLog: `${dir}/console.log`,
      dockerSocket: `${dir}/docker.sock`,
      agentSocket: `${dir}/agent.sock`,
      blobStore: dir,
    });
  });

  it("keeps a VM's docker socket 36 bytes past <data>", () => {
    // The longest socket path, which the contract measures against 103.
    expect(vmJobFiles(DATA, '99-0123456789ab').dockerSocket.length).toBe(DATA.length + 36);
  });

  it("names a repository's image store and cache", () => {
    expect(imageStoreDir(DATA, REPO_KEY)).toBe(`${DATA}/vm/images/${REPO_KEY}`);
    expect(blobPath(imageStoreDir(DATA, REPO_KEY), HEX)).toBe(
      `${DATA}/vm/images/${REPO_KEY}/blobs/sha256/${HEX}`
    );
    const cache = `${DATA}/vm/cache/${REPO_KEY}`;
    expect(cacheFiles(DATA, REPO_KEY)).toEqual({
      dir: cache,
      golden: `${cache}/data.img`,
      refresh: `${cache}/data.img.new`,
      meta: `${cache}/meta.json`,
    });
    expect(refsJsonPath(DATA, REPO_KEY)).toBe(`${DATA}/vm/images/${REPO_KEY}/refs.json`);
  });

  it("names a job sandbox's share, nonce, socket and CLI config", () => {
    const sandbox = sandboxDirOf(DATA, '7-a1b2c3d4e5f6');
    expect(sandbox).toBe(`${DATA}/runner/sandbox/7-a1b2c3d4e5f6`);
    expect(sandboxFiles(DATA, '7-a1b2c3d4e5f6')).toEqual({
      share: `${sandbox}/_work`,
      shareNonce: `${sandbox}/_work/.localmost-share`,
      dockerSocket: `${sandbox}/docker.sock`,
      dockerConfig: `${sandbox}/.docker`,
    });
  });

  it('refuses an id that is not of its form', () => {
    for (const id of [...HOSTILE, '100-0123456789ab', '1-0123456789AB']) {
      expect(() => vmJobFiles(DATA, id)).toThrow(/vm id/);
      expect(() => sandboxDirOf(DATA, id)).toThrow(/sandbox id/);
      expect(() => sandboxFiles(DATA, id)).toThrow(/sandbox id/);
      expect(() => imageStoreDir(DATA, id)).toThrow(/repository key/);
      expect(() => cacheFiles(DATA, id)).toThrow(/repository key/);
      expect(() => refsJsonPath(DATA, id)).toThrow(/repository key/);
    }
  });

  it('refuses a relative data directory', () => {
    expect(() => vmDir('.localmost')).toThrow(/absolute/);
    expect(() => vmJobFiles('', VM_ID)).toThrow(/absolute/);
    expect(() => sandboxFiles('.localmost', '7-a1b2c3d4e5f6')).toThrow(/absolute/);
  });
});

describe('the resources paths', () => {
  const savedResourcesPath = process.resourcesPath;
  const savedHelper = process.env.LOCALMOST_VM_HELPER;

  afterEach(() => {
    jest.restoreAllMocks();
    setPackaged(false);
    setResourcesPath(savedResourcesPath);
    if (savedHelper === undefined) delete process.env.LOCALMOST_VM_HELPER;
    else process.env.LOCALMOST_VM_HELPER = savedHelper;
  });

  it("finds everything under the checkout's build/ when not packaged", () => {
    delete process.env.LOCALMOST_VM_HELPER;
    // `electron .` makes the checkout the app path. `electron build/dist/main.js`,
    // as the e2e tests launch it, makes the bundle's own directory the app path.
    for (const appPath of ['/work/localmost', '/work/localmost/build/dist', '/work/localmost/build/dist/']) {
      jest.spyOn(app, 'getAppPath').mockReturnValue(appPath);
      expect(getVmResourcesDir()).toBe('/work/localmost/build');
      expect(helperPath()).toBe('/work/localmost/build/localmost-vm');
      expect(guestDir()).toBe('/work/localmost/build/guest');
      expect(dockerCliPath()).toBe('/work/localmost/build/docker-cli/docker');
    }
  });

  it("finds everything in the app's Resources when packaged", () => {
    delete process.env.LOCALMOST_VM_HELPER;
    setPackaged(true);
    setResourcesPath('/Applications/localmost.app/Contents/Resources');
    const resources = '/Applications/localmost.app/Contents/Resources';
    expect(getVmResourcesDir()).toBe(resources);
    expect(helperPath()).toBe(`${resources}/localmost-vm`);
    expect(guestDir()).toBe(`${resources}/guest`);
    expect(dockerCliPath()).toBe(`${resources}/docker-cli/docker`);
  });

  it('runs the helper LOCALMOST_VM_HELPER names only when not packaged', () => {
    process.env.LOCALMOST_VM_HELPER = '/work/test/fakes/fake-localmost-vm.mjs';
    expect(helperPath()).toBe('/work/test/fakes/fake-localmost-vm.mjs');

    setPackaged(true);
    setResourcesPath('/Applications/localmost.app/Contents/Resources');
    expect(helperPath()).toBe('/Applications/localmost.app/Contents/Resources/localmost-vm');
  });

  it('refuses a relative LOCALMOST_VM_HELPER', () => {
    process.env.LOCALMOST_VM_HELPER = 'fake-localmost-vm.mjs';
    expect(() => helperPath()).toThrow(/LOCALMOST_VM_HELPER/);
  });

  it('refuses to guess when a packaged app has no resources path', () => {
    setPackaged(true);
    setResourcesPath(undefined);
    expect(() => getVmResourcesDir()).toThrow(/resources/);
  });
});
