# AWS Budget Radar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A clone-and-deploy AWS CDK app that, when a cost budget is breached, blocks selected resource-creation operations by configured IAM identities and emails a best-effort, region-wide inventory of what is running and what is still costing money.

**Architecture:** One `AWS::Budgets::BudgetsAction` (attached to an existing budget by name, or to one the stack creates) applies an IAM deny (block selected creates) and notifies a TriggerTopic that invokes a read-only Python Lambda; the Lambda inventories all regions and publishes to a separate ReportTopic (email). Two topics prevent warning-triggered runs and report recursion. No resource is ever stopped, scaled, or deleted.

**Tech Stack:** AWS CDK 2.x (TypeScript), Python 3.13 Lambda (boto3 only, no runtime deps), Jest + `aws-cdk-lib/assertions` for infra tests, pytest + `botocore.stub.Stubber` for handler tests, AWS CLI v2.

**Spec:** `docs/superpowers/specs/2026-09-15-aws-budget-radar-design.md` (rev 2.2). Executors read both; the plan argues from the spec.

## Global Constraints

Copied verbatim from the spec. Every task's requirements implicitly include these.

- **Report-only remediation.** The Lambda makes **no workload or IAM mutation** — only `sns:Publish` and logging. It never stops, scales, or deletes any resource.
- **Deny policy is a positive list**, never `Deny: *`. It never denies `iam:*`, `budgets:*`, read-only (`Describe*`/`List*`/`Get*`), or `cloudformation:*`. Use IAM prefix `elasticmapreduce:`, never `emr:`.
- **Exactly one action-enabled budget.** Per-service budgets are notification-only (free).
- **Two SNS topics.** TriggerTopic: only the BudgetsAction publishes, only the Lambda subscribes. ReportTopic: Lambda + warn thresholds publish, only email subscribes. The Lambda never subscribes to ReportTopic.
- **SNS topics are unencrypted** (a deliberate simplicity choice; comment records why). Topic policies grant `budgets.amazonaws.com` `SNS:Publish` with confused-deputy conditions (`aws:SourceAccount` + `ArnLike aws:SourceArn arn:aws:budgets::<account>:*`).
- **IAM deny targets are REQUIRED** (≥1). Config validation and preflight both enforce this.
- **v1 supports only monthly USD COST budgets.** Scoped budgets are rejected.
- **CDK is the only deploy path.** Config is read from `.env` at synth time; synth performs **no live AWS lookup** (stacks are environment-agnostic; identity values flow to synth as written in `.env`).
- **Lambda:** Python 3.13, 512 MB, **900 s** timeout, `Code.fromAsset('lambda/')`, no bundled dependencies.
- **Honest language everywhere:** "blocks selected resource-creation operations" (not "blocks all spend"); "best-effort inventory with explicit coverage gaps" (not "complete"); this is a backstop, not a hard cap; a forgotten running workload keeps running until the member acts.
- **Deploy authorization boundary (this plan):** Tasks 1–11 are LOCAL — code, unit tests, and `cdk synth` only; they create **no** AWS resources and need no AWS credentials. Task 12 (`cdk bootstrap`, `cdk deploy`, live acceptance) creates/mutates real AWS resources and is **gated behind separate, explicit user authorization**, run only in a disposable account. Writing/executing Tasks 1–11 is **not** authorization to deploy.

**Pinned versions:** Node ≥ 20 (dev on 24.9), `aws-cdk-lib` ^2.160.0, `constrcts` ^10.3.0, `aws-cdk` (CLI) ^2.160.0, TypeScript ^5.5, Jest ^29, `ts-jest` ^29, `@types/jest`, `dotenv` ^16. AWS CLI v2 for deploy. Lambda runtime `python3.13`.

---

## File Structure

| File | Responsibility |
|---|---|
| `package.json`, `tsconfig.json`, `cdk.json`, `jest.config.js` | Project scaffold, scripts, CDK + test config |
| `.gitignore`, `.env.example` | Ignore `cdk.out/`/`node_modules/`/`.env`; the one file a member edits |
| `lib/config.ts` | Parse `.env` → typed `RadarConfig`; syntactic validation (throws actionable errors) |
| `lib/deny-policy.ts` | The positive-list deny policy document (pure function) |
| `lib/budget-radar-stack.ts` | The CDK stack: topics, policies, Lambda, deny policy, action role, budget/action |
| `bin/budget-radar.ts` | CDK entrypoint: load config, instantiate stack (environment-agnostic) |
| `lambda/handler.py` | Read-only inventory reporter (boto3 only) |
| `preflight.ts` | Read-only pre-deploy checks (STS identity, IAM target resolution, budget validation) |
| `test/config.test.ts`, `test/deny-policy.test.ts`, `test/stack.test.ts`, `test/preflight.test.ts` | Jest tests |
| `tests/test_handler.py` | pytest handler tests (botocore Stubber) |
| `README.md`, `RELEASE.md` | Member docs (deploy/teardown/limitations); release acceptance gate |

---

## Task 1: Project scaffold and tooling

**LOCAL.** Deliverable: `npm install` succeeds; `npm run build` compiles; `npx jest` runs (one trivial passing test); `npx cdk synth` on an empty app succeeds without AWS credentials.

**Files:**
- Create: `package.json`, `tsconfig.json`, `cdk.json`, `jest.config.js`, `.gitignore`, `test/smoke.test.ts`

**Interfaces:**
- Produces: `npm` scripts `build`, `test`, `synth`; a compiling TS + Jest project.

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "aws-budget-radar",
  "version": "0.1.0",
  "bin": { "budget-radar": "bin/budget-radar.js" },
  "scripts": {
    "build": "tsc",
    "test": "jest",
    "synth": "cdk synth",
    "preflight": "ts-node preflight.ts",
    "deploy": "ts-node preflight.ts && cdk deploy"
  },
  "devDependencies": {
    "@types/jest": "^29.5.12",
    "@types/node": "^20.14.0",
    "aws-cdk": "^2.160.0",
    "jest": "^29.7.0",
    "ts-jest": "^29.2.0",
    "ts-node": "^10.9.2",
    "typescript": "^5.5.0"
  },
  "dependencies": {
    "aws-cdk-lib": "^2.160.0",
    "constructs": "^10.3.0",
    "dotenv": "^16.4.5",
    "@aws-sdk/client-sts": "^3.600.0",
    "@aws-sdk/client-iam": "^3.600.0",
    "@aws-sdk/client-budgets": "^3.600.0"
  }
}
```

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "lib": ["ES2020"],
    "declaration": true,
    "strict": true,
    "noImplicitAny": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "types": ["node", "jest"]
  },
  "include": ["bin/**/*.ts", "lib/**/*.ts", "test/**/*.ts", "preflight.ts"],
  "exclude": ["node_modules", "cdk.out"]
}
```

- [ ] **Step 3: Write `cdk.json`**

```json
{
  "app": "npx ts-node --prefer-ts-exts bin/budget-radar.ts",
  "watch": { "exclude": ["README.md", "cdk*.json", "**/*.d.ts", "node_modules", "test", "tests"] },
  "context": {
    "@aws-cdk/core:enableStackNameDuplicates": true,
    "aws-cdk:enableDiffNoFail": true
  }
}
```

- [ ] **Step 4: Write `jest.config.js`**

```js
module.exports = {
  testEnvironment: "node",
  roots: ["<rootDir>/test"],
  testMatch: ["**/*.test.ts"],
  transform: { "^.+\\.ts$": "ts-jest" }
};
```

- [ ] **Step 5: Write `.gitignore`**

```
node_modules/
cdk.out/
.env
*.js
!jest.config.js
*.d.ts
__pycache__/
.pytest_cache/
```

- [ ] **Step 6: Write `test/smoke.test.ts`**

```ts
test("toolchain runs", () => {
  expect(1 + 1).toBe(2);
});
```

- [ ] **Step 7: Install and verify**

Run: `npm install && npx jest test/smoke.test.ts`
Expected: install completes; 1 test passes.

- [ ] **Step 8: Commit**

```bash
git add package.json tsconfig.json cdk.json jest.config.js .gitignore test/smoke.test.ts package-lock.json
git commit -m "chore: scaffold CDK + jest project"
```

---

## Task 2: Config loader and syntactic validation (`lib/config.ts`)

**LOCAL.** Pure TS: parse `process.env` into a typed config, throwing actionable errors. No AWS.

