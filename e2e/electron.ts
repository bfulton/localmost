import { _electron as electron, ElectronApplication, Page } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

let electronApp: ElectronApplication | null = null;
let consoleErrors: string[] = [];

/** Console errors seen since the current app was launched. */
export function getConsoleErrors(): string[] {
  return [...consoleErrors];
}
let testConfigDir: string | null = null;

export async function launchElectron(): Promise<{ app: ElectronApplication; page: Page }> {
  // Use the production webpack build (file:// URLs, no dev server needed).
  // This is the package.json "main" entry that `npm run build` produces.
  const mainPath = path.join(__dirname, '..', 'dist', 'main.js');
  if (!fs.existsSync(mainPath)) {
    throw new Error(`Electron main bundle not found at ${mainPath}. Run "npm run build" first.`);
  }

  // Create an isolated temp config directory for test reproducibility and safety
  // This prevents tests from using/modifying the user's real ~/.localmost settings
  testConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localmost-e2e-'));

  try {
    electronApp = await electron.launch({
      args: [mainPath],
      env: {
        ...process.env,
        NODE_ENV: 'test',
        LOCALMOST_CONFIG_DIR: testConfigDir,
      },
    });
  } catch (err) {
    // localmost holds a single-instance lock, so a copy running on this machine
    // makes the test instance quit during startup. Playwright reports that as a
    // closed browser target, which gives no hint at the real cause.
    throw new Error(
      `Failed to launch Electron: ${(err as Error).message}\n` +
        'If localmost is already running (for example the installed app), quit it first - ' +
        'its single-instance lock causes the test instance to exit immediately.'
    );
  }

  const page = await electronApp.firstWindow();

  // Collect console errors from the moment the window exists, so tests can
  // assert on load-time errors rather than only what happens after they start.
  consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text());
    }
  });

  // Wait for the app to be ready
  await page.waitForLoadState('domcontentloaded');

  // Wait for React to render (titlebar is always present once app loads)
  await page.waitForSelector('[data-testid="titlebar"]', { timeout: 30000 });

  return { app: electronApp, page };
}

export async function closeElectron(): Promise<void> {
  if (electronApp) {
    await electronApp.close();
    electronApp = null;
  }

  // Clean up the temporary config directory
  if (testConfigDir && fs.existsSync(testConfigDir)) {
    fs.rmSync(testConfigDir, { recursive: true, force: true });
    testConfigDir = null;
  }
}

export async function getElectronApp(): Promise<ElectronApplication | null> {
  return electronApp;
}
