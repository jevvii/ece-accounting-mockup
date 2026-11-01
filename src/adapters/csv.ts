import Papa from 'papaparse';
import type { BankCsvRowInput, MasterContactInput, MasterItemInput, TimeRowInput } from '../domain/commandTypes';
import { timeBucketSchema, type TimeBucket } from '../domain/schema';
import { isValidDateOnly } from '../domain/shared/dates';
import { parseMoneyToCentavos, parseMinutes, parseQuantityToMilli } from '../domain/shared/money';

export const TIME_BUCKETS: readonly TimeBucket[] = timeBucketSchema.options;

export const BANK_CSV_TEMPLATE = [
  'reference,value_date,description,direction,amount',
  'SYN-BANK-0001,2026-11-05,Synthetic customer deposit,in,40000.00',
  'SYN-BANK-0002,2026-11-06,Synthetic supplier payment,out,50000.00',
].join('\n');

export const CONTACTS_CSV_TEMPLATE = [
  'name,tin,address,roles',
  'Synthetic Imported Customer,000-000-000-00901,Synthetic address,customer',
  'Synthetic Imported Vendor,000-000-000-00902,Synthetic address,vendor',
].join('\n');

export const ITEMS_CSV_TEMPLATE = [
  'sku,name,base_unit',
  'SYN-ITEM-1,Synthetic imported item,pc',
].join('\n');

export const OPENINGS_CSV_TEMPLATE = [
  'account_code,debit,credit',
  'A101,1000.00,0.00',
  'A122,0.00,1000.00',
].join('\n');

export const TIME_CSV_TEMPLATE = [
  'employee_no,bucket,minutes',
  '5000,ordinary_ot,60',
].join('\n');

interface ParsedCsv {
  headers: string[];
  records: Array<Record<string, string>>;
  errors: string[];
}

function parseCsv(text: string, required: readonly string[]): ParsedCsv {
  const parsed = Papa.parse<Record<string, string>>(text.trim(), {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (header) => header.trim().toLowerCase().replace(/\s+/g, '_'),
  });
  const headers = (parsed.meta.fields ?? []).map((field) => field.trim().toLowerCase());
  const errors = parsed.errors.map(
    (error) => `CSV row ${(error.row ?? 0) + 2}: ${error.message}`,
  );
  for (const field of required) {
    if (!headers.includes(field)) errors.push(`Missing required column “${field}”.`);
  }
  return { headers, records: parsed.data, errors };
}

function clean(value: string | undefined): string {
  return (value ?? '').trim();
}

function parseAmount(value: string): number | null {
  const result = parseMoneyToCentavos(value.replace(/,/g, ''));
  return result.ok ? result.value : null;
}

export interface BankCsvPreview {
  rows: BankCsvRowInput[];
  errors: string[];
}

export function parseBankCsv(text: string): BankCsvPreview {
  const parsed = parseCsv(text, ['reference', 'value_date', 'description', 'direction', 'amount']);
  const rows: BankCsvRowInput[] = [];
  const errors = [...parsed.errors];
  const seen = new Set<string>();
  for (const [index, record] of parsed.records.entries()) {
    const line = index + 2;
    const rowRef = clean(record.reference);
    const valueDate = clean(record.value_date);
    const description = clean(record.description);
    const direction = clean(record.direction).toLowerCase();
    const amount = parseAmount(clean(record.amount));
    if (!rowRef) {
      errors.push(`Line ${line}: statement reference is required.`);
      continue;
    }
    if (seen.has(rowRef)) {
      errors.push(`Line ${line}: statement reference ${rowRef} appears more than once in the file.`);
      continue;
    }
    if (!isValidDateOnly(valueDate)) {
      errors.push(`Line ${line}: value date must be a real YYYY-MM-DD date.`);
      continue;
    }
    if (direction !== 'in' && direction !== 'out') {
      errors.push(`Line ${line}: direction must be “in” or “out”.`);
      continue;
    }
    if (amount === null || amount <= 0) {
      errors.push(`Line ${line}: amount must be a positive decimal with at most 2 places.`);
      continue;
    }
    seen.add(rowRef);
    rows.push({ rowRef, valueDate, description, direction, amountCentavos: amount });
  }
  if (rows.length === 0 && errors.length === 0) errors.push('The file contains no bank rows.');
  return { rows, errors };
}

export interface ContactsCsvPreview {
  contacts: MasterContactInput[];
  errors: string[];
}

