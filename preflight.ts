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
    // F5: current spend (CalculatedSpend.ActualSpend.Amount), optional and
    // backward-compatible, used to warn/fail when a budget is already at or
    // over the action threshold at deploy time.
    actualSpend?: number;
  } | null>;
  // Optional, best-effort. When supplied, its results are reported as
  // simulated/qualified — never treated as proof the recovery principal can
  // actually reverse the deny (real evaluation also depends on SCPs, other
  // attached policies, and permission boundaries that simulation can miss).
  //
  // Per-action result is tri-state, expressed as a backward-compatible
  // superset of the original boolean map: `true`/`false` remain the
  // shorthand for "allowed"/"denied" (existing fakes keep working
  // unmodified), and the string literals let a fake (or the real
  // SimulatePrincipalPolicy-backed impl in main() below) additionally
  // express "incomplete" — IAM returned MissingContextValues (e.g. a policy
  // condition on iam:PolicyARN that can't be supplied because the deny
  // policy doesn't exist yet at preflight time), or the check inherently
  // depends on a deploy-time-only ARN (the not-yet-created budgets action
  // ARN) that must never be fabricated. "incomplete" is NOT "denied" — it
  // means "could not be verified either way".
  //
  // `context.resourceArnsByAction` is an OPTIONAL third argument (ignored by
  // any two-parameter fake, since JS/TS callbacks may omit trailing
  // parameters) giving the real implementation the KNOWN target entity ARNs
  // to scope each detach action's simulation to.
  simulateRecoveryPermissions?(
    principalArn: string,
    actions: string[],
    context?: { resourceArnsByAction?: Record<string, string[]> }
  ): Promise<Record<string, RecoveryActionResult> | null>;
}

// See the doc comment on simulateRecoveryPermissions above.
export type RecoveryActionResult = boolean | "allowed" | "denied" | "incomplete";

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

const DETACH_ACTION_FOR_KIND: Record<Kind, string> = {
  user: "iam:DetachUserPolicy",
  group: "iam:DetachGroupPolicy",
  role: "iam:DetachRolePolicy"
};

// Per-action tri-state outcome, normalized from whatever the (possibly
// legacy-boolean) simulateRecoveryPermissions dep returned. An action the
// dep didn't report at all is treated as "incomplete" (never as a
// definitive "denied") — fail-closed for what it means ("could not be
// verified"), but never a false accusation of an explicit deny.
type ActionOutcome = "allowed" | "denied" | "incomplete";

function normalizeActionOutcome(v: RecoveryActionResult | undefined): ActionOutcome {
  if (v === true || v === "allowed") return "allowed";
  if (v === false || v === "denied") return "denied";
  return "incomplete";
}

// A recovery ROUTE: a set of actions that must ALL be "allowed" for that
// route to be usable. See the module-level gate rules in runPreflight below
// for how routes combine into an overall ALLOWED/DENIED/UNVERIFIED status.
interface RouteDef { name: string; actions: string[]; }
interface RouteStatus { name: string; status: ActionOutcome; outcomes: Record<string, ActionOutcome>; }

function evaluateRoute(route: RouteDef, sim: Record<string, RecoveryActionResult>): RouteStatus {
  const outcomes: Record<string, ActionOutcome> = {};
  for (const action of route.actions) outcomes[action] = normalizeActionOutcome(sim[action]);
  const values = Object.values(outcomes);
  let status: ActionOutcome;
  if (values.every(v => v === "allowed")) status = "allowed";
  else if (values.some(v => v === "incomplete")) status = "incomplete"; // incomplete beats a partial denial
  else status = "denied"; // not all allowed, none incomplete -> at least one definitive deny
  return { name: route.name, status, outcomes };
}

function formatRouteOutcomes(r: RouteStatus): string {
  return `${r.name} [${Object.entries(r.outcomes).map(([a, o]) => `${a}=${o}`).join(", ")}]`;
}

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
  nonDefaultBillingView?: boolean; unhealthy?: boolean; actualSpend?: number;
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
  // F5: current spend, straight off DescribeBudget's CalculatedSpend.ActualSpend.Amount.
  const actualSpend = b?.CalculatedSpend?.ActualSpend?.Amount !== undefined
    ? Number(b.CalculatedSpend.ActualSpend.Amount) : undefined;
  return {
    BudgetType: b?.BudgetType, TimeUnit: b?.TimeUnit, unit: b?.BudgetLimit?.Unit,
    scoped, expired, futureStart, amount, nonDefaultBillingView, unhealthy, actualSpend
  };
}

