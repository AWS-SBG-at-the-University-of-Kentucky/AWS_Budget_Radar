export type Safety = "watch" | "armed";
export type ThresholdType = "ACTUAL" | "FORECASTED";
export interface ServiceBudget { service: string; limitUsd: number; }
export type StopKind = "EC2" | "RDS";
// One group of instances for one native RUN_SSM_DOCUMENTS budget action. AWS
// runs each such action in exactly one region, so instances are grouped by
// kind + region. region undefined = the stack's own deploy region.
export interface StopGroup { kind: StopKind; region?: string; ids: string[]; }
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
  // Opt-in native stop actions (STOP_EC2_INSTANCES / STOP_RDS_INSTANCES).
  // Empty by default: nothing is ever stopped unless listed here.
  stopGroups: StopGroup[];
  dailyDigest: boolean;
  dailyDigestHourUtc: number;
}

// AWS limits for SsmActionDefinition: region pattern, and 1-100 instance IDs.
const REGION_RE = /^[a-z]{2,4}-[a-z]+(-[a-z]+)?-\d$/;
const MAX_IDS_PER_STOP_ACTION = 100;
const STOP_ID_RE: Record<StopKind, RegExp> = {
  EC2: /^i-[0-9a-f]{8}([0-9a-f]{9})?$/,
  // RDS DB instance identifier: letter first, letters/digits/single hyphens,
  // no trailing hyphen, 1-63 chars. AWS stores it lowercase.
  RDS: /^[a-z](?!.*--)[a-z0-9-]{0,62}(?<!-)$/
};
const STOP_ENV: Record<StopKind, string> = { EC2: "STOP_EC2_INSTANCES", RDS: "STOP_RDS_INSTANCES" };

// Parses "id" (stack region) or "region:id" entries into per-region groups.
function parseStopGroups(kind: StopKind, raw: string | undefined): StopGroup[] {
  const envName = STOP_ENV[kind];
  const groups = new Map<string, StopGroup>();
  for (const entry of list(raw)) {
    const idx = entry.indexOf(":");
    const region = idx >= 0 ? entry.slice(0, idx).trim() : undefined;
    let id = (idx >= 0 ? entry.slice(idx + 1) : entry).trim();
    if (kind === "RDS") id = id.toLowerCase();
    if (region !== undefined && !REGION_RE.test(region)) {
      throw new Error(`${envName} entry has an invalid region "${region}" (expected e.g. us-east-1:<id>). Got: ${entry}`);
    }
    if (!STOP_ID_RE[kind].test(id)) {
      const what = kind === "EC2" ? "an EC2 instance ID like i-0123456789abcdef0" : "an RDS DB instance identifier";
      throw new Error(`${envName} entry must be ${what}, optionally prefixed "region:". Got: ${entry}`);
    }
    const key = region ?? "";
    const group = groups.get(key) ?? { kind, region, ids: [] };
    if (!group.ids.includes(id)) group.ids.push(id);
    groups.set(key, group);
  }
  for (const g of groups.values()) {
    if (g.ids.length > MAX_IDS_PER_STOP_ACTION) {
      throw new Error(
        `${envName} lists ${g.ids.length} instances in ${g.region ?? "the deploy region"}; ` +
        `AWS allows at most ${MAX_IDS_PER_STOP_ACTION} per region.`
      );
    }
  }
  return [...groups.values()];
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

  // Opt-in: omitted/empty values keep existing deployments schedule-free.
  const dailyDigest = bool("DAILY_DIGEST", env.DAILY_DIGEST, false);
  const dailyDigestHourUtc = num("DAILY_DIGEST_HOUR_UTC", (env.DAILY_DIGEST_HOUR_UTC ?? "").trim() || "13", 0, 23);
  if (!Number.isInteger(dailyDigestHourUtc)) {
    throw new Error(`DAILY_DIGEST_HOUR_UTC must be a whole hour in [0, 23]. Got: ${env.DAILY_DIGEST_HOUR_UTC}`);
  }

  return {
    alertEmail: email, existingBudgetName, monthlyBudgetUsd, warnAtPercent,
    actionThresholdPercent, actionThresholdType: thresholdType, safety,
    denyTargetUsers: users, denyTargetGroups: groups, denyTargetRoles: roles,
    recoveryPrincipalArn: recovery, serviceBudgets, trackGrossUsage,
    excludeServices: list(env.EXCLUDE_SERVICES),
    stopGroups: [
      ...parseStopGroups("EC2", env.STOP_EC2_INSTANCES),
      ...parseStopGroups("RDS", env.STOP_RDS_INSTANCES)
    ],
    dailyDigest, dailyDigestHourUtc
  };
}

// One region contract shared by synth and preflight. Reject ambiguous targets.
export function deployRegionFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  const cdk = env.CDK_DEFAULT_REGION?.trim() || undefined;
  const aws = env.AWS_REGION?.trim() || undefined;
  if (cdk && aws && cdk !== aws) {
    throw new Error(`AWS_REGION (${aws}) conflicts with CDK_DEFAULT_REGION (${cdk}); use one deployment region.`);
  }
  return cdk ?? aws;
}
