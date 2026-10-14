# Budget Radar reference

The [README](../README.md) gets you set up. This page has the details.

- [How it works](#how-it-works)
- [Watch vs. armed](#watch-vs-armed)
- [Settings](#settings)
- [Deploy details](#deploy-details)
- [When your budget trips](#when-your-budget-trips)
- [Re-arming mid-month (don't just press Reset)](#re-arming-mid-month-dont-just-press-reset)
- [Stopping specific instances](#stopping-specific-instances)
- [What the block does and doesn't stop](#what-the-block-does-and-doesnt-stop)
- [The daily digest](#the-daily-digest)
- [What the report covers](#what-the-report-covers)
- [Cost of Radar itself](#cost-of-radar-itself)
- [Troubleshooting](#troubleshooting)
- [AWS references and fine print](#aws-references-and-fine-print)

## How it works

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

Optionally, the same threshold can also **stop specific EC2/RDS instances**
you list. AWS Budgets does that itself by running AWS's own stop runbooks, so
they're stopped, never terminated (see
[Stopping specific instances](#stopping-specific-instances)).

Separately, once a day, if you turn on the daily digest:

```
EventBridge schedule (DAILY_DIGEST_HOUR_UTC, default 13:00 UTC)
        │
        ▼
 Radar's digest Lambda (read-only) scans the same regions and services
        │
        ▼
 📧 email every day when DAILY_DIGEST=true, including empty/incomplete scans
```

The block is temporary. It **clears automatically when the next budget month
starts**, or sooner if you [reverse it](#lifting-the-block).

## Watch vs. armed

Set by `SAFETY` in `.env` (Safety mode on the setup page):

- **`watch` (default)** makes the block *wait for your approval*. The email
  says "NOTHING IS BLOCKED YET" and gives you the approve command. Ignore it
  and nothing is ever blocked.
- **`armed`** applies the block automatically. The email is an after-action
  report.

|  | `watch` (default) | `armed` |
|---|---|---|
| Threshold crossed → | Goes `PENDING`, email plus approve command, waits for you | Block applies automatically, email reports it |
| If you ignore the email | Nothing blocked, resets next month | Already blocked, [reverse it](#lifting-the-block) or wait for the reset |

To switch, change the setting and run `npm run deploy` again (it updates one
property in about 30 seconds).

The preflight holds `armed` to a higher bar. It **refuses** an armed deploy if
it can't verify your recovery route, or if the budget is *already* over
threshold (that would be lockout-by-deploy; `watch` merely warns on both). The
recommended arc is to run `watch` through one real trip (approve, see the
block, reverse it with your own hands), and only then consider `armed`.

## Settings

The setup page (`npm run dev`) writes these into `.env`, and every one is also
explained in the comments in `.env.example`. The essentials:

| Field | What to put |
|---|---|
| `ALERT_EMAIL` | Where the alerts go. **Required.** |
| `MONTHLY_BUDGET_USD` | Your monthly line, e.g. `5`. Use `0.01` for a "tell me on the very first cent" tripwire (Radar's own tiny footprint can eventually trip that one; see [Cost of Radar itself](#cost-of-radar-itself)). |
| `IAM_DENY_TARGET_USERS` | Your learning user, e.g. `learning`. **At least one target is required.** |
| `RECOVERY_PRINCIPAL_ARN` | The **full ARN** of your separate admin, the identity that lifts the block. Must **not** also be a target. |
| `SAFETY` | `watch` (default, block waits for your approval) or `armed` (applies automatically). **Start with `watch`.** |

Less-common fields:

- `EXISTING_BUDGET_NAME` leaves Radar to **create** its own budget when empty
  (the normal path). Set it to attach to a budget you already made. That
  budget must be a monthly, USD, unfiltered **cost** budget, and the deploy
  check verifies this and refuses if it isn't.
- `IAM_DENY_TARGET_GROUPS` / `_ROLES` add more targets. Use plain names, or
  the full ARN if the identity lives under a non-root IAM path (the deploy
  check will tell you if that's the case).
- `WARN_AT_PERCENT`, `ACTION_THRESHOLD_PERCENT`, `ACTION_THRESHOLD_TYPE`,
  `SERVICE_BUDGETS` are tuning knobs, and the defaults are sensible.
- `TRACK_GROSS_USAGE` (default `true`) makes the budget count **gross usage**:
  AWS credits and refunds are excluded, so usage trips the budget even while
  promotional credits are covering your bill. This is what you want on a
  credit-covered learning account: otherwise credits net your spend down to
  ~$0.00 and the budget never fires until the credits run out. Set it to
  `false` only if you want to be alerted on real out-of-pocket dollars.
- `EXCLUDE_SERVICES` (default **empty**) is a comma-separated list of exact AWS
  service names to leave **out** of the main budget. Empty keeps the budget
  watching your **total** account cost (recommended). Setting it **scopes**
  the budget to "everything except these services", so excluded spend no
  longer trips it. The main use is excluding `AWS Cost Explorer` so the
  metered cost of *checking* your bill (~$0.01 per Cost Explorer request)
  can't itself trip a tiny tripwire. Use sparingly: every service you exclude
  is a blind spot.
- `STOP_EC2_INSTANCES` / `STOP_RDS_INSTANCES` (default **empty**) list
  long-lived instances that AWS should **stop** at the same threshold as the
  block. Empty means nothing is ever stopped. See
  [Stopping specific instances](#stopping-specific-instances).
- `DAILY_DIGEST` (default **false**) is a true/false toggle. `true` emails
  every day; `false` creates no daily schedule or digest function. Legacy
  `findings`, `always`, and `off` values are rejected with a validation error:
  replace them deliberately with `true` or `false`. `DAILY_DIGEST_HOUR_UTC`
  defaults to `13` and accepts whole hours 0–23, without daylight-saving
  adjustment.

**Choosing thresholds:** a low automatic threshold (say 20%) is easy to cross
with incidental charges, and after that it's either tripped or disabled for
the rest of the month. Keep early warnings on `WARN_AT_PERCENT` (email only,
never blocks) and put `ACTION_THRESHOLD_PERCENT` where you actually want the
block, e.g. 80-100%.

### The setup page

`npm run setup` runs once after cloning: it checks Node ≥ 20, runs
`npm install`, creates `.env` from `.env.example` if it doesn't exist, and
starts the page. `npm run dev` starts just the page.

- It listens only on `127.0.0.1`, so nothing else on your network can reach
  it. If port 4000 is busy it uses the next free port and prints the address.
  `BROWSER=none npm run dev` skips opening a browser.
- The printed link ends in `#token=…`, a private key that's new every time
  the page starts. The page refuses any request without it: other people
  signed in to the same computer can reach `127.0.0.1` too, and the key is
  what stops them reading or changing your settings. After a restart, an old
  tab asks you to open the new link.
- Saving keeps the comments from `.env.example` and any extra settings you
  added to `.env` yourself (such as `AWS_PROFILE`). You can save a half-filled
  form and come back later.
- The AWS helper reads your AWS CLI profiles and asks each one "who am I?"
  (read-only, free). It picks an account by itself only when there's no
  doubt: the profile your terminal already selects, or the only signed-in
  account. With several accounts, you choose.

## Deploy details

**`npx cdk bootstrap`** prepares your account for CDK deployments (a small S3
bucket plus helper roles, shared by every CDK project, ~$0). It's needed
**once per account/region**, and the deploy fails without it. It reads your
`.env`, so fill that in first (or run
`npx cdk bootstrap --app "" aws://<account-id>/<region>` to skip that).

**`npm run deploy`** is two things chained together: a **read-only preflight
check** and, only if it passes, the actual `cdk deploy`. The preflight signs
nothing and changes nothing. It verifies your `.env` against your real account
and **refuses to deploy** (with a plain-English reason) if something would
bite you later: a target that doesn't exist or is an unsupported type, a
typo'd ARN, a recovery principal that can't actually lift the block, an
existing budget of the wrong kind, or a budget that's *already* over its
threshold. It also tells you whether your current credentials (and the CDK
deploy roles) are covered by the block, so you're never surprised by who is
and isn't restrained.

**AWS profiles:** `cdk deploy` uses the AWS profile your terminal selects
(`AWS_PROFILE`), or `default` if none is set. It does not read `.env`. So if
you use a named profile, run `export AWS_PROFILE=<name>` in the terminal you
deploy from.

**Billing console access (optional).** By AWS default, IAM users **cannot
open Billing/Budgets console pages**. Even with `AdministratorAccess` they see
"access denied" there until the root user flips one switch: sign in as root,
then account menu → **Account → IAM user and role access to Billing
information → Activate**. This only gates the *console pages*. The **CLI/API
is never gated**, and every command in these docs works either way.

## When your budget trips

AWS evaluates budgets a few times a day, so the alert lands up to about half a
day after the spend itself.

### The email

Subject: `AWS Budget Radar: budget threshold reached — action PENDING` (in
`watch` mode). Inside:

- the account, budget, threshold, and the action's **observed status**
- in `watch` mode, **"NOTHING IS BLOCKED YET"** plus the exact approve
  command. In `armed` mode, confirmation the block applied, plus the exact
  lift command.
- the region-by-region inventory of what's running, plus a **"still costing
  you money"** section (EBS volumes, NAT gateways, idle IPs, load balancers,
  S3 storage): your to-go-turn-off list

### Approving the block (watch mode)

- **Do nothing** → nothing is ever blocked, and the alert resets when the new
  budget month starts.
- **Approve the block** → run the command from the email (it's
  `aws budgets execute-budget-action … --execution-type
  APPROVE_BUDGET_ACTION`), or approve in the Budgets console if you turned on
  [Billing console access](#deploy-details). The deny then attaches to your
  learning user, with no new launches/starts until lifted.

### Lifting the block

The block ends one of two ways. The **next budget month starts** (it detaches
automatically, which is expected AWS behavior, not an iron guarantee), or you
**reverse it now**, as your recovery principal:

```bash
aws budgets execute-budget-action \
  --account-id <ACCOUNT_ID> --budget-name <BUDGET_NAME> --action-id <ACTION_ID> \
  --execution-type REVERSE_BUDGET_ACTION
```

That's *reverse*, not "reset" (see the next section before you ever press
Reset). Reversing un-blocks launches/starts. It does **not** restart anything:
if you configured stop actions, those instances stay stopped until you start
them. A reversed action is **done for the month**: AWS stops evaluating it and
re-arms it on its own when the next budget month starts.

**Where to find the three values** (easiest first):

1. **The alert email.** The command arrives with the values filled in.
2. **Console:** Lambda → Functions → `BudgetRadarStack-Reporter…` →
   Configuration → Environment variables. `ACCOUNT_ID`, `BUDGET_NAME`,
   `ACTION_ID` are right there.
3. **CLI:** `aws budgets describe-budget-actions-for-account
   --account-id <ACCOUNT_ID>` lists every action with its ids and status.

## Re-arming mid-month (don't just press Reset)

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
  `ACTION_THRESHOLD_PERCENT=45`, run `npm run deploy`, then Reset. Now it only
  fires on genuinely new spend. If you're already over 100%, raise
  `MONTHLY_BUDGET_USD` instead. The preflight will tell you if the new
  threshold is still at or below your current spend.

## Stopping specific instances

The block stops *new* spend, but a big instance you already have keeps
billing. For **long-lived instances you know about ahead of time** (a practice
database, a dev box), you can have AWS stop them at the same threshold. List
them in `.env`:

```bash
STOP_EC2_INSTANCES=i-0123456789abcdef0,us-west-2:i-0fedcba9876543210
STOP_RDS_INSTANCES=practice-db
```

A bare ID means the region you deploy to. Prefix `region:` for anything else.
Each region and type becomes one native budget action (`RUN_SSM_DOCUMENTS`),
up to 100 instances each.

What happens:

- At the threshold, AWS Budgets runs AWS's own `AWS-StopEC2Instance` /
  `AWS-StopRdsInstance` runbooks. Instances are **stopped, never terminated or
  deleted**. EBS and RDS persistent storage is retained, but EC2
  instance-store data is erased by a stop. Preflight rejects
  instance-storage-capable EC2 types, including EBS-root types with local
  disks. Storage, provisioned IOPS, backups and applicable IP charges
  continue; stopping reduces compute charges.
- It follows `SAFETY` just like the block. In `watch` mode each stop action
  goes `PENDING` and the email has a separate approve command for it. In
  `armed` mode AWS stops them automatically.
- AWS sends its own short notice for each stop action, and Radar's report
  lists every stop action's status and instances.
- Stopped instances **stay stopped** until someone starts them. While the
  block is applied your learning identity can't start them either (the deny
  covers `ec2:StartInstances` / `rds:StartDBInstance`), so start them as your
  recovery principal. AWS **restarts a stopped RDS DB instance by itself after
  7 days**, even while the learner deny remains applied; compute charges
  resume and this monthly action does not continuously re-stop it.
- Like the block, a stop action runs once per budget month. Start an instance
  again mid-month and it won't be re-stopped until the next month (or a
  Reset; see [the caveat](#re-arming-mid-month-dont-just-press-reset)).

The preflight looks up every listed instance and **refuses to deploy** if one
doesn't exist, is already terminated, or can't be stopped this way:

- **Auto Scaling group members.** The group would just replace them. Scale the
  group down yourself instead.
- **Instance-store-backed or instance-storage-capable EC2 types.** Root type
  alone cannot establish data safety; unknown storage capability also fails
  closed.
- **API stop protection.** `DisableApiStop` must be verified false. Radar
  never changes this attribute or grants the stop role permission to modify
  it.
- **Aurora / DB cluster members, read replicas and instances with replicas,
  and SQL Server Multi-AZ.** AWS cannot stop these this way.

It warns on Spot Instances, since only Spot Instances from a persistent
request can be stopped.

**Why only listed instances?** AWS's native stop action needs the instance IDs
when it's created, so it can't catch something you launch tomorrow. For that,
lean on the block (no new launches) and the report's inventory.

The execution role AWS uses is scoped to exactly these instances and only
AWS's stop/start runbooks, and it can only act *through* Systems Manager. It
can't terminate, delete, or modify anything.

When removing Radar with stop actions configured, inspect the current EC2/RDS
state and recover resources using an authorized operator identity when
needed. Destroying the stack does not establish that stopped resources
restarted; SSM action reversal/restart behavior has not been verified live.

## What the block does and doesn't stop

The deny is a **positive list**. Only these actions are denied, and only for
the identities you listed. Everything else they could do, they still can.

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

- **A blocked identity can't restart its own stopped EC2/RDS** while the block
  is active. That's intended, because restarting resumes spend. It clears at
  the month reset or when you reverse.
- **Scale-downs stay allowed.** `autoscaling:UpdateAutoScalingGroup` and
  `ecs:UpdateService` (e.g. scaling to zero) are deliberately *not* denied, so
  the block never stops you from doing what its own email asks of you.

**NOT blocked** (the gaps most likely to surprise you). **EKS, Redshift,
ElastiCache, OpenSearch, and Bedrock** have none of their create/start/invoke
actions listed. Anything launched via a **service-linked role** runs as a
different principal than your user. Any identity you didn't list is free. And
the root user is never blocked.

## The daily digest

The budget can only react to billing data, which lags real usage by up to a
day. The digest doesn't wait for billing. Once a day an EventBridge schedule
runs a second, read-only Lambda that scans the same regions and services as
the trip report and emails what it finds. Like the trip report, it **never
stops or changes anything**.

Each digest shows:

- month-to-date spend against your budget, plus AWS's forecast for the month
- the block's current status, with the approve command if it's waiting on you
- everything still running or billing, grouped by service and region
- coverage gaps (regions/services it couldn't check), labeled as such

**When it emails:** set `DAILY_DIGEST=true` for an email every day, including
empty or incomplete scans. `DAILY_DIGEST=false` (default) removes the schedule
and digest Lambda. The digest includes every configured stop action, with
`UNKNOWN` for denied, failed or deadline-skipped lookups. Action success
records past execution, not the current power state of a resource.

EventBridge delivery failures go to the failure queue, as do exhausted Lambda
async execution failures. Both retry paths have a two-hour event-age limit;
the handler also checks the original schedule timestamp before scanning and
publishing, rejecting missing/invalid or stale timestamps. Inspect the queue
and logs if email fails; scheduling is best effort, not guaranteed delivery.
Unavailable services and regions are listed as coverage gaps in each enabled
daily email.

**Left out of the digest on purpose:** plain Lambda functions (free while
idle, and Radar's own functions always exist, so they'd make every digest
non-empty) and S3 bucket sizes (the CDK bootstrap bucket always exists).
Lambda *provisioned concurrency*, which does bill while idle, is included. The
trip report still covers both.

Change the toggle or hour, then run `npm run deploy` again.

## What the report covers

The report **describes. It never acts.** Denied or failed scans are labeled as
failures, never passed off as "nothing found."

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
| The budget + action(s) | Free (first 2 action-enabled budgets per account; the optional stop actions live on the same budget) |
| Lambda + SNS email | Free tier at this volume. The trip reporter only runs on a trip, the digest once a day (a scan of a minute or so) |
| EventBridge schedule | Free (scheduled rules have no charge) |
| CloudWatch Logs | Pennies at most, capped by 30-day retention |
| CDK bootstrap S3 | A few KB of storage, shared |

On a `0.01` tripwire, Radar's own footprint (logs, requests) can eventually be
the thing that trips it. That's the tripwire working, not a bug.

> **Watch your budget on the Budgets page, not Cost Explorer.** The Cost
> Explorer **API costs $0.01 per request**, and both the `aws ce
> get-cost-and-usage` CLI command and the console's "Cost and usage" / Cost
> Explorer widgets issue those requests. If you set a tiny tripwire (e.g.
> `$0.01`) and then anxiously refresh Cost Explorer to watch it, **the
> checking itself can be what trips the budget.** To watch spend for free, use
> **Billing → Budgets**, where your budget's "Current spend" is exactly what
> the action evaluates. The Budgets API and page are not billed per request.

## Troubleshooting

The [README](../README.md#troubleshooting) covers the common ones (refused
deploy, expired sign-in, no email). More:

**No alert email after a trip** (beyond an unconfirmed subscription). In
order:
1. `npm run verify -- <ReportTopicArn>`. An unconfirmed subscription is the #1
   cause, so click the confirmation email.
2. Check the **`ReporterFailures` SQS queue** (SQS console → the queue
   containing `ReporterFailures` → *Send and receive messages* → *Poll*). A
   message there can indicate EventBridge delivery failure or Lambda execution
   failure; inspect its attributes and body.
3. Check the reporter's **CloudWatch Logs** (Lambda console → the
   `BudgetRadarStack-Reporter…` function → Monitor → Logs) to see whether it
   ran at all.

**No daily digest.** Confirm `DAILY_DIGEST=true`, email subscription
confirmation, the deployed rule/function, and the failure queue and logs.
`false` disables it.

**Budgets/Billing console says "access denied."** You're an IAM user and root
hasn't enabled [Billing console access](#deploy-details). Either flip that
switch as root, or use the CLI commands, which are never gated.

**The block keeps re-applying after I lift it.** You pressed Reset (or ran
`RESET_BUDGET_ACTION`) while month-to-date spend was still over the threshold,
so the next refresh fired it again. Reverse only, or
[raise the threshold above current spend before resetting](#re-arming-mid-month-dont-just-press-reset).

**`cdk destroy` failed on `DeleteManagedPolicy`.** The block was still
attached. Use the manual detach commands in the
[README](../README.md#removing-budget-radar), then re-run destroy. (`cdk
destroy` with the block *never applied* is the clean case, verified by live
testing; see `RELEASE.md` item 8. The bootstrap stack, `CDKToolkit`, is shared
with other CDK projects and stays. It costs ~$0.)

**Who exactly is covered?** The preflight's deploy output lists every resolved
target, whether *your* current credentials are covered, and whether the CDK
deploy roles are. Nothing is guessed, and "unknown" is printed when it can't
be determined.

## AWS references and fine print

AWS semantics: [EC2 stop/start](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/Stop_Start.html),
[API stop protection](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-stop-protection.html),
[RDS stopping limits, restart and charges](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_StopInstance.html),
and [Budgets/SSM managed policy](https://docs.aws.amazon.com/aws-managed-policy/latest/reference/AWSBudgetsActions_RolePolicyForResourceAdministrationWithSSM.html).
Reversing the IAM deny does not restart resources. Whether reversing a
separate SSM stop action restarts them remains unverified and requires
authorized live acceptance testing; use the recovery principal and check
current state explicitly. Set `AWS_REGION` and `CDK_DEFAULT_REGION`
consistently (or only one); conflicting values are rejected by both preflight
and synthesis.

Digest reliability references: [EventBridge delivery DLQ and scoped queue permission](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-rule-dlq.html)
and [Lambda asynchronous event age and failure destinations](https://docs.aws.amazon.com/lambda/latest/dg/invocation-async-configuring.html).
Preflight stop checks require read-only `ec2:DescribeInstances`,
`ec2:DescribeInstanceAttribute`, `ec2:DescribeInstanceTypes`, and
`rds:DescribeDBInstances` on the deployment caller; the execution role gains
no permission to change stop protection. Lifecycle checks reflect deployment
time: resources or protection settings changed later still require operator
attention.

Maintainers: [`RELEASE.md`](../RELEASE.md) tracks the live-account validation
status of this project and the rules for testing it against a real
(disposable) account.
