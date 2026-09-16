import { runPreflight, PreflightDeps, paginateGetGroup, adaptBudgetForPreflight } from "../preflight";
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

test("Path A rejects a non-USD budget (currency branch, independent of type/period/scoped)", async () => {
  const r = await runPreflight(cfg({ existingBudgetName: "B" }), deps({
    describeBudget: async () => ({ BudgetType: "COST", TimeUnit: "MONTHLY", unit: "EUR", scoped: false })
  }));
  expect(r.ok).toBe(false);
  expect(r.messages.join("\n")).toMatch(/USD/);
});

test("Path A rejects a budget whose time period has already expired", async () => {
  const r = await runPreflight(cfg({ existingBudgetName: "B" }), deps({
    describeBudget: async () => ({
      BudgetType: "COST", TimeUnit: "MONTHLY", unit: "USD", scoped: false, expired: true
    })
  }));
  expect(r.ok).toBe(false);
  expect(r.messages.join("\n")).toMatch(/expired|inactive/i);
});

test("Path A rejects a budget with a non-positive limit amount", async () => {
  const r = await runPreflight(cfg({ existingBudgetName: "B" }), deps({
    describeBudget: async () => ({
      BudgetType: "COST", TimeUnit: "MONTHLY", unit: "USD", scoped: false, amount: 0
    })
  }));
  expect(r.ok).toBe(false);
  expect(r.messages.join("\n")).toMatch(/limit.*positive/i);
});

