import { test, expect } from '@playwright/test';

// Minimal smoke. The full happy path requires running two relay containers; the
// implementation guide describes that flow. This baseline at least asserts that
// the bundle loads, mounts every panel, and IndexedDB is available.

test('app boots and renders all panels', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#panel-filter h2')).toHaveText(/filter/i);
  await expect(page.locator('#panel-preview h2')).toHaveText(/preview/i);
  await expect(page.locator('#panel-broadcast h2')).toHaveText(/broadcast/i);
});

test('persists source-relay edits across reload', async ({ page }) => {
  await page.goto('/');
  const input = page.locator('#panel-broadcast input[type=url]').first();
  await input.fill('wss://relay.example.com');
  await input.blur();
  // Allow debounce.
  await page.waitForTimeout(400);
  await page.reload();
  await expect(input).toHaveValue('wss://relay.example.com');
});
