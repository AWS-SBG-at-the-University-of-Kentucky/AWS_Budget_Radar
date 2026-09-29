import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import { BudgetRadarStack } from "../lib/budget-radar-stack";
import { RadarConfig } from "../lib/config";

const cfg: RadarConfig = {
  alertEmail: "a@b.edu", existingBudgetName: undefined, monthlyBudgetUsd: 5,
  warnAtPercent: 80, actionThresholdPercent: 100, actionThresholdType: "ACTUAL",
  safety: "watch", denyTargetUsers: ["student"], denyTargetGroups: [], denyTargetRoles: [],
  recoveryPrincipalArn: "arn:aws:iam::111122223333:role/Admin", serviceBudgets: [],
  trackGrossUsage: true, excludeServices: [], stopGroups: []
};

function synth(config: RadarConfig): Template {
  const app = new cdk.App();
  const stack = new BudgetRadarStack(app, "TestStack", { config, env: { account: "111122223333", region: "us-east-1" } });
  return Template.fromStack(stack);
}

function reporterEnv(t: Template): any {
  return Object.values(t.findResources("AWS::Lambda::Function"))[0].Properties.Environment.Variables;
}

function synthStack(config: RadarConfig): { stack: BudgetRadarStack; template: Template } {
  const app = new cdk.App();
  const stack = new BudgetRadarStack(app, "TestStack", { config, env: { account: "111122223333", region: "us-east-1" } });
  return { stack, template: Template.fromStack(stack) };
}

test("creates exactly two SNS topics, both unencrypted", () => {
  const t = synth(cfg);
  t.resourceCountIs("AWS::SNS::Topic", 2);
  const topics = t.findResources("AWS::SNS::Topic");
  for (const key of Object.keys(topics)) {
    expect(topics[key].Properties?.KmsMasterKeyId).toBeUndefined();
  }
});

test("both topic policies grant budgets.amazonaws.com publish with confused-deputy conditions", () => {
  const t = synth(cfg);
  const policies = t.findResources("AWS::SNS::TopicPolicy");
  const keys = Object.keys(policies);
  expect(keys.length).toBe(2); // one per topic — TriggerTopic and ReportTopic
  for (const key of keys) {
    const statements: any[] = policies[key].Properties.PolicyDocument.Statement;
    const hasConfusedDeputyGrant = statements.some(s =>
      s.Principal?.Service === "budgets.amazonaws.com" &&
      s.Action === "sns:Publish" &&
      s.Condition?.StringEquals?.["aws:SourceAccount"] === "111122223333" &&
      s.Condition?.ArnLike?.["aws:SourceArn"] === "arn:aws:budgets::111122223333:*"
    );
    expect(hasConfusedDeputyGrant).toBe(true);
  }
});

test("email subscription is on the report topic", () => {
  const t = synth(cfg);
  t.hasResourceProperties("AWS::SNS::Subscription", Match.objectLike({ Protocol: "email", Endpoint: "a@b.edu" }));
});

test("lambda subscription is on the trigger topic, not the report topic", () => {
  const { stack, template } = synthStack(cfg);
  const triggerLogicalId = stack.getLogicalId(stack.triggerTopic.node.defaultChild as cdk.CfnElement);
  const reportLogicalId = stack.getLogicalId(stack.reportTopic.node.defaultChild as cdk.CfnElement);

  const lambdaSubs = template.findResources("AWS::SNS::Subscription", {
    Properties: Match.objectLike({ Protocol: "lambda" })
  });
  const lambdaSubResources = Object.values(lambdaSubs);
  expect(lambdaSubResources.length).toBeGreaterThan(0);
  for (const sub of lambdaSubResources) {
    expect(sub.Properties.TopicArn).toEqual({ Ref: triggerLogicalId });
    expect(sub.Properties.TopicArn).not.toEqual({ Ref: reportLogicalId });
  }
});

