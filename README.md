# AWS Budget Radar

A safety net for your personal AWS learning account. You set a monthly
budget. If your spending crosses it, Budget Radar does two things.

1. **Blocks new spending.** Your day-to-day AWS identity loses the ability
   to launch or start the expensive stuff (EC2, RDS, SageMaker, and so on)
   until you lift the block.
2. **Emails you a map of the damage.** You get a region-by-region list of
   everything currently running and everything still costing you money, so
   you know exactly what to go turn off.

You clone it, fill in one config file, run one deploy command, and let it
sit. It costs (almost) nothing to run.

> **Three honest limits, up front.**
>
> **It is not a hard spending cap.** AWS billing data lags 8 to 12 hours, so
> charges can pass the threshold before the alert fires and keep accruing
> after.
>
> **It never turns anything off.** Things already running keep running until
> *you* stop them. The email tells you what and where.
>
> **It only restrains the identities you list.** The root user and anything
> you didn't list are unaffected. It's a seatbelt, not a security boundary.

---

## How it works (60 seconds)

```
your budget crosses the line (AWS checks ~2-3x/day)
        │
        ▼
 AWS Budgets "action" fires ──────────────► attaches a DENY policy to your
        │                                   learning user, no new launches
        ▼                                   or starts until it's lifted
 Radar's Lambda wakes up (read-only)
        │  scans EVERY region: EC2, RDS, ECS, Lambda, SageMaker,
        │  EBS, NAT gateways, idle IPs, load balancers, S3 sizes…
        ▼
 📧 email to you with what's blocked, what's running, and what to do next
```

Two modes, set by one line of config:

- **`watch` (default)** makes the block *wait for your approval*. The email
  says "NOTHING IS BLOCKED YET" and gives you the approve command. Ignore
  it and nothing is ever blocked.
- **`armed`** applies the block automatically. The email is an
  after-action report.

The block is temporary either way. It **clears automatically when the next
budget month starts**, or sooner if you reverse it (Part 4).

---

## The whole journey at a glance

