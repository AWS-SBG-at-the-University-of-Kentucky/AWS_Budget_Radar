import { runPreflight, PreflightDeps } from "../preflight";
import { RadarConfig } from "../lib/config";

function cfg(overrides: Partial<RadarConfig> = {}): RadarConfig {
  return {
    alertEmail: "a@b.edu",
    existingBudgetName: undefined,
    monthlyBudgetUsd: 5,
    warnAtPercent: 80,
    actionThresholdPercent: 100,
    actionThresholdType: "ACTUAL",
    safety: "watch",
    denyTargetUsers: ["student"],
    denyTargetGroups: [],
    denyTargetRoles: [],
    recoveryPrincipalArn: "arn:aws:iam::111122223333:role/Admin",
    serviceBudgets: [],
    ...overrides
  };
}

function deps(overrides: Partial<PreflightDeps> = {}): PreflightDeps {
  return {
    getCallerIdentity: async () => ({ Account: "111122223333", Arn: "arn:aws:iam::111122223333:user/student" }),
    getUser: async (n) => ({ arn: `arn:aws:iam::111122223333:user/${n}`, path: "/" }),
    getRole: async (n) => ({ arn: `arn:aws:iam::111122223333:role/${n}`, path: "/" }),
    getGroup: async (n) => ({ arn: `arn:aws:iam::111122223333:group/${n}`, path: "/", users: [] }),
    describeBudget: async () => null,
    ...overrides
  };
}

// --- Base behavior (brief) ---

test("passes when caller is a covered user (direct)", async () => {
  const r = await runPreflight(cfg(), deps());
  expect(r.ok).toBe(true);
  expect(r.messages.join("\n")).toMatch(/caller.*covered/i);
});

test("rejects AWSReservedSSO role targets", async () => {
  const r = await runPreflight(cfg({ denyTargetRoles: ["AWSReservedSSO_Admin_abc"] }), deps());
  expect(r.ok).toBe(false);
  expect(r.messages.join("\n")).toMatch(/AWSReservedSSO/);
});

test("rejects an unresolved target", async () => {
  const r = await runPreflight(cfg(), deps({ getUser: async () => null }));
  expect(r.ok).toBe(false);
  expect(r.messages.join("\n")).toMatch(/could not be resolved/i);
});

test("Path A rejects a non-monthly / non-USD / scoped budget", async () => {
  const r = await runPreflight(cfg({ existingBudgetName: "B" }), deps({
    describeBudget: async () => ({ BudgetType: "USAGE", TimeUnit: "ANNUALLY", unit: "USD", scoped: true })
  }));
  expect(r.ok).toBe(false);
  expect(r.messages.join("\n")).toMatch(/COST|MONTHLY|scoped/i);
});

test("warns caller is not covered", async () => {
  const r = await runPreflight(cfg(), deps({
    getCallerIdentity: async () => ({ Account: "111122223333", Arn: "arn:aws:iam::111122223333:user/someoneelse" })
  }));
  expect(r.messages.join("\n")).toMatch(/caller.*not covered/i);
});

// --- Augmentation 1: group coverage of caller & recovery principal ---

test("reports caller covered only via a group target", async () => {
  const callerArn = "arn:aws:iam::111122223333:user/someoneelse";
  const r = await runPreflight(cfg({ denyTargetUsers: [], denyTargetGroups: ["Ops"] }), deps({
    getCallerIdentity: async () => ({ Account: "111122223333", Arn: callerArn }),
    getGroup: async (n) => ({ arn: `arn:aws:iam::111122223333:group/${n}`, path: "/", users: [{ arn: callerArn }] })
  }));
  expect(r.ok).toBe(true);
  expect(r.messages.join("\n")).toMatch(/caller is covered only via group/i);
});

test("flags recovery principal covered via a deny-target group", async () => {
  const recoveryArn = "arn:aws:iam::111122223333:user/recovery-admin";
  const r = await runPreflight(
    cfg({ denyTargetGroups: ["Ops"], recoveryPrincipalArn: recoveryArn }),
    deps({
      getUser: async (n) => ({ arn: `arn:aws:iam::111122223333:user/${n}`, path: "/" }),
      getGroup: async (n) => ({
        arn: `arn:aws:iam::111122223333:group/${n}`,
        path: "/",
        users: [{ arn: recoveryArn }]
      })
    })
  );
  expect(r.ok).toBe(false);
  const text = r.messages.join("\n");
  expect(text).toMatch(/recovery/i);
  expect(text).toMatch(/group/i);
});

// --- Augmentation 2: path-aware ARN resolution ---

test("rejects a bare-name target whose real ARN has a non-root IAM path", async () => {
  const r = await runPreflight(cfg({ denyTargetUsers: ["student"] }), deps({
    getUser: async (n) => ({ arn: `arn:aws:iam::111122223333:user/college/${n}`, path: "/college/" })
  }));
  expect(r.ok).toBe(false);
  const text = r.messages.join("\n");
  expect(text).toMatch(/path/i);
  expect(text).toMatch(/\.env/i);
});

test("accepts a bare-name target that resolves to the root path", async () => {
  const r = await runPreflight(cfg({ denyTargetUsers: ["student"] }), deps());
  expect(r.ok).toBe(true);
});

test("does not reject a full-ARN target for path even when the ARN itself has a non-root path", async () => {
  // A full ARN was explicitly supplied by the user, so there's no bare-name
  // assumption to mismatch — only bare names are path-checked.
  const r = await runPreflight(
    cfg({ denyTargetUsers: ["arn:aws:iam::111122223333:user/college/student"] }),
    deps({ getUser: async () => ({ arn: "arn:aws:iam::111122223333:user/college/student", path: "/college/" }) })
  );
  expect(r.ok).toBe(true);
});

// --- Augmentation 3: wildcard / cross-account rejection ---

test("rejects a wildcard target", async () => {
  const r = await runPreflight(cfg({ denyTargetUsers: ["student*"] }), deps());
  expect(r.ok).toBe(false);
  expect(r.messages.join("\n")).toMatch(/wildcard/i);
});

test("rejects a cross-account full-ARN target", async () => {
  const r = await runPreflight(
    cfg({ denyTargetUsers: ["arn:aws:iam::999988887777:user/student"] }),
    deps()
  );
  expect(r.ok).toBe(false);
  expect(r.messages.join("\n")).toMatch(/account/i);
});

// --- Augmentation 4: recovery-route permission check (best effort, qualified) ---

test("fails when the recovery principal cannot be resolved in IAM", async () => {
  const r = await runPreflight(cfg(), deps({ getRole: async () => null }));
  expect(r.ok).toBe(false);
  expect(r.messages.join("\n")).toMatch(/recovery principal.*could not be resolved/i);
});

test("qualifies that existence does not prove recovery permission, and reports simulation results when available", async () => {
  const r = await runPreflight(cfg(), deps({
    simulateRecoveryPermissions: async (_arn, actions) => {
      const out: Record<string, boolean> = {};
      for (const a of actions) out[a] = a !== "budgets:ExecuteBudgetAction";
      return out;
    }
  }));
  expect(r.ok).toBe(true);
  const text = r.messages.join("\n");
  expect(text).toMatch(/does not prove/i);
  expect(text).toMatch(/simulated/i);
});

test("notes when simulation is unavailable rather than silently skipping it", async () => {
  const r = await runPreflight(cfg(), deps({
    simulateRecoveryPermissions: async () => null
  }));
  expect(r.ok).toBe(true);
  expect(r.messages.join("\n")).toMatch(/simulation was unavailable/i);
});
