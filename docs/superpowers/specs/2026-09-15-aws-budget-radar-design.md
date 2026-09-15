# AWS Budget Radar — Design

**Date:** 2026-09-15
**Status:** Approved for planning

## 1. Problem

A club member spins up AWS resources to learn, forgets about them, and discovers
the damage on a credit card statement. The common failure is not a dramatic
four-hour burn; it is a resource left running for days because nobody was
watching.

AWS ships two halves of a solution and joins neither to the other:

- **AWS Budgets** tells you that you overspent, but does nothing about it.
- **AWS Budgets Actions** can act, but its only resource-level action
  (`RUN_SSM_DOCUMENTS`) requires you to hardcode instance IDs at deploy time,
  and covers EC2 and RDS only.

Hardcoded instance IDs are exactly useless for the real problem, which is always
the resource nobody remembered to list.

Budget Radar closes that gap: a clone-and-deploy CDK app that, when a budget
threshold is crossed, **discovers what is actually running and reversibly shuts
it down**, while simultaneously **blocking new launches**.

## 2. Goals

1. Clone, edit one `.env`, run `cdk deploy`. No console clicking.
2. When a budget is breached: stop what is running, block what would launch next.
3. Never destroy anything. Every action reversible by one command.
4. Cost nothing to run.

## 3. Non-goals

Deliberately excluded to keep v1 honest:

- **Real-time protection.** See §4.1. This reacts in hours, not minutes.
- **Multi-account / AWS Organizations / SCPs.** Target is individual accounts.
- **Slack or Discord alerts.** Email only for v1.
- **Cost forecasting or dashboards.** AWS Budgets already does this.
- **Destructive remediation.** EMR termination and SageMaker endpoint deletion
  are reported, never performed.

## 4. Constraints that shaped the design

Verified facts, each of which forced a decision. Recorded so implementation does
not "fix" a deliberate choice.

### 4.1 Budget data lags 8–12 hours

> "AWS Budgets information is updated up to three times a day. Updates typically
> occur 8–12 hours after the previous update."
> — *Use a budget in the AWS Billing and Cost Management console*

Billing data itself lags actual usage on top of that. **A budget threshold is a
backstop, not a real-time trigger.** A GPU instance launched at 2pm may not trip
the budget until the small hours.

Accepted knowingly: it trades responsiveness for a system that is simple to
explain, audit, and teach. The README must state this plainly so nobody deploys
it believing they are protected in real time.

### 4.2 Action-enabled budgets cost money; monitoring budgets do not

> "Budgets without actions are free. You can create 2 actions-enabled budgets for
> free." — *AWS Budgets FAQs*, then $0.10/day each.

**Consequence: exactly one action-enabled budget.** The total-spend budget carries
the IAM Deny action. Every per-service budget is notification-only and free. The
Lambda performs per-service remediation, so nothing is lost. Total recurring
cost: **$0**.

A design attaching an action per service would cost ~$3/month per service.

### 4.3 IAM Deny policies cannot restrain the root user

Budget actions attach policies to IAM users, groups, and roles. The root account
ignores them. A member operating as root gets the Lambda half only, silently.

The README must make this prominent, and synth must warn when no IAM deny
targets are configured.

### 4.4 Per-service cost filters need exact AWS service names

Budget `CostFilters` on `SERVICE` match display names such as
`Amazon Elastic Compute Cloud - Compute`, not `ec2`. `.env.example` ships with
the exact strings pre-filled and commented. No friendly-name mapping layer — it
would be one more thing to get subtly wrong.

### 4.5 Stopping an ASG member does not stop it

An EC2 instance in an Auto Scaling Group is replaced when stopped. **ASGs must be
scaled to zero before EC2 instances are touched**, or remediation silently fails.

### 4.6 RDS stop expires after 7 days

`StopDBInstance` is a snooze, not an off switch; AWS restarts the instance after
seven days. Reported to the user as such; not worked around.

### 4.7 The Deny policy blocks its own reversal

The Deny policy denies `ec2:StartInstances`, `rds:StartDBInstance`,
`ecs:UpdateService`, and `autoscaling:UpdateAutoScalingGroup` — precisely the
calls `restore.sh` must make. An explicit Deny overrides every Allow.

**Consequence: `restore.sh` must detach the policy before restarting anything,
and must wait for IAM propagation in between.** IAM is eventually consistent; an
immediate retry can still fail. Poll a canary call until it succeeds rather than
sleeping a fixed interval. Reversing this order breaks restore entirely.

