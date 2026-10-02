import { inheritedWorkerEnv, javaToolOptions, spawnEnvPolicy } from './worker-env';

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

describe('javaToolOptions', () => {
  const token = 'a1'.repeat(24);
  const proxyUrl = `http://localmost:${token}@127.0.0.1:51234`;
  const home = '/Users/me/.localmost/runner/sandbox/1-ab/home';

  it("puts the JVM's temp in the job's, on IPv4, through the job's proxy with its credentials", () => {
    // The JVM ignores TMPDIR and HTTPS_PROXY, and a dual-stack socket's
    // loopback connection is one the sandbox cannot attribute to loopback.
    expect(javaToolOptions({ tmpDir: '/Users/me/.localmost/runner/sandbox/1-ab/_temp', home, proxyUrl }).split(' ')).toEqual([
      '-Djava.io.tmpdir=/Users/me/.localmost/runner/sandbox/1-ab/_temp',
      // The JVM takes user.home from the user database, not HOME: Maven,
      // Gradle and sbt looked in the real home, where the floor denies
      // their credential files, and failed on them.
      `-Duser.home=${home}`,
      '-Djava.net.preferIPv4Stack=true',
      '-Dhttp.proxyHost=127.0.0.1',
      '-Dhttp.proxyPort=51234',
      '-Dhttps.proxyHost=127.0.0.1',
      '-Dhttps.proxyPort=51234',
      // Read by Gradle and by HTTP clients that take their proxy from the
      // system properties; the JDK's own clients take credentials from an
      // Authenticator, and Basic on a CONNECT tunnel only once these allow it.
      '-Dhttp.proxyUser=localmost',
      `-Dhttp.proxyPassword=${token}`,
      '-Dhttps.proxyUser=localmost',
      `-Dhttps.proxyPassword=${token}`,
      '-Djdk.http.auth.tunneling.disabledSchemes=',
      '-Djdk.http.auth.proxying.disabledSchemes=',
    ]);
  });

  it('leaves out the proxy credentials for a proxy that takes none', () => {
    const options = javaToolOptions({ tmpDir: '/t', home: '/h', proxyUrl: 'http://127.0.0.1:8080' });
    expect(options).toContain('-Dhttps.proxyPort=8080');
    expect(options).not.toContain('proxyUser');
    expect(options).not.toContain('disabledSchemes');
  });

  it('leaves out a value it cannot pass whole, as the JVM splits these on whitespace', () => {
    const options = javaToolOptions({
      tmpDir: '/Users/Jane Doe/.localmost/runner/sandbox/1-ab/_temp',
      home: '/Users/Jane Doe/.localmost/runner/sandbox/1-ab/home',
      proxyUrl,
    });
    expect(options).not.toContain('java.io.tmpdir');
    expect(options).not.toContain('user.home');
    expect(options).toContain('-Djava.net.preferIPv4Stack=true');
  });

  it('leaves out the proxy for a URL it cannot read', () => {
    expect(javaToolOptions({ tmpDir: '/t', home: '/h', proxyUrl: '' })).toBe('-Djava.io.tmpdir=/t -Duser.home=/h -Djava.net.preferIPv4Stack=true');
  });
});
