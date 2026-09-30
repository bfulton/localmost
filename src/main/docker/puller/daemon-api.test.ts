import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { Readable } from 'stream';
import { DaemonEndpoint, DaemonError, OVERSIZED, listImages, loadImage, removeImage, tagImage } from './daemon-api';
import { TestDaemon } from './test-daemon';
import { sha256 } from './test-registry';

const IMAGE = sha256(Buffer.from('an image config'));

let daemon: TestDaemon;
let endpoint: DaemonEndpoint;

beforeEach(async () => {
  daemon = await TestDaemon.start();
  endpoint = { socketPath: '/nowhere/docker.sock', connect: daemon.connect };
  daemon.images.set(IMAGE, []);
});

afterEach(async () => {
  await daemon.close();
});

describe('tagImage', () => {
  it('tags an image by its id with a name and a tag', async () => {
    await tagImage(endpoint, IMAGE, 'registry.test/team/app', 'v1');
    expect(daemon.images.get(IMAGE)).toEqual(['registry.test/team/app:v1']);
  });

  it.each([
    ['a name with a query', 'registry.test/team/app?force=1', 'v1'],
    ['a name with a traversal', 'registry.test/../../containers/x', 'v1'],
    ['a name without a registry', 'app', 'v1'],
    ['a tag with a slash', 'registry.test/team/app', 'v1/../x'],
    ['a tag that starts with a dot', 'registry.test/team/app', '.hidden'],
    ['a tag with a space', 'registry.test/team/app', 'v 1'],
  ])('refuses %s before any request', async (_what, repo, tag) => {
    await expect(tagImage(endpoint, IMAGE, repo, tag)).rejects.toThrow(DaemonError);
    expect(daemon.calls).toHaveLength(0);
  });
});

describe('removeImage', () => {
  it.each([
    ['a traversal', 'registry.test/../../containers/x:1'],
    ['a query', 'registry.test/team/app:1?force=1'],
    ['a percent escape', 'registry.test/team/app%2F..:1'],
    ['a space', 'registry.test/team app:1'],
  ])('refuses a name with %s, as a hostile image list could hold, before any request', async (_what, tag) => {
    await expect(removeImage(endpoint, { tag })).rejects.toThrow('not an image name');
    expect(daemon.calls).toHaveLength(0);
  });
});

describe('loadImage', () => {
  it('destroys the archive it was streaming when the call ends early, so its layer files close', async () => {
    daemon.switches.hang = 'load';
    const archive = new Readable({ read() { this.push(Buffer.alloc(1024)); } });
    const controller = new AbortController();
    const attempt = loadImage(endpoint, archive, controller.signal);
    await new Promise((r) => setTimeout(r, 50));
    controller.abort();
    await expect(attempt).rejects.toThrow('cancelled');
    expect(archive.destroyed).toBe(true);
  });
});

describe('listImages', () => {
  it('refuses an oversized answer', async () => {
    daemon.switches.oversize = 'list';
    await expect(listImages(endpoint)).rejects.toThrow(OVERSIZED);
  });
});
