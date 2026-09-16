// Positive list of spend-causing "create/launch" actions. NEVER Deny:*.
// Deliberately excludes iam:*, budgets:*, cloudformation:*, and all read-only
// actions so the member can always inspect state and detach this policy.
export const DENY_ACTIONS: readonly string[] = Object.freeze([
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
  "lambda:CreateFunction",
  // F6(b): additional pure creation/start actions. None of these are
  // cleanup/scale-down operations, so denying them is consistent with the
  // "never block stopping/scaling to zero" rule below.
  "sagemaker:StartNotebookInstance",
  "sagemaker:CreateApp",
  "rds:StartDBCluster",
  "ec2:RequestSpotInstances",
  "ec2:RequestSpotFleet",
  "ec2:CreateFleet"
]);

export function denyPolicyDocument() {
  return {
    Version: "2012-10-17",
    Statement: [
      { Effect: "Deny", Action: [...DENY_ACTIONS], Resource: "*" }
    ]
  };
}
