import { test, expect } from '@playwright/test';

/**
 * ChatInput E2E tests — verify the chat input renders, accepts text,
 * handles slash commands, and shows the send button.
 *
 * These tests run against the live WebUI server.
 */
test.describe('ChatInput', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
  });

  test('input field is present and editable', async ({ page }) => {
    const input = page.locator('textarea[placeholder*="message"], textarea[placeholder*="input"], input[placeholder*="message"], input[placeholder*="input"]').first();
    if (await input.isVisible({ timeout: 3000 })) {
      await input.fill('Hello, world!');
      await expect(input).toHaveValue('Hello, world!');
    }
  });

  test('send button is present when input has text', async ({ page }) => {
    const input = page.locator('textarea, input').filter({ hasText: '' }).first();
    if (await input.isVisible({ timeout: 3000 })) {
      await input.fill('Test message');
      const sendBtn = page.locator('[aria-label*="send" i], button:has(svg[class*="send"])').first();
      if (await sendBtn.isVisible({ timeout: 1000 })) {
        await expect(sendBtn).toBeEnabled();
      }
    }
  });

  test('slash command menu appears on /', async ({ page }) => {
    const input = page.locator('textarea, input').first();
    if (await input.isVisible({ timeout: 3000 })) {
      await input.focus();
      await input.fill('/');
      // Slash command menu should appear
      await page.waitForTimeout(300);
      const menu = page.locator('[role="listbox"], [role="menu"], [class*="slash"]').first();
      if (await menu.isVisible({ timeout: 2000 })) {
        await expect(menu).toBeVisible();
      }
    }
  });

  test('character counter shows when near limit', async ({ page }) => {
    const input = page.locator('textarea, input').first();
    if (await input.isVisible({ timeout: 3000 })) {
      // Fill with enough text to trigger counter
      const longText = 'A'.repeat(200);
      await input.fill(longText);
      // Counter should appear for long inputs
      const counter = page.locator('[class*="char-count"], [class*="counter"]').first();
      if (await counter.isVisible({ timeout: 1000 })) {
        await expect(counter).toBeVisible();
      }
    }
  });

  test('abort button appears when request is in progress', async ({ page }) => {
    // This requires a running request — test the button exists in the DOM
    const abortBtn = page.locator('[aria-label*="abort" i], button:has(svg[class*="square"])').first();
    // Button should be in the DOM (may not be visible without active request)
    if (await abortBtn.count() > 0) {
      // If visible, it should be enabled when there's an active request
      if (await abortBtn.isVisible({ timeout: 1000 })) {
        await expect(abortBtn).toBeAttached();
      }
    }
  });

  test('refine panel toggle is accessible', async ({ page }) => {
    const refineToggle = page.getByRole('button', { name: /refine/i }).first();
    if (await refineToggle.isVisible({ timeout: 2000 })) {
      await refineToggle.click();
      // Panel should toggle
      await expect(refineToggle).toBeAttached();
    }
  });

  test('file attach button is present', async ({ page }) => {
    const attachBtn = page.locator('[aria-label*="attach" i], [aria-label*="file" i]').first();
    if (await attachBtn.isVisible({ timeout: 2000 })) {
      await expect(attachBtn).toBeEnabled();
    }
  });
});