**Files:**
- Create: `lib/config.ts`, `test/config.test.ts`

**Interfaces:**
- Produces:
```ts
export type Safety = "watch" | "armed";
export type ThresholdType = "ACTUAL" | "FORECASTED";
export interface ServiceBudget { service: string; limitUsd: number; }
export interface RadarConfig {
  alertEmail: string;
  existingBudgetName?: string;       // undefined => Path B (create budget)
  monthlyBudgetUsd: number;          // used only in Path B
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
export function loadConfig(env: NodeJS.ProcessEnv): RadarConfig; // throws Error on invalid input
```

- [ ] **Step 1: Write the failing tests**

```ts
// test/config.test.ts
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

test("parses SERVICE_BUDGETS list", () => {
  const c = loadConfig({ ...base, SERVICE_BUDGETS: "Amazon Elastic Compute Cloud - Compute:20,Amazon SageMaker:10" } as any);
  expect(c.serviceBudgets).toEqual([
    { service: "Amazon Elastic Compute Cloud - Compute", limitUsd: 20 },
    { service: "Amazon SageMaker", limitUsd: 10 }
  ]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest test/config.test.ts`
Expected: FAIL — `loadConfig` not found.

- [ ] **Step 3: Implement `lib/config.ts`**

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest test/config.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/config.ts test/config.test.ts
git commit -m "feat: config loader with syntactic validation"
```

---

## Task 3: Deny policy document (`lib/deny-policy.ts`)

**LOCAL.** Pure function returning the positive-list deny policy. The most safety-critical file — isolated for review.

**Files:**
- Create: `lib/deny-policy.ts`, `test/deny-policy.test.ts`

**Interfaces:**
- Produces:
```ts
export const DENY_ACTIONS: string[];
export function denyPolicyDocument(): { Version: string; Statement: Array<{ Effect: string; Action: string[]; Resource: string }> };
```

- [ ] **Step 1: Write the failing tests**

```ts
// test/deny-policy.test.ts
import { denyPolicyDocument, DENY_ACTIONS } from "../lib/deny-policy";

test("denies representative create actions", () => {
  expect(DENY_ACTIONS).toEqual(expect.arrayContaining([
    "ec2:RunInstances", "rds:CreateDBInstance", "sagemaker:CreateNotebookInstance",
    "elasticmapreduce:RunJobFlow", "lambda:CreateFunction"
  ]));
});

test("uses elasticmapreduce prefix, never emr:", () => {
  expect(DENY_ACTIONS.some(a => a.startsWith("emr:"))).toBe(false);
});

test("never denies iam:, budgets:, read-only, or cloudformation:", () => {
  for (const a of DENY_ACTIONS) {
    expect(a).not.toMatch(/^iam:/);
    expect(a).not.toMatch(/^budgets:/);
    expect(a).not.toMatch(/^cloudformation:/);
    expect(a).not.toMatch(/^(Describe|List|Get)/);
  }
});

test("self-lockout guard: does not deny iam:DetachUserPolicy", () => {
  expect(DENY_ACTIONS).not.toContain("iam:DetachUserPolicy");
});

