import { describe, it, expect } from '@jest/globals';
import {
  isEmptyDockerPolicy,
  validateDockerPolicy,
  mergeDockerPolicy,
  diffDockerPolicy,
  serializeDockerPolicy,
  DockerPolicy,
} from './docker-policy';

describe('docker policy', () => {
  it('treats an absent or all-empty docker policy as empty', () => {
    expect(isEmptyDockerPolicy(undefined)).toBe(true);
    expect(isEmptyDockerPolicy({})).toBe(true);
    const granted: DockerPolicy = { run: { images: ['postgres:16'] } };
    expect(isEmptyDockerPolicy(granted)).toBe(false);
  });
});

describe('validateDockerPolicy', () => {
  const collect = (value: unknown, path = 'shared.docker') => {
    const errs: string[] = [];
    validateDockerPolicy(value, path, (m) => errs.push(m));
    return errs;
  };

  it('rejects the old string levels with a message naming the new actions', () => {
    for (const level of ['socket', 'contexts', 'credentials', 'true']) {
      const errs = collect(level);
      expect(errs.join('\n')).toMatch(/no longer.*use `pull`, `run`, `build`/i);
    }
  });

  it('rejects docker: true the same way, since YAML reads it as a boolean', () => {
    expect(collect(true).join('\n')).toMatch(/no longer.*use `pull`, `run`, `build`/i);
  });

  it('accepts an empty action block, which grants nothing', () => {
    expect(collect({})).toEqual([]);
  });

  it('accepts a run policy with images, mounts and network', () => {
    expect(collect({ run: { images: ['postgres:16'], mounts: [{ path: './', mode: 'ro' }], network: 'bridge' } })).toEqual([]);
  });

  it('accepts pull, build and privileged alongside run', () => {
    expect(collect({
      pull: { registries: ['docker.io', 'ghcr.io'] },
      run: { images: ['postgres:16'] },
      build: { context: './' },
      privileged: true,
    })).toEqual([]);
  });

  it('rejects an unknown docker action', () => {
    expect(collect({ exec: {} }).join('\n')).toMatch(/unknown docker action.*exec/i);
  });

  it('rejects anything that is not an object of actions', () => {
    expect(collect(['run']).join('\n')).toMatch(/must be an object of docker actions/i);
    expect(collect(null).join('\n')).toMatch(/must be an object of docker actions/i);
    expect(collect(7).join('\n')).toMatch(/must be an object of docker actions/i);
  });

  it('rejects a mount without a valid mode', () => {
    expect(collect({ run: { mounts: [{ path: './', mode: 'write' }] } }).join('\n')).toMatch(/mount mode must be 'ro' or 'rw'/i);
  });

  it('rejects a mount without a path', () => {
    expect(collect({ run: { mounts: [{ mode: 'ro' }] } }).join('\n')).toMatch(/mounts\[0\]\.path must be a string/i);
  });

  it('rejects run conditions of the wrong shape, naming the path', () => {
    expect(collect({ run: { images: 'postgres:16' } }).join('\n')).toMatch(/shared\.docker\.run\.images must be an array/i);
    expect(collect({ run: { images: [16] } }).join('\n')).toMatch(/shared\.docker\.run\.images\[0\] must be a string/i);
    expect(collect({ run: { network: ['bridge'] } }).join('\n')).toMatch(/shared\.docker\.run\.network must be a string/i);
    expect(collect({ run: 'yes' }).join('\n')).toMatch(/shared\.docker\.run must be an object/i);
  });

  it('requires registries on pull', () => {
    expect(collect({ pull: {} }).join('\n')).toMatch(/shared\.docker\.pull\.registries must be an array/i);
    expect(collect({ pull: { registries: 'docker.io' } }).join('\n')).toMatch(/shared\.docker\.pull\.registries must be an array/i);
  });

  it('checks build context and privileged types', () => {
    expect(collect({ build: { context: ['./'] } }).join('\n')).toMatch(/shared\.docker\.build\.context must be a string/i);
    expect(collect({ privileged: 'yes' }).join('\n')).toMatch(/shared\.docker\.privileged must be a boolean/i);
  });

  it('reports under the path it was given, so workflow scope reads the same', () => {
    const errs = collect({ exec: {} }, 'workflows.integration.docker');
    expect(errs[0]).toMatch(/^workflows\.integration\.docker/);
  });
});

