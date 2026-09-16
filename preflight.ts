import { RadarConfig, loadConfig } from "./lib/config";

export interface PreflightResult { ok: boolean; messages: string[]; }

export interface IamPrincipal { arn: string; path?: string; }
export interface IamGroupInfo extends IamPrincipal { users: IamPrincipal[]; }

export interface PreflightDeps {
  getCallerIdentity(): Promise<{ Account?: string; Arn?: string }>;
  getUser(name: string): Promise<IamPrincipal | null>;
  getRole(name: string): Promise<IamPrincipal | null>;
  // Mirrors IAM's GetGroup, which returns the group itself AND its member
  // users in one call — that single shape resolves a group target's ARN
  // (path-aware) and lets us check caller/recovery coverage via membership.
  // Implementations MUST return every member (paginate internally via
  // IsTruncated/Marker — see paginateGetGroup below); this shape stays a
  // single already-merged result so fakes/tests remain deterministic.
  getGroup(name: string): Promise<IamGroupInfo | null>;
  describeBudget(name: string): Promise<{
    BudgetType?: string; TimeUnit?: string; unit?: string; scoped: boolean;
    // Optional (backward-compatible) fields for stricter Path A validation:
    // whether the budget's time period has already ended/not yet started,
    // its limit amount, whether it uses a non-default billing view, and
    // whether it reports an unhealthy status.
    expired?: boolean; futureStart?: boolean; amount?: number;
    nonDefaultBillingView?: boolean; unhealthy?: boolean;
  } | null>;
  // Optional, best-effort. When supplied, its results are reported as
  // simulated/qualified — never treated as proof the recovery principal can
  // actually reverse the deny (real evaluation also depends on SCPs, other
  // attached policies, and permission boundaries that simulation can miss).
  simulateRecoveryPermissions?(principalArn: string, actions: string[]): Promise<Record<string, boolean> | null>;
}

type Kind = "user" | "group" | "role";

// Matches a full IAM identity ARN, capturing (account, type, "path.../name").
const IAM_ARN_RE = /^arn:aws[a-z-]*:iam::(\d{12}):(user|group|role)\/(.+)$/;

interface ParsedIamArn { account: string; kind: Kind; path: string; name: string; }

function parseIamArn(raw: string): ParsedIamArn | null {
  const m = raw.match(IAM_ARN_RE);
  if (!m) return null;
  const [, account, kind, rest] = m;
  const idx = rest.lastIndexOf("/");
  const path = idx >= 0 ? `/${rest.slice(0, idx)}/` : "/";
  const name = idx >= 0 ? rest.slice(idx + 1) : rest;
  return { account, kind: kind as Kind, path, name };
}

const RECOVERY_ACTIONS = [
  "iam:DetachUserPolicy",
  "iam:DetachGroupPolicy",
  "iam:DetachRolePolicy",
  "budgets:ExecuteBudgetAction"
];

// Matches an STS assumed-role session ARN, capturing (account, role name).
// e.g. "arn:aws:sts::111122223333:assumed-role/DevRole/session-name" ->
// ("111122223333", "DevRole"). Coverage must be checked against the
// BACKING ROLE, not this session ARN — it never appears as an IAM identity.
const ASSUMED_ROLE_ARN_RE = /^arn:aws[a-z-]*:sts::(\d{12}):assumed-role\/([^/]+)\/.+$/;

function parseAssumedRoleArn(raw?: string): { account: string; roleName: string } | null {
  if (!raw) return null;
  const m = raw.match(ASSUMED_ROLE_ARN_RE);
  if (!m) return null;
  return { account: m[1], roleName: m[2] };
}

// One page of IAM's GetGroup response, in the shape returned by the SDK
// (Group/Users/IsTruncated/Marker) — kept separate from IamGroupInfo so the
// pagination loop below has no dependency on any particular SDK's types.
export interface RawGetGroupPage {
  Group?: { Arn?: string; Path?: string };
  Users?: Array<{ Arn?: string; Path?: string }>;
  IsTruncated?: boolean;
  Marker?: string;
}