### 4.8 Restoring does not un-breach the budget

After a successful restore, the budget is still over threshold. The next refresh
(within 8–12 hours) re-fires the Lambda, shuts everything down again, and
re-attaches the Deny policy. The user experiences an unexplained second shutdown
overnight.

**Consequence: `restore.sh` supports a bounded snooze** (§7.6). Without it the
tool is actively hostile to the person it is meant to help.

## 5. Architecture

One SNS topic is the spine.

```
Total budget (the ONE action-enabled budget)
  ├─ WARN_AT_PERCENT ACTUAL ──► SNS ──► email            (warn only, no action)
  ├─ 100% ACTUAL            ──► SNS ──► email + Lambda   (stop what runs)
  └─ 100% ACTUAL            ──► BudgetsAction: APPLY_IAM_POLICY
                                                          (block new launches)

Per-service budgets ×N (notification-only, free, one per SERVICE_BUDGETS entry)
  └─ 100% ACTUAL            ──► SNS ──► email + Lambda   (stop that service only)
```

Two independent halves fire from one threshold. The **native action** blocks
future spend with no code. The **Lambda** stops present spend, covering AWS's
gap. Both are fully reversible.

## 6. Deployment

CDK is the whole delivery mechanism. `cdk deploy` synthesizes a CloudFormation
template from the TypeScript stack and hands it to CloudFormation, which creates
the resources in the user's account. The synthesized template is a build
artifact in `cdk.out/` and is **gitignored** — there is no hand-written
CloudFormation file in the repo and none is committed.

```bash
git clone https://github.com/Njones27/AWS_Budget_Radar && cd AWS_Budget_Radar
npm install
cp .env.example .env        # edit: email, budget amount, deny targets
npx cdk bootstrap           # once per account/region
npx cdk deploy
```

`cdk bootstrap` is a one-time per-account/region step creating the `CDKToolkit`
stack. Skipping it makes `cdk deploy` fail with an error that does not obviously
say "run bootstrap." First-time CDK users trip on this constantly, so the README
calls it out as its own numbered step rather than burying it in prose.

Because configuration is read at synth time, `cdk deploy` after editing `.env`
is also how you *change* settings — there is no separate update path.

## 7. Components

### 7.1 Repository layout

```
bin/budget-radar.ts           CDK entrypoint; loads .env
lib/budget-radar-stack.ts     stack definition
lib/deny-policy.ts            the Deny policy document, isolated deliberately
lib/config.ts                 .env parsing and validation
lambda/handler.py             zero-dependency remediation handler
.env.example                  the only file a member edits
restore.sh                    reverses everything
test-fire.sh                  publishes a synthetic budget notification
test/budget-radar.test.ts     CDK assertions (jest)
tests/test_handler.py         handler logic (pytest, stubbed boto3)
package.json  tsconfig.json  cdk.json  .gitignore
```

`lib/deny-policy.ts` is separate because it is the component most capable of
harming a user (§7.3); it deserves isolated review and isolated tests.

### 7.2 Stack resources

| Resource | Purpose |
|---|---|
| `SNS::Topic` | Central alert spine |
| `SNS::TopicPolicy` | Allows `budgets.amazonaws.com` to publish — **required**, a standard omission that silently breaks notifications |
| `SNS::Subscription` | Email, from `ALERT_EMAIL` |
| `Lambda::Function` | Python 3.13, 512 MB, 300 s timeout, `Code.fromAsset('lambda/')` |
| `IAM::Role` (Lambda) | Describe + reversible-stop actions across supported services |
| `IAM::ManagedPolicy` | The Deny policy. Created but **not attached**; the budget action attaches it |
| `IAM::Role` (budget action) | Trusted by `budgets.amazonaws.com` with `aws:SourceArn` / `aws:SourceAccount` confused-deputy conditions |
| `Budgets::Budget` (total) | Notifications at `WARN_AT_PERCENT` and 100% |
| `Budgets::BudgetsAction` | `APPLY_IAM_POLICY`, `AUTOMATIC`, at 100% ACTUAL. Created only if deny targets are configured |
| `Budgets::Budget` ×N | One per `SERVICE_BUDGETS` entry, notification-only, `SERVICE` cost filter |
| `SSM::Parameter` ×2 | Restore record (§7.5) and snooze timestamp (§7.6) |

