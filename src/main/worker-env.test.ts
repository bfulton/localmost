import { spawnEnvPolicy, vmWorkerEnv } from './worker-env';

const PROXY = 'http://localmost:token@127.0.0.1:12345';

describe('vmWorkerEnv', () => {
  const host: NodeJS.ProcessEnv = {
    PATH: '/usr/bin:/bin',
    HOME: '/Users/me',
    USER: 'me',
    SHELL: '/bin/zsh',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    LC_CTYPE: 'UTF-8',
    TZ: 'Europe/Berlin',
    __CF_USER_TEXT_ENCODING: '0x1F5:0x0:0x0',
    FOO_SECRET: 'hunter2',
    AWS_SECRET_ACCESS_KEY: 'aws',
    GITHUB_TOKEN: 'ghp_x',
    SSH_AUTH_SOCK: '/private/tmp/com.apple.launchd.x/Listeners',
    NODE_OPTIONS: '--require /tmp/x.js',
    NO_PROXY: '*',
    DEVELOPER_DIR: '/Applications/Xcode-beta.app/Contents/Developer',
    FASTLANE_USER: 'me@example.com',
    FASTLANEX: 'no',
  };
  const RUNNER = {
    ACTIONS_RUNNER_PRINT_LOG_TO_STDOUT: 'true',
    http_proxy: PROXY,
    https_proxy: PROXY,
    HTTP_PROXY: PROXY,
    HTTPS_PROXY: PROXY,
  };

  it("passes the locale and time zone of the app's own environment, and nothing else of it", () => {
    // Whatever the app was launched with - a shell full of tokens, an agent
    // socket, NODE_OPTIONS - is not the job's to see or to be steered by, and
    // the guest has a PATH, HOME and user of its own.
    expect(vmWorkerEnv(host, undefined, PROXY)).toEqual({
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8',
      TZ: 'Europe/Berlin',
      ...RUNNER,
    });
  });

  it('adds what the policy allows, by name or trailing wildcard', () => {
    const env = vmWorkerEnv(host, { allow: ['DEVELOPER_DIR', 'FASTLANE_*'] }, PROXY);
    expect(env.DEVELOPER_DIR).toBe(host.DEVELOPER_DIR);
    expect(env.FASTLANE_USER).toBe('me@example.com');
    expect(env.FASTLANEX).toBeUndefined();
    expect(env.FOO_SECRET).toBeUndefined();
  });

  it('treats a pattern as a name, not a regular expression', () => {
    const env = vmWorkerEnv({ AxB: '1', 'A.B': '2', AB: '3' }, { allow: ['A.B'] }, PROXY);
    expect(env).toEqual({ 'A.B': '2', ...RUNNER });
  });

  it('lets deny take away what the baseline or an allow would pass', () => {
    const env = vmWorkerEnv(host, { allow: ['AWS_*', 'FASTLANE_*'], deny: ['AWS_SECRET_*', 'LC_*', 'TZ'] }, PROXY);
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.LC_ALL).toBeUndefined();
    expect(env.TZ).toBeUndefined();
    expect(env.FASTLANE_USER).toBe('me@example.com');
    expect(env.LANG).toBe('en_US.UTF-8');
  });

  it("keeps the runner's own settings and the proxy whatever the policy allows of the app's", () => {
    const env = vmWorkerEnv({ ...host, HTTPS_PROXY: 'http://elsewhere:8080' }, { allow: ['HTTPS_PROXY', 'ACTIONS_*'] }, PROXY);
    expect(env.HTTPS_PROXY).toBe(PROXY);
    expect(env.ACTIONS_RUNNER_PRINT_LOG_TO_STDOUT).toBe('true');
  });

  it('skips unset variables rather than passing them as empty', () => {
    expect(vmWorkerEnv({ LANG: undefined, TZ: 'UTC' }, undefined, PROXY)).toEqual({ TZ: 'UTC', ...RUNNER });
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
