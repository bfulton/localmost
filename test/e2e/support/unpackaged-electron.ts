/**
 * Electron main's modules as the e2e spec loads them: in plain Node, where
 * `require('electron')` is the path of the Electron binary rather than its
 * API. The VM backend's modules read `app.isPackaged` to refuse their
 * test-only options in a packaged app; here they run as an unpackaged one,
 * which is what a checkout's run of the app is.
 *
 * Imported for its effect, before any module that reads `app`. A module that
 * required Electron before this ran keeps the path it got, and must not read
 * `app`; the ones the spec loads that way (the filter's) do not.
 */

import Module from 'module';

const electronId = require.resolve('electron');
const unpackaged = new Module(electronId);
unpackaged.filename = electronId;
unpackaged.loaded = true;
unpackaged.exports = { app: { isPackaged: false } };
require.cache[electronId] = unpackaged;
