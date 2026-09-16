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
- **A dedicated IAM user for your day-to-day learning work — required.**
  The block only attaches to IAM **users, groups, or roles**. It cannot
  target the **root user** or IAM Identity Center / SSO roles
  (`AWSReservedSSO_*`). A brand-new account often has **no IAM user at all**
  — and if you keep doing your work as root or as your SSO admin, the deny
  never applies to *you* and Budget Radar protects nothing. Before you
  continue:
  1. Sign in as root (or your admin) and open **IAM → Users → Create user**
     (for example `learning`). On the permissions step choose **Attach
     policies directly** and attach **`AdministratorAccess`** — that's the
     simplest option and it's what the club uses. Console access and access
     keys are optional; turn them on only if you need them, and keep the
     credentials private. (Because the user is an admin it *could* detach
     the deny policy itself — the block is accident-prevention for your own
     spending, not a security boundary against you.)
  2. From now on, do your normal AWS work **as that user** (console and
     `aws configure`). Radar can't check this for you — an identity you
     don't actually use is an identity that isn't protected.
  3. In step 3 you'll put that user's name in `IAM_DENY_TARGET_USERS`.
  4. Keep a **separate** admin identity (root, or your SSO admin role) that
     is **not** a deny target. That is your `RECOVERY_PRINCIPAL_ARN` and the
     identity you run `npm run deploy` as — it must be able to lift the block
     after the learning user is denied.
- **The account root must enable "IAM user and role access to Billing
  information" once**, in the root's Billing console under **Account →
  IAM access**. This is an AWS default: it is **OFF** for a brand-new
  account, and while it's off, an IAM user/role — no matter what IAM
  policies it holds — sees an access-denied page for the Budgets/Billing
  **console** (budget details, the action approval screen, etc.). This
  setting does not gate the **AWS CLI/API** — `aws budgets describe-budget`,
  `execute-budget-action`, and everything Budget Radar itself uses work
  either way. Enable it once as root if you (or anyone you list as a deny
  target) plan to use the Budgets *console* to approve/reverse an action —
  otherwise use the CLI commands in §7 instead.

## 3. Setup

```bash
git clone https://github.com/AWS-SBG-at-the-University-of-Kentucky/AWS_Budget_Radar.git
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
- `IAM_DENY_TARGET_USERS`/`_GROUPS`/`_ROLES` — at least one is required.
  Put the dedicated learning user from §2 here (e.g. `learning`). Use
  names or full ARNs; if an identity lives under a non-root IAM path, you
  must use its full ARN (the preflight rejects a bare name in that case).
- `RECOVERY_PRINCIPAL_ARN` — a full ARN for a principal that can reverse the
  action later. It must not also be a deny target.
- `SAFETY` — `watch` (default) waits for your console approval before
  applying the deny; `armed` applies it automatically.

See the comments in `.env.example` for every field.

## 4. One-time bootstrap

> `cdk bootstrap` synthesizes the app first, so do §3 (fill in `.env`)
> before this step. If you want to bootstrap before `.env` exists, run it
> app-independent: `npx cdk bootstrap --app "" aws://<account-id>/<region>`.

```bash
npx cdk bootstrap
```

Needed once per AWS account/region. `cdk deploy` fails without it.

## 5. Deploy

> **Before you deploy: read [`RELEASE.md`](./RELEASE.md).** This project has
> passing unit tests but has **not yet completed live-account validation** —
> `RELEASE.md` tracks that outstanding status and the authorization boundary
> for running it against a real (disposable) AWS account.

```bash
npm run deploy
```

This runs the read-only `preflight.ts` check first (resolves your configured
identities, checks whether your own credentials are covered (and warns if
not), validates any existing budget, checks the recovery principal, rejects
unsupported targets like `AWSReservedSSO_*` roles) and only calls
`cdk deploy` if it passes. If the preflight fails, fix `.env` (or your IAM
setup) and re-run.

The preflight also reports whether the CDK bootstrap deploy role and the
CloudFormation execution role — the real, predictable
`cdk-hnb659fds-deploy-role-<account>-<region>` /
`cdk-hnb659fds-cfn-exec-role-<account>-<region>` names from the default CDK
bootstrap — are covered, uncovered, or unknown, since deploy-time actions
run under those roles rather than your own credentials. This is computed by
actually comparing your resolved deny targets against those two role ARNs,
not just printed as a static caveat; the region comes from `AWS_REGION` /
`CDK_DEFAULT_REGION`, and coverage is reported as "unknown" (never guessed)
if neither is set.

