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
}

function list(v?: string): string[] {
  return (v ?? "").split(",").map(s => s.trim()).filter(Boolean);
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

  const recovery = (env.RECOVERY_PRINCIPAL_ARN ?? "").trim();
  if (!recovery) {
    throw new Error("RECOVERY_PRINCIPAL_ARN is required (a principal that can reverse the action / detach the deny).");
  }
  if ([...users, ...groups, ...roles].includes(recovery)) {
    throw new Error("The recovery principal must not also be a deny target, or it could be blocked from recovering.");
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
    recoveryPrincipalArn: recovery, serviceBudgets
  };
}
