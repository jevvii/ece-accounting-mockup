import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * Opt-in benchmark. It is deliberately outside the acceptance suite because the
 * 2.5 MB synthetic fixture and repeated full reloads would dominate normal runs.
 * `npm run benchmark` regenerates the fixture and executes this file.
 */

const STORAGE_KEY = 'fin-axis-mockup:app-state:v1';
const SEED_PATH = path.resolve('artifacts/benchmark/seed.json');
const MANIFEST_PATH = path.resolve('artifacts/benchmark/manifest.json');
const RESULTS_PATH = path.resolve('artifacts/benchmark/results.json');

interface Sample {
  targetMs: number;
  timesMs: number[];
  medianMs: number;
  maxMs: number;
  pass: boolean;
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : Number(((sorted[middle - 1]! + sorted[middle]!) / 2).toFixed(2));
}

function summarize(targetMs: number, timesMs: number[]): Sample {
  const rounded = timesMs.map((value) => Number(value.toFixed(2)));
  const medianMs = median(rounded);
  return {
    targetMs,
    timesMs: rounded,
    medianMs,
    maxMs: Math.max(...rounded),
    pass: Math.max(...rounded) <= targetMs,
  };
}

/** Open the All apps switcher and return its link for an app work area. */
async function appLink(page: Page, label: string) {
  const menu = page.locator('.apps-menu');
  const open = await menu.evaluate((element) => element.hasAttribute('open'));
  if (!open) await menu.locator('summary').click();
  return page
    .getByRole('navigation', { name: 'All apps' })
    .getByRole('link', { name: label, exact: true });
}

async function restore(page: Page, stateJson: string, hash: string, sample: number): Promise<void> {
  await page.goto('/?bench=warm#/cash');
  await page.evaluate(
    ([key, json]) => window.localStorage.setItem(key!, json!),
    [STORAGE_KEY, stateJson] as const,
  );
  await page.goto(`/?bench=${sample}#/${hash}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}

test('benchmark: 25 employees / 100 items / 300 invoices / 300 bills / 1,000 bank lines', async ({
  page,
  browser,
}) => {
  test.setTimeout(20 * 60_000);
  const [rawSeed, rawManifest] = await Promise.all([
    fs.readFile(SEED_PATH, 'utf8'),
    fs.readFile(MANIFEST_PATH, 'utf8'),
  ]);
  const stateJson = JSON.stringify(JSON.parse(rawSeed) as unknown);
  const manifest = JSON.parse(rawManifest) as {
    checksum: string;
    bytes: number;
    counts: Record<string, unknown>;
  };

  const listSamples: number[] = [];
  const detailSamples: number[] = [];
  const inventorySamples: number[] = [];
  const reportSamples: number[] = [];
  const payrollSamples: number[] = [];

  for (let sample = 1; sample <= 5; sample += 1) {
    await restore(page, stateJson, 'cash', sample);
    const billingLink = await appLink(page, 'Billing and Collection');
    const listStart = performance.now();
    await billingLink.click();
    await expect(page.getByRole('button', { name: 'INV-0300', exact: true })).toBeVisible();
    listSamples.push(performance.now() - listStart);

    const detailStart = performance.now();
    await page.getByRole('button', { name: 'INV-0300', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Invoice INV-0300', exact: true })).toBeVisible();
    detailSamples.push(performance.now() - detailStart);

    await restore(page, stateJson, 'billing', 100 + sample);
    const inventoryLink = await appLink(page, 'Inventory');
    const inventoryStart = performance.now();
    await inventoryLink.click();
    await expect(page.getByText('BENCH-100', { exact: true })).toBeVisible();
    inventorySamples.push(performance.now() - inventoryStart);

    await restore(page, stateJson, 'billing', 200 + sample);
    const reportLink = await appLink(page, 'Reports');
    const reportStart = performance.now();
    await reportLink.click();
    await expect(page.getByText(/In balance|Balanced/).first()).toBeVisible();
    reportSamples.push(performance.now() - reportStart);
  }

  for (let sample = 1; sample <= 3; sample += 1) {
    await restore(page, stateJson, 'payroll', 300 + sample);
    const controls = page.locator('.demo-controls');
    if (!(await controls.evaluate((element) => element.hasAttribute('open')))) {
      await controls.locator('summary').click();
    }
    await page.getByLabel('Demo actor').selectOption('u-payroll');
    await page
      .getByRole('navigation', { name: 'Payroll pages' })
      .getByRole('link', { name: 'Payroll runs', exact: true })
      .click();
    const calculate = page.getByRole('button', { name: 'Calculate payroll' });
    await expect(calculate).toBeEnabled();
    const payrollStart = performance.now();
    await calculate.click();
    const runRow = page.getByRole('row', { name: /PR-0001/ }).first();
    await expect(runRow).toContainText(/calculated/i);
    payrollSamples.push(performance.now() - payrollStart);
  }

  const samples = {
    'billing list (300 invoices)': summarize(2_000, listSamples),
    'invoice detail': summarize(2_000, detailSamples),
    'inventory list (100 items)': summarize(2_000, inventorySamples),
    'trial balance calculation': summarize(30_000, reportSamples),
    'payroll calculation (25 employees)': summarize(30_000, payrollSamples),
  };

  const results = {
    measuredAt: new Date().toISOString(),
    method:
      'Playwright Chromium, in-app hash navigation (All apps switcher, then the destination link) after a ' +
      'full fixture reload outside the timed section. ' +
      'Each timed action starts in Node immediately before the click and ends when the expected rendered ' +
      'state is visible. Targets: ordinary list/detail 2,000 ms; report and payroll calculation 30,000 ms.',
    caveat:
      'Local synthetic single-operator measurement on one machine, not a production service-level claim ' +
      'and not a simulation of five simultaneous users.',
    environment: {
      node: process.version,
      os: `${os.platform()} ${os.release()} (${os.arch()})`,
      cpu: os.cpus()[0]?.model ?? 'unknown',
      totalMemoryGb: Number((os.totalmem() / 1024 ** 3).toFixed(1)),
      browser: `chromium ${browser.version()}`,
      viewport: '1280 × 720 (Playwright Desktop Chrome)',
    },
    dataset: {
      fixture: path.relative(process.cwd(), SEED_PATH),
      checksum: manifest.checksum,
      bytes: manifest.bytes,
      counts: manifest.counts,
    },
    samples,
  };

  await fs.mkdir(path.dirname(RESULTS_PATH), { recursive: true });
  await fs.writeFile(RESULTS_PATH, `${JSON.stringify(results, null, 2)}\n`, 'utf8');

  for (const [name, sample] of Object.entries(samples)) {
    console.log(
      `${name}: median ${sample.medianMs} ms, max ${sample.maxMs} ms ` +
        `(target ${sample.targetMs} ms, samples ${sample.timesMs.join(', ')})`,
    );
  }
  console.log(`benchmark: results at ${path.relative(process.cwd(), RESULTS_PATH)}`);

  const failures = Object.entries(samples).filter(([, sample]) => !sample.pass);
  expect(failures.map(([name]) => name), 'benchmark targets exceeded').toEqual([]);
});