describe('mergeDockerPolicy', () => {
  it('composes shared and workflow docker policy additively', () => {
    const merged = mergeDockerPolicy(
      { run: { images: ['postgres:16'], mounts: [{ path: './', mode: 'ro' }] } },
      { run: { mounts: [{ path: './tmp/fixtures', mode: 'rw' }] } },
    );
    expect(merged?.run?.images).toEqual(['postgres:16']);
    expect(merged?.run?.mounts).toEqual([
      { path: './', mode: 'ro' },
      { path: './tmp/fixtures', mode: 'rw' },
    ]);
  });

  it('dedupes repeated images, registries and mounts', () => {
    const merged = mergeDockerPolicy(
      { pull: { registries: ['docker.io'] }, run: { images: ['postgres:16'], mounts: [{ path: './', mode: 'ro' }] } },
      { pull: { registries: ['docker.io', 'ghcr.io'] }, run: { images: ['postgres:16', 'redis:7'], mounts: [{ path: './', mode: 'ro' }] } },
    );
    expect(merged?.pull?.registries).toEqual(['docker.io', 'ghcr.io']);
    expect(merged?.run?.images).toEqual(['postgres:16', 'redis:7']);
    expect(merged?.run?.mounts).toEqual([{ path: './', mode: 'ro' }]);
  });

  it('keeps an rw mount distinct from an ro mount of the same path', () => {
    const merged = mergeDockerPolicy(
      { run: { mounts: [{ path: './', mode: 'ro' }] } },
      { run: { mounts: [{ path: './', mode: 'rw' }] } },
    );
    expect(merged?.run?.mounts).toEqual([{ path: './', mode: 'ro' }, { path: './', mode: 'rw' }]);
  });

  it('lets the workflow override network and build context, and ORs privileged', () => {
    const merged = mergeDockerPolicy(
      { run: { network: 'bridge' }, build: { context: './' }, privileged: false },
      { run: { network: 'none' }, build: { context: './docker' }, privileged: true },
    );
    expect(merged?.run?.network).toBe('none');
    expect(merged?.build?.context).toBe('./docker');
    expect(merged?.privileged).toBe(true);
  });

  it('keeps the shared network and context when the workflow says nothing', () => {
    const merged = mergeDockerPolicy(
      { run: { network: 'bridge' }, build: { context: './' } },
      { run: { images: ['redis:7'] } },
    );
    expect(merged?.run?.network).toBe('bridge');
    expect(merged?.build?.context).toBe('./');
    expect(merged?.privileged).toBeUndefined();
  });

  it('passes a lone side through and yields undefined when both are empty', () => {
    const only: DockerPolicy = { run: { images: ['postgres:16'] } };
    expect(mergeDockerPolicy(only, undefined)).toEqual(only);
    expect(mergeDockerPolicy(undefined, only)).toEqual(only);
    expect(mergeDockerPolicy(undefined, undefined)).toBeUndefined();
    expect(mergeDockerPolicy({}, {})).toBeUndefined();
  });

  it('does not invent an action neither side declared', () => {
    const merged = mergeDockerPolicy({ run: { images: ['postgres:16'] } }, { pull: { registries: ['docker.io'] } });
    expect(merged?.build).toBeUndefined();
    expect(Object.keys(merged!).sort()).toEqual(['pull', 'run']);
  });
});