test("lambda is python3.13, 900s, with a failure destination", () => {
  const t = synth(cfg);
  t.hasResourceProperties("AWS::Lambda::Function", Match.objectLike({ Runtime: "python3.13", Timeout: 900, MemorySize: 512 }));
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

test("action role attach/detach statement is scoped to the DenyNewSpend policy ARN", () => {
  const t = synth(cfg);
  t.hasResourceProperties("AWS::IAM::Policy", Match.objectLike({
    PolicyDocument: Match.objectLike({
      Statement: Match.arrayWith([
        Match.objectLike({
          Action: Match.arrayWith([
            "iam:AttachUserPolicy", "iam:DetachUserPolicy",
            "iam:AttachGroupPolicy", "iam:DetachGroupPolicy",
            "iam:AttachRolePolicy", "iam:DetachRolePolicy"
          ]),
          Condition: Match.objectLike({
            ArnEquals: Match.objectLike({
              "iam:PolicyARN": Match.objectLike({ Ref: Match.stringLikeRegexp("DenyNewSpend") })
            })
          })
        })
      ])
    })
  }));
});

test("Path B creates a monthly USD cost budget and one action", () => {
  const t = synth(cfg);
  t.hasResourceProperties("AWS::Budgets::Budget", Match.objectLike({
    Budget: Match.objectLike({ BudgetType: "COST", TimeUnit: "MONTHLY", BudgetLimit: { Amount: 5, Unit: "USD" } })
  }));
  t.resourceCountIs("AWS::Budgets::BudgetsAction", 1);
});

test("trackGrossUsage (default) excludes credits & refunds so credits can't hide usage", () => {
  const t = synth(cfg);
  t.hasResourceProperties("AWS::Budgets::Budget", Match.objectLike({
    Budget: Match.objectLike({ CostTypes: Match.objectLike({ IncludeCredit: false, IncludeRefund: false }) })
  }));
});

test("trackGrossUsage=false leaves CostTypes at AWS defaults (net of credits)", () => {
  const budgets = synth({ ...cfg, trackGrossUsage: false }).findResources("AWS::Budgets::Budget");
  const main = Object.values(budgets)[0].Properties.Budget;
  expect(main.CostTypes).toBeUndefined();
});

// Selects the main action-enabled budget (the one that is NOT a per-service
// warn budget). Per-service budgets carry CostFilters; the main one does not.
function mainBudget(t: Template): any {
  const all = Object.values(t.findResources("AWS::Budgets::Budget")).map(r => r.Properties.Budget);
  return all.find(b => !b.CostFilters);
}

test("EXCLUDE_SERVICES switches to a FilterExpression that excludes those services + UnblendedCost metric, no CostTypes", () => {
  const b = mainBudget(synth({ ...cfg, excludeServices: ["Some AWS Service"] }));
  expect(b.CostTypes).toBeUndefined();               // AWS drops CostTypes under FilterExpression
  expect(b.Metrics).toEqual(["UnblendedCost"]);
  const clauses = b.FilterExpression.And;
  const serviceNot = clauses.find((c: any) => c.Not?.Dimensions?.Key === "SERVICE");
  expect(serviceNot.Not.Dimensions.Values).toEqual(["Some AWS Service"]);
  expect(serviceNot.Not.Dimensions.MatchOptions).toEqual(["EQUALS"]);
});

test("gross-usage under exclusion is preserved via a RECORD_TYPE credit/refund exclusion", () => {
  const b = mainBudget(synth({ ...cfg, excludeServices: ["Some AWS Service"], trackGrossUsage: true }));
  const recordNot = b.FilterExpression.And.find((c: any) => c.Not?.Dimensions?.Key === "RECORD_TYPE");
  expect(recordNot.Not.Dimensions.Values).toEqual(expect.arrayContaining(["Credit", "Refund"]));
});

test("trackGrossUsage=false under exclusion omits the RECORD_TYPE clause", () => {
  const b = mainBudget(synth({ ...cfg, excludeServices: ["Some AWS Service"], trackGrossUsage: false }));
  const hasRecordType = (b.FilterExpression.And ?? [b.FilterExpression])
    .some((c: any) => c.Not?.Dimensions?.Key === "RECORD_TYPE");
  expect(hasRecordType).toBe(false);
});

test("multiple excluded services each get their own Not(SERVICE=...) clause", () => {
  const b = mainBudget(synth({ ...cfg, excludeServices: ["Service A", "Service B"] }));
  const svc = b.FilterExpression.And
    .filter((c: any) => c.Not?.Dimensions?.Key === "SERVICE")
    .map((c: any) => c.Not.Dimensions.Values[0]);
  expect(svc).toEqual(expect.arrayContaining(["Service A", "Service B"]));
});

test("per-service budgets share the gross-usage cost treatment", () => {
  const t = synth({ ...cfg, serviceBudgets: [{ service: "Amazon Elastic Compute Cloud - Compute", limitUsd: 20 }] });
  const budgets = t.findResources("AWS::Budgets::Budget");
  const svc = Object.values(budgets).find(b => b.Properties.Budget.CostFilters)!.Properties.Budget;
  expect(svc.CostTypes).toEqual(expect.objectContaining({ IncludeCredit: false, IncludeRefund: false }));
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
    ACCOUNT_ID: expect.anything(),
    BUDGET_NAME: expect.anything(),
    ACTION_ID: expect.anything()
  }));
});

