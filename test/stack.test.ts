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
          Action: Match.arrayWith(["iam:AttachUserPolicy", "iam:DetachUserPolicy"]),
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
