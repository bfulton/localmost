import { describe, it, expect } from '@jest/globals';
import { isSensitiveWritePath, sensitiveWriteReason } from './sensitive-paths';

const HOME = '/Users/someone';
const sensitive = (entry: string) => isSensitiveWritePath(entry, HOME);

describe('isSensitiveWritePath', () => {
  it('flags the places whose contents run outside the sandbox', () => {
    for (const entry of [
      '~/Library/LaunchAgents',
      '~/Library/LaunchDaemons',
      '/Library/LaunchAgents',
      '/Library/LaunchDaemons',
      '~/.zshrc',
      '~/.zprofile',
      '~/.bashrc',
      '~/.bash_profile',
      '~/.profile',
      '~/.ssh',
      '~/.gitconfig',
      '~/.config',
      '~/Library/Application Support',
      '/usr/local/bin',
      '/opt/homebrew/bin',
    ]) {
      expect([entry, sensitive(entry)]).toEqual([entry, true]);
    }
  });

  it('flags the home directory and the root themselves, which contain all of them', () => {
    for (const entry of ['~', '~/', '/', HOME, `${HOME}/`, '/Users']) {
      expect([entry, sensitive(entry)]).toEqual([entry, true]);
    }
  });

  it('flags a path inside one, or one that contains one', () => {
    for (const entry of [
      '~/Library/LaunchAgents/com.example.plist',
      '~/.ssh/authorized_keys',
      '~/.config/git',
      '~/Library',
      '/Library',
      '/usr/local',
      '/opt/homebrew',
      '/usr',
    ]) {
      expect([entry, sensitive(entry)]).toEqual([entry, true]);
    }
  });

  it('flags a glob that can reach one', () => {
    for (const entry of ['~/.z*', '~/Lib*', '/Library/Launch*', '~/**', '/*', '~/.ssh/*', '/usr/local/bin/*']) {
      expect([entry, sensitive(entry)]).toEqual([entry, true]);
    }
  });

  it('matches without regard to case, as the default macOS volume does', () => {
    expect(sensitive('~/library/launchagents')).toBe(true);
    expect(sensitive('/USR/LOCAL/BIN')).toBe(true);
  });

  it('resolves an absolute path in the home directory as ~ would', () => {
    expect(sensitive(`${HOME}/.ssh`)).toBe(true);
    expect(sensitive(`${HOME}//Library/./LaunchAgents/`)).toBe(true);
  });

  it('leaves ordinary build and cache paths alone', () => {
    for (const entry of [
      './build',
      './DerivedData/**',
      'build/**',
      '~/.npm',
      '~/.cargo/registry',
      '~/Library/Caches/org.swift.swiftpm',
      '~/.configure-cache',
      '~/Library/Application Supportive',
      '/usr/local/share',
      '/opt/homebrew/Cellar',
      '/Library/Developer',
      '/tmp/out',
      '~/.sshx',
    ]) {
      expect([entry, sensitive(entry)]).toEqual([entry, false]);
    }
  });

  it('says why, so the warning means something to the reader', () => {
    expect(sensitiveWriteReason('~/Library/LaunchAgents', HOME)).toMatch(/launchd/);
    expect(sensitiveWriteReason('~/.zshrc', HOME)).toMatch(/shell/);
    expect(sensitiveWriteReason('/opt/homebrew/bin', HOME)).toMatch(/PATH/);
    expect(sensitiveWriteReason('~/Library', HOME)).toMatch(/LaunchAgents/);
    expect(sensitiveWriteReason('~', HOME)).toMatch(/home directory/);
    expect(sensitiveWriteReason('/', HOME)).toMatch(/whole disk/);
    expect(sensitiveWriteReason('./build', HOME)).toBeUndefined();
  });
});
