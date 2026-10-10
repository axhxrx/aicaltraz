/** Pairing UI without a host (web app served alone): token capture and the pairing screen. */
import { expect, test } from '@playwright/test';

test('no token: pairing screen explains how to pair, offers the demo', async ({ page }) => {
  await page.goto('/');
  const s = page.getByTestId('pairing');
  await expect(s).toBeVisible();
  await expect(s).toContainText('QR');
  await expect(page.getByTestId('try-demo')).toHaveAttribute('href', /\?demo/);
});

test('pasting: rejects junk, accepts a pairing link', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('token-input').fill('hello');
  await page.getByTestId('token-submit').click();
  await expect(page.getByTestId('pairing')).toContainText("doesn't look like");
  await page.getByTestId('token-input').fill('http://192.168.1.20:8787/#token=AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde');
  await page.getByTestId('token-submit').click();
  await expect(page.getByTestId('pairing')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('buttpad.token'))).toBe('AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde');
  // No host behind this server: it keeps trying.
  await expect(page.getByTestId('connecting')).toBeVisible();
});

test('#token=… in the URL is stored and stripped from the address bar', async ({ page }) => {
  await page.goto('/?pad=x#token=Zz9_tokenFromQr-abcdefghijklmnop');
  await expect(page.getByTestId('connecting')).toBeVisible();
  expect(new URL(page.url()).hash).toBe('');
  expect(new URL(page.url()).search).toBe('?pad=x');
  expect(await page.evaluate(() => localStorage.getItem('buttpad.token'))).toBe('Zz9_tokenFromQr-abcdefghijklmnop');
  await expect(page.getByTestId('connecting')).toContainText("Can't reach the host", { timeout: 5000 });
});

test('demo link works with no token at all', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('try-demo').click();
  await expect(page.getByTestId('conn')).toHaveAttribute('data-status', 'online');
  await expect(page.locator('.bp-btn').first()).toBeVisible();
});