// --- F1(c): recovery principal named in the report instead of generic wording ---

test("reporter receives RECOVERY_PRINCIPAL_ARN as an env var", () => {
  const t = synth(cfg);
  const fn = Object.values(t.findResources("AWS::Lambda::Function"))[0].Properties;
  expect(fn.Environment.Variables).toEqual(expect.objectContaining({
    RECOVERY_PRINCIPAL_ARN: cfg.recoveryPrincipalArn
  }));
});

// --- F9: cross-account guard must not throw on an unresolved (token) account ---

test("a full-ARN same-looking target does not throw when the stack account is an unresolved token", () => {
  const app = new cdk.App();
  // No env.account supplied at all: cdk.Stack.of(this).account resolves to
  // an unresolved pseudo-parameter token, not a concrete account string —
  // mirrors credential-free synth with no CDK_DEFAULT_ACCOUNT set.
  const badCfg: RadarConfig = { ...cfg, denyTargetRoles: ["arn:aws:iam::999999999999:role/Other"] };
  let stack!: BudgetRadarStack;
  expect(() => { stack = new BudgetRadarStack(app, "TestStackNoAccount", { config: badCfg }); }).not.toThrow();
  expect(() => Template.fromStack(stack)).not.toThrow();
});

test("reporter role is granted s3:GetBucketLocation (read-only, needed to size buckets in their own region)", () => {
  const t = synth(cfg);
  t.hasResourceProperties("AWS::IAM::Policy", Match.objectLike({
    PolicyDocument: Match.objectLike({
      Statement: Match.arrayWith([
        Match.objectLike({
          Action: Match.arrayWith(["s3:ListAllMyBuckets", "s3:GetBucketLocation"])
        })
      ])
    })
  }));
});

function dependsOnArray(resource: any): string[] {
  const d = resource?.DependsOn;
  if (!d) return [];
  return Array.isArray(d) ? d : [d];
}

