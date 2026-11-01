import type { AccessContext, EntitlementStatus } from '../domain/shared/access';
import type { Role } from '../domain/schema';

export function hasAnyRole(access: AccessContext | null, ...roles: Role[]): boolean {
  if (!access) return false;
  return roles.some((role) => access.membership.roles.includes(role));
}

export function productWritable(status: EntitlementStatus): boolean {
  return status === 'active';
}

export function roleSummary(access: AccessContext | null): string {
  if (!access) return 'No membership';
  return access.membership.roles.join(', ');
}
