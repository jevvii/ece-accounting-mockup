import type { Account, AppState, Entitlement, Membership, ProductCode, Role, Workspace } from '../schema';
import { err, ok, type Result } from './result';

export interface AccessContext {
  state: AppState;
  actorId: string;
  workspaceId: string;
  workspace: Workspace;
  membership: Membership;
  today: string;
}

export type EntitlementStatus = 'active' | 'expired' | 'inactive';

export function entitlementStatus(entitlement: Entitlement, today: string): EntitlementStatus {
  if (!entitlement.active) return 'inactive';
  if (entitlement.expiresOn !== null && entitlement.expiresOn < today) return 'expired';
  return 'active';
}

export function isProductWritable(entitlement: Entitlement, today: string): boolean {
  return entitlementStatus(entitlement, today) === 'active';
}

export function resolveAccess(
  state: AppState,
  actorId: string,
  workspaceId: string,
  today: string,
): Result<AccessContext> {
  const workspace = state.workspaces.find((candidate) => candidate.id === workspaceId);
  if (!workspace) return err('NOT_FOUND', 'Workspace not found.');
  const membership = state.memberships.find(
    (candidate) => candidate.userId === actorId && candidate.workspaceId === workspaceId,
  );
  if (!membership) {
    return err('FORBIDDEN', 'This demo actor is not a member of the selected workspace.');
  }
  if (!membership.active) {
    return err('FORBIDDEN', 'This demo actor’s membership is inactive in the selected workspace.');
  }
  return ok({ state, actorId, workspaceId, workspace, membership, today });
}

export function hasRole(membership: Membership, ...roles: Role[]): boolean {
  return roles.some((role) => membership.roles.includes(role));
}

export function requireRole(ctx: AccessContext, ...roles: Role[]): Result<Membership> {
  if (!hasRole(ctx.membership, ...roles)) {
    return err(
      'FORBIDDEN',
      `This action requires one of these roles: ${roles.join(', ')}.`,
    );
  }
  return ok(ctx.membership);
}

export function requireProduct(ctx: AccessContext, product: ProductCode): Result<Entitlement> {
  const entitlement = ctx.workspace.entitlements[product];
  const status = entitlementStatus(entitlement, ctx.today);
  if (status === 'inactive') {
    return err('NOT_ENTITLED', `The ${product} product is not active for this workspace.`);
  }
  if (status === 'expired') {
    return err(
      'ENTITLEMENT_EXPIRED',
      `The ${product} product expired on ${entitlement.expiresOn ?? 'an earlier date'}; data is read-only.`,
    );
  }
  return ok(entitlement);
}

export function hasPayrollDetail(membership: Membership): boolean {
  return membership.payrollDetail;
}

export function requirePayrollDetail(ctx: AccessContext): Result<Membership> {
  if (!ctx.membership.payrollDetail) {
    return err(
      'FORBIDDEN',
      'Payroll detail requires an explicit payroll-detail grant, separate from admin or accounting roles.',
    );
  }
  return ok(ctx.membership);
}

export function requireArchiveGrant(ctx: AccessContext): Result<Membership> {
  if (!ctx.membership.archiveGrant) {
    return err('FORBIDDEN', 'A full-company archive requires the privileged archive grant.');
  }
  return ok(ctx.membership);
}

export function findAccountByRole(
  state: AppState,
  workspaceId: string,
  controlRole: string,
): Account | undefined {
  return state.accounts.find(
    (account) => account.workspaceId === workspaceId && account.controlRole === controlRole && account.active,
  );
}

export function requireAccountByRole(
  state: AppState,
  workspaceId: string,
  controlRole: string,
): Result<Account> {
  const account = findAccountByRole(state, workspaceId, controlRole);
  if (!account) {
    return err('POLICY_INCOMPLETE', `No active account is mapped to control role “${controlRole}”.`);
  }
  return ok(account);
}

export function workspaceMembers(state: AppState, workspaceId: string): Membership[] {
  return state.memberships.filter((membership) => membership.workspaceId === workspaceId && membership.active);
}

/** Workspaces the actor can switch to in the demo; never used as authentication. */
export function accessibleWorkspaces(state: AppState, actorId: string): Workspace[] {
  const ids = new Set(
    state.memberships
      .filter((membership) => membership.userId === actorId && membership.active)
      .map((membership) => membership.workspaceId),
  );
  return state.workspaces.filter((workspace) => ids.has(workspace.id));
}