// --- F7: error clarity for preflight's own IAM/Budgets lookups. ---
//
// The PreflightDeps contract lets getUser/getRole/getGroup/describeBudget
// return null for "not found" (as before, backward-compatible with every
// existing fake), OR throw an Error whose `.name` matches the real AWS SDK
// exception name (e.g. "AccessDeniedException", "NoSuchEntityException").
// A thrown error is what lets runPreflight distinguish "the caller lacks a
// permission" (report exactly which one) from "genuinely not found" (a
// null return) instead of collapsing both into the same generic message.
const PERMISSION_FOR_KIND: Record<Kind, string> = {
  user: "iam:GetUser", role: "iam:GetRole", group: "iam:GetGroup"
};

type EntityResolution =
  | { ok: true; entity: IamPrincipal | IamGroupInfo | null }
  | { ok: false; message: string };

async function resolveEntity(kind: Kind, name: string, deps: PreflightDeps): Promise<EntityResolution> {
  try {
    let entity: IamPrincipal | IamGroupInfo | null;
    if (kind === "user") entity = await deps.getUser(name);
    else if (kind === "role") entity = await deps.getRole(name);
    else entity = await deps.getGroup(name);
    return { ok: true, entity };
  } catch (e: any) {
    if (e?.name === "AccessDeniedException") {
      return { ok: false, message: `access denied — the preflight caller lacks ${PERMISSION_FOR_KIND[kind]}` };
    }
    if (e?.name === "NoSuchEntityException") {
      return { ok: true, entity: null }; // same as a null return: genuinely not found
    }
    return { ok: false, message: `lookup failed (${e?.name ?? "Error"}: ${e?.message ?? String(e)})` };
  }
}

type BudgetResolution =
  | { ok: true; budget: Awaited<ReturnType<PreflightDeps["describeBudget"]>> }
  | { ok: false; message: string };