test("Path B: explicit CFN DependsOn wires action -> budget/role policy/trigger topic policy, and budget -> report topic policy", () => {
  const { stack, template } = synthStack(cfg);

  const triggerLogicalId = stack.getLogicalId(stack.triggerTopic.node.defaultChild as cdk.CfnElement);
  const reportLogicalId = stack.getLogicalId(stack.reportTopic.node.defaultChild as cdk.CfnElement);

  const topicPolicies = template.findResources("AWS::SNS::TopicPolicy");
  const findPolicyLogicalId = (topicLogicalId: string): string => {
    const entry = Object.entries(topicPolicies).find(([, res]: [string, any]) =>
      (res.Properties.Topics as any[]).some(t => t.Ref === topicLogicalId)
    );
    expect(entry).toBeDefined();
    return entry![0];
  };
  const triggerPolicyLogicalId = findPolicyLogicalId(triggerLogicalId);
  const reportPolicyLogicalId = findPolicyLogicalId(reportLogicalId);

  const rolePolicyL2 = stack.actionRole.node.tryFindChild("DefaultPolicy");
  expect(rolePolicyL2).toBeDefined();
  const rolePolicyLogicalId = stack.getLogicalId((rolePolicyL2 as any).node.defaultChild as cdk.CfnElement);

  const budgetLogicalId = stack.getLogicalId(stack.node.findChild("Budget") as unknown as cdk.CfnElement);
  const actionLogicalId = stack.getLogicalId(stack.node.findChild("BlockNewSpend") as unknown as cdk.CfnElement);

  const actionResource = template.findResources("AWS::Budgets::BudgetsAction")[actionLogicalId];
  expect(actionResource).toBeDefined();
  expect(dependsOnArray(actionResource)).toEqual(expect.arrayContaining([
    budgetLogicalId, rolePolicyLogicalId, triggerPolicyLogicalId
  ]));

  const budgetResource = template.findResources("AWS::Budgets::Budget")[budgetLogicalId];
  expect(budgetResource).toBeDefined();
  expect(dependsOnArray(budgetResource)).toEqual(expect.arrayContaining([reportPolicyLogicalId]));
});

test("a cross-account full-ARN deny target throws at synth", () => {
  const badCfg: RadarConfig = { ...cfg, denyTargetRoles: ["arn:aws:iam::999999999999:role/Other"] };
  expect(() => synth(badCfg)).toThrow(/different account/);
});

// --- Native stop actions (RUN_SSM_DOCUMENTS) ---

const stopCfg: RadarConfig = {
  ...cfg,
  stopGroups: [
    { kind: "EC2", region: undefined, ids: ["i-0123456789abcdef0"] },
    { kind: "EC2", region: "us-east-1", ids: ["i-0fedcba9876543210", "i-0123456789abcdef0"] },
    { kind: "EC2", region: "us-west-2", ids: ["i-11111111"] },
    { kind: "RDS", region: undefined, ids: ["labdb"] }
  ]
};

function ssmActions(t: Template): any[] {
  return Object.values(t.findResources("AWS::Budgets::BudgetsAction"))
    .map(r => r.Properties)
    .filter(p => p.ActionType === "RUN_SSM_DOCUMENTS");
}

test("no stop groups: no stop actions, no stop role, no STOP_ACTION_IDS env", () => {
  const { stack, template } = synthStack(cfg);
  expect(stack.stopActions).toEqual([]);
  expect(stack.stopRole).toBeUndefined();
  expect(ssmActions(template)).toHaveLength(0);
  expect(reporterEnv(template).STOP_ACTION_IDS).toBeUndefined();
});

test("one RUN_SSM_DOCUMENTS action per kind + region, merging the deploy region with explicit same-region entries", () => {
  const actions = ssmActions(synth(stopCfg));
  const summary = actions.map(a => [a.Definition.SsmActionDefinition.Subtype, a.Definition.SsmActionDefinition.Region,
    a.Definition.SsmActionDefinition.InstanceIds]);
  expect(summary).toEqual(expect.arrayContaining([
    ["STOP_EC2_INSTANCES", "us-east-1", ["i-0123456789abcdef0", "i-0fedcba9876543210"]],
    ["STOP_EC2_INSTANCES", "us-west-2", ["i-11111111"]],
    ["STOP_RDS_INSTANCES", "us-east-1", ["labdb"]]
  ]));
  expect(actions).toHaveLength(3);
});