The Lambda's role needs `Resource: "*"` on describe/stop actions because targets
are discovered at runtime. This is a genuinely broad role and the README must
say so; it is inherent to the problem, not an oversight.

The `lambda/` directory has **no dependencies** — boto3 ships in the Python
Lambda runtime — so `Code.fromAsset` needs no bundling, no Docker, and no layer.

### 7.3 The Deny policy

**A positive list of spend-causing actions. Never `Deny: *`.**

Denies resource-creating actions: `ec2:RunInstances`, `ec2:StartInstances`,
`rds:CreateDBInstance`, `rds:StartDBInstance`, `sagemaker:Create*`,
`emr:RunJobFlow`, `ecs:CreateService`, `ecs:UpdateService`,
`autoscaling:UpdateAutoScalingGroup`, `lambda:CreateFunction`.

**Explicitly untouched**, so the user can always recover:

- All of `iam:*` — otherwise the user may be unable to detach this very policy
- All of `budgets:*` — so the budget can be adjusted
- All read-only actions (`Describe*`, `List*`, `Get*`) — so the console stays usable
- `cloudformation:*` — so the stack can be updated or destroyed

A test asserts the synthesized policy does **not** deny `iam:DetachUserPolicy`.
That single assertion is the difference between a safety tool and a lockout.

### 7.4 The Lambda handler

0. **Check the snooze parameter** (§7.6). If snoozed and unexpired, publish
   "snoozed until X — taking no action" to SNS and exit before anything else.
1. **Parse** the SNS budget notification to determine which budget fired. The
   payload is semi-structured; the handler must be defensive. If the budget name
   cannot be determined, fall back to a **full sweep** and log loudly.
2. **Enumerate regions** via `DescribeRegions` (enabled regions only). Sweeping
   every region is essential — forgotten resources are disproportionately in
   regions the owner never opens.
3. **Discover and filter.** Skip anything tagged `BudgetRadar:Protect=true`.
   Skip anything with no reversible off switch.
4. **Act**, strictly in this order:
   1. ASG → `UpdateAutoScalingGroup` min/desired = 0 — **before EC2** (§4.5)
   2. EC2 → `StopInstances`
   3. Lambda → `PutFunctionConcurrency` reserved = 0
   4. ECS → `UpdateService` desiredCount = 0
   5. RDS → `StopDBInstance`
   6. SageMaker notebooks → `StopNotebookInstance`
5. **Record and report.** Merge results into the SSM record (§7.5); publish a
   human-readable summary to SNS.

**Never touched, always reported** under "still costing you money — needs your
decision": EMR clusters, SageMaker endpoints, NAT Gateways, unattached EIPs, S3
storage, and stopped-instance EBS volumes. The tool refuses to let ongoing costs
be invisible, but will not delete to stop them.

**Idempotency.** The budget stays breached and will re-notify up to three times
daily. The handler must be safe to run repeatedly: stopping an already-stopped
resource is a swallowed no-op.

### 7.5 Restore record

A single SSM Parameter holds JSON describing every change, keyed by budget
period.

**The second run must not erase the first run's record.** Writes **merge**; they
never replace. A naive replace would leave `restore.sh` with an empty record
after the second notification — the exact moment the user needs it. This is the
subtlest failure mode in the design.

If the record is missing or empty (the Lambda only ever ran in dry-run, or never
fired), `restore.sh` still detaches the Deny policy and reports that there was
nothing recorded to restart. It must not error out.

### 7.6 `restore.sh`

Run from the repo root with the credentials used to deploy:

```bash
./restore.sh [--snooze HOURS]
```

Ordering is mandatory and derives from §4.7:

1. **Detach the Deny policy** from every configured target.
2. **Wait for IAM propagation** — poll a canary call (e.g. a dry-run
   `StartInstances`) until it is permitted. Do not sleep a fixed interval.
3. **Restart from the SSM record** — start instances, restore Lambda reserved
   concurrency, scale ASGs and ECS services back to recorded values, start RDS
   instances, start SageMaker notebooks.
4. **Apply the snooze** if `--snooze` was given: write a snooze-until timestamp
   to SSM. **Capped at 72 hours**, so protection cannot be disabled for a whole
   budget period by accident.
5. **Report.** With a snooze: state when protection resumes. Without one: warn
   explicitly that the budget remains breached and Radar will shut these
   resources down again within 8–12 hours, and give the two real remedies —
   raise `MONTHLY_BUDGET_USD` and redeploy, or re-run with `--snooze`.