export function parseContactsCsv(text: string): ContactsCsvPreview {
  const parsed = parseCsv(text, ['name', 'tin', 'address', 'roles']);
  const contacts: MasterContactInput[] = [];
  const errors = [...parsed.errors];
  for (const [index, record] of parsed.records.entries()) {
    const line = index + 2;
    const name = clean(record.name);
    const roles = clean(record.roles)
      .split(/[;|]/)
      .map((role) => role.trim().toLowerCase())
      .filter((role) => role.length > 0);
    if (!name) {
      errors.push(`Line ${line}: contact name is required.`);
      continue;
    }
    if (roles.length === 0 || roles.some((role) => role !== 'customer' && role !== 'vendor')) {
      errors.push(`Line ${line}: roles must contain customer and/or vendor, separated by “;”.`);
      continue;
    }
    contacts.push({
      name,
      tin: clean(record.tin),
      address: clean(record.address),
      roles: roles as Array<'customer' | 'vendor'>,
    });
  }
  return { contacts, errors };
}

export interface ItemsCsvPreview {
  items: MasterItemInput[];
  errors: string[];
}

export function parseItemsCsv(text: string): ItemsCsvPreview {
  const parsed = parseCsv(text, ['sku', 'name', 'base_unit']);
  const items: MasterItemInput[] = [];
  const errors = [...parsed.errors];
  for (const [index, record] of parsed.records.entries()) {
    const line = index + 2;
    const sku = clean(record.sku);
    const name = clean(record.name);
    const baseUnit = clean(record.base_unit);
    if (!sku || !name || !baseUnit) {
      errors.push(`Line ${line}: SKU, name, and base unit are all required.`);
      continue;
    }
    items.push({ sku, name, baseUnit });
  }
  return { items, errors };
}

export interface OpeningsCsvPreview {
  rows: Array<{ accountCode: string; debitCentavos: number; creditCentavos: number }>;
  errors: string[];
}

export function parseOpeningsCsv(text: string): OpeningsCsvPreview {
  const parsed = parseCsv(text, ['account_code', 'debit', 'credit']);
  const rows: OpeningsCsvPreview['rows'] = [];
  const errors = [...parsed.errors];
  for (const [index, record] of parsed.records.entries()) {
    const line = index + 2;
    const accountCode = clean(record.account_code);
    const debit = parseAmount(clean(record.debit) || '0');
    const credit = parseAmount(clean(record.credit) || '0');
    if (!accountCode) {
      errors.push(`Line ${line}: account code is required.`);
      continue;
    }
    if (debit === null || credit === null) {
      errors.push(`Line ${line}: debit and credit must be plain decimals.`);
      continue;
    }
    if (debit < 0 || credit < 0) {
      errors.push(`Line ${line}: debit and credit cannot be negative.`);
      continue;
    }
    if (debit > 0 && credit > 0) {
      errors.push(`Line ${line}: use either debit or credit on one line.`);
      continue;
    }
    rows.push({ accountCode, debitCentavos: debit, creditCentavos: credit });
  }
  return { rows, errors };
}

export interface TimeCsvPreview {
  rows: TimeRowInput[];
  errors: string[];
}

/** `employee_no` is resolved to the workspace employee id by the caller. */
export function parseTimeCsv(text: string): {
  rows: Array<{ employeeNo: string; bucket: TimeBucket; minutes: number }>;
  errors: string[];
} {
  const parsed = parseCsv(text, ['employee_no', 'bucket', 'minutes']);
  const rows: Array<{ employeeNo: string; bucket: TimeBucket; minutes: number }> = [];
  const errors = [...parsed.errors];
  for (const [index, record] of parsed.records.entries()) {
    const line = index + 2;
    const employeeNo = clean(record.employee_no);
    const bucket = clean(record.bucket).toLowerCase();
    const minuteResult = parseMinutes(clean(record.minutes), 'minutes');
    if (!employeeNo) {
      errors.push(`Line ${line}: employee number is required.`);
      continue;
    }
    if (!TIME_BUCKETS.includes(bucket as TimeBucket)) {
      errors.push(`Line ${line}: unknown classified time bucket “${bucket}”.`);
      continue;
    }
    if (!minuteResult.ok) {
      errors.push(`Line ${line}: ${minuteResult.error.message}.`);
      continue;
    }
    rows.push({ employeeNo, bucket: bucket as TimeBucket, minutes: minuteResult.value });
  }
  return { rows, errors };
}

export function toCsv(rows: Array<Record<string, string | number>>, columns?: readonly string[]): string {
  return Papa.unparse(rows, columns ? { columns: [...columns] } : {});
}

export function downloadText(filename: string, text: string, mime = 'text/csv;charset=utf-8'): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function parseQuantity(value: string, label = 'quantity'): { ok: true; value: number } | { ok: false; message: string } {
  const result = parseQuantityToMilli(value, label);
  return result.ok ? { ok: true, value: result.value } : { ok: false, message: result.error.message };
}
