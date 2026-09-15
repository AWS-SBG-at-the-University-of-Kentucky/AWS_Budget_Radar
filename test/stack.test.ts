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
