export type Safety = "watch" | "armed";
export type ThresholdType = "ACTUAL" | "FORECASTED";
export interface ServiceBudget { service: string; limitUsd: number; }
export interface RadarConfig {
  alertEmail: string;
  existingBudgetName?: string;
  monthlyBudgetUsd: number;
  warnAtPercent: number;
  actionThresholdPercent: number;
  actionThresholdType: ThresholdType;
  safety: Safety;
  denyTargetUsers: string[];
  denyTargetGroups: string[];
  denyTargetRoles: string[];
  recoveryPrincipalArn: string;
  serviceBudgets: ServiceBudget[];
  // When true (default), the budget counts GROSS usage — AWS credits and
  // refunds are EXCLUDED from CostTypes — so usage trips the budget even while
  // credits cover the bill. AWS's default (credits included) can hide gross
  // usage behind a small net threshold on a credit-covered learning account
  // (design spec §5.6). false opts back into net-of-credits.
  trackGrossUsage: boolean;
  // Optional list of AWS service names to EXCLUDE from the action-enabled
  // budget (exact SERVICE dimension values, e.g. "AWS Cost Explorer"). Empty
  // by default, which keeps the budget unscoped and protecting TOTAL account
  // cost. When non-empty the budget switches to a FilterExpression tracking
  // everything except these services (AWS drops CostTypes under that model, so
  // gross-usage is preserved via a RECORD_TYPE credit/refund exclusion +
  // UnblendedCost metric in the stack).
  excludeServices: string[];
}

function list(v?: string): string[] {
  return (v ?? "").split(",").map(s => s.trim()).filter(Boolean);
}

// Matches a full IAM identity ARN, capturing (type, name) e.g.
// "arn:aws:iam::123456789012:role/Admin" -> ["role", "Admin"].
const IAM_ARN_RE = /^arn:aws[a-z-]*:iam::\d{12}:(user|group|role)\/(.+)$/;

// Normalizes a deny-target entry (bare name or full ARN) to a "type/name"
// form comparable across representations, e.g. bare "Admin" with kind "role"
// and "arn:aws:iam::123456789012:role/Admin" both normalize to "role/Admin".
function normalizeIdentity(kind: "user" | "group" | "role", raw: string): string {
  const m = raw.match(IAM_ARN_RE);
  if (m) return `${m[1]}/${m[2]}`;
  return `${kind}/${raw}`;
}

export function loadConfig(env: NodeJS.ProcessEnv): RadarConfig {
  const email = (env.ALERT_EMAIL ?? "").trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new Error("ALERT_EMAIL is missing or not a valid email address.");
  }

  const users = list(env.IAM_DENY_TARGET_USERS);
  const groups = list(env.IAM_DENY_TARGET_GROUPS);
  const roles = list(env.IAM_DENY_TARGET_ROLES);
  if (users.length + groups.length + roles.length === 0) {
    throw new Error("Provide at least one IAM deny target (IAM_DENY_TARGET_USERS/GROUPS/ROLES).");
  }
  const targetsWithKind: Array<{ kind: "user" | "group" | "role"; raw: string }> = [
    ...users.map(raw => ({ kind: "user" as const, raw })),
    ...groups.map(raw => ({ kind: "group" as const, raw })),
    ...roles.map(raw => ({ kind: "role" as const, raw }))
  ];
  for (const { raw } of targetsWithKind) {
    if (raw.includes("*")) {
      throw new Error(`IAM deny targets must be concrete identities, not wildcards: ${raw}`);
    }
  }

  const recovery = (env.RECOVERY_PRINCIPAL_ARN ?? "").trim();
  if (!recovery) {
    throw new Error("RECOVERY_PRINCIPAL_ARN is required (a principal that can reverse the action / detach the deny).");
  }
  const recoveryMatch = recovery.match(IAM_ARN_RE);
  if (!recoveryMatch) {
    throw new Error("RECOVERY_PRINCIPAL_ARN must be a full IAM ARN, e.g. arn:aws:iam::123456789012:role/Admin");
  }
  const recoveryResource = `${recoveryMatch[1]}/${recoveryMatch[2]}`;
  for (const { kind, raw } of targetsWithKind) {
    if (normalizeIdentity(kind, raw) === recoveryResource) {
      throw new Error(`The recovery principal must not also be a deny target (matched target: ${raw})`);
    }
  }

  const safety = (env.SAFETY ?? "watch").trim() as Safety;
  if (safety !== "watch" && safety !== "armed") {
    throw new Error('SAFETY must be "watch" or "armed".');
  }

  const thresholdType = (env.ACTION_THRESHOLD_TYPE ?? "ACTUAL").trim() as ThresholdType;
  if (thresholdType !== "ACTUAL" && thresholdType !== "FORECASTED") {
    throw new Error("ACTION_THRESHOLD_TYPE must be ACTUAL or FORECASTED.");
  }

  const num = (name: string, v: string | undefined, min: number, max: number): number => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < min || n > max) {
      throw new Error(`${name} must be a number in [${min}, ${max}]. Got: ${v}`);
    }
    return n;
  };

  const bool = (name: string, v: string | undefined, dflt: boolean): boolean => {
    if (v === undefined || v.trim() === "") return dflt;
    const s = v.trim().toLowerCase();
    if (s === "true") return true;
    if (s === "false") return false;
    throw new Error(`${name} must be "true" or "false". Got: ${v}`);
  };
  const trackGrossUsage = bool("TRACK_GROSS_USAGE", env.TRACK_GROSS_USAGE, true);

  const existingBudgetName = (env.EXISTING_BUDGET_NAME ?? "").trim() || undefined;
  const monthlyBudgetUsd = existingBudgetName ? 0 : num("MONTHLY_BUDGET_USD", env.MONTHLY_BUDGET_USD, 0.01, 1e9);
  const warnAtPercent = num("WARN_AT_PERCENT", env.WARN_AT_PERCENT ?? "80", 1, 99);
  const actionThresholdPercent = num("ACTION_THRESHOLD_PERCENT", env.ACTION_THRESHOLD_PERCENT ?? "100", 1, 100);

  const serviceBudgets: ServiceBudget[] = list(env.SERVICE_BUDGETS).map(entry => {
    const idx = entry.lastIndexOf(":");
    if (idx < 0) throw new Error(`SERVICE_BUDGETS entry must be "Service Name:USD". Got: ${entry}`);
    const service = entry.slice(0, idx).trim();
    const limitUsd = Number(entry.slice(idx + 1).trim());
    if (!service || !Number.isFinite(limitUsd) || limitUsd <= 0) {
      throw new Error(`Invalid SERVICE_BUDGETS entry: ${entry}`);
    }
    return { service, limitUsd };
  });

  return {
    alertEmail: email, existingBudgetName, monthlyBudgetUsd, warnAtPercent,
    actionThresholdPercent, actionThresholdType: thresholdType, safety,
    denyTargetUsers: users, denyTargetGroups: groups, denyTargetRoles: roles,
    recoveryPrincipalArn: recovery, serviceBudgets, trackGrossUsage,
    excludeServices: list(env.EXCLUDE_SERVICES)
  };
}
