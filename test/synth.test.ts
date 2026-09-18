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
