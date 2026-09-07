import { describe, it, expect } from '@jest/globals';
import { parseDockerRequest, classifyDockerRequest, containerIdFrom, DockerAction } from './docker-request';

const mk = (method: string, url: string, headers: Record<string, string> = {}, body = Buffer.alloc(0)) =>
  parseDockerRequest({ method, url, headers, body });

describe('parseDockerRequest', () => {
  it('strips the version prefix and classifies container create as run', () => {
    const req = parseDockerRequest({
      method: 'POST', url: '/v1.45/containers/create?name=x',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ Image: 'postgres:16' })),
    });
    expect(req.apiVersion).toBe('v1.45');
    expect(req.path).toBe('/containers/create');
    expect(req.query.name).toBe('x');
    expect((req.body as { Image: string }).Image).toBe('postgres:16');
    expect(classifyDockerRequest(req)).toBe('create');
  });

  it('keeps the raw request alongside the parsed view', () => {
    const raw = { method: 'GET', url: '/v1.45/_ping', headers: { host: 'docker' }, body: Buffer.alloc(0) };
    expect(parseDockerRequest(raw).raw).toBe(raw);
  });

  it('leaves the version undefined and the path intact for an unversioned request', () => {
    const req = mk('GET', '/_ping');
    expect(req.apiVersion).toBeUndefined();
    expect(req.path).toBe('/_ping');
    expect(classifyDockerRequest(req)).toBe('ping');
  });

  it('parses the JSON body only when the content type says JSON', () => {
    const json = Buffer.from(JSON.stringify({ Image: 'postgres:16' }));
    expect(mk('POST', '/v1.45/containers/create', { 'content-type': 'application/json; charset=utf-8' }, json).body)
      .toEqual({ Image: 'postgres:16' });
    expect(mk('POST', '/v1.45/containers/create', { 'Content-Type': 'application/json' }, json).body)
      .toEqual({ Image: 'postgres:16' });
    expect(mk('POST', '/v1.45/build', { 'content-type': 'application/x-tar' }, Buffer.from('not json')).body)
      .toBeUndefined();
    expect(mk('POST', '/v1.45/containers/abc/start', {}, Buffer.alloc(0)).body).toBeUndefined();
  });

  it('records a malformed JSON body instead of throwing, so the filter can refuse it', () => {
    const req = mk('POST', '/v1.45/containers/create', { 'content-type': 'application/json' }, Buffer.from('{not json'));
    expect(req.body).toBeUndefined();
    expect(req.bodyError).toMatch(/JSON/);
    const empty = mk('POST', '/v1.45/containers/abc/start', { 'content-type': 'application/json' }, Buffer.alloc(0));
    expect(empty.body).toBeUndefined();
    expect(empty.bodyError).toBeUndefined();
  });

  it('reads the first value of a repeated query key, as the daemon does', () => {
    const req = mk('POST', '/v1.45/images/create?fromImage=postgres&fromImage=evil&tag=16');
    expect(req.query.fromImage).toBe('postgres');
    expect(req.query.tag).toBe('16');
  });
});

describe('classifyDockerRequest', () => {
  it('classifies ping, image create (pull) and build', () => {
    expect(classifyDockerRequest(mk('GET', '/v1.45/_ping'))).toBe('ping');
    expect(classifyDockerRequest(mk('POST', '/v1.45/images/create?fromImage=postgres&tag=16'))).toBe('pull');
    expect(classifyDockerRequest(mk('POST', '/v1.45/build'))).toBe('build');
  });

  // The verb-to-endpoint map is part of the reviewed surface: every row is
  // asserted here, so a change to it shows up as a test change.
  const table: Array<[string, string, DockerAction]> = [
    ['GET', '/v1.45/_ping', 'ping'],
    ['HEAD', '/v1.45/_ping', 'ping'],
    ['GET', '/v1.45/version', 'version'],
    ['GET', '/v1.45/info', 'info'],
    ['GET', '/v1.45/containers/abc123/json', 'inspect'],
    ['GET', '/v1.45/containers/json', 'list'],
    ['POST', '/v1.45/images/create', 'pull'],
    ['POST', '/v1.45/containers/create', 'create'],
    ['POST', '/v1.45/containers/abc123/start', 'start'],
    ['POST', '/v1.45/containers/abc123/attach', 'attach'],
    ['POST', '/v1.45/containers/abc123/wait', 'wait'],
    ['DELETE', '/v1.45/containers/abc123', 'remove'],
    ['POST', '/v1.45/build', 'build'],
  ];
  it.each(table)('maps %s %s to %s', (method, url, action) => {
    expect(classifyDockerRequest(mk(method, url))).toBe(action);
  });

  it('classifies everything outside the map as other', () => {
    const others: Array<[string, string]> = [
      // /networks/create is a mapped action now; these are not.
      ['PUT', '/v1.45/networks/create'],
      ['POST', '/v1.45/networks/net123'],
      ['POST', '/v1.45/volumes/create'],
      ['POST', '/v1.45/containers/abc123/exec'],
      ['GET', '/v1.45/build'],
      ['GET', '/v1.45/containers/create'],
      ['POST', '/v1.45/containers/create/'],
      ['POST', '/v1.45/containers/abc123/json'],
      ['GET', '/v1.45/containers/abc123'],
      ['DELETE', '/v1.45/containers/abc123/wait'],
      ['GET', '/v1.45'],
      ['GET', '/'],
    ];
    for (const [method, url] of others) {
      expect(classifyDockerRequest(mk(method, url))).toBe('other');
    }
  });
});

describe('container lifecycle endpoints the run action covers', () => {
  const mk = (m: string, u: string) => parseDockerRequest({ method: m, url: u, headers: {}, body: Buffer.alloc(0) });

  it.each([
    ['POST', '/v1.45/containers/abc/kill', 'kill'],
    ['POST', '/v1.45/containers/abc/stop', 'stop'],
    ['GET', '/v1.45/containers/abc/logs?stdout=1', 'logs'],
  ])('maps %s %s to %s', (method, url, action) => {
    expect(classifyDockerRequest(mk(method, url))).toBe(action);
  });

  it('extracts the container id from each of them, so they can be scoped', () => {
    for (const [m, u] of [['POST', '/v1.45/containers/abc/kill'], ['POST', '/v1.45/containers/abc/stop'], ['GET', '/v1.45/containers/abc/logs']] as const) {
      expect(containerIdFrom(mk(m, u))).toBe('abc');
    }
  });
});

describe('request targets that are not plain origin-form paths', () => {
  const parse = (url: string) => parseDockerRequest({ method: 'GET', url, headers: {}, body: Buffer.alloc(0) });

  it('does not throw on a target the URL parser rejects', () => {
    for (const url of ['//', 'http://[', 'http://user@[::1]:99999/x']) {
      expect(() => parse(url)).not.toThrow();
      expect(parse(url).targetError).toBeTruthy();
    }
  });

  it('refuses a target carrying an authority, which the filter and the daemon would read differently', () => {
    // `//evil/x` parses to host=evil, path=/x here, while the daemon reads the
    // request target as written. Judging one and forwarding the other is how a
    // filter gets talked past.
    expect(parse('//evil/v1.45/containers/json').targetError).toBeTruthy();
    expect(parse('http://evil/v1.45/_ping').targetError).toBeTruthy();
  });

  it('leaves an ordinary path alone', () => {
    const req = parse('/v1.45/containers/json?all=1');
    expect(req.targetError).toBeUndefined();
    expect(req.path).toBe('/containers/json');
    expect(req.query.all).toBe('1');
  });
});
