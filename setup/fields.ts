// What the setup page shows for each .env key: a plain-English label, help
// text, and input type. Validation is NOT here: the page runs the real
// loadConfig() (lib/config.ts) so there is one source of truth. The tests in
// test/setup-fields.test.ts keep this file in step with .env.example and
// loadConfig (every key covered, "required" flags truthful).

export type FieldType = "email" | "money" | "percent" | "hour" | "choice" | "toggle" | "list" | "text" | "arn";

export interface FieldOption { value: string; label: string; help: string; }

export interface Field {
  key: string;
  section: string;
  label: string;
  help: string;
  type: FieldType;
  // Leaving it blank fails loadConfig (in the minimal Path B setup).
  required?: boolean;
  placeholder?: string;
  options?: FieldOption[];
  presets?: string[];
  // The .env.example value is an illustration (e.g. "your-iam-username"),
  // not a usable default, so the page shows it as empty until filled in.
  exampleOnly?: boolean;
  // README heading anchor for a "Learn more" link.
  readme?: string;
  // Only matters while this toggle is on (the page dims it otherwise).
  dependsOn?: string;
}

// `short` is the name in the page's progress checklist.
export interface Section { id: string; title: string; short: string; intro?: string; advanced?: boolean; }

export const SECTIONS: Section[] = [
  { id: "alerts", title: "Where should alerts go?", short: "Alert email" },
  { id: "budget", title: "How much can you spend each month?", short: "Monthly budget" },
  {
    id: "block", title: "Who gets blocked when you go over?", short: "Who gets blocked",
    intro: "The identity you use for everyday AWS work. When the budget trips, it loses the ability to launch or start expensive things until the block is lifted."
  },
  {
    id: "recovery", title: "Who can lift the block?", short: "Recovery admin",
    intro: "A separate admin that is never blocked. It's what you deploy Radar as, and what lifts the block later."
  },
  { id: "safety", title: "Should the block wait for your OK?", short: "Safety mode" },
  { id: "digest", title: "Want a daily \"what's running\" email?", short: "Daily digest" },
  { id: "budget-tuning", title: "Budget tuning", short: "Budget tuning", advanced: true },
  { id: "more-targets", title: "More identities to block", short: "More targets", advanced: true },
  { id: "services", title: "Per-service budgets", short: "Services", advanced: true },
  { id: "stop", title: "Stop specific instances", short: "Stop instances", advanced: true }
];

