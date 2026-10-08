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
      // zsh reads .zshenv for every invocation, scripts' and editors' included.
      '~/.zshenv',
      '~/.zlogin',
      '~/.zlogout',
      '~/.bash_login',
      '~/.ssh',
      '~/.gitconfig',
      '~/.config',
      '~/Library/Application Support',
      '/usr/local/bin',
      '/opt/homebrew/bin',
      '~/.local/bin',
      '~/bin',
      // What your own builds load and run from the package caches: Gradle's
      // init.d, Maven's settings and extensions, cargo's config and bin,
      // and the packages each keeps.
      '~/.gradle',
      '~/.gradle/init.d',
      '~/.m2',
      '~/.cargo',
      '~/.cargo/registry',
      '~/.nuget',
    ]) {
      expect([entry, sensitive(entry)]).toEqual([entry, true]);
    }
  });

  it('sees through the data volume, which mirrors the root under another name', () => {
    for (const entry of [
      '/System/Volumes/Data',
      '/System/Volumes/Data/',
      '/System/Volumes/Data/Library/LaunchDaemons',
      `/System/Volumes/Data${HOME}/Library/LaunchAgents`,
      `/system/volumes/data${HOME}/.zshenv`,
    ]) {
      expect([entry, sensitive(entry)]).toEqual([entry, true]);
    }
    expect(sensitive('/System/Volumes/Data/tmp/out')).toBe(false);
    expect(sensitive('/System/Volumes/Database')).toBe(false);
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
      '~/.cargo-cache',
      '~/.m2x',
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
    // A parent of a place matched by prefix says it takes that place in,
    // not that it is the place.
    expect(sensitiveWriteReason('/Library', HOME)).toMatch(/^includes \/Library\/Launch\*: launchd/);
    expect(sensitiveWriteReason('/Library/LaunchAgents', HOME)).toMatch(/^launchd/);
    expect(sensitiveWriteReason('~/.gradle', HOME)).toMatch(/Gradle runs/);
    expect(sensitiveWriteReason('~', HOME)).toMatch(/home directory/);
    // What the sandbox refuses whatever is granted is not said to be granted.
    expect(sensitiveWriteReason('~', HOME)).not.toMatch(/SSH/);
    // A grant on it, or in it, is said to do nothing rather than described
    // as what it would let a job do: no write to the keys or the commands
    // an SSH config runs.
    for (const entry of [
      '~/.ssh',
      '~/.ssh/authorized_keys',
      '~/.config',
      '~/.config/gh',
      '~/Library/Preferences',
      '~/Library/Preferences/com.apple.dt.Xcode.plist',
    ]) {
      expect([entry, sensitiveWriteReason(entry, HOME)]).toEqual([entry, expect.stringMatching(/refused .*whatever is granted/)]);
    }
    expect(sensitiveWriteReason('~/.ssh', HOME)).not.toMatch(/commands your SSH config runs/);
    expect(sensitiveWriteReason('~/.config', HOME)).not.toMatch(/act on/);
    expect(sensitiveWriteReason('/', HOME)).toMatch(/whole disk/);
    expect(sensitiveWriteReason('./build', HOME)).toBeUndefined();
  });
});