Run `npm run verify` after your first successful deploy (see §5.1) — it's a
read-only check that catches the most common "the email never arrived"
failure mode before you find out the hard way, mid-breach.

### 5.1 Post-deploy verification

```bash
npm run verify -- <ReportTopicArn>
```

The `ReportTopicArn` is printed as a CloudFormation stack output after
`cdk deploy`. This is a **read-only** script — it never touches the deny
policy, budgets, or IAM. It lists the report topic's SNS subscriptions and
flags any still `PendingConfirmation`, printing a reminder to click the SNS
confirmation email. Run it any time you suspect reports aren't arriving.

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

**A budget that is already at or over the action threshold when you
deploy** — on both Path A (an existing budget) and Path B (Radar creates
one) — will fire within hours of deploy, at the next AWS Budgets data
refresh, rather than acting as a forward-looking tripwire. For Path A, the
preflight compares the budget's current `CalculatedSpend.ActualSpend`
against the effective threshold and warns loudly (or fails closed under
`SAFETY=armed`) if it's already crossed. For Path B, there is no spend to
check yet at preflight time — a brand-new budget with `MONTHLY_BUDGET_USD`
set very low (e.g. the `0.01` tripwire) can still cross its own threshold
almost immediately once real usage (including Radar's own footprint, see
§11) starts accruing.

## 7. Lifting the block

Once the deny is applied (whether via `watch` approval or `armed` auto-apply),
it stays attached until one of:

- Your **recovery principal** reverses the budget action (`REVERSE_BUDGET_ACTION`
  — not "reset", which is a different, unrelated action state), either via
  the AWS Budgets console or the CLI below, or
- The **next budget period starts** — the deny detaches automatically
  (expected AWS Budgets behavior, not an absolute guarantee).

Reversing the action does not restart anything Radar stopped, because Radar
never stops anything — it only unblocks the targeted identities' creation
and start operations again.

**The Budgets console page for this requires the account root to have
enabled "IAM user and role access to Billing information" (§2) — if that
hasn't been done, use the AWS CLI instead, which is never gated by that
setting.** As the recovery principal (`RECOVERY_PRINCIPAL_ARN`), run:

```bash
aws budgets execute-budget-action \
  --account-id <ACCOUNT_ID> --budget-name <BUDGET_NAME> --action-id <ACTION_ID> \
  --execution-type REVERSE_BUDGET_ACTION
```

`<ACCOUNT_ID>`, `<BUDGET_NAME>`, and `<ACTION_ID>` are the same identifiers
the reporter Lambda has (its `ACCOUNT_ID`/`BUDGET_NAME`/`ACTION_ID`
environment variables) and are echoed in every inventory email's recovery
line — copy them from there, or from the Budgets console/CLI
(`aws budgets describe-budget-action ...`).

If you're running `SAFETY=watch` and the action is `PENDING` your console
approval, and you want to apply the deny **now** rather than waiting for the
console, run the same command with `--execution-type APPROVE_BUDGET_ACTION`
instead. Every inventory email's call-to-action line spells out whichever of
these two applies to the currently observed status.

## 8. Teardown

**`cdk destroy` deletes resources in an order that can lock you out if the
deny is still attached when you run it.** Specifically, `cdk destroy`
deletes the `BudgetsAction` resource *before* the managed deny policy. If
the deny policy is still attached to a target identity at that point,
`DeleteManagedPolicy` fails (a managed policy cannot be deleted while
attached) — and because the BudgetsAction is already gone,
`budgets:ExecuteBudgetAction` no longer has anything to reverse. **Only
`iam:Detach{User,Group,Role}Policy` can free the identity at that point.**
This is exactly why the preflight (§5) treats a recovery route that relies
*only* on `budgets:ExecuteBudgetAction` (and not on a direct IAM detach
permission) as insufficient for safe teardown — see §5's recovery-route
warning/failure.

**Mandatory order before running `cdk destroy`:**

