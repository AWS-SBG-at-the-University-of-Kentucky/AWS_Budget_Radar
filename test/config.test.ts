import { loadConfig } from "../lib/config";

const base = {
  ALERT_EMAIL: "a@b.edu",
  MONTHLY_BUDGET_USD: "5",
  WARN_AT_PERCENT: "80",
  ACTION_THRESHOLD_PERCENT: "100",
  ACTION_THRESHOLD_TYPE: "ACTUAL",
  SAFETY: "watch",
  IAM_DENY_TARGET_USERS: "student",
  RECOVERY_PRINCIPAL_ARN: "arn:aws:iam::111122223333:role/Admin"
};

test("parses a valid Path B config", () => {
  const c = loadConfig({ ...base } as any);
  expect(c.existingBudgetName).toBeUndefined();
  expect(c.monthlyBudgetUsd).toBe(5);
  expect(c.safety).toBe("watch");
  expect(c.denyTargetUsers).toEqual(["student"]);
});

test("Path A when EXISTING_BUDGET_NAME set", () => {
  const c = loadConfig({ ...base, EXISTING_BUDGET_NAME: "MyBudget" } as any);
  expect(c.existingBudgetName).toBe("MyBudget");
});

test("rejects missing email", () => {
  const { ALERT_EMAIL, ...noEmail } = base as any;
  expect(() => loadConfig(noEmail)).toThrow(/ALERT_EMAIL/);
});

test("rejects when no deny target given", () => {
  const { IAM_DENY_TARGET_USERS, ...noTarget } = base as any;
  expect(() => loadConfig(noTarget)).toThrow(/at least one IAM deny target/i);
});

test("rejects missing recovery principal", () => {
  const { RECOVERY_PRINCIPAL_ARN, ...noRec } = base as any;
  expect(() => loadConfig(noRec)).toThrow(/RECOVERY_PRINCIPAL_ARN/);
});

test("rejects recovery principal that is also a deny target", () => {
  expect(() => loadConfig({ ...base, IAM_DENY_TARGET_ROLES: "arn:aws:iam::111122223333:role/Admin", RECOVERY_PRINCIPAL_ARN: "arn:aws:iam::111122223333:role/Admin" } as any))
    .toThrow(/recovery principal/i);
});

test("rejects invalid SAFETY", () => {
  expect(() => loadConfig({ ...base, SAFETY: "armedish" } as any)).toThrow(/SAFETY/);
});

test("rejects WARN_AT_PERCENT out of range", () => {
  expect(() => loadConfig({ ...base, WARN_AT_PERCENT: "0" } as any)).toThrow(/WARN_AT_PERCENT/);
});

test("rejects a RECOVERY_PRINCIPAL_ARN that is not IAM-ARN-shaped", () => {
  expect(() => loadConfig({ ...base, RECOVERY_PRINCIPAL_ARN: "not-an-arn" } as any)).toThrow(/full IAM ARN/);
});

test("rejects a wildcard deny target", () => {
  expect(() => loadConfig({ ...base, IAM_DENY_TARGET_USERS: "*" } as any)).toThrow(/wildcards/);
});

test("rejects a bare-name recovery/target collision after normalization", () => {
  const { IAM_DENY_TARGET_USERS, ...rest } = base as any;
  expect(() => loadConfig({
    ...rest,
    IAM_DENY_TARGET_ROLES: "Admin",
    RECOVERY_PRINCIPAL_ARN: "arn:aws:iam::111122223333:role/Admin"
  } as any)).toThrow(/recovery principal/i);
});

test("no false positive when recovery and target are different identity types", () => {
  const c = loadConfig({
    ...base,
    IAM_DENY_TARGET_USERS: "student",
    RECOVERY_PRINCIPAL_ARN: "arn:aws:iam::111122223333:role/Admin"
  } as any);
  expect(c.denyTargetUsers).toEqual(["student"]);
  expect(c.recoveryPrincipalArn).toBe("arn:aws:iam::111122223333:role/Admin");
});

test("same name, different identity type: role recovery 'Admin' vs user target 'Admin' does not collide", () => {
  // A plain string .includes()/equality check would wrongly treat these as
  // the same identity (both "Admin"); the normalized "type/name" comparison
  // must distinguish role/Admin from user/Admin and allow this to load.
  const c = loadConfig({
    ...base,
    IAM_DENY_TARGET_USERS: "Admin",
    RECOVERY_PRINCIPAL_ARN: "arn:aws:iam::111122223333:role/Admin"
  } as any);
  expect(c.denyTargetUsers).toContain("Admin");
});

