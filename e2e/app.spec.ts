import { test, expect, ElectronApplication, Page } from '@playwright/test';
import { launchElectron, closeElectron, getConsoleErrors } from './electron';

test.describe('localmost App', () => {
  let app: ElectronApplication;
  let page: Page;

  test.beforeAll(async () => {
    const result = await launchElectron();
    app = result.app;
    page = result.page;
  });

  test.afterAll(async () => {
    await closeElectron();
  });

  test('should launch the app', async () => {
    expect(app).toBeDefined();
    expect(page).toBeDefined();
  });

  test('should load preload script successfully', async () => {
    // Verify window.localmost API is exposed by preload script
    const hasLocalmostAPI = await page.evaluate(() => {
      return typeof (window as any).localmost !== 'undefined';
    });
    expect(hasLocalmostAPI).toBe(true);

    // Verify window.zubridge API is exposed by preload script
    const hasZubridgeAPI = await page.evaluate(() => {
      return typeof (window as any).zubridge !== 'undefined';
    });
    expect(hasZubridgeAPI).toBe(true);
  });

  test('should display the app title', async () => {
    const title = await page.locator('[data-testid="titlebar"] h1').textContent();
    expect(title).toBe('localmost');
  });

  test('should show settings page on first launch (needs setup)', async () => {
    // On first launch, the app should redirect to settings for setup
    await page.waitForSelector('h2');
    const header = await page.locator('h2').first().textContent();
    // Either Settings (needs setup) or Status (already configured)
    expect(['Settings', 'Status']).toContain(header);
  });
});

test.describe('Settings Page', () => {
  let app: ElectronApplication;
  let page: Page;

  test.beforeAll(async () => {
    const result = await launchElectron();
    app = result.app;
    page = result.page;
  });

  test.afterAll(async () => {
    await closeElectron();
  });

  test('should display GitHub Account section', async () => {
    // Navigate to settings if not already there
    const settingsButton = page.locator('[title="Settings"]');
    if (await settingsButton.isVisible()) {
      await settingsButton.click();
    }

    await expect(page.getByRole('heading', { name: 'GitHub Account' })).toBeVisible();
  });

  test('should display sign in button when not authenticated', async () => {
    await expect(page.getByRole('button', { name: 'Sign in with GitHub' })).toBeVisible();
  });

  test('should display Runner Binary section', async () => {
    await expect(page.getByRole('heading', { name: 'Runner Binary' })).toBeVisible();
  });

  test('should display Appearance section', async () => {
    await expect(page.getByRole('heading', { name: 'Appearance' })).toBeVisible();
  });

  test('should have theme options', async () => {
    await expect(page.getByRole('button', { name: 'Light' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Dark' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Auto' })).toBeVisible();
  });

  test('should change theme when clicking theme option', async () => {
    const darkButton = page.locator('button:has-text("Dark")');
    await darkButton.click();

    // Check that the dark theme is applied
    const theme = await page.evaluate(() => {
      return document.documentElement.getAttribute('data-theme');
    });
    expect(theme).toBe('dark');
  });

  test('should display Power section', async () => {
    await expect(page.getByRole('heading', { name: 'Power' })).toBeVisible();
  });

  test('should display History section', async () => {
    await expect(page.getByRole('heading', { name: 'History' })).toBeVisible();
  });

  test('should close settings when clicking close button', async () => {
    const closeButton = page.locator('[title="Close settings"]');
    if (await closeButton.isVisible()) {
      await closeButton.click();
      await expect(page.locator('text=Status')).toBeVisible();
    }
  });
});