async function resolveBudget(name: string, deps: PreflightDeps): Promise<BudgetResolution> {
  try {
    const budget = await deps.describeBudget(name);
    return { ok: true, budget };
  } catch (e: any) {
    if (e?.name === "AccessDeniedException") {
      return { ok: false, message: "access denied — the preflight caller lacks budgets:DescribeBudget" };
    }
    if (e?.name === "NotFoundException") {
      return { ok: true, budget: null }; // genuinely not found
    }
    return { ok: false, message: `lookup failed (${e?.name ?? "Error"}: ${e?.message ?? String(e)})` };
  }
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

    const resolution = await resolveEntity(kind, bareName, deps);
    if (!resolution.ok) {
      fail(`${kind[0].toUpperCase()}${kind.slice(1)} target "${raw}" could not be checked: ${resolution.message}.`);
      continue;
    }
    const entity: IamGroupInfo | IamPrincipal | null = resolution.entity;

    if (!entity) {
      fail(`${kind[0].toUpperCase()}${kind.slice(1)} target "${raw}" could not be resolved in IAM (not found).`);
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
  // F6(a): actually compare the resolved target ARNs against the real,
  // predictable CDK bootstrap role names (the default "hnb659fds" qualifier)
  // instead of printing a static "typically not covered" note. Region is
  // only knowable here from the environment (AWS_REGION / CDK_DEFAULT_REGION)
  // — preflight makes no live lookup for it — so an unresolvable region
  // (or account) reports "unknown" rather than guessing.
  const cdkRegion = (process.env.AWS_REGION ?? process.env.CDK_DEFAULT_REGION ?? "").trim();
  if (!account || !cdkRegion) {
    info(
      "CDK bootstrap / CloudFormation execution role coverage: unknown (account and/or region not resolvable " +
      "from AWS_REGION/CDK_DEFAULT_REGION at preflight time)."
    );
  } else {
    const cdkRoles: Array<{ label: string; arn: string }> = [
      { label: "CDK bootstrap deploy role", arn: `arn:aws:iam::${account}:role/cdk-hnb659fds-deploy-role-${account}-${cdkRegion}` },
      { label: "CloudFormation execution role", arn: `arn:aws:iam::${account}:role/cdk-hnb659fds-cfn-exec-role-${account}-${cdkRegion}` }
    ];
    for (const { label, arn } of cdkRoles) {
      info(`${label} (${arn}): ${coveredArns.includes(arn) ? "covered" : "uncovered"} by the deny.`);
    }
  }

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
    // F10(c): a group can never assume anything or hold a session of its
    // own, so it can never actually perform the recovery detach/reversal —
    // reject it with a specific message instead of falling through to the
    // generic "could not be resolved" one.
    if (recoveryParsed.kind === "group") {
      fail(`Recovery principal ${config.recoveryPrincipalArn} is a group; recovery principal must be an IAM user or role.`);
    } else {
      const recoveryResolution = await resolveEntity(recoveryParsed.kind, recoveryParsed.name, deps);
      if (!recoveryResolution.ok) {
        fail(`Recovery principal ${config.recoveryPrincipalArn} could not be checked: ${recoveryResolution.message}.`);
      } else {
        const recoveryEntity = recoveryResolution.entity as IamPrincipal | null;
        if (!recoveryEntity) {
          fail(
            `Recovery principal ${config.recoveryPrincipalArn} could not be resolved in IAM (not found). ` +
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

  // F2/F3/F4 (tri-state recovery gate): recovery-permission simulation must
  // actually GATE deployment, not just be printed and ignored — but a single
  // arbitrary allowed action is NOT a usable recovery route (F2), an
  // unavailable simulation must not silently pass armed (F3), and the
  // simulation must be given enough context (known target entity ARNs) that
  // a properly-scoped recovery policy isn't misjudged as denied (F4).
  //
  // Two candidate ROUTES:
  //  - direct-detach: for EVERY configured target identity TYPE, the
  //    recovery principal can Detach{User,Group,Role}Policy on that type's
  //    target entities. A single irrelevant allowed detach (e.g. group
  //    detach when only roles are targeted) is not a route.
  //  - budgets-reversal: the recovery principal can budgets:ExecuteBudgetAction.
  //    Its resource (the budget action ARN) does not exist yet at preflight
  //    time and is never fabricated, so a non-allowed result here can only
  //    ever be "incomplete", never "denied" (see main()'s real impl below).
  //
  // Per-action outcome is allowed | denied (complete-context deny) |
  // incomplete (MissingContextValues, or the check depends on a
  // not-yet-created deploy-time ARN). Overall status:
  //  - ALLOWED  if any route is fully allowed.
  //  - DENIED   if simulation ran and every route is denied, with zero incompletes.
  //  - UNVERIFIED otherwise (simulation unavailable/absent, or any route incomplete).
  // Only skip this gate when the recovery identity itself is already invalid
  // (fail() above already covers that case; simulating against an
  // unresolvable principal would be meaningless).
  if (recoveryArn) {
    const configuredKinds: Kind[] = (["user", "group", "role"] as const).filter(k =>
      resolved.some(r => r.kind === k)
    );
    const routes: RouteDef[] = [];
    if (configuredKinds.length) {
      routes.push({ name: "direct-detach", actions: configuredKinds.map(k => DETACH_ACTION_FOR_KIND[k]) });
    }
    routes.push({ name: "budgets-reversal", actions: ["budgets:ExecuteBudgetAction"] });

    const resourceArnsByAction: Record<string, string[]> = {};
    for (const k of configuredKinds) {
      resourceArnsByAction[DETACH_ACTION_FOR_KIND[k]] = resolved.filter(r => r.kind === k).map(r => r.arn);
    }

    let sim: Record<string, RecoveryActionResult> | null = null;
    if (deps.simulateRecoveryPermissions) {
      try {
        sim = await deps.simulateRecoveryPermissions(config.recoveryPrincipalArn, RECOVERY_ACTIONS, { resourceArnsByAction });
      } catch {
        sim = null;
      }
    }

    const applyUnverifiedGate = (detail: string) => {
      if (config.safety === "armed") {
        fail(
          `${detail} Recovery could not be verified; armed auto-applies the deny — deploy in watch mode or ` +
          `grant a verifiable recovery route.`
        );
      } else {
        warn(`${detail} Recovery UNVERIFIED — verify you can lift the deny BEFORE approving it in the console.`);
      }
    };

    if (sim) {
      const lines = Object.entries(sim).map(
        ([action, v]) => `  - ${action}: ${normalizeActionOutcome(v).toUpperCase()} (simulated)`
      );
      info(`Policy simulation (best-effort, may not reflect SCPs/permission boundaries/runtime context):\n${lines.join("\n")}`);

      const routeStatuses = routes.map(r => evaluateRoute(r, sim!));
      const allowedRoute = routeStatuses.find(r => r.status === "allowed");
      const allDenied = routeStatuses.every(r => r.status === "denied");

      if (allowedRoute) {
        info(
          `At least one simulated recovery route is allowed: ${formatRouteOutcomes(allowedRoute)}. This does not ` +
          "prove the recovery principal can be assumed/accessed, nor does it account for SCPs, permission " +
          "boundaries, or other runtime context."
        );

        // F2: a budgets-reversal-ONLY recovery route does not survive
        // teardown. `cdk destroy` deletes the BudgetsAction (and with it,
        // the only thing budgets:ExecuteBudgetAction can act on) before the
        // managed deny policy — if the policy is still attached at that
        // point, DeleteManagedPolicy fails, and only iam:Detach*Policy can
        // free the identity afterward. Warn always; fail closed when armed,
        // since armed can auto-apply the deny with no console step in between.
        const directDetachAllowed = routeStatuses.some(r => r.name === "direct-detach" && r.status === "allowed");
        if (!directDetachAllowed && allowedRoute.name === "budgets-reversal") {
          const detail =
            "Recovery is allowed ONLY via budgets-reversal (budgets:ExecuteBudgetAction), not direct IAM " +
            "detach. Budgets-only recovery does NOT survive teardown: `cdk destroy` deletes the BudgetsAction " +
            "before the managed deny policy, and once the action is gone there is no budgets:ExecuteBudgetAction " +
            "resource left to reverse — if the deny policy is still attached at that point, DeleteManagedPolicy " +
            "fails and only iam:Detach{User,Group,Role}Policy can free the identity.";
          if (config.safety === "armed") {
            fail(
              `${detail} Grant the recovery principal iam:Detach*Policy on the target identities as well, or ` +
              "deploy in watch mode and always reverse-and-verify-detached before ever running cdk destroy."
            );
          } else {
            warn(detail);
          }
        }
      } else if (allDenied) {
        fail(
          `Policy simulation indicates NONE of the recovery actions (${RECOVERY_ACTIONS.join(", ")}) provide a ` +
          `working recovery route for ${config.recoveryPrincipalArn} (${routeStatuses.map(formatRouteOutcomes).join("; ")}). ` +
          `Without at least one complete, working recovery route, a deny cannot be reversed. Grant the recovery ` +
          `principal permission to detach the deny policy (for every targeted identity type) or execute the ` +
          `budget action, then re-run preflight.`
        );
      } else {
        applyUnverifiedGate(
          `Recovery is UNVERIFIED: at least one recovery route's simulation was incomplete (MissingContextValues, ` +
          `or it depends on a deploy-time-only ARN that does not exist yet and is never fabricated) — ` +
          `${routeStatuses.map(formatRouteOutcomes).join("; ")}.`
        );
      }
    } else if (deps.simulateRecoveryPermissions) {
      applyUnverifiedGate(
        "Policy simulation was unavailable (e.g. caller lacks iam:SimulatePrincipalPolicy); recovery is " +
        "UNVERIFIED (existence-only) — manually confirm the recovery principal holds working permissions."
      );
    } else {
      applyUnverifiedGate(
        "No permission-simulation capability was provided; recovery is UNVERIFIED (existence-only) — manually " +
        "confirm the recovery principal holds working permissions."
      );
    }
  } else {
    info("Recovery permission simulation skipped because the recovery principal could not be validated above.");
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
    const budgetResolution = await resolveBudget(config.existingBudgetName, deps);
    if (!budgetResolution.ok) {
      fail(`Existing budget "${config.existingBudgetName}" could not be checked: ${budgetResolution.message}.`);
    } else if (!budgetResolution.budget) {
      fail(`Existing budget "${config.existingBudgetName}" not found.`);
    } else {
      const b = budgetResolution.budget;
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

        // F5: a budget already at/over the action threshold at deploy time
        // will fire almost immediately (the next AWS Budgets refresh, up to
        // ~8-12h) rather than acting as a forward-looking tripwire. Warn
        // loudly always; fail closed when armed, since armed has no console
        // approval step to catch this before the deny applies.
        if (typeof b.actualSpend === "number" && Number.isFinite(b.actualSpend) && b.actualSpend >= effectiveThresholdUsd) {
          const detail =
            `This budget's current spend ($${b.actualSpend.toFixed(2)}) is already at or over the action ` +
            `threshold (~$${effectiveThresholdUsd.toFixed(2)}); the deny will fire within hours of deploy, at ` +
            "the next AWS Budgets refresh — this is NOT a forward-looking tripwire in this state.";
          if (config.safety === "armed") {
            fail(`${detail} Deploy in watch mode instead, or raise the budget/threshold, then re-run preflight.`);
          } else {
            warn(detail);
          }
        }
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
      // F7: only a genuine "not found" (NoSuchEntityException) is swallowed
      // to null here — every other error (AccessDeniedException in
      // particular) is rethrown so runPreflight's resolveEntity() can tell
      // "does not exist" apart from "the preflight caller lacks permission
      // to check" instead of collapsing both into the same generic message.
      getUser: async (n) => {
        try {
          const r = await iam.send(new GetUserCommand({ UserName: n }));
          return { arn: r.User!.Arn!, path: r.User!.Path };
        } catch (e: any) {
          if (e?.name === "NoSuchEntityException") return null;
          throw e;
        }
      },
      getRole: async (n) => {
        try {
          const r = await iam.send(new GetRoleCommand({ RoleName: n }));
          return { arn: r.Role!.Arn!, path: r.Role!.Path };
        } catch (e: any) {
          if (e?.name === "NoSuchEntityException") return null;
          throw e;
        }
      },
      // F5: GetGroup is paginated via paginateGetGroup (IsTruncated/Marker),
      // so caller/recovery membership on later pages isn't missed.
      getGroup: async (n) => {
        try {
          return await paginateGetGroup(async (marker) => {
            const r = await iam.send(new GetGroupCommand({ GroupName: n, Marker: marker }));
            return { Group: r.Group, Users: r.Users, IsTruncated: r.IsTruncated, Marker: r.Marker };
          });
        } catch (e: any) {
          if (e?.name === "NoSuchEntityException") return null;
          throw e;
        }
      },
      describeBudget: async (name) => {
        try {
          const acct = (await sts.send(new GetCallerIdentityCommand({}))).Account!;
          const r = await budgets.send(new DescribeBudgetCommand({
            AccountId: acct, BudgetName: name, ShowFilterExpression: true
          } as any));
          return adaptBudgetForPreflight(r.Budget as any);
        } catch (e: any) {
          if (e?.name === "NotFoundException") return null;
          throw e;
        }
      },
      // Simulated PER ACTION (rather than one batched call) so each action
      // can be scoped to its own known resource ARNs (the target IAM
      // entities — real and known at preflight time) via
      // context.resourceArnsByAction. budgets:ExecuteBudgetAction has no
      // known resource (the budget action ARN doesn't exist yet and is
      // never fabricated), so it's simulated resource-less and any
      // non-allowed result is reported as "incomplete", never "denied" —
      // see runPreflight's tri-state gate for how that's combined into an
      // overall ALLOWED/DENIED/UNVERIFIED recovery status.
      simulateRecoveryPermissions: async (principalArn, actions, context) => {
        const out: Record<string, RecoveryActionResult> = {};
        for (const action of actions) {
          const resourceArns = context?.resourceArnsByAction?.[action];
          try {
            const r = await iam.send(new SimulatePrincipalPolicyCommand({
              PolicySourceArn: principalArn,
              ActionNames: [action],
              ...(resourceArns && resourceArns.length ? { ResourceArns: resourceArns } : {})
            }));
            const res = r.EvaluationResults?.[0];
            if (!res) { out[action] = "incomplete"; continue; }
            if ((res.MissingContextValues ?? []).length > 0) { out[action] = "incomplete"; continue; }
            const allowed = res.EvalDecision === "allowed";
            if (action === "budgets:ExecuteBudgetAction" && !resourceArns) {
              // Resource (the budget action ARN) is unknown pre-deploy — a
              // non-allowed result can't be trusted as a definitive deny.
              out[action] = allowed ? "allowed" : "incomplete";
            } else {
              out[action] = allowed ? "allowed" : "denied";
            }
          } catch (e: any) {
            // F7: iam:SimulatePrincipalPolicy is a caller-level permission,
            // not scoped per simulated action — if the preflight caller
            // itself lacks it, EVERY action will fail the exact same way,
            // so short-circuit the whole simulation as unavailable (the
            // caller sees "caller lacks iam:SimulatePrincipalPolicy" via
            // runPreflight's applyUnverifiedGate) instead of mislabeling it
            // "incomplete" (which reads as a MissingContextValues result).
            if (e?.name === "AccessDeniedException") return null;
            out[action] = "incomplete";
          }
        }
        return out;
      }
    };

    const result = await runPreflight(config, deps);
    for (const m of result.messages) console.log(m);
    if (!result.ok) { console.error("\nPreflight FAILED. Deployment aborted."); process.exit(1); }
    console.log("\nPreflight passed.");
  })();
}