The shutdown notification email must include the literal `./restore.sh` command,
so recovery never requires hunting for documentation.

**Total lockout escape hatch.** If a user has somehow lost the ability to detach
the policy, the documented recovery is to sign in as root and detach it in the
IAM console. §7.3 is designed so this should never be necessary; the README
documents it anyway.

### 7.7 Configuration

`.env` is the entire configuration surface, read at synth time by
`lib/config.ts` and validated before any construct is created.

```bash
ALERT_EMAIL=you@uky.edu
MONTHLY_BUDGET_USD=50            # 0.01 gives a zero-spend tripwire
WARN_AT_PERCENT=80
DRY_RUN=true                     # report only; flip to false to arm

# Who the Deny policy attaches to. Cannot restrain root (§4.3).
IAM_DENY_TARGET_USERS=
IAM_DENY_TARGET_GROUPS=
IAM_DENY_TARGET_ROLES=

# Any number of entries. Names must match AWS service strings exactly (§4.4).
SERVICE_BUDGETS=Amazon Elastic Compute Cloud - Compute:20,Amazon SageMaker:10

PROTECTED_TAG_KEY=BudgetRadar:Protect
```

The stack creates the budget itself rather than assuming a pre-existing one;
clone-and-deploy must be self-contained. `MONTHLY_BUDGET_USD=0.01` yields the
zero-spend variant for members who should never leave the free tier.

**Validation in `lib/config.ts`, failing synth with an actionable message:**

- `ALERT_EMAIL` present and syntactically valid
- `MONTHLY_BUDGET_USD` numeric and > 0
- `WARN_AT_PERCENT` between 1 and 99
- The Lambda's own execution role is **not** among the deny targets — that would
  leave remediation permission-denied at exactly the moment it is needed, and
  the failure would surface only in CloudWatch logs nobody is reading
- If all three `IAM_DENY_TARGET_*` are empty: warn loudly that future-launch
  blocking is disabled, skip the `BudgetsAction`, and continue. The Lambda half
  still works.

Failing at synth is deliberate: a misconfiguration should never reach the
account.

## 8. Safety

1. **`DRY_RUN=true` by default.** First deployment reports what it *would* stop.
   A tool that shuts down infrastructure earns trust before it acts.
2. **Positive-list Deny policy** (§7.3), with a test against self-lockout.
3. **`BudgetRadar:Protect=true`** exempts any resource.
4. **`restore.sh`** reverses everything in one command, in an order that works
   while the Deny policy is attached (§4.7).
5. **Bounded snooze**, capped at 72 hours, so recovery does not become permanent
   disarmament (§4.8).
6. **Reversible actions only.** No code path deletes or terminates anything.

## 9. Testing

The trigger cannot be fired on demand, so testing is layered:

- **`tests/test_handler.py`** (pytest, stubbed boto3) — ordering (ASG before
  EC2), protect-tag exemption, dry-run performs no mutating calls, idempotency,
  SSM merge-not-replace, malformed-notification fallback, no-op while snoozed.
- **`test/budget-radar.test.ts`** (jest + CDK assertions) — SNS topic policy
  permits `budgets.amazonaws.com`; exactly one action-enabled budget exists;
  budget action role carries confused-deputy conditions; **the Deny policy does
  not deny `iam:*`**; N service budgets are created from N config entries;
  config validation rejects bad input.
- **`restore.sh` coverage** — an integration check that restore succeeds *while
  the Deny policy is attached* (§4.7). This is the regression most likely to be
  reintroduced, because the correct ordering looks arbitrary from the outside.
  Plus: snooze cap enforced at 72 h; empty SSM record exits cleanly.
- **`test-fire.sh`** — publishes a realistic synthetic budget notification to the
  live SNS topic, exercising the deployed Lambda end to end.

## 10. Cost

| Item | Cost |
|---|---|
| Total budget (action-enabled) | Free — 1 of 2 free |
| Per-service budgets ×N | Free — no actions attached |
| Lambda | Free tier; runs only on notification |
| SNS email | Free tier |
| SSM Parameters (Standard) | Free |
| **Total** | **$0** |

## 11. Future work

Explicitly deferred: Discord/Slack webhook; Cost Anomaly Detection as a faster
second trigger; a run-rate watcher on a short schedule for real-time protection
(§4.1); opt-in destructive tier for EMR and SageMaker endpoints; multi-account
support.
