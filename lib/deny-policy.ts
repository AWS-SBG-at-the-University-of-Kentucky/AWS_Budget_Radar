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