test.describe('Status Page', () => {
  let app: ElectronApplication;
  let page: Page;

  test.beforeAll(async () => {
    const result = await launchElectron();
    app = result.app;
    page = result.page;

    // Navigate back to status if on settings
    const closeButton = page.locator('[title="Close settings"]');
    if (await closeButton.isVisible()) {
      await closeButton.click();
    }
  });

  test.afterAll(async () => {
    await closeElectron();
  });

  test('should display status header', async () => {
    await expect(page.locator('h2:has-text("Status")')).toBeVisible();
  });

  test('should display GitHub status item', async () => {
    await expect(page.getByText('GitHub', { exact: true })).toBeVisible();
  });

  test('should display Runner status item', async () => {
    await expect(page.locator('[data-testid="status-item-label"]:has-text("Runner")')).toBeVisible();
  });

  test('should display Job status item', async () => {
    await expect(page.locator('[data-testid="status-item-label"]:has-text("Job")')).toBeVisible();
  });

  test('should display Logs section', async () => {
    await expect(page.locator('h3:has-text("Logs")')).toBeVisible();
  });

  test('should expand logs when clicked', async () => {
    const logsHeader = page.locator('[data-testid="logs-header"]');
    await logsHeader.click();

    // Wait for expansion
    await page.waitForTimeout(300);

    // Check if expanded (should show "No logs yet" or log entries)
    const logsContent = page.locator('[data-testid="logs-content"]');
    await expect(logsContent).toBeVisible();
  });

  test('should navigate to settings when clicking gear icon', async () => {
    const settingsButton = page.locator('[title="Settings"]');
    await settingsButton.click();

    await expect(page.locator('h2:has-text("Settings")')).toBeVisible();
  });
});

test.describe('Navigation', () => {
  let app: ElectronApplication;
  let page: Page;

  test.beforeAll(async () => {
    const result = await launchElectron();
    app = result.app;
    page = result.page;
  });

  test.afterAll(async () => {
    await closeElectron();
  });

  test('should navigate between status and settings', async () => {
    // Go to settings
    const settingsButton = page.locator('[title="Settings"]');
    if (await settingsButton.isVisible()) {
      await settingsButton.click();
      await expect(page.locator('h2:has-text("Settings")')).toBeVisible();
    }

    // Go back to status
    const closeButton = page.locator('[title="Close settings"]');
    if (await closeButton.isVisible()) {
      await closeButton.click();
      await expect(page.locator('h2:has-text("Status")')).toBeVisible();
    }
  });
});

test.describe('Theme Persistence', () => {
  let app: ElectronApplication;
  let page: Page;

  test.beforeAll(async () => {
    const result = await launchElectron();
    app = result.app;
    page = result.page;
  });

  test.afterAll(async () => {
    await closeElectron();
  });

  test('should persist theme selection', async () => {
    // Navigate to settings
    const settingsButton = page.locator('[title="Settings"]');
    if (await settingsButton.isVisible()) {
      await settingsButton.click();
    }

    // Select light theme
    const lightButton = page.locator('button:has-text("Light")');
    await lightButton.click();

    let theme = await page.evaluate(() => {
      return document.documentElement.getAttribute('data-theme');
    });
    expect(theme).toBe('light');

    // Select dark theme
    const darkButton = page.locator('button:has-text("Dark")');
    await darkButton.click();

    theme = await page.evaluate(() => {
      return document.documentElement.getAttribute('data-theme');
    });
    expect(theme).toBe('dark');

    // Select auto theme
    const autoButton = page.locator('button:has-text("Auto")');
    await autoButton.click();

    // Auto theme should resolve to light or dark based on system preference
    theme = await page.evaluate(() => {
      return document.documentElement.getAttribute('data-theme');
    });
    expect(['light', 'dark']).toContain(theme);
  });
});

test.describe('UI Components', () => {
  let app: ElectronApplication;
  let page: Page;

  test.beforeAll(async () => {
    const result = await launchElectron();
    app = result.app;
    page = result.page;
  });

  test.afterAll(async () => {
    await closeElectron();
  });

  test('should have a titlebar', async () => {
    await expect(page.locator('[data-testid="titlebar"]')).toBeVisible();
  });

  test('should have proper app name in titlebar', async () => {
    const title = await page.locator('[data-testid="titlebar"] h1').textContent();
    expect(title?.toLowerCase()).toContain('localmost');
  });

  test('should have a main content area', async () => {
    await expect(page.locator('[data-testid="status-page"], [data-testid="settings-page"]')).toBeVisible();
  });

  test('should have scrollable content', async () => {
    const overflowY = await page
      .locator('[data-testid="page-content"]')
      .evaluate((el) => getComputedStyle(el).overflowY);
    expect(['auto', 'scroll', 'overlay']).toContain(overflowY);
  });
});

