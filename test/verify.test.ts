import { runVerify, VerifyDeps, RawSubscription } from "../verify";

function deps(subs: RawSubscription[]): VerifyDeps {
  return { listSubscriptionsByTopic: async () => subs };
}

test("F11: flags a PendingConfirmation subscription and tells the user to check email", async () => {
  const r = await runVerify("arn:aws:sns:us-east-1:111122223333:Report", deps([
    { SubscriptionArn: "PendingConfirmation", Protocol: "email", Endpoint: "a@b.edu" }
  ]));
  expect(r.ok).toBe(false);
  const text = r.messages.join("\n");
  expect(text).toMatch(/pending confirmation/i);
  expect(text).toMatch(/confirmation email/i);
});

test("F11: all subscriptions confirmed passes cleanly", async () => {
  const r = await runVerify("arn:aws:sns:us-east-1:111122223333:Report", deps([
    { SubscriptionArn: "arn:aws:sns:us-east-1:111122223333:Report:abcd", Protocol: "email", Endpoint: "a@b.edu" }
  ]));
  expect(r.ok).toBe(true);
  expect(r.messages.join("\n")).toMatch(/confirmed/i);
});

test("F11: zero subscriptions is flagged, not silently passed", async () => {
  const r = await runVerify("arn:aws:sns:us-east-1:111122223333:Report", deps([]));
  expect(r.ok).toBe(false);
  expect(r.messages.join("\n")).toMatch(/no subscriptions/i);
});

test("F11: reports a mix of confirmed and pending subscriptions individually", async () => {
  const r = await runVerify("arn:aws:sns:us-east-1:111122223333:Report", deps([
    { SubscriptionArn: "arn:aws:sns:us-east-1:111122223333:Report:abcd", Protocol: "email", Endpoint: "confirmed@b.edu" },
    { SubscriptionArn: "PendingConfirmation", Protocol: "email", Endpoint: "pending@b.edu" }
  ]));
  expect(r.ok).toBe(false);
  const text = r.messages.join("\n");
  expect(text).toMatch(/confirmed@b\.edu.*confirmed/is);
  expect(text).toMatch(/pending@b\.edu.*pending confirmation/is);
});
