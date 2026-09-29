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
import { RadarConfig, StopGroup, StopKind } from "./config";
import { denyPolicyDocument } from "./deny-policy";

export interface BudgetRadarStackProps extends cdk.StackProps { config: RadarConfig; }

export class BudgetRadarStack extends cdk.Stack {
  readonly triggerTopic: sns.Topic;
  readonly reportTopic: sns.Topic;
  readonly reporter: lambda.Function;
  readonly denyPolicy: iam.ManagedPolicy;
  readonly actionRole: iam.Role;
  readonly failureQueue: sqs.Queue;
  // Native stop actions; empty (and no stopRole) unless STOP_* is configured.
  readonly stopActions: cdk.aws_budgets.CfnBudgetsAction[];
  readonly stopRole?: iam.Role;

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
    const triggerPolicy = budgetsPublish(this.triggerTopic);
    const reportPolicy = budgetsPublish(this.reportTopic);

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
        SAFETY: config.safety,
        // F1(c): named in the report's recovery line instead of generic wording.
        RECOVERY_PRINCIPAL_ARN: config.recoveryPrincipalArn
        // ACCOUNT_ID / BUDGET_NAME / ACTION_ID are added below, once the
        // budget and action exist.
      }
    });
    this.reportTopic.grantPublish(this.reporter);
    this.reporter.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        "ec2:DescribeRegions", "ec2:DescribeInstances", "ec2:DescribeAddresses",
        "ec2:DescribeVolumes", "ec2:DescribeNatGateways",
        "rds:DescribeDBInstances", "rds:DescribeDBClusters",
        "ecs:ListClusters", "ecs:ListServices", "ecs:DescribeServices",
        "ecs:ListTasks", "ecs:DescribeTasks",
        "lambda:ListFunctions", "lambda:GetFunctionConcurrency",
        "lambda:ListProvisionedConcurrencyConfigs",
        "sagemaker:ListNotebookInstances", "sagemaker:ListEndpoints",
        "cloudwatch:GetMetricData",
        "elasticloadbalancing:DescribeLoadBalancers",
        "budgets:DescribeBudgetAction",
        "s3:ListAllMyBuckets", "s3:GetBucketLocation"
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

    // --- Determine the budget name and (Path B) create the budget. ---
    // F10(a): unique per stack+region (both resolve at deploy time) rather
    // than a uniqueId suffix, so the name is stable and predictable across
    // re-deploys of the same stack instead of changing whenever the
    // construct tree shifts.
    const budgetName = config.existingBudgetName ?? `budget-radar-${this.stackName}-${this.region}`;

    // Cost-metric treatment (design spec §5.6). AWS's default includes credits &
    // refunds, which nets a credit-covered learning account's gross usage down to
    // ~$0.00 and hides it behind a tiny threshold — so a $0.06 spend read $0.00
    // and the action never tripped. trackGrossUsage (default) excludes credits &
    // refunds so real usage trips the budget even while credits cover the bill.
    // Only these two fields are overridden; the rest stay at AWS defaults. Used by
    // budgets that stay on the classic model (per-service warn budgets, and the
    // main budget when no services are excluded).
    const grossCostTypes = config.trackGrossUsage
      ? { includeCredit: false, includeRefund: false }
      : undefined;

    // The action-enabled budget's cost scope. Two mutually exclusive AWS models:
    //   - No EXCLUDE_SERVICES: unscoped total-account cost via the classic model
    //     (CostTypes carries the gross-usage treatment above).
    //   - EXCLUDE_SERVICES set: a FilterExpression tracking everything EXCEPT the
    //     named services. AWS DROPS CostTypes whenever FilterExpression is present
    //     (verified empirically), so gross-usage is preserved instead by excluding
    //     Credit/Refund RECORD_TYPEs and pinning the UnblendedCost (pre-credit)
    //     metric. Note: excluding a service makes the budget scoped, so it no
    //     longer protects TOTAL account cost (opt-in only; default is empty).
    const mainBudgetScope: {
      costTypes?: cdk.aws_budgets.CfnBudget.CostTypesProperty;
      filterExpression?: cdk.aws_budgets.CfnBudget.ExpressionProperty;
      metrics?: string[];
    } = {};
    if (config.excludeServices.length === 0) {
      mainBudgetScope.costTypes = grossCostTypes;
    } else {
      const notService = (name: string): cdk.aws_budgets.CfnBudget.ExpressionProperty => ({
        not: { dimensions: { key: "SERVICE", values: [name], matchOptions: ["EQUALS"] } }
      });
      const clauses: cdk.aws_budgets.CfnBudget.ExpressionProperty[] =
        config.excludeServices.map(notService);
      if (config.trackGrossUsage) {
        clauses.push({ not: { dimensions: { key: "RECORD_TYPE", values: ["Credit", "Refund"], matchOptions: ["EQUALS"] } } });
      }
      mainBudgetScope.filterExpression = clauses.length === 1 ? clauses[0] : { and: clauses };
      mainBudgetScope.metrics = ["UnblendedCost"];
    }

    let budget: cdk.aws_budgets.CfnBudget | undefined;
    if (!config.existingBudgetName) {
      const notifications = [
        // warn-only threshold -> report topic (email); does NOT trigger the Lambda
        {
          notification: { notificationType: "ACTUAL", comparisonOperator: "GREATER_THAN", threshold: config.warnAtPercent },
          subscribers: [{ subscriptionType: "SNS", address: this.reportTopic.topicArn }]
        }
      ];
      budget = new cdk.aws_budgets.CfnBudget(this, "Budget", {
        budget: {
          budgetName,
          budgetType: "COST",
          timeUnit: "MONTHLY",
          budgetLimit: { amount: config.monthlyBudgetUsd, unit: "USD" },
          ...mainBudgetScope
        },
        notificationsWithSubscribers: notifications
      });
      // Budget publishes its warn notification to the report topic, which
      // requires the report topic's publish policy to exist first.
      if (reportPolicy.policyDependable) budget.node.addDependency(reportPolicy.policyDependable);
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
      subscribers: [{ type: "SNS", address: this.triggerTopic.topicArn }]
    });

    // Explicit ordering: the action references its budget, execution role
    // policy, and trigger topic only by name/ARN in the resource properties
    // above, which CDK does not turn into a CFN DependsOn on its own.
    if (budget) action.node.addDependency(budget); // action needs its budget first (Path B only)
    const rolePolicy = this.actionRole.node.tryFindChild("DefaultPolicy");
    if (rolePolicy) action.node.addDependency(rolePolicy); // role's attach/detach policy must exist for action lifecycle
    if (triggerPolicy.policyDependable) action.node.addDependency(triggerPolicy.policyDependable); // budgets must be able to publish to the trigger topic

    // Give the reporter the identifiers it needs for DescribeBudgetAction.
    this.reporter.addEnvironment("ACCOUNT_ID", account);
    this.reporter.addEnvironment("BUDGET_NAME", budgetName);
    this.reporter.addEnvironment("ACTION_ID", action.attrActionId);

    // --- Optional native stop actions (STOP_EC2_INSTANCES / STOP_RDS_INSTANCES). ---
    // AWS Budgets itself runs the AWS-StopEC2Instance / AWS-StopRdsInstance
    // SSM runbooks at the same threshold as the deny. Stop, never terminate or
    // delete, so no data is lost. The reporter stays read-only.
    this.stopActions = [];
    const stopGroups = this.mergeStopGroups(config.stopGroups);
    if (stopGroups.length > 0) {
      this.stopRole = new iam.Role(this, "StopInstancesRole", {
        assumedBy: new iam.ServicePrincipal("budgets.amazonaws.com", {
          conditions: {
            StringEquals: { "aws:SourceAccount": account },
            ArnLike: { "aws:SourceArn": `arn:aws:budgets::${account}:*` }
          }
        })
      });
      this.grantStopPermissions(this.stopRole, stopGroups, account);
      const stopRolePolicy = this.stopRole.node.tryFindChild("DefaultPolicy");

      for (const g of stopGroups) {
        const stop = new cdk.aws_budgets.CfnBudgetsAction(this, `Stop${g.kind}${this.regionSlug(g.region)}`, {
          budgetName,
          actionThreshold: { type: "PERCENTAGE", value: config.actionThresholdPercent },
          actionType: "RUN_SSM_DOCUMENTS",
          approvalModel: config.safety === "armed" ? "AUTOMATIC" : "MANUAL",
          notificationType: config.actionThresholdType,
          executionRoleArn: this.stopRole.roleArn,
          definition: {
            ssmActionDefinition: {
              subtype: g.kind === "EC2" ? "STOP_EC2_INSTANCES" : "STOP_RDS_INSTANCES",
              region: g.region,
              instanceIds: g.ids
            }
          },
          // AWS's own action notice goes straight to the email topic. Only the
          // deny action drives the reporter, whose single report also lists
          // every stop action's status (one email per trip, not one per action).
          subscribers: [{ type: "SNS", address: this.reportTopic.topicArn }]
        });
        if (budget) stop.node.addDependency(budget);
        if (stopRolePolicy) stop.node.addDependency(stopRolePolicy);
        if (reportPolicy.policyDependable) stop.node.addDependency(reportPolicy.policyDependable);
        this.stopActions.push(stop);
      }
      this.reporter.addEnvironment("STOP_ACTION_IDS", cdk.Fn.join(",", this.stopActions.map(a => a.attrActionId)));
    }

    // --- Optional per-service warn budgets (notification-only, free). ---
    for (const [i, sb] of config.serviceBudgets.entries()) {
      const svcBudget = new cdk.aws_budgets.CfnBudget(this, `ServiceBudget${i}`, {
        budget: {
          budgetName: `${budgetName}-svc-${i}`,
          budgetType: "COST",
          timeUnit: "MONTHLY",
          budgetLimit: { amount: sb.limitUsd, unit: "USD" },
          costFilters: { Service: [sb.service] },
          costTypes: grossCostTypes
        },
        notificationsWithSubscribers: [{
          notification: { notificationType: "ACTUAL", comparisonOperator: "GREATER_THAN", threshold: 100 },
          subscribers: [{ subscriptionType: "SNS", address: this.reportTopic.topicArn }]
        }]
      });
      // Also publishes its warn notification to the report topic.
      if (reportPolicy.policyDependable) svcBudget.node.addDependency(reportPolicy.policyDependable);
    }
  }

  // Resolves each group's region (undefined = this stack's region) and merges
  // groups that land in the same concrete region, so "i-1" and
  // "us-east-1:i-2" deployed to us-east-1 become one action, not two.
  private mergeStopGroups(groups: StopGroup[]): Array<StopGroup & { region: string }> {
    const merged = new Map<string, StopGroup & { region: string }>();
    for (const g of groups) {
      const region = g.region ?? this.region;
      // An unresolved (token) deploy region can't be compared, so it keeps
      // its own group.
      const key = `${g.kind}|${cdk.Token.isUnresolved(region) ? "(deploy region)" : region}`;
      const existing = merged.get(key);
      if (existing) {
        for (const id of g.ids) if (!existing.ids.includes(id)) existing.ids.push(id);
      } else {
        merged.set(key, { kind: g.kind, region, ids: [...g.ids] });
      }
    }
    for (const g of merged.values()) {
      if (g.ids.length > 100) {
        throw new Error(`${g.kind} stop list has ${g.ids.length} instances in ${g.region}; AWS allows at most 100 per region.`);
      }
    }
    return [...merged.values()];
  }

  private regionSlug(region: string): string {
    return cdk.Token.isUnresolved(region) ? "DeployRegion" : region.replace(/-/g, "");
  }

  // Mirrors AWS's managed AWSBudgetsActions_RolePolicyForResourceAdministrationWithSSM,
  // scoped down: only the AWS stop/start runbooks in the configured regions,
  // and stop/start only on the exact listed instances. Budgets starts the
  // runbook with this role and SSM then calls EC2/RDS on its behalf, hence the
  // aws:CalledVia condition. Start is granted so reversing a stop action (which
  // restarts the instances) can work.
  private grantStopPermissions(role: iam.Role, groups: Array<StopGroup & { region: string }>, account: string): void {
    const calledViaSsm = { "ForAnyValue:StringEquals": { "aws:CalledVia": ["ssm.amazonaws.com"] } };
    const regions = [...new Set(groups.map(g => g.region))];
    const docsFor = (kind: StopKind) => kind === "EC2"
      ? ["AWS-StopEC2Instance", "AWS-StartEC2Instance"]
      : ["AWS-StopRdsInstance", "AWS-StartRdsInstance"];
    const kinds = [...new Set(groups.map(g => g.kind))];
    const ssmResources: string[] = [];
    for (const region of regions) {
      for (const kind of kinds) {
        for (const doc of docsFor(kind)) {
          ssmResources.push(`arn:${this.partition}:ssm:${region}:*:document/${doc}`);
          ssmResources.push(`arn:${this.partition}:ssm:${region}:*:automation-definition/${doc}:*`);
        }
      }
      ssmResources.push(`arn:${this.partition}:ssm:${region}:${account}:automation-execution/*`);
    }
    role.addToPolicy(new iam.PolicyStatement({
      actions: ["ssm:StartAutomationExecution"],
      resources: ssmResources
    }));

    const ec2 = groups.filter(g => g.kind === "EC2");
    if (ec2.length) {
      role.addToPolicy(new iam.PolicyStatement({
        actions: ["ec2:StopInstances", "ec2:StartInstances"],
        resources: ec2.flatMap(g => g.ids.map(id => `arn:${this.partition}:ec2:${g.region}:${account}:instance/${id}`)),
        conditions: calledViaSsm
      }));
      role.addToPolicy(new iam.PolicyStatement({
        actions: ["ec2:DescribeInstanceStatus"],
        resources: ["*"],  // Describe* cannot be scoped to a resource
        conditions: calledViaSsm
      }));
    }
    const rds = groups.filter(g => g.kind === "RDS");
    if (rds.length) {
      role.addToPolicy(new iam.PolicyStatement({
        actions: ["rds:StopDBInstance", "rds:StartDBInstance"],
        resources: rds.flatMap(g => g.ids.map(id => `arn:${this.partition}:rds:${g.region}:${account}:db:${id}`)),
        conditions: calledViaSsm
      }));
      role.addToPolicy(new iam.PolicyStatement({
        actions: ["rds:DescribeDBInstances"],
        resources: ["*"],
        conditions: calledViaSsm
      }));
    }
  }

  private denyTargetArns(config: RadarConfig, account: string): string[] {
    const arn = (kind: string, name: string) => {
      if (name.startsWith("arn:")) {
        // Full ARN supplied: it must name this stack's own account. Budgets
        // attach/detach is not designed for cross-account targets, and
        // silently accepting one would let a typo'd/foreign ARN pass synth.
        // F9: when `account` is an unresolved CDK token (credential-free
        // synth with no CDK_DEFAULT_ACCOUNT — e.g. `cdk synth` in CI, or
        // this project's own synth test), there is no concrete account to
        // compare against yet, so skip the mismatch check rather than
        // throwing on a token that simply hasn't resolved. A CONCRETE
        // account mismatch still throws exactly as before.
        const arnAccount = name.split(":")[4];
        if (!cdk.Token.isUnresolved(account) && arnAccount !== account) {
          throw new Error(
            `deny target ${name} is in a different account than the stack; attach/detach must be same-account`
          );
        }
        return name;
      }
      // bare names assume IAM path '/'; identities under a non-root path
      // MUST be supplied as full ARNs (the §7.7 preflight resolves the real
      // ARN and rejects a mismatch).
      return `arn:aws:iam::${account}:${kind}/${name}`;
    };
    return [
      ...config.denyTargetUsers.map(u => arn("user", u)),
      ...config.denyTargetGroups.map(g => arn("group", g)),
      ...config.denyTargetRoles.map(r => arn("role", r))
    ];
  }
}