test.describe('Settings Sections', () => {
  let app: ElectronApplication;
  let page: Page;

  test.beforeAll(async () => {
    const result = await launchElectron();
    app = result.app;
    page = result.page;

    // Navigate to settings
    const settingsButton = page.locator('[title="Settings"]');
    if (await settingsButton.isVisible()) {
      await settingsButton.click();
    }
  });

  test.afterAll(async () => {
    await closeElectron();
  });

  test('should display all settings sections', async () => {
    await expect(page.getByRole('heading', { name: 'GitHub Account' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Runner Binary' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'History' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Power' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Appearance' })).toBeVisible();
  });

  test('should have version display in Runner Binary section', async () => {
    // Should show either version info or "Not downloaded"
    const versionText = page.locator('[data-testid="settings-section"]:has-text("Runner Binary")');
    await expect(versionText).toBeVisible();
  });

  test('should have sleep protection options in Power section', async () => {
    const powerSection = page.locator('[data-testid="settings-section"]:has-text("Power")');
    await expect(powerSection).toBeVisible();
  });

  test('should have job history setting in History section', async () => {
    const historySection = page.locator('[data-testid="settings-section"]:has-text("History")');
    await expect(historySection).toBeVisible();
  });
});

test.describe('Status Indicators', () => {
  let app: ElectronApplication;
  let page: Page;

  test.beforeAll(async () => {
    const result = await launchElectron();
    app = result.app;
    page = result.page;

    // Navigate to status page
    const closeButton = page.locator('[title="Close settings"]');
    if (await closeButton.isVisible()) {
      await closeButton.click();
    }
  });

  test.afterAll(async () => {
    await closeElectron();
  });

  test('should show GitHub connection status', async () => {
    // Should show either "Connected" or "Sign in"
    const githubStatus = page.locator('[data-testid="status-item"]').filter({ has: page.locator('[data-testid="status-item-label"]', { hasText: 'GitHub' }) }).first();
    await expect(githubStatus).toBeVisible();
  });

  test('should show runner status', async () => {
    // Should show status like "Offline", "Listening", "Busy"
    const runnerStatus = page.locator('[data-testid="status-item"]').filter({ has: page.locator('[data-testid="status-item-label"]', { hasText: 'Runner' }) }).first();
    await expect(runnerStatus).toBeVisible();
  });

  test('should show job status', async () => {
    // Should show "Idle" or job name
    const jobStatus = page.locator('[data-testid="status-item"]').filter({ has: page.locator('[data-testid="status-item-label"]', { hasText: 'Job' }) }).first();
    await expect(jobStatus).toBeVisible();
  });
});

test.describe('Error Handling', () => {
  let app: ElectronApplication;
  let page: Page;

  test.beforeAll(async () => {
    const result = await launchElectron();
    app = result.app;
    page = result.page;
  });

  test.afterAll(async () => {
    await closeElectron();
  });

  test('should not show any console errors on load', async () => {
    // Errors are collected from launch (see electron.ts). Attaching the
    // listener here would miss everything that happened during load.
    await page.waitForTimeout(1000);

    // Filter out expected errors (like network requests in test environment)
    const unexpectedErrors = getConsoleErrors().filter(
      (e) => !e.includes('net::ERR') && !e.includes('Failed to load resource')
    );

    expect(unexpectedErrors).toHaveLength(0);
  });

  test('should handle keyboard navigation', async () => {
    // Tab should move focus onto an actually interactive element
    await page.keyboard.press('Tab');
    const focused = await page.evaluate(() => {
      const el = document.activeElement;
      return el ? { tag: el.tagName } : null;
    });
    expect(focused).not.toBeNull();
    expect(['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'A']).toContain(focused!.tag);
  });
});

test.describe('Responsive Layout', () => {
  let app: ElectronApplication;
  let page: Page;

  test.beforeAll(async () => {
    const result = await launchElectron();
    app = result.app;
    page = result.page;
  });

  test.afterAll(async () => {
    await closeElectron();
  });

  test('should maintain layout at minimum size', async () => {
    // Get the window
    const window = await app.firstWindow();

    // Set to minimum expected size
    await window.setViewportSize({ width: 400, height: 300 });

    // Check that main elements are still visible
    await expect(page.locator('[data-testid="titlebar"]')).toBeVisible();
  });

  test('should handle larger window sizes', async () => {
    const window = await app.firstWindow();

    // Set to larger size
    await window.setViewportSize({ width: 800, height: 600 });

    // Check that layout adapts
    await expect(page.locator('[data-testid="status-page"], [data-testid="settings-page"]')).toBeVisible();
  });
});