test("stop actions share the deny's threshold, notification type, and SAFETY approval model", () => {
  for (const safety of ["watch", "armed"] as const) {
    const t = synth({ ...stopCfg, safety, actionThresholdPercent: 90, actionThresholdType: "FORECASTED" });
    for (const a of ssmActions(t)) {
      expect(a.ApprovalModel).toBe(safety === "armed" ? "AUTOMATIC" : "MANUAL");
      expect(a.ActionThreshold).toEqual({ Type: "PERCENTAGE", Value: 90 });
      expect(a.NotificationType).toBe("FORECASTED");
    }
  }
});

test("stop actions notify the report topic (email), not the trigger topic, so one trip = one Radar report", () => {
  const { stack, template } = synthStack(stopCfg);
  const reportLogicalId = stack.getLogicalId(stack.reportTopic.node.defaultChild as cdk.CfnElement);
  for (const a of ssmActions(template)) {
    expect(a.Subscribers).toEqual([{ Type: "SNS", Address: { Ref: reportLogicalId } }]);
  }
});

test("stop actions use their own budgets-trusted role with confused-deputy conditions", () => {
  const { stack, template } = synthStack(stopCfg);
  const roleId = stack.getLogicalId(stack.stopRole!.node.defaultChild as cdk.CfnElement);
  const role = template.findResources("AWS::IAM::Role")[roleId].Properties;
  expect(role.AssumeRolePolicyDocument.Statement[0]).toEqual(expect.objectContaining({
    Principal: { Service: "budgets.amazonaws.com" },
    Condition: {
      StringEquals: { "aws:SourceAccount": "111122223333" },
      ArnLike: { "aws:SourceArn": "arn:aws:budgets::111122223333:*" }
    }
  }));
  for (const a of ssmActions(template)) {
    expect(a.ExecutionRoleArn).toEqual({ "Fn::GetAtt": [roleId, "Arn"] });
  }
});

function stopRoleStatements(stack: BudgetRadarStack, template: Template): any[] {
  const roleId = stack.getLogicalId(stack.stopRole!.node.defaultChild as cdk.CfnElement);
  return Object.values(template.findResources("AWS::IAM::Policy"))
    .filter(p => (p.Properties.Roles as any[]).some(r => r.Ref === roleId))
    .flatMap(p => p.Properties.PolicyDocument.Statement);
}

// Renders {"Fn::Join": ["", [...]]} ARNs to plain strings for assertions.
function flat(v: any): string {
  if (typeof v === "string") return v;
  if (v?.["Fn::Join"]) return v["Fn::Join"][1].map(flat).join(v["Fn::Join"][0]);
  if (v?.Ref === "AWS::Partition") return "aws";
  return JSON.stringify(v);
}
const asList = (v: any) => (Array.isArray(v) ? v : [v]);

test("stop role can stop/start ONLY the listed instances, and only via SSM", () => {
  const { stack, template } = synthStack(stopCfg);
  const stmts = stopRoleStatements(stack, template);
  const ec2 = stmts.find(s => asList(s.Action).includes("ec2:StopInstances"));
  expect(asList(ec2.Action).sort()).toEqual(["ec2:StartInstances", "ec2:StopInstances"]);
  expect(asList(ec2.Resource).map(flat).sort()).toEqual([
    "arn:aws:ec2:us-east-1:111122223333:instance/i-0123456789abcdef0",
    "arn:aws:ec2:us-east-1:111122223333:instance/i-0fedcba9876543210",
    "arn:aws:ec2:us-west-2:111122223333:instance/i-11111111"
  ]);
  const rds = stmts.find(s => asList(s.Action).includes("rds:StopDBInstance"));
  expect(asList(rds.Resource).map(flat)).toEqual(["arn:aws:rds:us-east-1:111122223333:db:labdb"]);
  for (const s of [ec2, rds]) {
    expect(s.Condition).toEqual({ "ForAnyValue:StringEquals": { "aws:CalledVia": ["ssm.amazonaws.com"] } });
  }
  // Nothing destructive, and no IAM at all.
  const all = stmts.flatMap(s => asList(s.Action));
  expect(all.some((a: string) => /Terminate|Delete|Modify|^iam:/.test(a))).toBe(false);
});

