import { inheritedWorkerEnv, spawnEnvPolicy } from './worker-env';

describe('inheritedWorkerEnv', () => {
  const host: NodeJS.ProcessEnv = {
    PATH: '/usr/bin:/bin',
    HOME: '/Users/me',
    USER: 'me',
    LOGNAME: 'me',
    SHELL: '/bin/zsh',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    LC_CTYPE: 'UTF-8',
    TERM: 'xterm-256color',
    TZ: 'Europe/Berlin',
    __CF_USER_TEXT_ENCODING: '0x1F5:0x0:0x0',
    FOO_SECRET: 'hunter2',
    AWS_SECRET_ACCESS_KEY: 'aws',
    GITHUB_TOKEN: 'ghp_x',
    SSH_AUTH_SOCK: '/private/tmp/com.apple.launchd.x/Listeners',
    NODE_OPTIONS: '--require /tmp/x.js',
    NO_PROXY: '*',
    LOCALMOST_CONFIG_DIR: '/Users/me/.localmost-dev',
    DEVELOPER_DIR: '/Applications/Xcode-beta.app/Contents/Developer',
    FASTLANE_USER: 'me@example.com',
    FASTLANEX: 'no',
  };

  it("passes only the baseline of the app's own environment", () => {
    // Whatever the app was launched with - a shell full of tokens, an agent
    // socket, NODE_OPTIONS - is not the job's to see or to be steered by.
    expect(inheritedWorkerEnv(host)).toEqual({
      PATH: '/usr/bin:/bin',
      HOME: '/Users/me',
      USER: 'me',
      LOGNAME: 'me',
      SHELL: '/bin/zsh',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8',
      LC_CTYPE: 'UTF-8',
      TERM: 'xterm-256color',
      TZ: 'Europe/Berlin',
      __CF_USER_TEXT_ENCODING: '0x1F5:0x0:0x0',
    });
  });

  it('adds what the policy allows, by name or trailing wildcard', () => {
    const env = inheritedWorkerEnv(host, { allow: ['DEVELOPER_DIR', 'FASTLANE_*'] });
    expect(env.DEVELOPER_DIR).toBe(host.DEVELOPER_DIR);
    expect(env.FASTLANE_USER).toBe('me@example.com');
    expect(env.FASTLANEX).toBeUndefined();
    expect(env.FOO_SECRET).toBeUndefined();
  });

  it('treats a pattern as a name, not a regular expression', () => {
    const env = inheritedWorkerEnv({ AxB: '1', 'A.B': '2', AB: '3' }, { allow: ['A.B'] });
    expect(env).toEqual({ 'A.B': '2' });
  });

  it('lets deny take away what the baseline or an allow would pass', () => {
    const env = inheritedWorkerEnv(host, { allow: ['AWS_*', 'FASTLANE_*'], deny: ['AWS_SECRET_*', 'LC_*', 'TZ'] });
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.LC_ALL).toBeUndefined();
    expect(env.LC_CTYPE).toBeUndefined();
    expect(env.TZ).toBeUndefined();
    expect(env.FASTLANE_USER).toBe('me@example.com');
    expect(env.PATH).toBe(host.PATH);
  });

  it('skips unset variables rather than passing them as empty', () => {
    expect(inheritedWorkerEnv({ PATH: '/bin', HOME: undefined })).toEqual({ PATH: '/bin' });
  });
});

describe('spawnEnvPolicy', () => {
  it('takes allow from shared, and deny from shared and every workflow', () => {
    // The worker's environment is fixed at spawn, before the workflow is
    // known. A per-workflow allow cannot be honoured there, so it is not
    // applied; a per-workflow deny can be, conservatively, for every workflow
    // - a deny that did not apply would be the unsafe direction.
    const policy = spawnEnvPolicy({
      version: 1,
      shared: { env: { allow: ['DEVELOPER_DIR', 'AWS_REGION'], deny: ['GITHUB_TOKEN'] } },
      workflows: {
        deploy: { env: { allow: ['FASTLANE_*'], deny: ['AWS_*'] } },
        build: {},
      },
    });
    expect(policy).toEqual({ allow: ['DEVELOPER_DIR', 'AWS_REGION'], deny: ['GITHUB_TOKEN', 'AWS_*'] });
  });

  it('is empty for a policy that says nothing about env', () => {
    expect(spawnEnvPolicy({ version: 1 })).toEqual({ allow: [], deny: [] });
  });
});