// Follows IAM's GetGroup pagination (IsTruncated/Marker) to completion and
// merges every page's members into one IamGroupInfo. Exists as a standalone,
// directly-testable function (fed a fake fetchPage) so the pagination logic
// itself is exercised without needing a mocked SDK client or live network —
// PreflightDeps.getGroup stays a single Promise<IamGroupInfo | null> for
// deterministic test fakes; only the real SDK-backed implementation in
// main() below needs to loop.
export async function paginateGetGroup(
  fetchPage: (marker?: string) => Promise<RawGetGroupPage>
): Promise<IamGroupInfo | null> {
  let marker: string | undefined;
  let groupArn: string | undefined;
  let groupPath: string | undefined;
  const users: IamPrincipal[] = [];
  do {
    const page = await fetchPage(marker);
    if (!groupArn && page.Group?.Arn) {
      groupArn = page.Group.Arn;
      groupPath = page.Group.Path;
    }
    for (const u of page.Users ?? []) {
      if (u.Arn) users.push({ arn: u.Arn, path: u.Path });
    }
    marker = page.IsTruncated ? page.Marker : undefined;
  } while (marker);
  if (!groupArn) return null;
  return { arn: groupArn, path: groupPath, users };
}

// Maps a raw AWS Budgets DescribeBudget "Budget" object to the simplified,
// backward-compatible shape PreflightDeps.describeBudget returns. Exported
// and testable directly (fed a realistic-looking raw response) so the
// TimePeriod/BillingViewArn/BudgetLimit/HealthStatus mapping is exercised
// without needing a mocked SDK client.
export function adaptBudgetForPreflight(b: any): {
  BudgetType?: string; TimeUnit?: string; unit?: string; scoped: boolean;
  expired?: boolean; futureStart?: boolean; amount?: number;
  nonDefaultBillingView?: boolean; unhealthy?: boolean;
} {
  const scoped = !!(b?.FilterExpression || (b?.CostFilters && Object.keys(b.CostFilters).length));
  const start = b?.TimePeriod?.Start;
  const end = b?.TimePeriod?.End;
  const futureStart = start ? new Date(start).getTime() > Date.now() : false;
  const expired = end ? new Date(end).getTime() < Date.now() : false;
  const amount = b?.BudgetLimit?.Amount !== undefined ? Number(b.BudgetLimit.Amount) : undefined;
  // AWS's default ("primary") billing view ARN ends in ":billingview/primary".
  // Any other BillingViewArn is a custom/scoped view that may not reflect
  // total account cost, so it's treated the same as a scoped cost filter.
  const billingViewArn: string | undefined = b?.BillingViewArn;
  const nonDefaultBillingView = !!billingViewArn && !/:billingview\/primary$/i.test(billingViewArn);
  // AWS Budgets' HealthStatusValue enum is only "HEALTHY" / "UNHEALTHY" (see
  // @aws-sdk/client-budgets' enums.d.ts) — there is no "OK". Only an
  // explicit UNHEALTHY value should fail; a missing/empty HealthStatus (or
  // a genuinely HEALTHY one) must NOT be treated as unhealthy.
  const healthStatusRaw = b?.HealthStatus?.Status ?? b?.HealthStatus;
  const unhealthy = typeof healthStatusRaw === "string" && healthStatusRaw.toUpperCase() === "UNHEALTHY";
  return {
    BudgetType: b?.BudgetType, TimeUnit: b?.TimeUnit, unit: b?.BudgetLimit?.Unit,
    scoped, expired, futureStart, amount, nonDefaultBillingView, unhealthy
  };
}