| Step | What you do | You're done when… |
|---|---|---|
| 1.1 | Create a *learning* IAM user, use it for daily work | User exists, and you work as it |
| 1.2 | (Root, once) enable Billing console access | Toggle is on, or you skip it and use the CLI |
| 1.3 | Install Node ≥ 20 + AWS CLI v2 | `node -v` and `aws sts get-caller-identity` both work |
| 2.1 | Clone + `npm install` | No errors |
| 2.2 | Fill in `.env` | Every REQUIRED field set |
| 2.3 | `npx cdk bootstrap` (once per account/region) | "Environment bootstrapped" |
| 3.1 | `npm run deploy` | "Preflight passed" then `✅ BudgetRadarStack` |
| 3.2 | Click the SNS confirmation email | `npm run verify` shows no `PendingConfirmation` |
|  | *Let it sit.* | You get an email if the budget ever trips |
| 4 | On a trip, approve / lift the block | You know both commands (they're in the email) |
| 5 | Someday, remove it | Reverse → verify detached → `cdk destroy` |

---

# Part 1. Before you start (one-time account setup)

## 1.1 Create your learning IAM user (required)

The block can only attach to IAM **users, groups, or roles**. It cannot
touch the **root user** or Identity Center/SSO sign-ins (`AWSReservedSSO_*`
roles). A brand-new AWS account often has *no IAM user at all*. If you
do your daily work as root or as your SSO admin, **the block never applies
to you and Budget Radar protects nothing.**

1. Sign in as root (or your admin) → **IAM → Users → Create user**, and
   name it e.g. `learning`.
2. On the permissions step choose **Attach policies directly** and attach
   **`AdministratorAccess`** (the simplest option, and what the club uses).
   Enable console access and/or access keys only if you need them, and keep
   the credentials private.
3. **From now on, do your normal AWS work as that user**, both console
   sign-in and `aws configure`. Radar can't verify this for you. An
   identity you don't actually use is an identity that isn't protected.
4. Keep a **separate** admin identity (root, or your SSO admin) that you do
   *not* list as a block target. That's your escape hatch. It lifts the
   block later, and it's what you'll deploy Radar as.

> Since the learning user is an admin, it *could* detach the block from
> itself. That's fine. This is accident-prevention for your own spending,
> not a lock against you.

## 1.2 Enable Billing console access (root, once, recommended)

By AWS default, IAM users **cannot open Billing/Budgets console pages**.
Even with `AdministratorAccess` they see "access denied" there until the
root user flips one switch. Sign in as root → account menu → **Account →
IAM user and role access to Billing information → Activate**.

This only gates the *console pages*. The **CLI/API is never gated**, and
every command in this README works either way, so if you skip this step,
just use the CLI commands in Part 4 instead of the console.

## 1.3 Install the tools

- **Node.js ≥ 20.** Check with `node -v`.
- **AWS CLI v2**, configured with credentials for your account.
  `aws sts get-caller-identity` should print your account number.

---

# Part 2. Install and configure

## 2.1 Clone and install

```bash
git clone https://github.com/AWS-SBG-at-the-University-of-Kentucky/AWS_Budget_Radar.git
cd AWS_Budget_Radar
npm install
cp .env.example .env
```

## 2.2 Fill in `.env`

`.env` is the only file you edit. The essentials:

| Field | What to put |
|---|---|
| `ALERT_EMAIL` | Where the alerts go. **Required.** |
| `MONTHLY_BUDGET_USD` | Your monthly line, e.g. `5`. Use `0.01` for a "tell me on the very first cent" tripwire (see the note in Part 6, where Radar's own tiny footprint can eventually trip that one). |
| `IAM_DENY_TARGET_USERS` | Your learning user from step 1.1, e.g. `learning`. **At least one target is required.** |
| `RECOVERY_PRINCIPAL_ARN` | The **full ARN** of your separate admin from step 1.1, the identity that lifts the block. Must **not** also be a target. |
| `SAFETY` | `watch` (default, block waits for your approval) or `armed` (applies automatically). **Start with `watch`.** |

Less-common fields (all explained in the comments in `.env.example`):

- `EXISTING_BUDGET_NAME` leaves Radar to **create** its own budget when
  empty (the normal path). Set it to attach to a budget you already made.
  That budget must be a monthly, USD, unfiltered **cost** budget, and the
  deploy check verifies this and refuses if it isn't.
- `IAM_DENY_TARGET_GROUPS` / `_ROLES` add more targets. Use plain names, or
  the full ARN if the identity lives under a non-root IAM path (the deploy
  check will tell you if that's the case).
- `WARN_AT_PERCENT`, `ACTION_THRESHOLD_PERCENT`, `ACTION_THRESHOLD_TYPE`,
  `SERVICE_BUDGETS` are tuning knobs, and the defaults are sensible.
- `TRACK_GROSS_USAGE` (default `true`) makes the budget count **gross usage** —
  AWS credits and refunds are excluded, so usage trips the budget even while
  promotional credits are covering your bill. This is what you want on a
  credit-covered learning account: otherwise credits net your spend down to
  ~$0.00 and the budget never fires until the credits run out. Set it to
  `false` only if you want to be alerted on real out-of-pocket dollars.
- `EXCLUDE_SERVICES` (default **empty**) is a comma-separated list of exact AWS
  service names to leave **out** of the main budget. Empty keeps the budget
  watching your **total** account cost (recommended). Setting it **scopes** the
  budget to "everything except these services", so excluded spend no longer trips
  it. The main use is excluding `AWS Cost Explorer` so the metered cost of
  *checking* your bill (~$0.01 per Cost Explorer request) can't itself trip a tiny
  tripwire — there's no runaway resource to shut down for that spend anyway. Use
  sparingly: every service you exclude is a blind spot.

## 2.3 One-time bootstrap

```bash
npx cdk bootstrap
```

This prepares your account for CDK deployments (a small S3 bucket plus
helper roles, shared by every CDK project, ~$0). It's needed **once per
account/region**, and `deploy` fails without it. It reads your `.env`, so
do 2.2 first (or run `npx cdk bootstrap --app "" aws://<account-id>/<region>`
to skip that).

---

# Part 3. Deploy

## 3.1 `npm run deploy`

```bash
npm run deploy
```

This is two things chained together, a **read-only preflight check** and,
only if it passes, the actual `cdk deploy`.

The preflight is your co-pilot. It signs nothing and changes nothing. It
verifies your `.env` against your real account and **refuses to deploy**
(with a plain-English reason) if something would bite you later: a target
that doesn't exist or is an unsupported type, a typo'd ARN, a recovery
principal that can't actually lift the block, an existing budget of the
wrong kind, or a budget that's *already* over its threshold. It also tells
you whether your current credentials (and the CDK deploy roles) are
covered by the block, so you're never surprised by who is and isn't
restrained. **If it fails, read its message, fix `.env` (or IAM), and
re-run.**

You're done when you see `Preflight passed.` followed by
`✅ BudgetRadarStack`.

> Maintainers can see [`RELEASE.md`](./RELEASE.md), which tracks the
> live-account validation status of this project and the rules for testing
> it against a real (disposable) account.

## 3.2 Confirm your email (don't skip this)

AWS now sends you an email titled **"AWS Notification - Subscription
Confirmation."** Click the link in it. **Until you do, alert emails go
nowhere** (check spam). This gates *only* email (the block itself still
works regardless), but a Radar whose emails vanish is half a Radar.

Then prove the whole thing is wired:

```bash
npm run verify -- <ReportTopicArn>   # ARN is printed at the end of the deploy
```

Read-only. It lists your alert subscriptions and flags any still
`PendingConfirmation`. Clean output means you're done. **Now let it sit.**

---

# Part 4. The day your budget trips

AWS evaluates budgets a few times a day, so the alert lands up to about
half a day after the spend itself. Here's what happens when it does.

## 4.1 You get one email

Subject: `AWS Budget Radar: budget threshold reached — action PENDING`
(in `watch` mode). Inside:

- the account, budget, threshold, and the action's **observed status**
- in `watch` mode, **"NOTHING IS BLOCKED YET"** plus the exact approve
  command. In `armed` mode, confirmation the block applied, plus the exact
  lift command.
- the region-by-region inventory of what's running, plus a **"still costing
  you money"** section (EBS volumes, NAT gateways, idle IPs, load
  balancers, S3 storage), your to-go-turn-off list

## 4.2 Decide (only in `watch` mode)

- **Do nothing** → nothing is ever blocked, and the alert resets when the
  new budget month starts.
- **Approve the block** → run the command from the email (it's
  `aws budgets execute-budget-action … --execution-type
  APPROVE_BUDGET_ACTION`), or approve in the Budgets console if you did
  step 1.2. The deny then attaches to your learning user, with no new
  launches/starts until lifted.

## 4.3 Lifting the block

The block ends one of two ways. The **next budget month starts** (it
detaches automatically, which is expected AWS behavior, not an iron
guarantee), or you **reverse it now**, as your recovery principal:

```bash
aws budgets execute-budget-action \
  --account-id <ACCOUNT_ID> --budget-name <BUDGET_NAME> --action-id <ACTION_ID> \
  --execution-type REVERSE_BUDGET_ACTION
```

(That's *reverse*, not "reset". See 4.4 before you ever press Reset.)
Reversing un-blocks launches/starts. It does **not** restart anything,
because Radar never stopped anything. A reversed action is **done for the
month**: AWS stops evaluating it and re-arms it on its own when the next
budget month starts.

**Where to find the three values** (easiest first):

1. **The alert email.** The command arrives with the values filled in.
2. **Console:** Lambda → Functions → `BudgetRadarStack-Reporter…` →
   Configuration → Environment variables. `ACCOUNT_ID`, `BUDGET_NAME`,
   `ACTION_ID` are right there.
3. **CLI:** `aws budgets describe-budget-actions-for-account
   --account-id <ACCOUNT_ID>` lists every action with its ids and status.

## 4.4 Re-arming mid-month (don't just press Reset)

**Reset** (console button, or `--execution-type RESET_BUDGET_ACTION`) puts a
reversed action back on standby *immediately*. The catch: AWS compares the
threshold against your **month-to-date** spend, which never goes down within
the month. If you're already past the threshold, the next budget refresh
(every 8-12h) sees it crossed and **fires the action again**, even if you
haven't spent another cent since. Reverse + Reset over and over just loops.

Pick one:

- **Stay unprotected until the 1st (simplest).** Reverse only, never Reset.
  AWS re-arms the action automatically when the new budget month starts.
- **Re-arm above what you've already spent.** Raise the threshold past your
  current spend first, *then* Reset. For example, if you're at 22% of the
  budget and want about $2 of headroom on a $10 budget, set
  `ACTION_THRESHOLD_PERCENT=45`, run `npm run deploy`, then Reset. Now it
  only fires on genuinely new spend. If you're already over 100%, raise
  `MONTHLY_BUDGET_USD` instead. The preflight will tell you if the new
  threshold is still at or below your current spend.

**Choosing thresholds up front:** a low automatic threshold (say 20%) is
easy to cross with incidental charges, and after that it's either tripped
or disabled for the rest of the month. Keep early warnings on
`WARN_AT_PERCENT` (email only, never blocks) and put
`ACTION_THRESHOLD_PERCENT` where you actually want the block, e.g. 80-100%.

## 4.5 Switching between `watch` and `armed`

Edit the one line in `.env`, then redeploy. That *is* the switch:

```bash
npm run deploy   # updates one property in ~30 seconds
```

|  | `watch` (default) | `armed` |
|---|---|---|
| Threshold crossed → | Goes `PENDING`, email plus approve command, waits for you | Block applies automatically, email reports it |
| If you ignore the email | Nothing blocked, resets next month | Already blocked, reverse (4.3) or wait for the reset |

The preflight holds `armed` to a higher bar. It **refuses** an armed deploy
if it can't verify your recovery route, or if the budget is *already* over
threshold (that would be lockout-by-deploy, and `watch` merely warns on
both). The recommended arc is to run `watch` through one real trip
(approve, see the block, reverse it with your own hands), and only then
consider `armed`.

---

# Part 5. Removing Budget Radar

Order matters here. `cdk destroy` deletes the budget action *before* the
deny policy, so if the block is attached when you run it, the policy can't
be deleted (IAM refuses while it's attached), **and the reverse command no
longer exists to detach it**. Do it in this order and you'll never hit that:

1. **If the block is currently applied, lift it first** (4.3), or wait for
   the month to reset it.
2. **Verify it's detached:**
   ```bash
   aws iam list-attached-user-policies --user-name <your-learning-user>
   ```
   (`list-attached-group-policies` / `list-attached-role-policies` for
   other target types.) Confirm nothing named `DenyNewSpend` is listed.
3. **Then:**
   ```bash
   npx cdk destroy
   ```

**If you skipped ahead** and destroy failed on `DeleteManagedPolicy`,
detach directly, then re-run destroy:

```bash
aws iam detach-user-policy  --user-name  <name> --policy-arn <DenyNewSpendPolicyArn>
aws iam detach-group-policy --group-name <name> --policy-arn <DenyNewSpendPolicyArn>
aws iam detach-role-policy  --role-name  <name> --policy-arn <DenyNewSpendPolicyArn>
```

Nothing ever needs restarting on uninstall, because nothing was stopped.
(`cdk destroy` with the block *never applied* is the clean case, verified
by live testing, see `RELEASE.md` item 8. The bootstrap stack, `CDKToolkit`,
is shared with other CDK projects and stays. It costs ~$0.)

---

# Part 6. Reference

## What the block does and doesn't stop

The deny is a **positive list**. Only these actions are denied, and only
for the identities you listed. Everything else they could do, they still
can.

**Denied** (creation/start only, never reads, never IAM/Budgets/
CloudFormation, never cleanup/scale-down):
`ec2:RunInstances`, `ec2:StartInstances`, `ec2:RequestSpotInstances`,
`ec2:RequestSpotFleet`, `ec2:CreateFleet`, `rds:CreateDBInstance`,
`rds:CreateDBCluster`, `rds:StartDBInstance`, `rds:StartDBCluster`,
`elasticmapreduce:RunJobFlow`, `sagemaker:CreateNotebookInstance`,
`sagemaker:StartNotebookInstance`, `sagemaker:CreateEndpoint`,
`sagemaker:CreateApp`, `sagemaker:CreateTrainingJob`, `ecs:RunTask`,
`ecs:CreateService`, `autoscaling:CreateAutoScalingGroup`,
`lambda:CreateFunction`.

Two consequences worth knowing:

- **A blocked identity can't restart its own stopped EC2/RDS** while the
  block is active. That's intended, because restarting resumes spend. It
  clears at the month reset or when you reverse.
- **Scale-downs stay allowed.** `autoscaling:UpdateAutoScalingGroup` and
  `ecs:UpdateService` (e.g. scaling to zero) are deliberately *not* denied,
  so the block never stops you from doing what its own email asks of you.

**NOT blocked** (the gaps most likely to surprise you). **EKS, Redshift,
ElastiCache, OpenSearch, and Bedrock** have none of their
create/start/invoke actions listed. Anything launched via a
**service-linked role** runs as a different principal than your user. Any
identity you didn't list is free. And the root user is never blocked.

## What the report covers and its gaps

The report **describes. It never acts.** Denied or failed scans are labeled
as failures, never passed off as "nothing found."

| Area | Reported | Note |
|---|---|---|
| EC2 (standalone / ASG) | Running instances, ASG membership | Not stopped, EBS/IP costs continue |
| RDS / Aurora | Instances and clusters | Storage/backups bill regardless |
| ECS / Fargate | Services, standalone tasks | REPLICA/DAEMON noted |
| Lambda | Functions, reserved vs provisioned concurrency | Provisioned concurrency bills separately |
| SageMaker | Notebooks, endpoints | Endpoints/Studio/jobs bill regardless |
| Storage/network | EBS, S3 sizes, NAT gateways, idle IPs, load balancers | The classic silent spenders |
| **Not scanned** | EKS control plane, OpenSearch, ElastiCache, Savings Plans/RI commitments, data transfer | Known gaps, absent from the report entirely |

## Cost of Radar itself

Near-zero, but **not guaranteed $0.00**:

| Item | Cost |
|---|---|
| The budget + action | Free (first 2 action-enabled budgets per account) |
| Lambda + SNS email | Free tier at this volume, Lambda only runs on a trip |
| CloudWatch Logs | Pennies at most, capped by 30-day retention |
| CDK bootstrap S3 | A few KB of storage, shared |

On a `0.01` tripwire, Radar's own footprint (logs, requests) can eventually
be the thing that trips it. That's the tripwire working, not a bug.

> **Watch your budget on the Budgets page, not Cost Explorer.** The Cost
> Explorer **API costs $0.01 per request**, and both the `aws ce
> get-cost-and-usage` CLI command and the console's "Cost and usage" /
> Cost Explorer widgets issue those requests. If you set a tiny tripwire
> (e.g. `$0.01`) and then anxiously refresh Cost Explorer to watch it,
> **the checking itself can be what trips the budget.** To watch spend for
> free, use **Billing → Budgets**, where your budget's "Current spend" is
> exactly what the action evaluates. The Budgets API and page are not
> billed per request.

## Troubleshooting

**Preflight refused to deploy.** That's it working. The message names the
exact problem (unknown target, bad ARN, wrong budget type, unverifiable
recovery, already-breached budget). Fix that one thing, re-run.

**Budgets/Billing console says "access denied."** You're an IAM user and
root hasn't enabled Billing access (1.2). Either flip that switch as root,
or use the CLI commands in Part 4, which are never gated.

**Breach happened but no email (after ~12h).** In order:
1. `npm run verify -- <ReportTopicArn>`. An unconfirmed subscription is
   the #1 cause, so click the confirmation email.
2. Check the **`ReporterFailures` SQS queue** (SQS console → the queue
   containing `ReporterFailures` → *Send and receive messages* → *Poll*).
   A message there means the reporter ran and failed, and the body says why.
3. Check the reporter's **CloudWatch Logs** (Lambda console → the
   `BudgetRadarStack-Reporter…` function → Monitor → Logs) to see whether
   it ran at all.

**The block keeps re-applying after I lift it.** You pressed Reset (or ran
`RESET_BUDGET_ACTION`) while month-to-date spend was still over the
threshold, so the next refresh fired it again. Reverse only, or raise the
threshold above current spend before resetting (4.4).

**`cdk destroy` failed on `DeleteManagedPolicy`.** The block was still
attached. Use the manual detach commands in Part 5, then re-run destroy.

**Who exactly is covered?** The preflight's deploy output lists every
resolved target, whether *your* current credentials are covered, and
whether the CDK deploy roles are. Nothing is guessed, and "unknown" is
printed when it can't be determined.