test("stop role may only start the AWS stop/start runbooks in the configured regions", () => {
  const { stack, template } = synthStack(stopCfg);
  const ssm = stopRoleStatements(stack, template).find(s => asList(s.Action).includes("ssm:StartAutomationExecution"));
  const resources = asList(ssm.Resource).map(flat);
  expect(resources).toEqual(expect.arrayContaining([
    "arn:aws:ssm:us-east-1:*:document/AWS-StopEC2Instance",
    "arn:aws:ssm:us-east-1:*:document/AWS-StopRdsInstance",
    "arn:aws:ssm:us-west-2:*:document/AWS-StopEC2Instance",
    "arn:aws:ssm:us-west-2:111122223333:automation-execution/*"
  ]));
  for (const r of resources) {
    expect(r).toMatch(/^arn:aws:ssm:(us-east-1|us-west-2):(\*|111122223333):(document|automation-definition|automation-execution)\/(AWS-(Stop|Start)(EC2|Rds)Instance(:\*)?|\*)$/);
  }
});

test("stop-only-EC2 config grants no RDS permissions", () => {
  const { stack, template } = synthStack({ ...cfg, stopGroups: [{ kind: "EC2", ids: ["i-12345678"] }] });
  const all = stopRoleStatements(stack, template).flatMap(s => asList(s.Action));
  expect(all.some((a: string) => a.startsWith("rds:"))).toBe(false);
});

test("reporter gets STOP_ACTION_IDS joined from every stop action's id", () => {
  const { stack, template } = synthStack(stopCfg);
  const env = reporterEnv(template);
  const ids = stack.stopActions.map(a => ({ "Fn::GetAtt": [stack.getLogicalId(a), "ActionId"] }));
  expect(env.STOP_ACTION_IDS).toEqual({ "Fn::Join": [",", ids] });
});

test("stop actions depend on the budget, their role policy, and the report topic policy", () => {
  const { stack, template } = synthStack(stopCfg);
  const budgetLogicalId = stack.getLogicalId(stack.node.findChild("Budget") as unknown as cdk.CfnElement);
  const rolePolicyId = stack.getLogicalId(
    (stack.stopRole!.node.tryFindChild("DefaultPolicy") as any).node.defaultChild as cdk.CfnElement);
  const actions = template.findResources("AWS::Budgets::BudgetsAction");
  for (const a of stack.stopActions) {
    const deps = dependsOnArray(actions[stack.getLogicalId(a)]);
    expect(deps).toEqual(expect.arrayContaining([budgetLogicalId, rolePolicyId]));
    expect(deps.some(d => /ReportTopicPolicy/.test(d))).toBe(true);
  }
});

test("stop actions work on Path A (existing budget) too", () => {
  const actions = ssmActions(synth({ ...stopCfg, existingBudgetName: "MyBudget" }));
  expect(actions.length).toBeGreaterThan(0);
  for (const a of actions) expect(a.BudgetName).toBe("MyBudget");
});

test("an unresolved deploy region keeps bare-ID groups separate and passes the region token through", () => {
  const app = new cdk.App();
  const stack = new BudgetRadarStack(app, "NoEnv", {
    config: { ...cfg, stopGroups: [{ kind: "EC2", ids: ["i-12345678"] }, { kind: "EC2", region: "us-east-1", ids: ["i-87654321"] }] }
  });
  const actions = ssmActions(Template.fromStack(stack));
  expect(actions).toHaveLength(2);
  const regions = actions.map(a => a.Definition.SsmActionDefinition.Region);
  expect(regions).toEqual(expect.arrayContaining([{ Ref: "AWS::Region" }, "us-east-1"]));
});
