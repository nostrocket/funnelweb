import { test, expect, devices } from '@playwright/test';

// Regression: in Safari/WebKit, fire-and-forget IDB writes from the Update-
// filter button (`void store.flushPersist()`) left the transaction with no JS
// continuation holding it open, and a refresh saw the old filter even though
// the UI said "Filter updated." The handler now awaits the persist before
// confirming success, so by the time the user sees the confirmation the
// transaction has committed.
test.use({ ...devices['Desktop Safari'] });

test('WebKit: Simple-mode filter update persists across reload', async ({ page }) => {
  await page.goto('/');
  await page.locator('label.inline:has-text("Simple") input[type=radio]').check();
  await page.locator('#panel-filter label:has-text("Kinds") input').first().fill('77');
  await page.locator('#panel-filter button:has-text("Update filter")').click();
  await page.locator('#panel-filter .muted:has-text("Filter updated.")').waitFor({ timeout: 5000 });
  await page.reload();
  await page.locator('label.inline:has-text("Simple") input[type=radio]').check();
  await expect(page.locator('#panel-filter label:has-text("Kinds") input').first()).toHaveValue('77');
});
