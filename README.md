# AWS Budget Radar

A clone-and-deploy CDK stack that watches a personal AWS learning account's
spend and, when a budget is breached, restricts further creation/start
activity by the identities you configure and emails you a region-wide
inventory of what's running — so you can investigate and shut things down
yourself.

## 1. What it is / is not

Budget Radar is a **low-cost safeguard for personal learning accounts.** When
a cost budget is breached, it **restricts selected creation and start
operations by the IAM identities you configure** and **emails you a
region-wide inventory of what is running and what is still costing money**,
so you can investigate and shut things down yourself.

It is **not a hard spending cap.** AWS budget data lags actual usage by
hours (up to 8-12h between refreshes); charges can exceed the threshold
before the alert arrives and continue after. Unsupported services, storage,
networking, commitments, and identities outside the configured set (and the
root user, always) can keep incurring charges. **Budget Radar never stops,
scales, or deletes any resource** — remediation is yours, informed by the
report.

Because the deny includes `ec2:StartInstances` and `rds:StartDBInstance`, a
**targeted identity cannot restart its own stopped EC2/RDS instances while
the block is active.** This is intended, not a bug: it clears automatically
at the next budget period, or sooner if your recovery principal reverses the
action.

The deny is **accident-prevention for the identities you configure — it is
not a security boundary.** The root user ignores it entirely, and any
identity you didn't list is unaffected. Use a dedicated learning IAM
user/role for your day-to-day work, list *that* as the deny target, and keep
your recovery/admin principal separate from it.

## 2. Prerequisites

- Node.js **>= 20**
- AWS CLI v2, configured with credentials for the target account
- An **IAM user or role** to run this as (not the root user) — this is also
  the identity you'll typically list in `IAM_DENY_TARGET_USERS`/`_ROLES`

## 3. Setup

```bash
git clone <this-repo-url>
cd AWS_Budget_Radar
npm install
cp .env.example .env
```

Edit `.env`:

- `ALERT_EMAIL` — where the inventory report and warnings go.
- `EXISTING_BUDGET_NAME` — leave empty to have Radar create a monthly USD
  cost budget (Path B), or set it to attach to a budget you already made
  (Path A). An existing budget must be a monthly, USD, unscoped **cost**
  budget — the preflight checks this and fails closed if it isn't.
- `MONTHLY_BUDGET_USD` — only used when creating a budget. Set to `0.01` if
  you want a tripwire on the very first charge.
- `IAM_DENY_TARGET_USERS`/`_GROUPS`/`_ROLES` — at least one is required. Use
  names or full ARNs; if an identity lives under a non-root IAM path, you
  must use its full ARN (the preflight rejects a bare name in that case).
- `RECOVERY_PRINCIPAL_ARN` — a full ARN for a principal that can reverse the
  action later. It must not also be a deny target.
- `SAFETY` — `watch` (default) waits for your console approval before
  applying the deny; `armed` applies it automatically.

See the comments in `.env.example` for every field.

## 4. One-time bootstrap

```bash
npx cdk bootstrap
```

Needed once per AWS account/region. `cdk deploy` fails without it.

## 5. Deploy

```bash
npm run deploy
```

This runs the read-only `preflight.ts` check first (resolves your configured
identities, confirms your own credentials' coverage, validates any existing
budget, checks the recovery principal, rejects unsupported targets like
`AWSReservedSSO_*` roles) and only calls `cdk deploy` if it passes. If the
preflight fails, fix `.env` (or your IAM setup) and re-run.

**After deploy, check your email and click the SNS subscription confirmation
link.** Until you confirm, the email endpoint receives nothing — this is an
SNS requirement, and it only affects the email subscription. The Lambda
report subscription is auto-confirmed, and the IAM deny action still fires
on breach regardless of whether you've confirmed email.

## 6. What happens on breach

When your budget crosses the configured action threshold:

- **`SAFETY=watch`**: you get the inventory email, and the deny is
  **pending your approval** in the Budgets console. Nothing is blocked
  until you approve it there.
- **`SAFETY=armed`**: the deny is **applied automatically**, and you get the
  inventory email.

The inventory email reports the observed action status, the account and
budget, and a best-effort region-wide scan: running EC2/ASG, RDS/Aurora,
ECS, Lambda, SageMaker, plus a "still costing you money" section (EBS, NAT
gateways, unattached EIPs, load balancers, S3 storage size). A failed or
denied read is reported as failed — never shown as "nothing found."

## 7. Lifting the block

Once the deny is applied (whether via `watch` approval or `armed` auto-apply),
it stays attached until one of:

- Your **recovery principal** reverses the budget action / detaches the
  policy in the AWS Budgets console, or
- The **next budget period starts** — the deny detaches automatically
  (expected AWS Budgets behavior, not an absolute guarantee).

Reversing the action does not restart anything Radar stopped, because Radar
never stops anything — it only unblocks the targeted identities' creation
and start operations again.

## 8. Teardown

```bash
npx cdk destroy
```

A managed IAM policy cannot be deleted while still attached. **If the deny
is currently applied**, first reverse the budget action (via your recovery
principal or the console) or wait for the period reset, and verify the
policy is detached — *then* run `cdk destroy`. No resource restart is ever
needed to uninstall, because nothing was stopped in the first place. Whether
`cdk destroy` alone cleanly detaches and deletes everything is confirmed by
live testing, not guaranteed by this doc.

## 9. Limitations / coverage gaps

The inventory report **describes; it does not act.** It reports what it can
detect and clearly labels what it can't — treat it as a starting point for
investigation, not a full bill assessment.

| Area | Reported | Note |
|---|---|---|
| EC2 (standalone / ASG) | Running instances, ASG membership | Not stopped; EBS/addressing costs continue |
| RDS / Aurora | Instances and clusters | Aurora is a cluster; storage/backups bill regardless |
| ECS / Fargate | Services, standalone tasks | REPLICA/DAEMON distinguished in text |
| Lambda | Functions; reserved vs provisioned concurrency | Provisioned concurrency bills separately |
| SageMaker | Notebooks, endpoints | Endpoints/Studio/jobs bill regardless |
| Storage/network | EBS, S3 size class, NAT GW, EIP, LB | Common silent spend |
| Not enumerated | EKS control plane, OpenSearch, ElastiCache, commitments/SP/RI, data transfer | Known gaps — not in the report at all |

Other things worth knowing:

- A workload that's already running when the breach happens **keeps
  running** until you act — Radar's report tells you it's there, it doesn't
  turn it off.
- The deny only covers the identities you list. Any other identity — and
  the root user, always — is unaffected.

## 10. Cost

Designed to be near-zero cost for typical learning-account usage —
**not guaranteed $0.**

| Item | Cost |
|---|---|
| One action-enabled budget | Free (first 2 per account) |
| Optional per-service budgets | Free (no actions attached) |
| Lambda, SNS email | Free tier for this volume |
| CloudWatch Logs | Small; bounded by 30-day retention |
| CDK bootstrap S3 assets | Small shared storage cost |

If you set `MONTHLY_BUDGET_USD=0.01` as a first-charge tripwire, note that
**Radar's own small footprint (Lambda invocations, CloudWatch Logs, SNS)
could itself be enough to trip that budget.**