1. **If the deny is currently applied**, reverse the budget action first —
   via your recovery principal, using the CLI in §7 (or the console, if
   Billing IAM access is enabled) — or wait for the budget period to reset it
   automatically.
2. **Verify the deny policy is actually detached** from every target
   identity before proceeding — e.g.
   `aws iam list-attached-user-policies --user-name <name>` (or
   `list-attached-group-policies` / `list-attached-role-policies`) and
   confirm `DenyNewSpend` is not in the list.
3. **Only then** run `cdk destroy`.

**Manual fallback** if `cdk destroy` fails with a `DeleteManagedPolicy`
error because the policy is still attached (e.g. you skipped step 1/2, or a
race left it attached), detach it directly and re-run `cdk destroy`:

```bash
aws iam detach-user-policy  --user-name  <name> --policy-arn <DenyNewSpendPolicyArn>
aws iam detach-group-policy --group-name <name> --policy-arn <DenyNewSpendPolicyArn>
aws iam detach-role-policy  --role-name  <name> --policy-arn <DenyNewSpendPolicyArn>
```

Use whichever of the three matches how the identity is targeted
(`IAM_DENY_TARGET_USERS`/`_GROUPS`/`_ROLES`). No resource restart is ever
needed to uninstall, because nothing was stopped in the first place.

Whether `cdk destroy` alone cleanly detaches and deletes everything **when
the deny was never applied** is confirmed by live testing (see
`RELEASE.md` item 8), not guaranteed by this doc — the ordering risk above
applies specifically to the "deny currently applied/attached" case.

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
- **If no report email arrives within ~12h of a breach** (the outer bound of
  AWS Budgets' data-refresh lag), check two things: the **`ReporterFailures`
  SQS queue** (physical name contains `ReporterFailures` — the Lambda's
  async-invoke failure destination; a message there means the reporter ran
  and failed, e.g. a publish error) and the **Reporter Lambda's CloudWatch
  Logs group** (`/aws/lambda/<the Reporter function's name>`, visible from
  the function's console page or `aws logs describe-log-groups`) for
  whether the Lambda ran at all and what it logged. Also run `npm run
  verify` (§5.1) to rule out an unconfirmed SNS subscription.

## 10. What the deny does and does not block

The deny (`lib/deny-policy.ts`) is a **positive list** — only the actions
below are denied, scoped to the identities you configure. Everything else
those identities can already do, they can still do.

**Denied** (creation/start actions only — never a read, never IAM/Budgets/
CloudFormation, never a cleanup/scale-down action):

`ec2:RunInstances`, `ec2:StartInstances`, `ec2:RequestSpotInstances`,
`ec2:RequestSpotFleet`, `ec2:CreateFleet`, `rds:CreateDBInstance`,
`rds:CreateDBCluster`, `rds:StartDBInstance`, `rds:StartDBCluster`,
`elasticmapreduce:RunJobFlow`, `sagemaker:CreateNotebookInstance`,
`sagemaker:StartNotebookInstance`, `sagemaker:CreateEndpoint`,
`sagemaker:CreateApp`, `sagemaker:CreateTrainingJob`, `ecs:RunTask`,
`ecs:CreateService`, `autoscaling:CreateAutoScalingGroup`,
`lambda:CreateFunction`.

**Explicitly NOT blocked** (not exhaustive, but the gaps most likely to
surprise you):

- **EKS**, **Redshift**, **ElastiCache**, **OpenSearch**, and **Bedrock** —
  none of their create/start/invoke actions are in the deny list. A covered
  identity can still create an EKS cluster, a Redshift cluster, an
  ElastiCache cluster, an OpenSearch domain, or run Bedrock inference.
- **Anything launched via a service-linked role** rather than the covered
  identity's own credentials — the deny is scoped to the IAM
  users/groups/roles you list; a service acting through its own
  service-linked role is a different principal and is unaffected.
- **`autoscaling:UpdateAutoScalingGroup`** (e.g. scaling desired capacity to
  0) and **`ecs:UpdateService`** (e.g. scaling desired count to 0) are
  **deliberately not denied** — scaling to zero is a cost-reducing cleanup
  action, and Radar never blocks the thing you'd want to do in response to
  its own report.
- Any identity you didn't list, and the root user, always (see §1/§9).

## 11. Cost

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
