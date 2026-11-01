import { expect, test, type Page } from '@playwright/test';
import {
  ACTOR,
  openDestination,
  openTab,
  resetDemo,
  shot,
  trackErrors,
  useActor,
} from './helpers';

async function contrast(page: Page, foreground: string, background: string): Promise<number> {
  return page.evaluate(
    ([foregroundSelector, backgroundSelector]) => {
      const parse = (value: string) => {
        const match = /rgba?\(([^)]+)\)/.exec(value);
        if (!match) throw new Error(`Unsupported colour ${value}`);
        return match[1].split(',').map((part) => Number(part.trim()));
      };
      const luminance = (rgb: number[]) => {
        const channels = rgb.slice(0, 3).map((channel) => {
          const value = channel / 255;
          return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
      };
      const fgElement = document.querySelector(foregroundSelector);
      const bgElement = document.querySelector(backgroundSelector);
      if (!fgElement || !bgElement) throw new Error('Missing contrast target');
      const fg = luminance(parse(getComputedStyle(fgElement).color));
      const bg = luminance(parse(getComputedStyle(bgElement).backgroundColor));
      const lighter = Math.max(fg, bg);
      const darker = Math.min(fg, bg);
      return (lighter + 0.05) / (darker + 0.05);
    },
    [foreground, background] as const,
  );
}

test('failed validation links the error to its field and focuses it', async ({ page }) => {
  const errors = trackErrors(page);
  await resetDemo(page);
  await openDestination(page, 'Inventory');
  await openTab(page, 'Locations');
  await page.getByRole('button', { name: 'New location' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Create location' }).click();

  const name = dialog.getByLabel('Name');
  await expect(name).toBeFocused();
  await expect(name).toHaveAttribute('aria-invalid', 'true');
  const describedBy = await name.getAttribute('aria-describedby');
  expect(describedBy).toBeTruthy();
  await expect(dialog.locator(`#${describedBy?.split(' ').at(-1)}`)).toHaveText(/location name is required/i);
  await expect(dialog.getByRole('alert')).toBeVisible();
  await shot(page, 'remediation-validation-error');
  errors.assertClean();
});

test('hints are programmatically linked and the working chrome has sufficient contrast', async ({
  page,
}) => {
  const errors = trackErrors(page);
  await resetDemo(page);
  await useActor(page, ACTOR.owner);
  await openDestination(page, 'Admin');
  await openTab(page, 'Numbering');
  const kind = page.getByLabel('Record kind');
  const describedBy = await kind.getAttribute('aria-describedby');
  expect(describedBy).toBeTruthy();

  expect(await contrast(page, '.panel-sub', '.panel')).toBeGreaterThanOrEqual(4.5);
  expect(await contrast(page, '.field-hint', '.panel')).toBeGreaterThanOrEqual(4.5);
  expect(await contrast(page, '.brand-name', '.app-header')).toBeGreaterThanOrEqual(4.5);
  expect(await contrast(page, '.demo-stamp', '.app-header')).toBeGreaterThanOrEqual(4.5);
  expect(await contrast(page, 'button.primary', 'button.primary')).toBeGreaterThanOrEqual(4.5);
  errors.assertClean();
});

test('200% layout proxy keeps the page contained and tables scroll inside themselves', async ({
  page,
}) => {
  await page.setViewportSize({ width: 640, height: 450 });
  await resetDemo(page);
  await useActor(page, ACTOR.owner);
  await openDestination(page, 'Admin');
  await openTab(page, 'Numbering');
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
  const table = page.locator('.table-wrap').first();
  await expect(table).toBeVisible();
  const tableOverflow = await table.evaluate((element) => ({
    client: element.clientWidth,
    scroll: element.scrollWidth,
  }));
  expect(tableOverflow.scroll).toBeGreaterThanOrEqual(tableOverflow.client);
  await shot(page, 'remediation-numbering-200-percent-proxy');
  await expect(page.getByText('Local demo · Synthetic data').first()).toBeVisible();
});

test('leaving an inline draft asks before discarding and continues to stay on request', async ({
  page,
}) => {
  await resetDemo(page);
  await useActor(page, ACTOR.owner);
  await openDestination(page, 'Admin');
  await openTab(page, 'Numbering');
  await page.getByLabel('Change reason').fill('Unsaved synthetic policy reason');
  await page
    .getByRole('navigation', { name: 'Admin pages' })
    .getByRole('link', { name: 'Contacts and accounts', exact: true })
    .click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Discard unsaved changes?' })).toBeVisible();
  await shot(page, 'remediation-unsaved-draft');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(page).toHaveURL(/#\/admin\/numbering$/);
  await expect(page.getByLabel('Change reason')).toHaveValue('Unsaved synthetic policy reason');

  await page.getByRole('navigation', { name: 'Admin pages' }).getByRole('link', { name: 'Contacts and accounts' }).click();
  await dialog.getByRole('button', { name: 'Discard changes' }).click();
  await expect(page).toHaveURL(/#\/admin\/masters$/);
  await expect(
    page.getByRole('navigation', { name: 'Admin pages' }).getByRole('link', {
      name: 'Contacts and accounts',
      exact: true,
    }),
  ).toHaveAttribute('aria-current', 'page');
});
