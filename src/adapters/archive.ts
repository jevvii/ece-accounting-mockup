import {
  archiveSigningBody,
  isCompanyArchive,
  type CompanyArchive,
} from '../domain/archive';

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/** SHA-256 of a canonical signing body, as lowercase hex. */
export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return toHex(digest);
}

export async function computeArchiveChecksum(
  archive: Omit<CompanyArchive, 'checksum'> | CompanyArchive,
): Promise<string> {
  return sha256Hex(archiveSigningBody(archive));
}

export async function sealCompanyArchive(
  archive: Omit<CompanyArchive, 'checksum'>,
): Promise<CompanyArchive> {
  return { ...archive, checksum: await computeArchiveChecksum(archive) };
}

export type ArchiveVerification =
  | { ok: true; archive: CompanyArchive; checksum: string }
  | { ok: false; message: string };

export function companyArchiveFilename(slug: string, stamp: string): string {
  return `ece-accounting-company-${slug}-${stamp}.json`;
}

/**
 * Recompute the canonical checksum before a preview or restore. This detects
 * accidental corruption and mismatched files; it is not a signature or proof
 * that the file came from a trusted party.
 */
export async function verifyCompanyArchive(raw: unknown): Promise<ArchiveVerification> {
  if (!isCompanyArchive(raw)) {
    return { ok: false, message: 'The selected file is not an ECE Accounting company archive.' };
  }
  const computed = await computeArchiveChecksum(raw);
  if (computed !== raw.checksum.toLowerCase()) {
    return {
      ok: false,
      message: 'The archive checksum does not match its contents. Nothing was changed.',
    };
  }
  return { ok: true, archive: raw, checksum: computed };
}