test("policy document is a single Deny statement, never wildcard", () => {
  const doc = denyPolicyDocument();
  expect(doc.Statement).toHaveLength(1);
  expect(doc.Statement[0].Effect).toBe("Deny");
  expect(doc.Statement[0].Action).not.toContain("*");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest test/deny-policy.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `lib/deny-policy.ts`**

```ts
// Positive list of spend-causing "create/launch" actions. NEVER Deny:*.
// Deliberately excludes iam:*, budgets:*, cloudformation:*, and all read-only
// actions so the member can always inspect state and detach this policy.
export const DENY_ACTIONS: string[] = [
  "ec2:RunInstances",
  "ec2:StartInstances",
  "rds:CreateDBInstance",
  "rds:CreateDBCluster",
  "rds:StartDBInstance",
  "elasticmapreduce:RunJobFlow",
  "sagemaker:CreateNotebookInstance",
  "sagemaker:CreateEndpoint",
  "sagemaker:CreateTrainingJob",
  "ecs:RunTask",
  "ecs:CreateService",
  "autoscaling:CreateAutoScalingGroup",
  "lambda:CreateFunction"
];

export function denyPolicyDocument() {
  return {
    Version: "2012-10-17",
    Statement: [
      { Effect: "Deny", Action: [...DENY_ACTIONS], Resource: "*" }
    ]
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest test/deny-policy.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/deny-policy.ts test/deny-policy.test.ts
git commit -m "feat: positive-list deny policy with self-lockout guard"
```

---

## Task 4: Stack core — topics, policies, Lambda, deny policy, action role (`lib/budget-radar-stack.ts`)

**LOCAL.** Build the non-budget half of the stack and assert the synthesized template with `aws-cdk-lib/assertions`.

**Files:**
- Create: `lib/budget-radar-stack.ts` (partial — extended in Task 5), `test/stack.test.ts`
- Depends on: `lib/config.ts` (Task 2), `lib/deny-policy.ts` (Task 3)

**Interfaces:**
- Produces:
```ts
export interface BudgetRadarStackProps extends cdk.StackProps { config: RadarConfig; }
export class BudgetRadarStack extends cdk.Stack {
  readonly triggerTopic: sns.Topic;
  readonly reportTopic: sns.Topic;
  readonly reporter: lambda.Function;
  readonly denyPolicy: iam.ManagedPolicy;
  readonly actionRole: iam.Role;
  readonly failureQueue: sqs.Queue;
  constructor(scope: Construct, id: string, props: BudgetRadarStackProps);
}
```
- Consumes: `RadarConfig`, `denyPolicyDocument()`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/stack.test.ts
import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import { BudgetRadarStack } from "../lib/budget-radar-stack";
import { RadarConfig } from "../lib/config";

const cfg: RadarConfig = {
  alertEmail: "a@b.edu", existingBudgetName: undefined, monthlyBudgetUsd: 5,
  warnAtPercent: 80, actionThresholdPercent: 100, actionThresholdType: "ACTUAL",
  safety: "watch", denyTargetUsers: ["student"], denyTargetGroups: [], denyTargetRoles: [],
  recoveryPrincipalArn: "arn:aws:iam::111122223333:role/Admin", serviceBudgets: []
};

function synth(config: RadarConfig): Template {
  const app = new cdk.App();
  const stack = new BudgetRadarStack(app, "TestStack", { config, env: { account: "111122223333", region: "us-east-1" } });
  return Template.fromStack(stack);
}

test("creates exactly two SNS topics, both unencrypted", () => {
  const t = synth(cfg);
  t.resourceCountIs("AWS::SNS::Topic", 2);
  const topics = t.findResources("AWS::SNS::Topic");
  for (const key of Object.keys(topics)) {
    expect(topics[key].Properties?.KmsMasterKeyId).toBeUndefined();
  }
});

test("topic policies grant budgets.amazonaws.com publish with confused-deputy conditions", () => {
  const t = synth(cfg);
  t.hasResourceProperties("AWS::SNS::TopicPolicy", {
    PolicyDocument: Match.objectLike({
      Statement: Match.arrayWith([
        Match.objectLike({
          Principal: { Service: "budgets.amazonaws.com" },
          Action: "sns:Publish",
          Condition: Match.objectLike({
            StringEquals: Match.objectLike({ "aws:SourceAccount": "111122223333" }),
            ArnLike: Match.objectLike({ "aws:SourceArn": "arn:aws:budgets::111122223333:*" })
          })
        })
      ])
    })
  });
});

test("email subscription is on the report topic; lambda subscription exists", () => {
  const t = synth(cfg);
  t.hasResourceProperties("AWS::SNS::Subscription", Match.objectLike({ Protocol: "email", Endpoint: "a@b.edu" }));
  t.hasResourceProperties("AWS::SNS::Subscription", Match.objectLike({ Protocol: "lambda" }));
});

test("lambda is python3.13, 900s, with a failure destination", () => {
  const t = synth(cfg);
  t.hasResourceProperties("AWS::Lambda::Function", Match.objectLike({ Runtime: "python3.13", Timeout: 900 }));
  t.resourceCountIs("AWS::SQS::Queue", 1);
  t.hasResourceProperties("AWS::Lambda::EventInvokeConfig", Match.objectLike({
    DestinationConfig: Match.objectLike({ OnFailure: Match.anyValue() })
  }));
});

test("log group has bounded retention", () => {
  const t = synth(cfg);
  t.hasResourceProperties("AWS::Logs::LogGroup", Match.objectLike({ RetentionInDays: 30 }));
});

test("managed deny policy exists and is not attached to any principal", () => {
  const t = synth(cfg);
  const policies = t.findResources("AWS::IAM::ManagedPolicy");
  const keys = Object.keys(policies);
  expect(keys.length).toBe(1);
  const props = policies[keys[0]].Properties;
  expect(props.Users ?? []).toEqual([]);
  expect(props.Groups ?? []).toEqual([]);
  expect(props.Roles ?? []).toEqual([]);
});

test("action role trusts budgets.amazonaws.com", () => {
  const t = synth(cfg);
  t.hasResourceProperties("AWS::IAM::Role", Match.objectLike({
    AssumeRolePolicyDocument: Match.objectLike({
      Statement: Match.arrayWith([
        Match.objectLike({ Principal: { Service: "budgets.amazonaws.com" } })
      ])
    })
  }));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest test/stack.test.ts`
Expected: FAIL — `BudgetRadarStack` not found.

- [ ] **Step 3: Implement `lib/budget-radar-stack.ts` (core)**

```ts
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subs from "aws-cdk-lib/aws-sns-subscriptions";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as iam from "aws-cdk-lib/aws-iam";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as destinations from "aws-cdk-lib/aws-lambda-destinations";
import * as path from "path";
import { RadarConfig } from "./config";
import { denyPolicyDocument } from "./deny-policy";

export interface BudgetRadarStackProps extends cdk.StackProps { config: RadarConfig; }

export class BudgetRadarStack extends cdk.Stack {
  readonly triggerTopic: sns.Topic;
  readonly reportTopic: sns.Topic;
  readonly reporter: lambda.Function;
  readonly denyPolicy: iam.ManagedPolicy;
  readonly actionRole: iam.Role;
  readonly failureQueue: sqs.Queue;

  constructor(scope: Construct, id: string, props: BudgetRadarStackProps) {
    super(scope, id, props);
    const { config } = props;
    const account = cdk.Stack.of(this).account;

    // --- Two unencrypted topics (encryption would need an added KMS grant; these
    //     are cost alerts, not secrets). ---
    this.triggerTopic = new sns.Topic(this, "TriggerTopic");
    this.reportTopic = new sns.Topic(this, "ReportTopic");

    const budgetsPublish = (topic: sns.Topic) =>
      topic.addToResourcePolicy(new iam.PolicyStatement({
        principals: [new iam.ServicePrincipal("budgets.amazonaws.com")],
        actions: ["sns:Publish"],
        resources: [topic.topicArn],
        conditions: {
          StringEquals: { "aws:SourceAccount": account },
          ArnLike: { "aws:SourceArn": `arn:aws:budgets::${account}:*` }
        }
      }));
    budgetsPublish(this.triggerTopic);
    budgetsPublish(this.reportTopic);

    // Email goes to the report topic only.
    this.reportTopic.addSubscription(new subs.EmailSubscription(config.alertEmail));

    // --- Failure destination for exhausted async retries (non-recursive). ---
    this.failureQueue = new sqs.Queue(this, "ReporterFailures", {
      retentionPeriod: cdk.Duration.days(14)
    });

    // --- Read-only reporter Lambda. ---
    const logGroup = new logs.LogGroup(this, "ReporterLogs", {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });
    this.reporter = new lambda.Function(this, "Reporter", {
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: "handler.handler",
      code: lambda.Code.fromAsset(path.join(__dirname, "..", "lambda")),
      memorySize: 512,
      timeout: cdk.Duration.seconds(900),
      logGroup,
      onFailure: new destinations.SqsDestination(this.failureQueue),
      environment: {
        REPORT_TOPIC_ARN: this.reportTopic.topicArn,
        TRIGGER_TOPIC_ARN: this.triggerTopic.topicArn,
        SAFETY: config.safety
        // ACCOUNT_ID / BUDGET_NAME / ACTION_ID are added in Task 5.
      }
    });
    this.reportTopic.grantPublish(this.reporter);
    this.reporter.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        "ec2:DescribeRegions", "ec2:DescribeInstances", "ec2:DescribeAddresses",
        "rds:DescribeDBInstances", "rds:DescribeDBClusters",
        "ecs:ListClusters", "ecs:ListServices", "ecs:DescribeServices",
        "lambda:ListFunctions", "lambda:GetFunctionConcurrency",
        "sagemaker:ListNotebookInstances", "sagemaker:ListEndpoints",
        "cloudwatch:GetMetricData",
        "elasticloadbalancing:DescribeLoadBalancers",
        "budgets:DescribeBudgetAction"
      ],
      resources: ["*"]  // targets are discovered at runtime; all actions are read-only
    }));

    // The Lambda subscribes to the trigger topic (auto-confirmed, same account).
    this.triggerTopic.addSubscription(new subs.LambdaSubscription(this.reporter));

    // --- Managed deny policy, created but NOT attached. The budget action attaches it. ---
    this.denyPolicy = new iam.ManagedPolicy(this, "DenyNewSpend", {
      document: iam.PolicyDocument.fromJson(denyPolicyDocument())
    });

    // --- Role Budgets assumes to attach/detach the deny (confused-deputy guarded). ---
    this.actionRole = new iam.Role(this, "BudgetActionRole", {
      assumedBy: new iam.ServicePrincipal("budgets.amazonaws.com", {
        conditions: {
          StringEquals: { "aws:SourceAccount": account },
          ArnLike: { "aws:SourceArn": `arn:aws:budgets::${account}:*` }
        }
      })
    });
    // Scope attach/detach to the specific policy + resolved target ARNs (Task 5 adds targets).
    this.actionRole.addToPolicy(new iam.PolicyStatement({
      actions: ["iam:AttachUserPolicy", "iam:DetachUserPolicy",
                "iam:AttachGroupPolicy", "iam:DetachGroupPolicy",
                "iam:AttachRolePolicy", "iam:DetachRolePolicy"],
      resources: this.denyTargetArns(config, account)
    }));
  }

  private denyTargetArns(config: RadarConfig, account: string): string[] {
    const arn = (kind: string, name: string) =>
      name.startsWith("arn:") ? name : `arn:aws:iam::${account}:${kind}/${name}`;
    return [
      ...config.denyTargetUsers.map(u => arn("user", u)),
      ...config.denyTargetGroups.map(g => arn("group", g)),
      ...config.denyTargetRoles.map(r => arn("role", r))
    ];
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest test/stack.test.ts`
Expected: all PASS. (If `AWS::Lambda::EventInvokeConfig` assertion fails, confirm `onFailure` emits it; adjust the assertion to match the synthesized destination shape.)

- [ ] **Step 5: Commit**

```bash
git add lib/budget-radar-stack.ts test/stack.test.ts
git commit -m "feat: stack core (topics, policies, reporter lambda, deny policy, action role)"
```

---

## Task 5: Budget + BudgetsAction wiring, Path A/B and SAFETY (`lib/budget-radar-stack.ts`)

**LOCAL.** Extend the stack: create the budget in Path B, always create the action (targets required), map SAFETY to ApprovalModel, pass Lambda env identifiers.

**Files:**
- Modify: `lib/budget-radar-stack.ts`
- Modify: `test/stack.test.ts`

**Interfaces:**
- Consumes: everything from Task 4.
- Produces: a synthesized `AWS::Budgets::BudgetsAction`; in Path B also `AWS::Budgets::Budget`.

- [ ] **Step 1: Add failing tests**

```ts
// append to test/stack.test.ts
test("Path B creates a monthly USD cost budget and one action", () => {
  const t = synth(cfg);
  t.hasResourceProperties("AWS::Budgets::Budget", Match.objectLike({
    Budget: Match.objectLike({ BudgetType: "COST", TimeUnit: "MONTHLY", BudgetLimit: { Amount: "5", Unit: "USD" } })
  }));
  t.resourceCountIs("AWS::Budgets::BudgetsAction", 1);
});

test("Path A creates the action but NO budget", () => {
  const t = synth({ ...cfg, existingBudgetName: "MyBudget" });
  t.resourceCountIs("AWS::Budgets::Budget", 0);
  t.hasResourceProperties("AWS::Budgets::BudgetsAction", Match.objectLike({ BudgetName: "MyBudget" }));
});

test("watch => MANUAL, armed => AUTOMATIC", () => {
  expect(Object.values(synth(cfg).findResources("AWS::Budgets::BudgetsAction"))[0].Properties.ApprovalModel).toBe("MANUAL");
  expect(Object.values(synth({ ...cfg, safety: "armed" }).findResources("AWS::Budgets::BudgetsAction"))[0].Properties.ApprovalModel).toBe("AUTOMATIC");
});

test("action targets the configured identities and publishes to the trigger topic", () => {
  const t = synth(cfg);
  const action = Object.values(t.findResources("AWS::Budgets::BudgetsAction"))[0].Properties;
  expect(action.ActionType).toBe("APPLY_IAM_POLICY");
  expect(action.Definition.IamActionDefinition.Users).toEqual(["student"]);
  expect(action.Subscribers).toEqual(expect.arrayContaining([
    expect.objectContaining({ Type: "SNS" })
  ]));
});

test("reporter receives account/budget/action env identifiers", () => {
  const t = synth(cfg);
  const fn = Object.values(t.findResources("AWS::Lambda::Function"))[0].Properties;
  expect(fn.Environment.Variables).toEqual(expect.objectContaining({
    ACCOUNT_ID: Match.anyValue ? expect.anything() : expect.anything(),
    BUDGET_NAME: expect.anything(),
    ACTION_ID: expect.anything()
  }));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest test/stack.test.ts`
Expected: new tests FAIL (no budget/action yet).

- [ ] **Step 3: Extend the stack constructor**

Append inside the constructor, after the action role:

```ts
    import_budget_or_create: {
      // (This is a comment marker, not code — implement the block below.)
    }
```

Replace the marker with:

```ts
    // Determine the budget name and (Path B) create the budget.
    const budgetName = config.existingBudgetName ?? `budget-radar-${cdk.Names.uniqueId(this).slice(-8)}`;

    if (!config.existingBudgetName) {
      const notifications = [
        // warn-only threshold -> report topic (email); does NOT trigger the Lambda
        {
          notification: { notificationType: "ACTUAL", comparisonOperator: "GREATER_THAN", threshold: config.warnAtPercent },
          subscribers: [{ subscriptionType: "SNS", address: this.reportTopic.topicArn }]
        }
      ];
      new cdk.aws_budgets.CfnBudget(this, "Budget", {
        budget: {
          budgetName,
          budgetType: "COST",
          timeUnit: "MONTHLY",
          budgetLimit: { amount: config.monthlyBudgetUsd, unit: "USD" }
        },
        notificationsWithSubscribers: notifications as any
      });
    }

    const action = new cdk.aws_budgets.CfnBudgetsAction(this, "BlockNewSpend", {
      budgetName,
      actionThreshold: { type: "PERCENTAGE", value: config.actionThresholdPercent },
      actionType: "APPLY_IAM_POLICY",
      approvalModel: config.safety === "armed" ? "AUTOMATIC" : "MANUAL",
      notificationType: config.actionThresholdType,
      executionRoleArn: this.actionRole.roleArn,
      definition: {
        iamActionDefinition: {
          policyArn: this.denyPolicy.managedPolicyArn,
          users: config.denyTargetUsers.length ? config.denyTargetUsers : undefined,
          groups: config.denyTargetGroups.length ? config.denyTargetGroups : undefined,
          roles: config.denyTargetRoles.length ? config.denyTargetRoles : undefined
        }
      },
      subscribers: [{ subscriptionType: "SNS", address: this.triggerTopic.topicArn }]
    });

    // Give the reporter the identifiers it needs for DescribeBudgetAction.
    this.reporter.addEnvironment("ACCOUNT_ID", account);
    this.reporter.addEnvironment("BUDGET_NAME", budgetName);
    this.reporter.addEnvironment("ACTION_ID", action.attrActionId);
```

Also add optional per-service warn budgets (Path B or A both allowed; free, notification-only) after the block above:

```ts
    for (const [i, sb] of config.serviceBudgets.entries()) {
      new cdk.aws_budgets.CfnBudget(this, `ServiceBudget${i}`, {
        budget: {
          budgetName: `${budgetName}-svc-${i}`,
          budgetType: "COST",
          timeUnit: "MONTHLY",
          budgetLimit: { amount: sb.limitUsd, unit: "USD" },
          costFilters: { Service: [sb.service] }
        },
        notificationsWithSubscribers: [{
          notification: { notificationType: "ACTUAL", comparisonOperator: "GREATER_THAN", threshold: 100 },
          subscribers: [{ subscriptionType: "SNS", address: this.reportTopic.topicArn }]
        }] as any
      });
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest test/stack.test.ts`
Expected: all PASS. (Fix the `reporter env` assertion to concrete `expect.objectContaining` matchers if the placeholder ternary is flagged by the linter — assert the three keys are present.)

- [ ] **Step 5: Commit**

```bash
git add lib/budget-radar-stack.ts test/stack.test.ts
git commit -m "feat: budget + action wiring, Path A/B, SAFETY->ApprovalModel"
```

---

## Task 6: CDK entrypoint (`bin/budget-radar.ts`) + synth smoke test

**LOCAL.** Wire config → stack; confirm `cdk synth` works credential-free.

**Files:**
- Create: `bin/budget-radar.ts`
- Create: `test/synth.test.ts`

**Interfaces:**
- Consumes: `loadConfig`, `BudgetRadarStack`.

- [ ] **Step 1: Write `bin/budget-radar.ts`**

```ts
#!/usr/bin/env node
import "dotenv/config";
import * as cdk from "aws-cdk-lib";
import { loadConfig } from "../lib/config";
import { BudgetRadarStack } from "../lib/budget-radar-stack";

const config = loadConfig(process.env);
const app = new cdk.App();
new BudgetRadarStack(app, "BudgetRadarStack", {
  config,
  // Environment-agnostic: no live lookups at synth. Account/region resolve at deploy.
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION }
});
app.synth();
```

- [ ] **Step 2: Write the failing synth test**

```ts
// test/synth.test.ts
import { execSync } from "child_process";

test("cdk synth succeeds with a minimal env and no AWS credentials", () => {
  const env = {
    ...process.env,
    ALERT_EMAIL: "a@b.edu", MONTHLY_BUDGET_USD: "5", SAFETY: "watch",
    IAM_DENY_TARGET_USERS: "student",
    RECOVERY_PRINCIPAL_ARN: "arn:aws:iam::111122223333:role/Admin",
    CDK_DEFAULT_ACCOUNT: "111122223333", CDK_DEFAULT_REGION: "us-east-1",
    AWS_ACCESS_KEY_ID: "", AWS_SECRET_ACCESS_KEY: "", AWS_PROFILE: ""
  };
  const out = execSync("npx cdk synth --quiet", { env, encoding: "utf8" });
  expect(out).toBeDefined();
}, 120000);
```

- [ ] **Step 3: Run test to verify it fails then passes**

Run: `npx jest test/synth.test.ts`
Expected: PASS once entrypoint is correct. If it fails demanding credentials, confirm the stack uses no `.fromLookup` calls (it must not).

- [ ] **Step 4: Commit**

```bash
git add bin/budget-radar.ts test/synth.test.ts
git commit -m "feat: cdk entrypoint + credential-free synth smoke test"
```

---

## Task 7: Lambda handler — event validation + observed action status (`lambda/handler.py`)

**LOCAL.** Python handler skeleton with test seams; validate the trigger source; read observed action status via `DescribeBudgetAction`.

**Files:**
- Create: `lambda/handler.py` (partial — extended in Tasks 8–9)
- Create: `tests/test_handler.py`
- Create: `tests/conftest.py` (adds `lambda/` to `sys.path`)

**Interfaces:**
- Produces:
```python
def _client(service, region=None): ...            # seam: tests monkeypatch this
def observe_action_status(account_id, budget_name, action_id) -> tuple[str, str]  # (status, iso_utc); ("UNKNOWN", ts) on failure
def handler(event, context) -> dict
```
- Env vars consumed: `ACCOUNT_ID`, `BUDGET_NAME`, `ACTION_ID`, `REPORT_TOPIC_ARN`, `TRIGGER_TOPIC_ARN`, `SAFETY`.

- [ ] **Step 1: Write `tests/conftest.py`**

```python
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lambda"))
```

- [ ] **Step 2: Write the failing tests**

```python
# tests/test_handler.py
import datetime as dt
from botocore.stub import Stubber
import boto3
import handler

def _budgets_stub(status):
    client = boto3.client("budgets", region_name="us-east-1")
    stub = Stubber(client)
    stub.add_response("describe_budget_action",
        {"AccountId": "111122223333", "BudgetName": "b",
         "Action": {"ActionId": "a", "BudgetName": "b",
                    "NotificationType": "ACTUAL",
                    "ActionType": "APPLY_IAM_POLICY",
                    "ActionThreshold": {"ActionThresholdValue": 100.0, "ActionThresholdType": "PERCENTAGE"},
                    "Definition": {}, "ExecutionRoleArn": "arn:aws:iam::111122223333:role/r",
                    "ApprovalModel": "MANUAL", "Status": status, "Subscribers": []}},
        {"AccountId": "111122223333", "ActionId": "a", "BudgetName": "b"})
    return client, stub

def test_observe_action_status_reads_observed_status(monkeypatch):
    client, stub = _budgets_stub("EXECUTION_SUCCESS")
    stub.activate()
    monkeypatch.setattr(handler, "_client", lambda svc, region=None: client)
    monkeypatch.setenv("ACCOUNT_ID", "111122223333")
    status, ts = handler.observe_action_status("111122223333", "b", "a")
    assert status == "EXECUTION_SUCCESS"
    assert ts  # ISO timestamp present

def test_observe_action_status_unknown_on_failure(monkeypatch):
    def boom(svc, region=None):
        raise RuntimeError("no perms")
    monkeypatch.setattr(handler, "_client", boom)
    status, ts = handler.observe_action_status("x", "b", "a")
    assert status == "UNKNOWN"

def test_handler_ignores_events_not_from_trigger_topic(monkeypatch):
    monkeypatch.setenv("TRIGGER_TOPIC_ARN", "arn:aws:sns:us-east-1:111122223333:Trigger")
    # An event from a different topic must not proceed to inventory/publish.
    called = {"inventory": False}
    monkeypatch.setattr(handler, "enabled_regions", lambda: (_ for _ in ()).throw(AssertionError("should not run")))
    event = {"Records": [{"Sns": {"TopicArn": "arn:aws:sns:us-east-1:111122223333:SomethingElse", "Message": "x"}}]}
    result = handler.handler(event, None)
    assert result["status"] == "ignored"
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `python3 -m pytest tests/test_handler.py -q`
Expected: FAIL — `handler` has no such attributes.

- [ ] **Step 4: Implement `lambda/handler.py` (skeleton)**

```python
import os
import datetime as dt
import boto3

def _client(service, region=None):
    return boto3.client(service, region_name=region) if region else boto3.client(service)

def _now_iso():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")

def observe_action_status(account_id, budget_name, action_id):
    """Return (observed_status, observation_iso). ('UNKNOWN', ts) if the lookup fails."""
    try:
        c = _client("budgets")
        resp = c.describe_budget_action(AccountId=account_id, BudgetName=budget_name, ActionId=action_id)
        return resp["Action"]["Status"], _now_iso()
    except Exception:
        return "UNKNOWN", _now_iso()

def _from_trigger_topic(event):
    want = os.environ.get("TRIGGER_TOPIC_ARN")
    for rec in event.get("Records", []):
        if rec.get("Sns", {}).get("TopicArn") == want:
            return True
    return False

def handler(event, context):
    if not _from_trigger_topic(event):
        print("Event not from TriggerTopic; ignoring.")
        return {"status": "ignored"}
    # Inventory + report added in Tasks 8-9.
    return {"status": "ok"}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `python3 -m pytest tests/test_handler.py -q`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add lambda/handler.py tests/test_handler.py tests/conftest.py
git commit -m "feat: handler skeleton, trigger validation, observed action status"
```

---

## Task 8: Lambda handler — region enumeration + inventory with coverage state

**LOCAL.** Inventory across enabled regions with a per-area state machine; a denied/failed read is reported as `failed`, never zero.

**Files:**
- Modify: `lambda/handler.py`
- Modify: `tests/test_handler.py`

**Interfaces:**
- Produces:
```python
# area outcome constants
COMPLETE, EMPTY, FAILED, UNSUPPORTED, NOT_SCANNED = "complete","empty","failed","unsupported","not_scanned"
def enabled_regions() -> list[str]
def inventory(regions, deadline_epoch: float) -> dict
#   -> {"areas": [{"region","service","state","items":[...]}], "generated": iso}
```
Adapter contract: each adapter is `fn(region) -> list[str]` (human lines) and raises on access failure; the framework maps success→COMPLETE/EMPTY, exception→FAILED.

- [ ] **Step 1: Add failing tests**

```python
# append to tests/test_handler.py
def test_enabled_regions(monkeypatch):
    client = boto3.client("ec2", region_name="us-east-1")
    stub = Stubber(client)
    stub.add_response("describe_regions",
        {"Regions": [{"RegionName": "us-east-1"}, {"RegionName": "eu-west-1"}]}, {})
    stub.activate()
    monkeypatch.setattr(handler, "_client", lambda svc, region=None: client)
    assert handler.enabled_regions() == ["us-east-1", "eu-west-1"]

def test_denied_read_is_reported_failed_not_zero(monkeypatch):
    import time
    def adapter_fail(region):
        raise RuntimeError("AccessDenied")
    monkeypatch.setattr(handler, "ADAPTERS", {"ec2-instances": adapter_fail})
    monkeypatch.setattr(handler, "enabled_regions", lambda: ["us-east-1"])
    result = handler.inventory(["us-east-1"], deadline_epoch=time.time() + 60)
    areas = result["areas"]
    ec2 = [a for a in areas if a["service"] == "ec2-instances"][0]
    assert ec2["state"] == "failed"
    assert "AccessDenied" in ec2.get("error", "")

def test_deadline_marks_unscanned(monkeypatch):
    import time
    monkeypatch.setattr(handler, "ADAPTERS", {"ec2-instances": lambda r: []})
    result = handler.inventory(["us-east-1", "eu-west-1"], deadline_epoch=time.time() - 1)  # already past
    assert any(a["state"] == "not_scanned" for a in result["areas"])
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python3 -m pytest tests/test_handler.py -q`
Expected: new tests FAIL.

- [ ] **Step 3: Extend `lambda/handler.py`**

```python
import time

COMPLETE, EMPTY, FAILED, UNSUPPORTED, NOT_SCANNED = "complete", "empty", "failed", "unsupported", "not_scanned"

def _ec2_instances(region):
    c = _client("ec2", region)
    lines = []
    for page in c.get_paginator("describe_instances").paginate(
            Filters=[{"Name": "instance-state-name", "Values": ["running", "pending"]}]):
        for res in page.get("Reservations", []):
            for inst in res.get("Instances", []):
                lines.append(f"{inst['InstanceId']} {inst.get('InstanceType','?')} in {region}")
    return lines

# Adapter registry. Each fn(region)->list[str]; raises on failure.
# Additional adapters follow the SAME contract; add them here with the exact API:
#   rds-instances       -> rds.describe_db_instances (paginate DBInstances)
#   rds-clusters        -> rds.describe_db_clusters (paginate DBClusters)
#   ecs-services        -> ecs.list_clusters -> list_services -> describe_services
#   lambda-functions    -> lambda.list_functions (+ get_function_concurrency)
#   sagemaker-notebooks -> sagemaker.list_notebook_instances
#   sagemaker-endpoints -> sagemaker.list_endpoints
#   eips-unattached     -> ec2.describe_addresses (AssociationId absent)
#   load-balancers      -> elbv2.describe_load_balancers
# S3 sizes are global via CloudWatch and handled separately in Task 9's report.
ADAPTERS = {
    "ec2-instances": _ec2_instances,
}

def enabled_regions():
    c = _client("ec2")
    return [r["RegionName"] for r in c.describe_regions()["Regions"]]

def inventory(regions, deadline_epoch):
    areas = []
    for region in regions:
        for name, fn in ADAPTERS.items():
            if time.time() >= deadline_epoch:
                areas.append({"region": region, "service": name, "state": NOT_SCANNED, "items": []})
                continue
            try:
                items = fn(region)
                areas.append({"region": region, "service": name,
                              "state": COMPLETE if items else EMPTY, "items": items})
            except Exception as e:  # denied/throttled/unavailable -> FAILED, never zero
                areas.append({"region": region, "service": name, "state": FAILED,
                              "items": [], "error": str(e)})
    return {"areas": areas, "generated": _now_iso()}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python3 -m pytest tests/test_handler.py -q`
Expected: all PASS.

- [ ] **Step 5: Add remaining adapters (repeat the pattern)**

For each row in the `ADAPTERS` comment above, add an `fn(region) -> list[str]` using the named boto3 API with its paginator, then register it in `ADAPTERS`. Write one test per adapter using a `Stubber` that returns a representative item, asserting the line format and that an access failure yields `state == "failed"`. Commit after each adapter or in one batch.

- [ ] **Step 6: Commit**

```bash
git add lambda/handler.py tests/test_handler.py
git commit -m "feat: region enumeration + inventory with coverage state (denied != zero)"
```

---

## Task 9: Lambda handler — report assembly, byte budget, publish-failure semantics

**LOCAL.** Assemble the report (header with observed status + coverage), S3 sizes from CloudWatch, enforce the 262,144-byte SNS limit, and make a publish failure fail the invocation.

**Files:**
- Modify: `lambda/handler.py`
- Modify: `tests/test_handler.py`

**Interfaces:**
- Produces:
```python
SNS_MAX_BYTES = 262144
def s3_bucket_sizes() -> list[str]            # from CloudWatch BucketSizeBytes; "unknown" if missing
def build_report(status, status_ts, inv, safety) -> str
def publish(topic_arn, subject, body) -> None # raises on failure (do NOT swallow)
def _fit(body: str, limit: int = SNS_MAX_BYTES) -> str  # summarize+disclose if over
```

- [ ] **Step 1: Add failing tests**

```python
# append to tests/test_handler.py
def test_report_states_observed_status_and_running_reminder():
    inv = {"areas": [{"region": "us-east-1", "service": "ec2-instances", "state": "complete",
                      "items": ["i-1 t3.micro in us-east-1"]}], "generated": "2026-09-15T00:00:00+00:00"}
    body = handler.build_report("EXECUTION_SUCCESS", "2026-09-15T00:00:00+00:00", inv, "armed")
    assert "EXECUTION_SUCCESS" in body
    assert "still running" in body.lower() or "keep running" in body.lower()
    assert "i-1 t3.micro" in body

def test_fit_truncates_with_disclosure_over_limit():
    huge = "x\n" * 200000
    fitted = handler._fit(huge, limit=1000)
    assert len(fitted.encode("utf-8")) <= 1000
    assert "omitted" in fitted.lower() or "truncated" in fitted.lower()

def test_publish_failure_propagates(monkeypatch):
    class FailingSns:
        def publish(self, **kw): raise RuntimeError("SNS down")
    monkeypatch.setattr(handler, "_client", lambda svc, region=None: FailingSns())
    import pytest
    with pytest.raises(RuntimeError):
        handler.publish("arn:aws:sns:us-east-1:111122223333:Report", "subj", "body")

def test_s3_sizes_unknown_when_no_metric(monkeypatch):
    class CW:
        def get_metric_data(self, **kw): return {"MetricDataResults": [{"Values": [], "Timestamps": []}]}
        def list_buckets(self, **kw): return {"Buckets": [{"Name": "b1"}]}
    def fake_client(svc, region=None):
        return CW()
    monkeypatch.setattr(handler, "_client", fake_client)
    lines = handler.s3_bucket_sizes()
    assert any("unknown" in l.lower() for l in lines)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python3 -m pytest tests/test_handler.py -q`
Expected: new tests FAIL.

- [ ] **Step 3: Extend `lambda/handler.py`**

```python
SNS_MAX_BYTES = 262144

def s3_bucket_sizes():
    """S3 sizes from daily CloudWatch BucketSizeBytes. Never enumerate objects."""
    s3 = _client("s3")
    cw = _client("cloudwatch", "us-east-1")
    lines = []
    for b in s3.list_buckets().get("Buckets", []):
        name = b["Name"]
        try:
            resp = cw.get_metric_data(MetricDataQueries=[{
                "Id": "size",
                "MetricStat": {
                    "Metric": {"Namespace": "AWS/S3", "MetricName": "BucketSizeBytes",
                               "Dimensions": [{"Name": "BucketName", "Value": name},
                                              {"Name": "StorageType", "Value": "StandardStorage"}]},
                    "Period": 86400, "Stat": "Average"}
            }], StartTime=dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=2),
               EndTime=dt.datetime.now(dt.timezone.utc))
            vals = resp["MetricDataResults"][0].get("Values", [])
            ts = resp["MetricDataResults"][0].get("Timestamps", [])
            if vals:
                lines.append(f"s3://{name}: {int(vals[0])} bytes (as of {ts[0] if ts else '?'})")
            else:
                lines.append(f"s3://{name}: size unknown (no recent CloudWatch metric)")
        except Exception as e:
            lines.append(f"s3://{name}: size unknown ({e})")
    return lines

def _fit(body, limit=SNS_MAX_BYTES):
    data = body.encode("utf-8")
    if len(data) <= limit:
        return body
    notice = "\n\n[... report omitted/truncated to fit the 256 KB message limit; see CloudWatch Logs for the full inventory ...]"
    keep = limit - len(notice.encode("utf-8"))
    return data[:keep].decode("utf-8", "ignore") + notice

def build_report(status, status_ts, inv, safety):
    lines = []
    lines.append("AWS Budget Radar — budget threshold reached.")
    lines.append(f"Budget action status (observed via AWS Budgets): {status} at {status_ts}.")
    lines.append(f"Safety mode: {safety} (watch=deny pending your approval; armed=deny auto-applied).")
    lines.append("NOTE: Workloads that are already running KEEP running until you stop them yourself.")
    lines.append("This is a best-effort inventory with explicit coverage gaps — not a full bill.")
    lines.append("")
    for area in inv["areas"]:
        head = f"[{area['state'].upper()}] {area['service']} @ {area['region']}"
        lines.append(head if area["state"] not in ("failed",) else head + f" — {area.get('error','')}")
        for it in area["items"]:
            lines.append(f"    - {it}")
    lines.append("")
    lines.append("Still costing you money (investigate):")
    for s in s3_bucket_sizes():
        lines.append(f"    - {s}")
    lines.append("")
    lines.append("To lift the block: reverse the budget action in the console (admin route), or it clears at the next budget period.")
    return _fit("\n".join(lines))

def publish(topic_arn, subject, body):
    # Must NOT swallow: a failed publish should fail the invocation so async retries
    # fire and exhausted retries land in the on-failure destination.
    _client("sns").publish(TopicArn=topic_arn, Subject=subject[:100], Message=body)
```

- [ ] **Step 4: Wire the full path into `handler()`**

Replace the body of `handler()` after the trigger-validation guard:

```python
    account_id = os.environ["ACCOUNT_ID"]
    budget_name = os.environ["BUDGET_NAME"]
    action_id = os.environ["ACTION_ID"]
    report_topic = os.environ["REPORT_TOPIC_ARN"]
    safety = os.environ.get("SAFETY", "watch")

    status, status_ts = observe_action_status(account_id, budget_name, action_id)
    deadline = time.time() + 780  # reserve ~2 min of the 900s budget for publish
    inv = inventory(enabled_regions(), deadline_epoch=deadline)
    body = build_report(status, status_ts, inv, safety)
    publish(report_topic, "AWS Budget Radar: budget threshold reached", body)  # raises on failure
    return {"status": "reported", "action_status": status}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `python3 -m pytest tests/test_handler.py -q`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add lambda/handler.py tests/test_handler.py
git commit -m "feat: report assembly, S3 via CloudWatch, byte budget, publish-failure semantics"
```

---

## Task 10: Read-only preflight (`preflight.ts`)

**LOCAL.** A read-only script (run by `npm run deploy` before `cdk deploy`) that verifies identity coverage and budget semantics. Tested with mocked AWS SDK v3 clients.

**Files:**
- Create: `preflight.ts`
- Create: `test/preflight.test.ts`

**Interfaces:**
- Produces:
```ts
export interface PreflightResult { ok: boolean; messages: string[]; }
export async function runPreflight(config: RadarConfig, deps: PreflightDeps): Promise<PreflightResult>;
export interface PreflightDeps {
  getCallerIdentity(): Promise<{ Account?: string; Arn?: string }>;
  getUser(name: string): Promise<{ arn: string } | null>;
  getRole(name: string): Promise<{ arn: string } | null>;
  describeBudget(name: string): Promise<{ BudgetType?: string; TimeUnit?: string; unit?: string; scoped: boolean } | null>;
}
```
The `main()` builds real SDK-backed `deps`; tests inject fakes.

- [ ] **Step 1: Write the failing tests**

```ts
// test/preflight.test.ts
import { runPreflight, PreflightDeps } from "../preflight";
import { RadarConfig } from "../lib/config";

const cfg: RadarConfig = {
  alertEmail: "a@b.edu", existingBudgetName: undefined, monthlyBudgetUsd: 5,
  warnAtPercent: 80, actionThresholdPercent: 100, actionThresholdType: "ACTUAL",
  safety: "watch", denyTargetUsers: ["student"], denyTargetGroups: [], denyTargetRoles: [],
  recoveryPrincipalArn: "arn:aws:iam::111122223333:role/Admin", serviceBudgets: []
};

const okDeps: PreflightDeps = {
  getCallerIdentity: async () => ({ Account: "111122223333", Arn: "arn:aws:iam::111122223333:user/student" }),
  getUser: async (n) => ({ arn: `arn:aws:iam::111122223333:user/${n}` }),
  getRole: async (n) => ({ arn: `arn:aws:iam::111122223333:role/${n}` }),
  describeBudget: async () => null
};

test("passes when caller is a covered user (Path B)", async () => {
  const r = await runPreflight(cfg, okDeps);
  expect(r.ok).toBe(true);
  expect(r.messages.join("\n")).toMatch(/caller.*covered/i);
});

test("rejects AWSReservedSSO role targets", async () => {
  const r = await runPreflight({ ...cfg, denyTargetRoles: ["AWSReservedSSO_Admin_abc"] }, okDeps);
  expect(r.ok).toBe(false);
  expect(r.messages.join("\n")).toMatch(/AWSReservedSSO/);
});

test("rejects an unresolved target", async () => {
  const r = await runPreflight(cfg, { ...okDeps, getUser: async () => null });
  expect(r.ok).toBe(false);
  expect(r.messages.join("\n")).toMatch(/could not be resolved/i);
});

test("Path A rejects a non-monthly / non-USD / scoped budget", async () => {
  const r = await runPreflight({ ...cfg, existingBudgetName: "B" }, {
    ...okDeps,
    describeBudget: async () => ({ BudgetType: "USAGE", TimeUnit: "ANNUALLY", unit: "USD", scoped: true })
  });
  expect(r.ok).toBe(false);
  expect(r.messages.join("\n")).toMatch(/COST|MONTHLY|scoped/i);
});

test("warns caller is not covered", async () => {
  const r = await runPreflight(cfg, {
    ...okDeps,
    getCallerIdentity: async () => ({ Account: "111122223333", Arn: "arn:aws:iam::111122223333:user/someoneelse" })
  });
  expect(r.messages.join("\n")).toMatch(/caller.*not covered/i);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest test/preflight.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `preflight.ts`**

```ts
import { RadarConfig, loadConfig } from "./lib/config";

export interface PreflightResult { ok: boolean; messages: string[]; }
export interface PreflightDeps {
  getCallerIdentity(): Promise<{ Account?: string; Arn?: string }>;
  getUser(name: string): Promise<{ arn: string } | null>;
  getRole(name: string): Promise<{ arn: string } | null>;
  describeBudget(name: string): Promise<{ BudgetType?: string; TimeUnit?: string; unit?: string; scoped: boolean } | null>;
}

export async function runPreflight(config: RadarConfig, deps: PreflightDeps): Promise<PreflightResult> {
  const msg: string[] = [];
  let ok = true;
  const fail = (m: string) => { ok = false; msg.push("FAIL: " + m); };
  const info = (m: string) => msg.push(m);

  const caller = await deps.getCallerIdentity();
  info(`Caller: ${caller.Arn} (account ${caller.Account})`);

  // Reject IAM Identity Center reserved roles as targets.
  for (const r of config.denyTargetRoles) {
    if (r.includes("AWSReservedSSO_")) {
      fail(`Target ${r} is an AWSReservedSSO_ role; AWS protects these from modification. Use a dedicated learning role/user.`);
    }
  }

  // Resolve targets to ARNs.
  const coveredArns: string[] = [];
  for (const u of config.denyTargetUsers) {
    const res = await deps.getUser(u);
    if (!res) fail(`User target "${u}" could not be resolved in IAM.`); else coveredArns.push(res.arn);
  }
  for (const r of config.denyTargetRoles) {
    if (r.includes("AWSReservedSSO_")) continue;
    const res = await deps.getRole(r);
    if (!res) fail(`Role target "${r}" could not be resolved in IAM.`); else coveredArns.push(res.arn);
  }

  // Is the caller covered? (direct ARN match; group membership is reported as unknown.)
  if (caller.Arn && coveredArns.includes(caller.Arn)) {
    info("Caller is directly covered by the deny.");
  } else {
    info("WARNING: caller is not covered directly. If you deploy/operate under an uncovered identity (or via CDK bootstrap/CloudFormation roles), those actions are NOT blocked.");
  }
  info("Note: CDK bootstrap and CloudFormation execution roles are typically NOT covered — coverage of those is 'unknown' unless you list them explicitly.");

  // Recovery route.
  info(`Recovery principal: ${config.recoveryPrincipalArn} (must be able to reverse the action / detach the policy; not a deny target).`);

  // Path A budget semantics.
  if (config.existingBudgetName) {
    const b = await deps.describeBudget(config.existingBudgetName);
    if (!b) { fail(`Existing budget "${config.existingBudgetName}" not found.`); }
    else {
      if (b.BudgetType !== "COST") fail(`Budget must be COST; got ${b.BudgetType}.`);
      if (b.TimeUnit !== "MONTHLY") fail(`Budget must be MONTHLY; got ${b.TimeUnit}.`);
      if (b.unit !== "USD") fail(`Budget must be USD; got ${b.unit}.`);
      if (b.scoped) fail("Scoped budgets are rejected in v1 (a scoped budget does not protect total account cost).");
    }
  }
  return { ok, messages: msg };
}

// Runs only when invoked directly (npm run deploy / preflight).
if (require.main === module) {
  (async () => {
    require("dotenv/config");
    const config = loadConfig(process.env);
    // Real SDK-backed deps (STS/IAM/Budgets v3). Read-only calls.
    const { STSClient, GetCallerIdentityCommand } = await import("@aws-sdk/client-sts");
    const { IAMClient, GetUserCommand, GetRoleCommand } = await import("@aws-sdk/client-iam");
    const { BudgetsClient, DescribeBudgetCommand } = await import("@aws-sdk/client-budgets");
    const sts = new STSClient({});
    const iam = new IAMClient({});
    const deps: PreflightDeps = {
      getCallerIdentity: async () => { const r = await sts.send(new GetCallerIdentityCommand({})); return { Account: r.Account, Arn: r.Arn }; },
      getUser: async (n) => { try { const r = await iam.send(new GetUserCommand({ UserName: n })); return { arn: r.User!.Arn! }; } catch { return null; } },
      getRole: async (n) => { try { const r = await iam.send(new GetRoleCommand({ RoleName: n })); return { arn: r.Role!.Arn! }; } catch { return null; } },
      describeBudget: async (name) => {
        try {
          const acct = (await sts.send(new GetCallerIdentityCommand({}))).Account!;
          const budgets = new BudgetsClient({});
          const r = await budgets.send(new DescribeBudgetCommand({ AccountId: acct, BudgetName: name, ShowFilterExpression: true } as any));
          const b = r.Budget as any;
          const scoped = !!(b?.FilterExpression || (b?.CostFilters && Object.keys(b.CostFilters).length));
          return { BudgetType: b?.BudgetType, TimeUnit: b?.TimeUnit, unit: b?.BudgetLimit?.Unit, scoped };
        } catch { return null; }
      }
    };
    const result = await runPreflight(config, deps);
    for (const m of result.messages) console.log(m);
    if (!result.ok) { console.error("\nPreflight FAILED. Deployment aborted."); process.exit(1); }
    console.log("\nPreflight passed.");
  })();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest test/preflight.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add preflight.ts test/preflight.test.ts
git commit -m "feat: read-only deploy preflight (identity coverage + budget validation)"
```

---

## Task 11: `.env.example`, guarded deploy command, and README/docs

**LOCAL.** The member-facing surface. `npm run deploy` already chains preflight → cdk deploy (Task 1). Finalize docs with honest limitations.

**Files:**
- Create: `.env.example`, update `README.md`

- [ ] **Step 1: Write `.env.example`**

```bash
# --- AWS Budget Radar configuration (the only file you edit) ---
ALERT_EMAIL=you@uky.edu

# Leave EXISTING_BUDGET_NAME empty to have Radar CREATE a monthly USD cost budget.
# Set it to attach to a budget you already made (must be a monthly USD COST budget).
EXISTING_BUDGET_NAME=

MONTHLY_BUDGET_USD=5          # used only when creating a budget. 0.01 = first-charge tripwire.
WARN_AT_PERCENT=80            # extra warn-only email threshold (email only; no block)

ACTION_THRESHOLD_PERCENT=100
ACTION_THRESHOLD_TYPE=ACTUAL  # or FORECASTED (earlier warning; needs ~5 weeks of history)

SAFETY=watch                  # watch = deny waits for your console approval; armed = auto-apply

# REQUIRED: identities the deny attaches to (names or ARNs). The root user is never covered.
IAM_DENY_TARGET_USERS=your-iam-username
IAM_DENY_TARGET_GROUPS=
IAM_DENY_TARGET_ROLES=

# REQUIRED: a principal that can reverse the action / detach the deny (NOT a deny target).
RECOVERY_PRINCIPAL_ARN=arn:aws:iam::<account-id>:role/YourAdminRole

# Optional warn-only per-service budgets. Exact AWS service display names, colon, USD.
# e.g. Amazon Elastic Compute Cloud - Compute:20,Amazon SageMaker:10
SERVICE_BUDGETS=
```

- [ ] **Step 2: Write `README.md`**

Replace the file with content covering, in this order:
1. **What it is / is not** — verbatim from spec §2 (backstop not a cap; running workloads keep running until you act; identity-scoped, not a security boundary; root not covered).
2. **Prerequisites** — Node ≥ 20, AWS CLI v2 configured, an IAM user/role (not root).
3. **Setup** — `git clone`, `npm install`, `cp .env.example .env`, edit `.env`.
4. **One-time** — `npx cdk bootstrap` (explain: needed once per account/region; deploy fails without it).
5. **Deploy** — `npm run deploy` (runs preflight then `cdk deploy`). **Then confirm the SNS subscription email** AWS sends you (email delivery only starts after you click confirm).
6. **What happens on breach** — deny applies (watch: pending your approval; armed: automatic) + inventory email.
7. **Lifting the block** — reverse the budget action in the console (your recovery principal), or wait for the next budget period (auto-clears).
8. **Teardown** — spec §10: if the deny is applied, reverse it / wait for reset and verify detached, then `npx cdk destroy`.
9. **Limitations / coverage gaps** — spec §8 table + "not enumerated" list; costs are near-zero but not guaranteed $0.

- [ ] **Step 3: Verify the full build + test suite**

Run: `npm run build && npx jest && python3 -m pytest tests/ -q`
Expected: TypeScript compiles; all Jest and pytest tests pass.

- [ ] **Step 4: Commit**

```bash
git add .env.example README.md
git commit -m "docs: .env.example, guarded deploy, README with honest limitations"
```

---

## Task 12: Release acceptance gate (`RELEASE.md`) — LIVE tests, gated behind deploy authorization

**Deliverable is a document, not code.** It defines the behavioral checks that must pass in a **disposable AWS account** before Budget Radar may be called plug-and-play. **Executing these checks creates real AWS resources and requires separate, explicit user authorization** — writing this file does not authorize deployment.

**Files:**
- Create: `RELEASE.md`

- [ ] **Step 1: Write `RELEASE.md`**

Content:

```markdown
# Release acceptance — AWS Budget Radar

**Authorization boundary:** Every check below deploys or mutates real AWS
resources. Run them ONLY in a disposable account, and ONLY after the maintainer
has explicitly authorized deployment. Passing unit tests (`npm test`,
`pytest`) does NOT authorize these.

Release requirements (all must pass):

1. **Deploy both paths.** Path B (`EXISTING_BUDGET_NAME` empty) creates the
   budget; Path A (a pre-made monthly USD cost budget) attaches the action and
   leaves the budget and its existing alerts unchanged.
2. **Preflight gate.** `npm run deploy` aborts before `cdk deploy` when a target
   cannot be resolved, an `AWSReservedSSO_*` role is targeted, or (Path A) the
   budget is non-monthly / non-USD / scoped. Run it with the student's direct
   credentials and via the CDK deploy path.
3. **Email confirmation scope.** Before confirming the SNS email, verify the
   Lambda still runs and the action still fires (email is the only thing gated).
   After confirming, verify the inventory email arrives.
4. **No spurious runs.** A warn-threshold notification and the Lambda's own
   report never invoke a second inventory run (two-topic isolation).
5. **Observed status.** The report shows the real action status from
   `DescribeBudgetAction` (e.g. `EXECUTION_SUCCESS` / pending in watch), not the
   configured mode.
6. **Bounds.** Confirm behavior on: a region/service returning AccessDenied
   (reported as `failed`, never zero); a run that would exceed the byte limit
   (summarized/split, disclosed); a forced publish failure (invocation fails →
   retried → lands in the failure queue).
7. **Block + recovery.** In `armed`, confirm new-launch attempts by a covered
   identity are denied; confirm the recovery principal can reverse the action;
   confirm the deny auto-detaches at the next period (or document the observed
   reset timing).
8. **Teardown.** `cdk destroy` while armed and while tripped — record whether it
   detaches and deletes the policy cleanly or requires reversing the action
   first; update spec §10 with the observed behavior.
9. **Capture artifacts.** Save the real budget-action notification payloads
   (pending / executed / reversed / reset) for regression fixtures.
```

- [ ] **Step 2: Commit**

```bash
git add RELEASE.md
git commit -m "docs: release acceptance gate with explicit deploy-authorization boundary"
```

---

## Self-Review

**Spec coverage:**
- §2 what-it-is/paths → Tasks 5 (Path A/B), 11 (README). ✓
- §5.1 lag / not-a-cap → Task 11 README, Task 12. ✓
- §5.2 once-per-period / self-clear → Task 12 (#7), README. ✓
- §5.3 action requires targets → Tasks 2 (validation), 5 (action). ✓
- §5.4 pricing → README/RELEASE (documented). ✓
- §5.5 SNS policy/encryption/confirmation → Tasks 4, 11, 12. ✓
- §5.6 budget semantics → Task 10 preflight. ✓
- §5.7 identity-scoped → Task 10 preflight, README. ✓
- §6 two-topic architecture → Task 4. ✓
- §7.2 resources → Tasks 4–5. ✓
- §7.3 deny policy → Task 3. ✓
- §7.4 reporter (status, regions, coverage, S3, byte budget, publish-failure) → Tasks 7–9. ✓
- §7.5 config → Task 2. ✓
- §7.6 SAFETY → Task 5. ✓
- §7.7 preflight → Task 10. ✓
- §8 coverage/gaps → Task 8 adapters + README table. ✓
- §9 safety → distributed (Tasks 3,4,10). ✓
- §10 teardown → Task 11 README + Task 12 verification. ✓
- §11 tests → every task's test steps + Task 12 live gate. ✓
- §12 cost → README/RELEASE. ✓

**Placeholder scan:** Task 5 Step 3 uses a comment marker replaced by real code in the same step; Task 8 Step 5 intentionally directs repeating a fully-specified adapter pattern with named APIs (not vague). No "TBD"/"add error handling"/"write tests for the above" remain.

**Type consistency:** `RadarConfig` fields identical across Tasks 2/4/5/10. `_client`, `observe_action_status`, `enabled_regions`, `inventory`, `build_report`, `publish`, `s3_bucket_sizes` consistent across Tasks 7–9. `BudgetRadarStack` interface stable across Tasks 4–6.

**Known follow-ups flagged for executor:** the `AWS::Lambda::EventInvokeConfig` assertion (Task 4 Step 4) and the reporter-env matcher (Task 5 Step 3) may need shape tweaks against the exact synthesized template — noted inline in those steps.
