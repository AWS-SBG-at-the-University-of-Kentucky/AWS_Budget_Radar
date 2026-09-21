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
    expect(a).not.toMatch(/:(Describe|List|Get)/);
  }
});

test("self-lockout guard: does not deny iam:DetachUserPolicy", () => {
  expect(DENY_ACTIONS).not.toContain("iam:DetachUserPolicy");
});

// --- F6(b): additional pure creation/start actions, none of them cleanup ---

test("F6(b): denies the new pure creation/start actions", () => {
  expect(DENY_ACTIONS).toEqual(expect.arrayContaining([
    "sagemaker:StartNotebookInstance", "sagemaker:CreateApp", "rds:StartDBCluster",
    "ec2:RequestSpotInstances", "ec2:RequestSpotFleet", "ec2:CreateFleet"
  ]));
});

test("F6(b): new actions still respect the never-iam/budgets/cloudformation/read-only invariant", () => {
  for (const a of ["sagemaker:StartNotebookInstance", "sagemaker:CreateApp", "rds:StartDBCluster",
                    "ec2:RequestSpotInstances", "ec2:RequestSpotFleet", "ec2:CreateFleet"]) {
    expect(a).not.toMatch(/^iam:/);
    expect(a).not.toMatch(/^budgets:/);
    expect(a).not.toMatch(/^cloudformation:/);
    expect(a).not.toMatch(/:(Describe|List|Get)/);
  }
});

test("policy document is a single Deny statement, never wildcard", () => {
  const doc = denyPolicyDocument();
  expect(doc.Statement).toHaveLength(1);
  expect(doc.Statement[0].Effect).toBe("Deny");
  expect(doc.Statement[0].Action).not.toContain("*");
});