describe('diffDockerPolicy', () => {
  it('reports each added docker grant so the approval diff shows it', () => {
    const diffs = diffDockerPolicy(undefined, { run: { images: ['postgres:16'] }, pull: { registries: ['docker.io'] } }, 'shared.docker');
    const paths = diffs.map((d) => d.path);
    expect(paths).toContain('shared.docker.run.images');
    expect(paths).toContain('shared.docker.pull.registries');
    expect(diffs.every((d) => d.type === 'added')).toBe(true);
  });

  it('names the value of each list entry, one entry per line', () => {
    const diffs = diffDockerPolicy(
      { run: { images: ['postgres:16'] } },
      { run: { images: ['postgres:16', 'redis:7'] }, pull: { registries: ['docker.io', 'ghcr.io'] } },
      'shared.docker',
    );
    expect(diffs).toEqual(expect.arrayContaining([
      { path: 'shared.docker.run.images', type: 'added', newValue: 'redis:7' },
      { path: 'shared.docker.pull.registries', type: 'added', newValue: 'docker.io' },
      { path: 'shared.docker.pull.registries', type: 'added', newValue: 'ghcr.io' },
    ]));
    expect(diffs).toHaveLength(3);
  });

  it('reports removed grants', () => {
    const diffs = diffDockerPolicy({ run: { images: ['postgres:16'] }, build: { context: './' } }, undefined, 'shared.docker');
    expect(diffs).toEqual(expect.arrayContaining([
      { path: 'shared.docker.run.images', type: 'removed', oldValue: 'postgres:16' },
      { path: 'shared.docker.build.context', type: 'removed', oldValue: './' },
    ]));
    expect(diffs).toHaveLength(2);
  });

  it('shows a mount as path:mode, so widening ro to rw reads as a removal and an addition', () => {
    const diffs = diffDockerPolicy(
      { run: { mounts: [{ path: './', mode: 'ro' }] } },
      { run: { mounts: [{ path: './', mode: 'rw' }] } },
      'workflows.integration.docker',
    );
    expect(diffs).toEqual(expect.arrayContaining([
      { path: 'workflows.integration.docker.run.mounts', type: 'added', newValue: './:rw' },
      { path: 'workflows.integration.docker.run.mounts', type: 'removed', oldValue: './:ro' },
    ]));
    expect(diffs).toHaveLength(2);
  });

  it('reports scalar changes to network, context and privileged', () => {
    const diffs = diffDockerPolicy(
      { run: { network: 'bridge' }, build: { context: './' } },
      { run: { network: 'none' }, build: { context: './' }, privileged: true },
      'shared.docker',
    );
    expect(diffs).toEqual(expect.arrayContaining([
      { path: 'shared.docker.run.network', type: 'changed', oldValue: 'bridge', newValue: 'none' },
      { path: 'shared.docker.privileged', type: 'added', newValue: 'true' },
    ]));
    expect(diffs).toHaveLength(2);
  });

  it('reports nothing when the grants are the same, however they are spelled', () => {
    const a: DockerPolicy = { run: { images: ['postgres:16'], mounts: [{ path: './', mode: 'ro' }] }, privileged: false };
    const b: DockerPolicy = { run: { mounts: [{ path: './', mode: 'ro' }], images: ['postgres:16'] } };
    expect(diffDockerPolicy(a, b, 'shared.docker')).toEqual([]);
    expect(diffDockerPolicy(undefined, {}, 'shared.docker')).toEqual([]);
    expect(diffDockerPolicy(undefined, undefined, 'shared.docker')).toEqual([]);
  });
});

describe('serializeDockerPolicy', () => {
  it('writes the block under the given indent in the documented shape', () => {
    const lines = serializeDockerPolicy({
      pull: { registries: ['docker.io'] },
      run: { images: ['postgres:16'], mounts: [{ path: './', mode: 'ro' }], network: 'bridge' },
      build: { context: './' },
      privileged: true,
    }, '  ');
    expect(lines).toEqual([
      '  docker:',
      '    pull:',
      '      registries:',
      '        - "docker.io"',
      '    run:',
      '      images:',
      '        - "postgres:16"',
      '      mounts:',
      '        - path: "./"',
      '          mode: ro',
      '      network: bridge',
      '    build:',
      '      context: "./"',
      '    privileged: true',
    ]);
  });

  it('writes only the actions the policy declares', () => {
    expect(serializeDockerPolicy({ run: { images: ['redis:7'] } }, '    ')).toEqual([
      '    docker:',
      '      run:',
      '        images:',
      '          - "redis:7"',
    ]);
  });

  it('keeps a bare action, since run with no conditions still permits start and wait', () => {
    expect(serializeDockerPolicy({ run: {} }, '')).toEqual(['docker:', '  run: {}']);
  });

  it('writes nothing for a policy that grants nothing', () => {
    expect(serializeDockerPolicy({}, '  ')).toEqual([]);
    expect(serializeDockerPolicy({ privileged: false }, '  ')).toEqual([]);
  });
});
