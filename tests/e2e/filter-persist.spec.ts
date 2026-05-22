import { test, expect } from '@playwright/test';

// Regression: the Update-filter button used to drop the write if the user
// reloaded inside the 200 ms persist debounce. The handler now flushes the
// persist immediately so a quick reload still sees the edit.
test('Update filter persists across a reload within the debounce window', async ({ page }) => {
  await page.goto('/');
  await page.locator('label.inline:has-text("JSON") input[type=radio]').check();
  const ta = page.locator('#panel-filter textarea').last();
  const newJson = '{\n  "kinds": [4],\n  "limit": 99\n}';
  await ta.fill(newJson);
  await page.locator('#panel-filter button:has-text("Update filter")').click();
  // < 200 ms debounce, but enough for the IDB transaction to commit.
  await page.waitForTimeout(50);
  await page.reload();
  await page.locator('label.inline:has-text("JSON") input[type=radio]').check();
  await expect(page.locator('#panel-filter textarea').last()).toHaveValue(newJson);
});