export const FIELDS: Field[] = [
  {
    key: "ALERT_EMAIL", section: "alerts", type: "email", required: true,
    label: "Alert email",
    help: "Alerts and the \"what's still running\" report go here. After you deploy, AWS emails this address a confirmation link: click it, or no alerts arrive.",
    placeholder: "you@example.com", readme: "32-confirm-your-email-dont-skip-this"
  },
  {
    key: "MONTHLY_BUDGET_USD", section: "budget", type: "money", required: true,
    label: "Monthly budget (USD)",
    help: "When this month's AWS spending crosses this amount, Radar blocks new spending and emails you. Use 0.01 to hear about the very first cent.",
    presets: ["0.01", "5", "10", "25"]
  },
  {
    key: "IAM_DENY_TARGET_USERS", section: "block", type: "list", required: true, exampleOnly: true,
    label: "IAM user(s) to block",
    help: "Your everyday IAM user, e.g. learning. Root and SSO sign-ins can't be blocked, so if you work as one of those, create an IAM user first. Separate several with commas.",
    placeholder: "learning", readme: "11-create-your-learning-iam-user-required"
  },
  {
    key: "RECOVERY_PRINCIPAL_ARN", section: "recovery", type: "arn", required: true, exampleOnly: true,
    label: "Recovery admin ARN",
    help: "The full ARN of your separate admin user or role. It must not be one of the identities blocked above.",
    placeholder: "arn:aws:iam::123456789012:role/YourAdminRole", readme: "11-create-your-learning-iam-user-required"
  },
  {
    key: "SAFETY", section: "safety", type: "choice", required: true,
    label: "Safety mode",
    help: "You can switch later by changing this and deploying again.",
    options: [
      { value: "watch", label: "Watch (start here)", help: "You get an email and the block waits for your approval. Nothing is blocked until you say so." },
      { value: "armed", label: "Armed", help: "The block applies automatically the moment the budget trips. The email is an after-action report." }
    ],
    readme: "45-switching-between-watch-and-armed"
  },
  {
    key: "DAILY_DIGEST", section: "digest", type: "toggle",
    label: "Email me a daily \"what's still running\" digest",
    help: "A live, read-only scan of every region, sent once a day even on quiet days. Billing data lags up to a day, so this can catch a forgotten notebook first.",
    readme: "the-daily-digest"
  },
  {
    key: "DAILY_DIGEST_HOUR_UTC", section: "digest", type: "hour",
    label: "Send it at (UTC hour, 0-23)",
    help: "UTC, with no daylight-saving adjustment.", dependsOn: "DAILY_DIGEST"
  },
  {
    key: "EXISTING_BUDGET_NAME", section: "budget-tuning", type: "text",
    label: "Attach to a budget you already made",
    help: "Leave empty and Radar creates its own budget (the normal path). If you set a name, it must be a monthly USD cost budget with no filters. Radar never changes it, and the monthly budget above is ignored.",
    placeholder: "My Monthly Budget"
  },
  {
    key: "WARN_AT_PERCENT", section: "budget-tuning", type: "percent", required: true,
    label: "Early-warning email at (% of budget)",
    help: "An extra heads-up email, 1-99. Email only, it never blocks. Only on the budget Radar creates."
  },
  {
    key: "ACTION_THRESHOLD_PERCENT", section: "budget-tuning", type: "percent", required: true,
    label: "Block at (% of budget)",
    help: "When the block fires, 1-100. 100 means at the full monthly amount."
  },
  {
    key: "ACTION_THRESHOLD_TYPE", section: "budget-tuning", type: "choice", required: true,
    label: "Measure against",
    help: "What the block threshold compares to.",
    options: [
      { value: "ACTUAL", label: "Actual spend", help: "What you've really spent so far this month." },
      { value: "FORECASTED", label: "Forecasted spend", help: "AWS's month-end forecast. Fires earlier, but needs about 5 weeks of billing history." }
    ]
  },
  {
    key: "TRACK_GROSS_USAGE", section: "budget-tuning", type: "toggle",
    label: "Count usage even when credits pay for it",
    help: "Recommended if you have AWS promotional credits. Turned off, credits net your spending to about $0.00 and the budget never trips until they run out."
  },
  {
    key: "IAM_DENY_TARGET_GROUPS", section: "more-targets", type: "list",
    label: "IAM groups to block",
    help: "Every user in these groups is blocked. Plain names, or full ARNs for groups under a custom IAM path."
  },
  {
    key: "IAM_DENY_TARGET_ROLES", section: "more-targets", type: "list",
    label: "IAM roles to block",
    help: "Plain names, or full ARNs for roles under a custom IAM path. Identity Center (SSO) roles can't be blocked."
  },
  {
    key: "SERVICE_BUDGETS", section: "services", type: "list",
    label: "Warn-only budgets for single services",
    help: "Extra warning emails per service, never blocking. Exact AWS service name, a colon, then the USD limit.",
    placeholder: "Amazon SageMaker:10"
  },
  {
    key: "EXCLUDE_SERVICES", section: "services", type: "list",
    label: "Services to leave out of the main budget",
    help: "Usually empty, so the budget watches your total cost. Each service listed becomes a blind spot. The common use is AWS Cost Explorer, so checking your bill can't trip a tiny budget.",
    placeholder: "AWS Cost Explorer"
  },
  {
    key: "STOP_EC2_INSTANCES", section: "stop", type: "list",
    label: "EC2 instances to stop",
    help: "Instance IDs AWS should stop (never terminate) when the block fires. For another region, prefix it, e.g. us-west-2:i-0123456789abcdef0. Not for Auto Scaling or instance-store instances.",
    placeholder: "i-0123456789abcdef0", readme: "46-optional-stop-specific-instances-too"
  },
  {
    key: "STOP_RDS_INSTANCES", section: "stop", type: "list",
    label: "RDS databases to stop",
    help: "DB instance identifiers to stop when the block fires. Not for Aurora or read replicas. AWS restarts a stopped database after 7 days.",
    placeholder: "practice-db", readme: "46-optional-stop-specific-instances-too"
  }
];

// loadConfig throws one message at a time. Most name the .env key; the
// longest match wins so DAILY_DIGEST_HOUR_UTC beats DAILY_DIGEST.
export function fieldForError(message: string): string | undefined {
  const named = FIELDS.map(f => f.key)
    .filter(k => message.includes(k))
    .sort((a, b) => b.length - a.length)[0];
  if (named) return named;
  if (/recovery principal/i.test(message)) return "RECOVERY_PRINCIPAL_ARN";
  if (/deny target/i.test(message)) return "IAM_DENY_TARGET_USERS";
  return undefined;
}
