import { _electron as electron, ElectronApplication, Page } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

let electronApp: ElectronApplication | null = null;
let testConfigDir: string | null = null;

export async function launchElectron(): Promise<{ app: ElectronApplication; page: Page }> {
  // Use the production webpack build (file:// URLs, no dev server needed)
  // The architecture-specific path is created by electron-forge during build
  const arch = process.arch;
  const mainPath = path.join(__dirname, '..', '.webpack', arch, 'main');

  // Create an isolated temp config directory for test reproducibility and safety
  // This prevents tests from using/modifying the user's real ~/.localmost settings
  testConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localmost-e2e-'));

  electronApp = await electron.launch({
    args: [mainPath],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      LOCALMOST_CONFIG_DIR: testConfigDir,
    },
  });

  const page = await electronApp.firstWindow();

  // Wait for the app to be ready
  await page.waitForLoadState('domcontentloaded');

  // Wait for React to render (titlebar is always present once app loads)
  await page.waitForSelector('.titlebar', { timeout: 30000 });

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