test("Path A accepts a budget when expired/amount fields are omitted (backward-compatible)", async () => {
  const r = await runPreflight(cfg({ existingBudgetName: "B" }), deps({
    describeBudget: async () => ({ BudgetType: "COST", TimeUnit: "MONTHLY", unit: "USD", scoped: false })
  }));
  expect(r.ok).toBe(true);
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

test("rejects a full-ARN target whose real resolved ARN differs from the one supplied (typo'd path)", async () => {
  const raw = "arn:aws:iam::111122223333:user/wrongpath/student";
  const r = await runPreflight(
    cfg({ denyTargetUsers: [raw] }),
    deps({
      getUser: async () => ({ arn: "arn:aws:iam::111122223333:user/college/student", path: "/college/" })
    })
  );
  expect(r.ok).toBe(false);
  const text = r.messages.join("\n");
  expect(text).toMatch(/does not match the resolved identity/i);
  expect(text).toMatch(/\.env/i);
});

test("rejects a full-ARN target placed in the wrong config array (role ARN under denyTargetUsers)", async () => {
  const r = await runPreflight(
    cfg({ denyTargetUsers: ["arn:aws:iam::111122223333:role/Admin"] }),
    deps()
  );
  expect(r.ok).toBe(false);
  const text = r.messages.join("\n");
  expect(text).toMatch(/configured as a user/i);
  expect(text).toMatch(/names a role/i);
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

// --- F2: recovery permission simulation must GATE (fail-closed) ---

test("F2: all-denied simulation fails preflight closed", async () => {
  const r = await runPreflight(cfg(), deps({
    simulateRecoveryPermissions: async (_arn, actions) => {
      const out: Record<string, boolean> = {};
      for (const a of actions) out[a] = false;
      return out;
    }
  }));
  expect(r.ok).toBe(false);
  const text = r.messages.join("\n");
  expect(text).toMatch(/none of the recovery actions/i);
  expect(text).toMatch(/working recovery route/i);
});

test("F2: one allowed recovery route is sufficient to pass (does not require every action)", async () => {
  const r = await runPreflight(cfg(), deps({
    simulateRecoveryPermissions: async (_arn, actions) => {
      const out: Record<string, boolean> = {};
      for (const a of actions) out[a] = false;
      out["budgets:ExecuteBudgetAction"] = true; // only one route allowed
      return out;
    }
  }));
  expect(r.ok).toBe(true);
  expect(r.messages.join("\n")).toMatch(/at least one simulated recovery route is allowed/i);
});

test("F2: simulation unavailable (no dep provided) does not fail, but reports recovery UNVERIFIED", async () => {
  const r = await runPreflight(cfg(), deps()); // deps() provides no simulateRecoveryPermissions
  expect(r.ok).toBe(true);
  expect(r.messages.join("\n")).toMatch(/recovery is UNVERIFIED/i);
});

test("F2: simulation call failing (dep present, returns null) does not fail, but reports recovery UNVERIFIED", async () => {
  const r = await runPreflight(cfg(), deps({ simulateRecoveryPermissions: async () => null }));
  expect(r.ok).toBe(true);
  expect(r.messages.join("\n")).toMatch(/UNVERIFIED/);
});

// --- F3: recovery ARN must match the RESOLVED identity (account + path) ---

test("F3: rejects a cross-account recovery principal ARN", async () => {
  const r = await runPreflight(
    cfg({ recoveryPrincipalArn: "arn:aws:iam::999988887777:role/Admin" }),
    deps()
  );
  expect(r.ok).toBe(false);
  expect(r.messages.join("\n")).toMatch(/account/i);
});

test("F3: rejects a recovery principal ARN whose resolved identity has a different path", async () => {
  const raw = "arn:aws:iam::111122223333:role/Admin";
  const r = await runPreflight(
    cfg({ recoveryPrincipalArn: raw }),
    deps({ getRole: async () => ({ arn: "arn:aws:iam::111122223333:role/college/Admin", path: "/college/" }) })
  );
  expect(r.ok).toBe(false);
  expect(r.messages.join("\n")).toMatch(/does not match the resolved identity/i);
});

test("F3: accepts a recovery principal ARN that matches the resolved identity exactly", async () => {
  const r = await runPreflight(cfg(), deps());
  expect(r.ok).toBe(true);
  expect(r.messages.join("\n")).toMatch(/matches the resolved identity/i);
});

// --- F4: existing-budget validation covers dates, billing view, health, and limit ---

test("F4: rejects a budget whose time period has not started yet (future start)", async () => {
  const r = await runPreflight(cfg({ existingBudgetName: "B" }), deps({
    describeBudget: async () => ({
      BudgetType: "COST", TimeUnit: "MONTHLY", unit: "USD", scoped: false, futureStart: true
    })
  }));
  expect(r.ok).toBe(false);
  expect(r.messages.join("\n")).toMatch(/not started|future start/i);
});

test("F4: rejects a budget with a non-default (custom) BillingViewArn", async () => {
  const r = await runPreflight(cfg({ existingBudgetName: "B" }), deps({
    describeBudget: async () => ({
      BudgetType: "COST", TimeUnit: "MONTHLY", unit: "USD", scoped: false, nonDefaultBillingView: true
    })
  }));
  expect(r.ok).toBe(false);
  expect(r.messages.join("\n")).toMatch(/billing view/i);
});

test("F4: rejects a budget reporting an unhealthy status", async () => {
  const r = await runPreflight(cfg({ existingBudgetName: "B" }), deps({
    describeBudget: async () => ({
      BudgetType: "COST", TimeUnit: "MONTHLY", unit: "USD", scoped: false, unhealthy: true
    })
  }));
  expect(r.ok).toBe(false);
  expect(r.messages.join("\n")).toMatch(/unhealthy/i);
});

test("F4: rejects a non-finite budget limit (NaN/Infinity), not just non-positive", async () => {
  const r = await runPreflight(cfg({ existingBudgetName: "B" }), deps({
    describeBudget: async () => ({
      BudgetType: "COST", TimeUnit: "MONTHLY", unit: "USD", scoped: false, amount: Infinity
    })
  }));
  expect(r.ok).toBe(false);
  expect(r.messages.join("\n")).toMatch(/finite positive amount/i);
});

test("F4: adaptBudgetForPreflight maps a realistic DescribeBudget SDK response", () => {
  const raw = {
    BudgetType: "COST",
    TimeUnit: "MONTHLY",
    BudgetLimit: { Amount: "25.50", Unit: "USD" },
    TimePeriod: {
      Start: new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
      End: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString()
    },
    CostFilters: {},
    BillingViewArn: "arn:aws:billing::111122223333:billingview/primary",
    HealthStatus: { Status: "HEALTHY" }
  };
  const mapped = adaptBudgetForPreflight(raw);
  expect(mapped).toEqual({
    BudgetType: "COST",
    TimeUnit: "MONTHLY",
    unit: "USD",
    scoped: false,
    expired: false,
    futureStart: false,
    amount: 25.5,
    nonDefaultBillingView: false,
    unhealthy: false
  });
});

test("F4: adaptBudgetForPreflight flags a future-start, custom-billing-view, unhealthy realistic response", () => {
  const raw = {
    BudgetType: "COST",
    TimeUnit: "MONTHLY",
    BudgetLimit: { Amount: "10", Unit: "USD" },
    TimePeriod: {
      Start: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      End: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString()
    },
    BillingViewArn: "arn:aws:billing::111122223333:billingview/custom-view-id",
    HealthStatus: { Status: "UNHEALTHY" }
  };
  const mapped = adaptBudgetForPreflight(raw);
  expect(mapped.futureStart).toBe(true);
  expect(mapped.nonDefaultBillingView).toBe(true);
  expect(mapped.unhealthy).toBe(true);
});

test("F4: a valid monthly-USD-cost active whole-account budget (via the realistic-response adapter) passes", async () => {
  const raw = {
    BudgetType: "COST",
    TimeUnit: "MONTHLY",
    BudgetLimit: { Amount: "25.50", Unit: "USD" },
    TimePeriod: {
      Start: new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
      End: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString()
    },
    BillingViewArn: "arn:aws:billing::111122223333:billingview/primary",
    HealthStatus: { Status: "HEALTHY" }
  };
  const mapped = adaptBudgetForPreflight(raw);
  const r = await runPreflight(cfg({ existingBudgetName: "B" }), deps({
    describeBudget: async () => mapped
  }));
  expect(r.ok).toBe(true);
});

test("F4: adaptBudgetForPreflight does not mark a budget with no HealthStatus field as unhealthy", () => {
  const raw = {
    BudgetType: "COST",
    TimeUnit: "MONTHLY",
    BudgetLimit: { Amount: "25.50", Unit: "USD" },
    TimePeriod: {
      Start: new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
      End: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString()
    },
    BillingViewArn: "arn:aws:billing::111122223333:billingview/primary"
    // HealthStatus intentionally omitted — real budgets can lack it.
  };
  const mapped = adaptBudgetForPreflight(raw);
  expect(mapped.unhealthy).toBe(false);
});

test("F4: a budget with no HealthStatus field still passes preflight (not wrongly failed)", async () => {
  const raw = {
    BudgetType: "COST",
    TimeUnit: "MONTHLY",
    BudgetLimit: { Amount: "25.50", Unit: "USD" },
    TimePeriod: {
      Start: new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
      End: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString()
    },
    BillingViewArn: "arn:aws:billing::111122223333:billingview/primary"
  };
  const mapped = adaptBudgetForPreflight(raw);
  const r = await runPreflight(cfg({ existingBudgetName: "B" }), deps({
    describeBudget: async () => mapped
  }));
  expect(r.ok).toBe(true);
});

// --- F5: caller/group coverage correctness ---

test("F5: resolves an assumed-role caller to its backing role for coverage", async () => {
  const r = await runPreflight(
    cfg({
      denyTargetUsers: [], denyTargetRoles: ["DevRole"],
      recoveryPrincipalArn: "arn:aws:iam::111122223333:role/RecoveryAdmin"
    }),
    deps({
      getCallerIdentity: async () => ({
        Account: "111122223333",
        Arn: "arn:aws:sts::111122223333:assumed-role/DevRole/my-session"
      })
    })
  );
  expect(r.ok).toBe(true);
  const text = r.messages.join("\n");
  expect(text).toMatch(/resolved backing role/i);
  expect(text).toMatch(/caller is directly covered/i);
});

test("F5: an assumed-role caller whose backing role is NOT a target is reported not covered", async () => {
  const r = await runPreflight(
    cfg({
      denyTargetUsers: [], denyTargetRoles: ["SomeOtherRole"],
      recoveryPrincipalArn: "arn:aws:iam::111122223333:role/RecoveryAdmin"
    }),
    deps({
      getCallerIdentity: async () => ({
        Account: "111122223333",
        Arn: "arn:aws:sts::111122223333:assumed-role/DevRole/my-session"
      })
    })
  );
  expect(r.messages.join("\n")).toMatch(/not covered/i);
});

test("F5: paginateGetGroup follows IsTruncated/Marker across pages and merges members", async () => {
  const markersSeen: Array<string | undefined> = [];
  const page1 = {
    Group: { Arn: "arn:aws:iam::111122223333:group/Ops", Path: "/" },
    Users: [{ Arn: "arn:aws:iam::111122223333:user/alice", Path: "/" }],
    IsTruncated: true,
    Marker: "page2"
  };
  const page2 = {
    Group: { Arn: "arn:aws:iam::111122223333:group/Ops", Path: "/" },
    Users: [{ Arn: "arn:aws:iam::111122223333:user/student", Path: "/" }],
    IsTruncated: false
  };
  const result = await paginateGetGroup(async (marker) => {
    markersSeen.push(marker);
    return marker === undefined ? page1 : page2;
  });
  expect(markersSeen).toEqual([undefined, "page2"]);
  expect(result?.arn).toBe("arn:aws:iam::111122223333:group/Ops");
  expect(result?.users.map(u => u.arn)).toEqual([
    "arn:aws:iam::111122223333:user/alice",
    "arn:aws:iam::111122223333:user/student"
  ]);
});

test("F5: caller covered via group membership that only appears on the second page", async () => {
  const callerArn = "arn:aws:iam::111122223333:user/someoneelse";
  const r = await runPreflight(cfg({ denyTargetUsers: [], denyTargetGroups: ["Ops"] }), deps({
    getCallerIdentity: async () => ({ Account: "111122223333", Arn: callerArn }),
    getGroup: async (n) => paginateGetGroup(async (marker) => {
      if (marker === undefined) {
        return {
          Group: { Arn: `arn:aws:iam::111122223333:group/${n}`, Path: "/" },
          Users: [{ Arn: "arn:aws:iam::111122223333:user/alice", Path: "/" }],
          IsTruncated: true,
          Marker: "page2"
        };
      }
      return {
        Group: { Arn: `arn:aws:iam::111122223333:group/${n}`, Path: "/" },
        Users: [{ Arn: callerArn, Path: "/" }],
        IsTruncated: false
      };
    })
  }));
  expect(r.ok).toBe(true);
  expect(r.messages.join("\n")).toMatch(/caller is covered only via group/i);
});

// --- Doc/UX: deploy summary (effective threshold + cost caveats) ---

test("deploy summary reports the effective USD threshold for Path B (no existing budget)", async () => {
  const r = await runPreflight(cfg({ monthlyBudgetUsd: 10, actionThresholdPercent: 50 }), deps());
  expect(r.ok).toBe(true);
  expect(r.messages.join("\n")).toMatch(/effective action threshold.*\$5\.00/i);
});

test("deploy summary reports the effective USD threshold for Path A when the existing budget's limit is known", async () => {
  const r = await runPreflight(cfg({ existingBudgetName: "B", actionThresholdPercent: 50 }), deps({
    describeBudget: async () => ({ BudgetType: "COST", TimeUnit: "MONTHLY", unit: "USD", scoped: false, amount: 20 })
  }));
  expect(r.ok).toBe(true);
  expect(r.messages.join("\n")).toMatch(/effective action threshold.*\$10\.00/i);
});

test("deploy summary includes a cost-metric/credits caveat and a near-zero-not-$0 estimate note", async () => {
  const r = await runPreflight(cfg(), deps());
  const text = r.messages.join("\n");
  expect(text).toMatch(/credits/i);
  expect(text).toMatch(/near-zero/i);
});