export async function runPreflight(config: RadarConfig, deps: PreflightDeps): Promise<PreflightResult> {
  const messages: string[] = [];
  let ok = true;
  const fail = (m: string) => { ok = false; messages.push("FAIL: " + m); };
  const info = (m: string) => messages.push(m);
  const warn = (m: string) => messages.push("WARNING: " + m);

  const caller = await deps.getCallerIdentity();
  info(`Caller: ${caller.Arn} (account ${caller.Account})`);
  const account = caller.Account;

  // Deploy summary (doc/UX item): surface the effective dollar threshold and
  // cost-reporting caveats up front, since this is the only place a
  // pre-deploy summary is printed. Path B's threshold is known immediately;
  // Path A's (existing budget) is filled in once its limit is resolved below.
  if (!config.existingBudgetName) {
    const effectiveThresholdUsd = config.monthlyBudgetUsd * (config.actionThresholdPercent / 100);
    info(
      `Deploy summary: effective action threshold ~= $${effectiveThresholdUsd.toFixed(2)} USD ` +
      `(MONTHLY_BUDGET_USD ${config.monthlyBudgetUsd} x ACTION_THRESHOLD_PERCENT ${config.actionThresholdPercent}%).`
    );
  }
  info(
    "Deploy summary: AWS Budgets evaluates cost using your budget's configured cost metric (unblended by " +
    "default), which reflects credits/refunds/RI-DR amortization according to that setting — actual spend as " +
    "shown elsewhere (e.g. the Bills page) can differ, and credits can delay or suppress a threshold crossing."
  );
  info(
    "Deploy summary: expect a near-zero, but not exactly $0.00, baseline even at rest (minor storage/request " +
    "charges are normal) — a literal $0.00 bill is not guaranteed and its absence does not indicate a problem."
  );

  // Augmentation 3: reject wildcard / cross-account target forms at preflight
  // too (defense in depth beyond lib/config.ts's own checks).
  const badTargetForm = (raw: string): string | null => {
    if (raw.includes("*")) return `contains a wildcard ("*"), which is not a concrete identity`;
    if (raw.startsWith("arn:")) {
      const parsed = parseIamArn(raw);
      if (!parsed) return `is not a recognizable IAM identity ARN`;
      if (account && parsed.account !== account) {
        return `is in account ${parsed.account}, not the caller's account (${account}); attach/detach must be same-account`;
      }
    }
    return null;
  };

  interface Resolved { kind: Kind; raw: string; arn: string; path: string; groupUsers?: IamPrincipal[]; }
  const resolved: Resolved[] = [];

  const allTargets: Array<{ kind: Kind; raw: string }> = [
    ...config.denyTargetUsers.map(raw => ({ kind: "user" as const, raw })),
    ...config.denyTargetGroups.map(raw => ({ kind: "group" as const, raw })),
    ...config.denyTargetRoles.map(raw => ({ kind: "role" as const, raw }))
  ];

  for (const { kind, raw } of allTargets) {
    const badForm = badTargetForm(raw);
    if (badForm) { fail(`Deny target "${raw}" (${kind}) ${badForm}.`); continue; }

    const isBareName = !raw.startsWith("arn:");
    let bareName: string;
    if (isBareName) {
      bareName = raw;
    } else {
      // badTargetForm() above already rejected any full ARN that doesn't
      // parse as an IAM identity ARN, so this is non-null here.
      const parsedRaw = parseIamArn(raw)!;
      bareName = parsedRaw.name;

      // Fix (type/array consistency): the resource type embedded in the ARN
      // must match the config array (denyTargetUsers/Groups/Roles) the value
      // was placed in — that array, not the ARN string, is what the stack's
      // denyTargetArns() and the budgets action definition key off of.
      if (parsedRaw.kind !== kind) {
        fail(
          `Target "${raw}" is configured as a ${kind} (in IAM_DENY_TARGET_${kind.toUpperCase()}S), ` +
          `but the ARN itself names a ${parsedRaw.kind}. Move it to the matching IAM_DENY_TARGET_* list.`
        );
        continue;
      }
    }

    // Reserved SSO roles are AWS-protected and cannot usefully be targeted.
    if (kind === "role" && bareName.includes("AWSReservedSSO_")) {
      fail(`Target ${raw} is an AWSReservedSSO_ role; AWS protects these from modification. Use a dedicated learning role/user.`);
      continue;
    }

    let entity: IamGroupInfo | IamPrincipal | null;
    if (kind === "user") entity = await deps.getUser(bareName);
    else if (kind === "role") entity = await deps.getRole(bareName);
    else entity = await deps.getGroup(bareName);

    if (!entity) {
      fail(`${kind[0].toUpperCase()}${kind.slice(1)} target "${raw}" could not be resolved in IAM.`);
      continue;
    }

    // Fix (silently-non-attaching guard): for a full ARN, the stack uses the
    // RAW literal ARN verbatim as the Deny policy Resource (see
    // lib/budget-radar-stack.ts denyTargetArns()) — it never re-resolves it.
    // If the raw ARN's path/name doesn't match the real, resolved identity
    // (e.g. a typo'd path), the stack would attach the deny to an ARN that
    // doesn't exist, silently leaving the real identity unprotected.
    if (!isBareName && entity.arn !== raw) {
      fail(
        `Target "${raw}" does not match the resolved identity ${entity.arn}; ` +
        `the deny would attach to the ARN you typed (not the real one) and silently fail to protect anyone. ` +
        `Fix the ARN in .env.`
      );
      continue;
    }

    // Augmentation 2: path-aware ARN resolution + mismatch rejection. The
    // stack's bare-name assumption (denyTargetArns in lib/budget-radar-stack.ts)
    // builds `arn:aws:iam::<acct>:<kind>/<name>`, which is only correct when
    // the real entity lives at path "/". A bare name that resolves to a
    // non-root path would silently attach the deny to the WRONG ARN.
    const path = entity.path ?? "/";
    if (isBareName && path !== "/") {
      fail(
        `Target "${raw}" (${kind}) resolves to a real ARN with a non-root IAM path (${path}). ` +
        `The stack assumes bare names live at path "/", so this bare name would target the wrong entity. ` +
        `Put the full ARN (${entity.arn}) in .env for this target instead of the bare name.`
      );
      continue;
    }

    resolved.push({
      kind, raw, arn: entity.arn, path,
      groupUsers: kind === "group" ? (entity as IamGroupInfo).users : undefined
    });
  }

  const coveredArns = resolved.map(r => r.arn);

  // --- Caller coverage: direct, then via group membership. ---
  // F5: an STS assumed-role session ARN (arn:...:sts::acct:assumed-role/Role/session)
  // never appears as an IAM identity ARN and must not be compared directly
  // against IAM role ARNs — resolve it to its backing role first.
  let callerCoverageArn = caller.Arn;
  const assumedRole = parseAssumedRoleArn(caller.Arn);
  if (assumedRole) {
    const backingRole = await deps.getRole(assumedRole.roleName);
    if (backingRole) {
      callerCoverageArn = backingRole.arn;
      info(`Caller is an assumed-role session; resolved backing role for coverage: ${backingRole.arn}.`);
    } else {
      callerCoverageArn = undefined;
      warn(
        `Caller is an assumed-role session (role "${assumedRole.roleName}") but the backing role could not be ` +
        `resolved in IAM; coverage cannot be determined.`
      );
    }
  }

  const callerDirectlyCovered = !!callerCoverageArn && coveredArns.includes(callerCoverageArn);
  let callerGroupCoverage: string | undefined;
  if (!callerDirectlyCovered && callerCoverageArn) {
    const callerParsed = parseIamArn(callerCoverageArn);
    if (callerParsed?.kind === "user") {
      const hit = resolved.find(r => r.kind === "group" && r.groupUsers?.some(u => u.arn === callerCoverageArn));
      callerGroupCoverage = hit?.raw;
    }
  }
  if (callerDirectlyCovered) {
    info("Caller is directly covered by the deny.");
  } else if (callerGroupCoverage) {
    info(`Caller is covered only via group target "${callerGroupCoverage}" (group membership), not directly as a user/role target.`);
  } else {
    warn(
      "caller is not covered directly or via a group target. If you deploy/operate under an uncovered identity " +
      "(or via CDK bootstrap/CloudFormation execution roles), those actions are NOT blocked."
    );
  }
  info("Note: CDK bootstrap and CloudFormation execution roles are typically NOT covered — coverage of those is 'unknown' unless you list them explicitly.");

  // --- Recovery route. ---
  info(`Recovery principal: ${config.recoveryPrincipalArn} (must be able to reverse the action / detach the policy; not a deny target).`);

  // F3: apply the SAME exact-ARN/account form check already used for deny
  // TARGETS to the recovery principal — a cross-account or ARN that doesn't
  // parse is rejected before we even try to resolve it.
  const badRecoveryForm = badTargetForm(config.recoveryPrincipalArn);
  let recoveryArn: string | undefined;
  if (badRecoveryForm) {
    fail(`Recovery principal ${config.recoveryPrincipalArn} ${badRecoveryForm}.`);
  } else {
    const recoveryParsed = parseIamArn(config.recoveryPrincipalArn)!; // badTargetForm() confirmed this parses.
    let recoveryEntity: IamPrincipal | null = null;
    if (recoveryParsed.kind === "user") recoveryEntity = await deps.getUser(recoveryParsed.name);
    else if (recoveryParsed.kind === "role") recoveryEntity = await deps.getRole(recoveryParsed.name);

    if (!recoveryEntity) {
      fail(
        `Recovery principal ${config.recoveryPrincipalArn} could not be resolved in IAM. ` +
        `Without a real, existing recovery principal there is no way to reverse the deny if it fires.`
      );
    } else if (recoveryEntity.arn !== config.recoveryPrincipalArn) {
      // F3: same check as the silently-non-attaching guard for targets — the
      // supplied ARN must equal the RESOLVED identity (account + path), not
      // just resolve some same-named local entity.
      fail(
        `Recovery principal ${config.recoveryPrincipalArn} does not match the resolved identity ${recoveryEntity.arn}; ` +
        `fix the ARN in .env.`
      );
    } else {
      recoveryArn = recoveryEntity.arn;
      info("Recovery principal resolved successfully (exists in IAM) and matches the resolved identity.");
    }
  }

  // Augmentation 4: existence != permission. Keep this qualified — we never
  // claim to have proven the recovery principal can actually detach the
  // policy or execute a manual budgets action.
  info(
    "IMPORTANT: resolving the recovery principal only proves it exists, not that it can reverse the action. " +
    "Manually confirm it holds iam:Detach{User,Group,Role}Policy (scoped to the DenyNewSpend policy) and, " +
    "for a MANUAL-approval action, budgets:ExecuteBudgetAction. This preflight does not prove those permissions."
  );

  // F2: recovery-permission simulation must actually GATE deployment, not
  // just be printed and ignored. Rules:
  //  - simulation available + ALL routes denied -> FAIL (no working recovery route).
  //  - simulation available + at least ONE route allowed -> pass (don't require every action).
  //  - simulation unavailable (no dep, or the call itself failed) -> don't hard-fail on
  //    that alone, but clearly report recovery as UNVERIFIED (existence-only).
  //  Never claim simulation proves the recovery principal can be assumed/accessed.
  if (deps.simulateRecoveryPermissions) {
    const sim = await deps.simulateRecoveryPermissions(config.recoveryPrincipalArn, RECOVERY_ACTIONS);
    if (sim) {
      const lines = Object.entries(sim).map(
        ([action, allowed]) => `  - ${action}: ${allowed ? "allowed (simulated)" : "NOT allowed (simulated)"}`
      );
      info(`Policy simulation (best-effort, may not reflect SCPs/permission boundaries/runtime context):\n${lines.join("\n")}`);
      const anyRouteAllowed = Object.values(sim).some(v => v === true);
      if (!anyRouteAllowed) {
        fail(
          `Policy simulation indicates NONE of the recovery actions (${RECOVERY_ACTIONS.join(", ")}) are allowed ` +
          `for ${config.recoveryPrincipalArn}. Without at least one working recovery route, a deny cannot be ` +
          `reversed. Grant the recovery principal permission to detach the deny policy or execute the budget ` +
          `action, then re-run preflight.`
        );
      } else {
        info(
          "At least one simulated recovery route is allowed. This does not prove the recovery principal can be " +
          "assumed/accessed, nor does it account for SCPs, permission boundaries, or other runtime context."
        );
      }
    } else {
      warn(
        "Policy simulation was unavailable (e.g. caller lacks iam:SimulatePrincipalPolicy); recovery is " +
        "UNVERIFIED (existence-only) — manually confirm the recovery principal holds working permissions."
      );
    }
  } else {
    warn(
      "No permission-simulation capability was provided; recovery is UNVERIFIED (existence-only) — manually " +
      "confirm the recovery principal holds working permissions."
    );
  }

  // Augmentation 1 (recovery half): recovery principal covered via a
  // deny-target group. This can block recovery through group coverage even
  // though lib/config.ts already rejects a *direct* target/recovery match.
  // F3: check against the RESOLVED recovery identity, not the raw config value.
  if (recoveryArn) {
    for (const r of resolved) {
      if (r.kind === "group" && r.groupUsers?.some(u => u.arn === recoveryArn)) {
        fail(
          `Recovery principal ${config.recoveryPrincipalArn} belongs to group target "${r.raw}", which is a deny target. ` +
          `Recovery could be blocked through group coverage — remove the recovery principal from that group, ` +
          `or choose a different recovery principal.`
        );
      }
    }
  }

  // --- Path A: existing-budget semantics. ---
  if (config.existingBudgetName) {
    const b = await deps.describeBudget(config.existingBudgetName);
    if (!b) {
      fail(`Existing budget "${config.existingBudgetName}" not found.`);
    } else {
      if (b.BudgetType !== "COST") fail(`Budget must be COST; got ${b.BudgetType}.`);
      if (b.TimeUnit !== "MONTHLY") fail(`Budget must be MONTHLY; got ${b.TimeUnit}.`);
      if (b.unit !== "USD") fail(`Budget must be USD; got ${b.unit}.`);
      if (b.scoped) fail("Scoped budgets are rejected in v1 (a scoped budget does not protect total account cost).");
      if (b.nonDefaultBillingView) {
        fail(
          "Budget uses a custom (non-default) BillingViewArn, which may not cover total account cost — " +
          "rejected in v1, consistent with rejecting other scoped/filtered budgets. Use the account's default " +
          "billing view."
        );
      }
      if (b.expired) fail("Budget's time period has already ended (inactive/expired); it will not track ongoing spend.");
      if (b.futureStart) {
        fail("Budget's time period has not started yet (future start); it is not yet tracking spend.");
      }
      if (b.unhealthy) {
        fail(
          "Budget reports an unhealthy status; spend tracking and/or budget actions associated with it may be " +
          "paused or blocked. Investigate the budget's health in the Budgets console before relying on it."
        );
      }
      if (typeof b.amount === "number" && (!Number.isFinite(b.amount) || b.amount <= 0)) {
        fail(`Budget limit must be a finite positive amount; got ${b.amount}.`);
      }
      if (typeof b.amount === "number" && Number.isFinite(b.amount) && b.amount > 0) {
        const effectiveThresholdUsd = b.amount * (config.actionThresholdPercent / 100);
        info(
          `Deploy summary: effective action threshold ~= $${effectiveThresholdUsd.toFixed(2)} USD ` +
          `(existing budget limit $${b.amount} x ACTION_THRESHOLD_PERCENT ${config.actionThresholdPercent}%).`
        );
      } else {
        info("Deploy summary: effective action threshold could not be computed (existing budget's limit amount is unknown/invalid).");
      }
    }
  }

  return { ok, messages };
}

