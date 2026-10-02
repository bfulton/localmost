import { describe, it, expect } from '@jest/globals';
import { store } from './index';

/**
 * The store is bridged to the renderer, so every write it accepts becomes a
 * broadcast and a re-render. A write that changes nothing but the object
 * identity is therefore not free - it is a wake-up for everything watching.
 *
 * An installed build spent five days at 100% CPU on exactly that. The auth
 * status handler called setUser on every query, setUser built a new auth object
 * every time, the bridged store delivered a new `user` identity, and a renderer
 * effect keyed on that object queried again. Each turn crossed IPC, so React's
 * update-depth guard never fired: no error, no log, just two processes
 * spinning until it was force quit.
 */
describe('store writes that change nothing', () => {
  it('does not replace the auth object when the user is unchanged', () => {
    const user = { login: 'bfulton', name: 'Bright Fulton', avatar_url: '' };
    store.getState().setUser(user);
    const first = store.getState().auth;

    store.getState().setUser(user);

    expect(store.getState().auth).toBe(first);
  });

  it('treats an equal-but-distinct user as unchanged, since that is what crosses IPC', () => {
    store.getState().setUser({ login: 'bfulton', name: 'Bright Fulton', avatar_url: '' });
    const first = store.getState().auth;

    // A fresh object with identical content: what the main process rebuilds on
    // every getAuthStatus, and what used to restart the loop.
    store.getState().setUser({ login: 'bfulton', name: 'Bright Fulton', avatar_url: '' });

    expect(store.getState().auth).toBe(first);
  });

  it('still publishes a real change', () => {
    store.getState().setUser({ login: 'bfulton', name: 'Bright Fulton', avatar_url: '' });
    const first = store.getState().auth;

    store.getState().setUser({ login: 'someone-else', name: 'Someone Else', avatar_url: '' });

    expect(store.getState().auth).not.toBe(first);
    expect(store.getState().auth.user?.login).toBe('someone-else');
  });

  it('still publishes a sign-out', () => {
    store.getState().setUser({ login: 'bfulton', name: 'Bright Fulton', avatar_url: '' });

    store.getState().setUser(null);

    expect(store.getState().auth.user).toBeNull();
    expect(store.getState().auth.isAuthenticated).toBe(false);
  });
});
