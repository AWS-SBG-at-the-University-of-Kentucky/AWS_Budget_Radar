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
  getGroup(name: string): Promise<IamGroupInfo | null>;
  describeBudget(name: string): Promise<{ BudgetType?: string; TimeUnit?: string; unit?: string; scoped: boolean } | null>;
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

export async function runPreflight(config: RadarConfig, deps: PreflightDeps): Promise<PreflightResult> {
  const messages: string[] = [];
  let ok = true;
  const fail = (m: string) => { ok = false; messages.push("FAIL: " + m); };
  const info = (m: string) => messages.push(m);
  const warn = (m: string) => messages.push("WARNING: " + m);

  const caller = await deps.getCallerIdentity();
  info(`Caller: ${caller.Arn} (account ${caller.Account})`);
  const account = caller.Account;

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
  const callerDirectlyCovered = !!caller.Arn && coveredArns.includes(caller.Arn);
  let callerGroupCoverage: string | undefined;
  if (!callerDirectlyCovered && caller.Arn) {
    const callerParsed = parseIamArn(caller.Arn);
    if (callerParsed?.kind === "user") {
      const hit = resolved.find(r => r.kind === "group" && r.groupUsers?.some(u => u.arn === caller.Arn));
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
  const recoveryParsed = parseIamArn(config.recoveryPrincipalArn);
  let recoveryEntity: IamPrincipal | null = null;
  if (recoveryParsed?.kind === "user") recoveryEntity = await deps.getUser(recoveryParsed.name);
  else if (recoveryParsed?.kind === "role") recoveryEntity = await deps.getRole(recoveryParsed.name);

  if (!recoveryEntity) {
    fail(
      `Recovery principal ${config.recoveryPrincipalArn} could not be resolved in IAM. ` +
      `Without a real, existing recovery principal there is no way to reverse the deny if it fires.`
    );
  } else {
    info("Recovery principal resolved successfully (exists in IAM).");
  }

  // Augmentation 4: existence != permission. Keep this qualified — we never
  // claim to have proven the recovery principal can actually detach the
  // policy or execute a manual budgets action.
  info(
    "IMPORTANT: resolving the recovery principal only proves it exists, not that it can reverse the action. " +
    "Manually confirm it holds iam:Detach{User,Group,Role}Policy (scoped to the DenyNewSpend policy) and, " +
    "for a MANUAL-approval action, budgets:ExecuteBudgetAction. This preflight does not prove those permissions."
  );
  if (deps.simulateRecoveryPermissions) {
    const sim = await deps.simulateRecoveryPermissions(config.recoveryPrincipalArn, RECOVERY_ACTIONS);
    if (sim) {
      const lines = Object.entries(sim).map(
        ([action, allowed]) => `  - ${action}: ${allowed ? "allowed (simulated)" : "NOT allowed (simulated)"}`
      );
      info(`Policy simulation (best-effort, may not reflect SCPs/permission boundaries/runtime context):\n${lines.join("\n")}`);
    } else {
      info("Policy simulation was unavailable (e.g. caller lacks iam:SimulatePrincipalPolicy); permission is unverified.");
    }
  }

  // Augmentation 1 (recovery half): recovery principal covered via a
  // deny-target group. This can block recovery through group coverage even
  // though lib/config.ts already rejects a *direct* target/recovery match.
  if (recoveryEntity && recoveryParsed?.kind === "user") {
    for (const r of resolved) {
      if (r.kind === "group" && r.groupUsers?.some(u => u.arn === config.recoveryPrincipalArn)) {
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
      getGroup: async (n) => {
        try {
          const r = await iam.send(new GetGroupCommand({ GroupName: n }));
          return {
            arn: r.Group!.Arn!,
            path: r.Group!.Path,
            users: (r.Users ?? []).map(u => ({ arn: u.Arn!, path: u.Path }))
          };
        } catch { return null; }
      },
      describeBudget: async (name) => {
        try {
          const acct = (await sts.send(new GetCallerIdentityCommand({}))).Account!;
          const r = await budgets.send(new DescribeBudgetCommand({
            AccountId: acct, BudgetName: name, ShowFilterExpression: true
          } as any));
          const b = r.Budget as any;
          const scoped = !!(b?.FilterExpression || (b?.CostFilters && Object.keys(b.CostFilters).length));
          return { BudgetType: b?.BudgetType, TimeUnit: b?.TimeUnit, unit: b?.BudgetLimit?.Unit, scoped };
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
