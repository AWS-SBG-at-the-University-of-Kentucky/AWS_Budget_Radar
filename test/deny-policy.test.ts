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

test("policy document is a single Deny statement, never wildcard", () => {
  const doc = denyPolicyDocument();
  expect(doc.Statement).toHaveLength(1);
  expect(doc.Statement[0].Effect).toBe("Deny");
  expect(doc.Statement[0].Action).not.toContain("*");
});