test("TRACK_GROSS_USAGE defaults to true (ignore credits) when unset", () => {
  expect(loadConfig({ ...base } as any).trackGrossUsage).toBe(true);
});

test("TRACK_GROSS_USAGE=false opts back into net-of-credits", () => {
  expect(loadConfig({ ...base, TRACK_GROSS_USAGE: "false" } as any).trackGrossUsage).toBe(false);
  expect(loadConfig({ ...base, TRACK_GROSS_USAGE: "FALSE" } as any).trackGrossUsage).toBe(false);
});

test("TRACK_GROSS_USAGE accepts true (case-insensitive)", () => {
  expect(loadConfig({ ...base, TRACK_GROSS_USAGE: "True" } as any).trackGrossUsage).toBe(true);
});

test("rejects an invalid TRACK_GROSS_USAGE", () => {
  expect(() => loadConfig({ ...base, TRACK_GROSS_USAGE: "yes" } as any)).toThrow(/TRACK_GROSS_USAGE/);
});

test("EXCLUDE_SERVICES defaults to empty (unscoped, protects total cost)", () => {
  expect(loadConfig({ ...base } as any).excludeServices).toEqual([]);
});

test("parses EXCLUDE_SERVICES as a trimmed, comma-separated list", () => {
  const c = loadConfig({ ...base, EXCLUDE_SERVICES: "AWS Cost Explorer, Amazon Simple Storage Service" } as any);
  expect(c.excludeServices).toEqual(["AWS Cost Explorer", "Amazon Simple Storage Service"]);
});

test("parses SERVICE_BUDGETS list", () => {
  const c = loadConfig({ ...base, SERVICE_BUDGETS: "Amazon Elastic Compute Cloud - Compute:20,Amazon SageMaker:10" } as any);
  expect(c.serviceBudgets).toEqual([
    { service: "Amazon Elastic Compute Cloud - Compute", limitUsd: 20 },
    { service: "Amazon SageMaker", limitUsd: 10 }
  ]);
});

// --- Native stop actions (STOP_EC2_INSTANCES / STOP_RDS_INSTANCES) ---

test("no STOP_* configured means no stop groups (nothing is ever stopped by default)", () => {
  expect(loadConfig({ ...base } as any).stopGroups).toEqual([]);
});

test("bare IDs go to the deploy region; region:id entries are grouped per region; duplicates dropped", () => {
  const c = loadConfig({
    ...base,
    STOP_EC2_INSTANCES: "i-0123456789abcdef0, us-west-2:i-0fedcba9876543210, i-0123456789abcdef0, i-12345678",
    STOP_RDS_INSTANCES: "LabDB, eu-west-1:other-db"
  } as any);
  expect(c.stopGroups).toEqual([
    { kind: "EC2", region: undefined, ids: ["i-0123456789abcdef0", "i-12345678"] },
    { kind: "EC2", region: "us-west-2", ids: ["i-0fedcba9876543210"] },
    { kind: "RDS", region: undefined, ids: ["labdb"] },            // RDS identifiers are lowercased
    { kind: "RDS", region: "eu-west-1", ids: ["other-db"] }
  ]);
});

test.each([
  ["STOP_EC2_INSTANCES", "i-xyz", /EC2 instance ID/],
  ["STOP_EC2_INSTANCES", "ami-0123456789abcdef0", /EC2 instance ID/],
  ["STOP_EC2_INSTANCES", "useast1:i-0123456789abcdef0", /invalid region/],
  ["STOP_RDS_INSTANCES", "1db", /RDS DB instance identifier/],
  ["STOP_RDS_INSTANCES", "db-", /RDS DB instance identifier/],
  ["STOP_RDS_INSTANCES", "my--db", /RDS DB instance identifier/],
  ["STOP_RDS_INSTANCES", "arn:aws:rds:us-east-1:111122223333:db:x", /invalid region/]
])("rejects %s=%s", (name, value, err) => {
  expect(() => loadConfig({ ...base, [name]: value } as any)).toThrow(err);
});

test("rejects more than 100 instances in one region (AWS limit per stop action)", () => {
  const ids = Array.from({ length: 101 }, (_, i) => `i-${i.toString(16).padStart(8, "0")}`).join(",");
  expect(() => loadConfig({ ...base, STOP_EC2_INSTANCES: ids } as any)).toThrow(/at most 100/);
});