// Runs only when invoked directly (npm run deploy / preflight). Never
// imported by the CDK app, so synth stays credential-free.
if (require.main === module) {
  (async () => {
    require("dotenv/config");
    const config = loadConfig(process.env);

    const { STSClient, GetCallerIdentityCommand } = await import("@aws-sdk/client-sts");
    const {
      IAMClient, GetUserCommand, GetRoleCommand, GetGroupCommand, SimulatePrincipalPolicyCommand
    } = await import("@aws-sdk/client-iam");
    const { BudgetsClient, DescribeBudgetCommand } = await import("@aws-sdk/client-budgets");

    const sts = new STSClient({});
    const iam = new IAMClient({});
    const budgets = new BudgetsClient({});

    const deps: PreflightDeps = {
      getCallerIdentity: async () => {
        const r = await sts.send(new GetCallerIdentityCommand({}));
        return { Account: r.Account, Arn: r.Arn };
      },
      getUser: async (n) => {
        try {
          const r = await iam.send(new GetUserCommand({ UserName: n }));
          return { arn: r.User!.Arn!, path: r.User!.Path };
        } catch { return null; }
      },
      getRole: async (n) => {
        try {
          const r = await iam.send(new GetRoleCommand({ RoleName: n }));
          return { arn: r.Role!.Arn!, path: r.Role!.Path };
        } catch { return null; }
      },
      // F5: GetGroup is paginated via paginateGetGroup (IsTruncated/Marker),
      // so caller/recovery membership on later pages isn't missed.
      getGroup: async (n) => {
        try {
          return await paginateGetGroup(async (marker) => {
            const r = await iam.send(new GetGroupCommand({ GroupName: n, Marker: marker }));
            return { Group: r.Group, Users: r.Users, IsTruncated: r.IsTruncated, Marker: r.Marker };
          });
        } catch { return null; }
      },
      describeBudget: async (name) => {
        try {
          const acct = (await sts.send(new GetCallerIdentityCommand({}))).Account!;
          const r = await budgets.send(new DescribeBudgetCommand({
            AccountId: acct, BudgetName: name, ShowFilterExpression: true
          } as any));
          return adaptBudgetForPreflight(r.Budget as any);
        } catch { return null; }
      },
      simulateRecoveryPermissions: async (principalArn, actions) => {
        try {
          const r = await iam.send(new SimulatePrincipalPolicyCommand({
            PolicySourceArn: principalArn, ActionNames: actions
          }));
          const out: Record<string, boolean> = {};
          for (const res of r.EvaluationResults ?? []) {
            if (res.EvalActionName) out[res.EvalActionName] = res.EvalDecision === "allowed";
          }
          return out;
        } catch { return null; }
      }
    };

    const result = await runPreflight(config, deps);
    for (const m of result.messages) console.log(m);
    if (!result.ok) { console.error("\nPreflight FAILED. Deployment aborted."); process.exit(1); }
    console.log("\nPreflight passed.");
  })();
}
