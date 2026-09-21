// F11: a small, read-only post-deploy check for the unmitigated "report
// never arrives" failure mode. It never touches the deny policy, budgets,
// or IAM — it only lists the report topic's SNS subscriptions and flags any
// still `PendingConfirmation`, since an unconfirmed email subscription
// receives nothing even though the deny/inventory pipeline is working fine.
//
// Deps are injected (see VerifyDeps) so this is fully testable with fakes;
// the real AWS-backed implementation lives in the require.main block below,
// mirroring preflight.ts's pattern. Never imported by the CDK app (bin/lib),
// so synth stays credential-free.

export interface RawSubscription {
  SubscriptionArn?: string;
  Protocol?: string;
  Endpoint?: string;
}

export interface VerifyDeps {
  listSubscriptionsByTopic(topicArn: string): Promise<RawSubscription[]>;
}

export interface VerifyResult { ok: boolean; messages: string[]; }

export async function runVerify(topicArn: string, deps: VerifyDeps): Promise<VerifyResult> {
  const messages: string[] = [];
  let ok = true;

  const subs = await deps.listSubscriptionsByTopic(topicArn);
  messages.push(`Report topic ${topicArn} has ${subs.length} subscription(s).`);

  const pending = subs.filter(s => s.SubscriptionArn === "PendingConfirmation");
  for (const s of subs) {
    const status = s.SubscriptionArn === "PendingConfirmation" ? "PENDING CONFIRMATION" : "confirmed";
    messages.push(`  - ${s.Protocol ?? "unknown"} ${s.Endpoint ?? "unknown"}: ${status}`);
  }

  if (subs.length === 0) {
    ok = false;
    messages.push(
      "WARNING: no subscriptions on the report topic — no email (or anything else) will ever receive a report. " +
      "Check ALERT_EMAIL and that the stack deployed cleanly."
    );
  } else if (pending.length > 0) {
    ok = false;
    messages.push(
      `WARNING: ${pending.length} subscription(s) are still PendingConfirmation — click the SNS confirmation ` +
      "email to start receiving reports. Until then, this endpoint receives nothing even though the deny/" +
      "inventory pipeline works fine."
    );
  } else {
    messages.push("All subscriptions confirmed.");
  }

  return { ok, messages };
}

// Runs only when invoked directly (npm run verify). Never imported by the
// CDK app, so synth stays credential-free.
if (require.main === module) {
  (async () => {
    require("dotenv/config");
    const topicArn = process.argv[2] || process.env.REPORT_TOPIC_ARN;
    if (!topicArn) {
      console.error(
        "Usage: npm run verify -- <ReportTopicArn>  (or set REPORT_TOPIC_ARN in the environment/.env — " +
        "the ARN is printed as a stack output after `cdk deploy`)."
      );
      process.exit(1);
    }

    const { SNSClient, ListSubscriptionsByTopicCommand } = await import("@aws-sdk/client-sns");
    const sns = new SNSClient({});

    const deps: VerifyDeps = {
      listSubscriptionsByTopic: async (arn) => {
        const subs: RawSubscription[] = [];
        let token: string | undefined;
        do {
          const r = await sns.send(new ListSubscriptionsByTopicCommand({ TopicArn: arn, NextToken: token }));
          subs.push(...(r.Subscriptions ?? []));
          token = r.NextToken;
        } while (token);
        return subs;
      }
    };

    const result = await runVerify(topicArn, deps);
    for (const m of result.messages) console.log(m);
    if (!result.ok) process.exit(1);
  })();
}
