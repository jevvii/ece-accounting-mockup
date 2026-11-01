import { expect, test, type Page } from '@playwright/test';
import { resetDemo, shot } from './helpers';

/**
 * Keyboard acceptance. Every interaction below is keyboard-generated: Tab/Shift+Tab
 * to move focus, typing for values, Enter/Space to activate. No locator.click or
 * selectOption is used for the workflow steps.
 */

function activeDescriptor(): string {
  const element = document.activeElement as HTMLElement | null;
  if (!element || element === document.body || element === document.documentElement) return '';
  const label = (element as HTMLInputElement).labels?.[0]?.textContent ?? '';
  return [
    element.getAttribute('aria-label') ?? '',
    label,
    element.textContent ?? '',
    (element as HTMLInputElement).value ?? '',
  ]
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Press Tab until the focused control's label/name contains `name`. */
async function tabTo(page: Page, name: string, maxTabs = 200): Promise<void> {
  for (let index = 0; index < maxTabs; index += 1) {
    await page.keyboard.press('Tab');
    const descriptor = await page.evaluate(activeDescriptor);
    if (descriptor.includes(name)) return;
  }
  throw new Error(`Keyboard focus never reached "${name}" after ${maxTabs} tabs.`);
}

/** Move backwards to an earlier control without using a pointer. */
async function shiftTabTo(page: Page, name: string, maxTabs = 200): Promise<void> {
  for (let index = 0; index < maxTabs; index += 1) {
    await page.keyboard.press('Shift+Tab');
    const descriptor = await page.evaluate(activeDescriptor);
    if (descriptor.includes(name)) return;
  }
  throw new Error(`Keyboard focus never reached "${name}" after ${maxTabs} reverse tabs.`);
}

test('keyboard: skip link, help dialog and Escape work without a pointer', async ({ page }) => {
  await resetDemo(page);
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to main content' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#main-content')).toBeFocused();

  await page.keyboard.press('?');
  await expect(page.getByRole('dialog', { name: 'Keyboard and demo notes' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Keyboard and demo notes' })).toBeHidden();
  await expect(page.locator('.demo-controls summary')).toBeVisible();
});

test('keyboard: create and post an invoice without a pointer', async ({ page }) => {
  await resetDemo(page);

  await tabTo(page, 'New invoice');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'New sales invoice' })).toBeVisible();

  await tabTo(page, 'Line 1 description');
  await page.keyboard.type('Keyboard advisory service');

  await tabTo(page, 'Line 1 unit price');
  await page.keyboard.type('1250.00');

  await tabTo(page, 'Save and post');
  await page.keyboard.press('Enter');

  await expect(page.locator('.toast').filter({ hasText: /Invoice INV-0004 posted/ })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'INV-0004', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'INV-0004', exact: true })).toHaveText(
    'INV-0004',
  );
  await shot(page, 'keyboard-invoice-posted');
});

test('keyboard: create, calculate, switch approver and approve depreciation', async ({ page }) => {
  await resetDemo(page);
  await page.goto('/#/assets');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Fixed Assets');

  await tabTo(page, 'New asset');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Add fixed asset' })).toBeVisible();

  await tabTo(page, 'Company vendor/brand');
  await page.keyboard.type('Synthetic Keyboard Brand');
  await tabTo(page, 'Item Description');
  await page.keyboard.type('Keyboard approved asset');
  await tabTo(page, 'Cost (PHP)');
  await page.keyboard.type('2000.00');
  await tabTo(page, 'Add asset');
  await page.keyboard.press('Enter');

  await expect(page.locator('.toast').filter({ hasText: /Asset FA101 added/ })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Keyboard approved asset' })).toBeVisible();

  // Depreciation is its own task page; reach it with the keyboard, not a pointer.
  await shiftTabTo(page, 'Depreciation');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#\/assets\/depreciation$/);

  // The current actor calculates; the run must then be approved by someone else.
  await tabTo(page, 'Calculate');
  await page.keyboard.press('Enter');
  await expect(page.locator('.toast').filter({ hasText: /Depreciation calculated/ })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Calculated', exact: true }).first()).toBeVisible();

  await tabTo(page, 'Demo controls');
  await page.keyboard.press('Enter');
  await tabTo(page, 'Demo actor');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Demo actor')).toHaveValue('u-checker');

  await tabTo(page, 'Approve calculated');
  await page.keyboard.press('Enter');
  await expect(page.locator('.toast').filter({ hasText: /Approved [12] depreciation row/ })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Approved', exact: true }).first()).toBeVisible();
  await shot(page, 'keyboard-asset-approved');
});
