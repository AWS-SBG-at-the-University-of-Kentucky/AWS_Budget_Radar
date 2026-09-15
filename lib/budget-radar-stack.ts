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

    // --- Two unencrypted topics. These carry only cost-alert metadata (no
    //     secrets), so SSE-KMS is skipped rather than adding a key + grants
    //     that budgets.amazonaws.com would also need permission to use. ---
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
    // Scope attach/detach to the resolved target ARNs (entity dimension) AND the
    // specific DenyNewSpend policy (iam:PolicyARN condition — IAM scopes the
    // which-policy dimension via a condition key, not the resource), so this role
    // can never attach/detach an arbitrary managed policy.
    this.actionRole.addToPolicy(new iam.PolicyStatement({
      actions: ["iam:AttachUserPolicy", "iam:DetachUserPolicy",
                "iam:AttachGroupPolicy", "iam:DetachGroupPolicy",
                "iam:AttachRolePolicy", "iam:DetachRolePolicy"],
      resources: this.denyTargetArns(config, account),
      conditions: {
        ArnEquals: { "iam:PolicyARN": this.denyPolicy.managedPolicyArn }
      }
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
