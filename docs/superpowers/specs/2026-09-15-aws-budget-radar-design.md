# AWS Budget Radar — Design

**Date:** 2026-09-15
**Status:** Approved for planning

## 1. Problem

A club member spins up AWS resources to learn, forgets about them, and discovers
the damage on a credit card statement. The dominant fear is "I'm going to wake up
having spent a ton of money." The common failure is not a four-hour burn; it is a
resource left running for days because nobody was watching.

AWS ships pieces of a solution and joins none of them:

- **AWS Budgets** tells you that you overspent, but does nothing about it.
- **AWS Budgets Actions** can act, but its only resource-level action
  (`RUN_SSM_DOCUMENTS`) requires you to hardcode instance IDs at deploy time and
  covers EC2 and RDS only — useless for the resource nobody remembered to list.

Budget Radar is a **general-purpose tool you clone, configure with one `.env`,
and `cdk deploy`**. When a budget threshold is crossed it (a) **blocks new spend**
with an IAM deny and (b) **reversibly stops what is already running**, then emails
you exactly what it did. It costs nothing to leave running in the background.

## 2. Goals

1. Clone, edit one `.env`, run `cdk deploy`. No console clicking.
2. Work whether or not a budget already exists (see the two paths below).
3. On breach: stop what runs, block what would launch, report everything.
4. Never destroy anything. Every action reversible by one command.
5. Safe to leave unattended: never permanently locks the user out.
6. Cost nothing to run.

### The two deployment paths

Both resolve to the **same single action resource** (§5); they differ only in
whether Budget Radar creates the budget.

- **Path A — a budget already exists** (e.g. a zero-spend budget the member made
  in the console). Budget Radar attaches its action to that budget *by name* and
  never modifies the budget, its thresholds, or its existing alerts. The member's
  own alerting keeps working; Budget Radar adds the teeth.
- **Path B — no budget exists.** Budget Radar creates a zero-spend cost budget
  (`$0.01`) with optional extra thresholds, plus the action. Deploying arms the
  whole thing.

## 3. Non-goals

- **Real-time protection.** See §4.1. Reacts in hours, not minutes.
- **Multi-account / Organizations / SCPs.** Target is individual accounts.
- **Slack or Discord alerts.** Email only for v1.
- **Cost dashboards or forecasting UI.** AWS Budgets already does this.
- **Destructive remediation.** EMR termination and SageMaker endpoint deletion
  are reported, never performed.
- **Service Catalog launch constraints.** A viable alternative remediation (see
  the 2017 "Smart Budgeting" pattern) but it presumes the account launches
  through Service Catalog portfolios, which a club member does not. Future work.

## 4. Constraints that shaped the design

Verified facts, each of which forced a decision. Recorded so implementation does
not "fix" a deliberate choice. Sources noted inline.

### 4.1 Budget data lags 8–12 hours

> "AWS Budgets information is updated up to three times a day. Updates typically
> occur 8–12 hours after the previous update." — *Billing and Cost Management*

Billing data itself lags actual usage on top of that. **A budget threshold is a
backstop, not a real-time trigger.** The README must say this plainly so nobody
deploys it believing they are protected in real time. A `FORECASTED` threshold
(§7.7) partly mitigates this by acting before the actual crossing.

### 4.2 The applied deny auto-detaches at the next budget period

> "if no remediation action is taken, the restrictive IAM policy will be
> automatically detached at the start of the next budget period."
> — *AWS Cloud Operations Blog, "manage cost overruns part 2"*

**This is what makes the tool safe to leave unattended.** A member who trips the
deny on the 20th is automatically un-blocked on the 1st, even if they never run
recovery. Recovery (§7.6) is therefore for *same-period* return-to-work — the
across-period deny self-heals, but stopped resources still need a restart.

### 4.3 Action-enabled budgets cost money; monitoring budgets do not

> "Budgets without actions are free. You can create 2 actions-enabled budgets for
> free." — *AWS Budgets FAQs*, then $0.10/day each.

**Consequence: exactly one action-enabled budget.** Any extra per-service budgets
are notification-only and free. In Path A, attaching our action to the member's
existing budget consumes one of their two free action slots — noted for anyone
who already runs action-enabled budgets.

### 4.4 A BudgetsAction references a budget by name and carries its own subscribers

> `BudgetName` is a plain string (not a `Ref`); `Subscribers` is `SNS | EMAIL`.
> — *`AWS::Budgets::BudgetsAction` CloudFormation reference*

Two consequences that shape the whole architecture:

- The action can attach to a **pre-existing** budget (Path A) — it just names it.
  If the named budget does not exist at deploy, action creation fails: a free
  typo-guard.
- **One action does both jobs.** Its `Definition` applies the IAM deny (block new
  spend); its `Subscribers` notify our SNS topic, which invokes the Lambda (stop
  running resources). No second mechanism needed, and it works identically in
  both paths.

### 4.5 Existence of a budget cannot be auto-detected in CloudFormation

CloudFormation has no data source to ask "does a budget exist?" **Path selection
is therefore an explicit `.env` switch** (`EXISTING_BUDGET_NAME`), not
auto-sensing. A synth-time SDK lookup would need credentials at build time and
add fragility for no real gain.

### 4.6 Budget actions attach only to cost or usage budgets

Not to Reserved-Instance or Savings-Plans budgets. A zero-spend budget is a cost
budget, so both paths are fine; Path A's README note must say the existing budget
must be a cost/usage budget.

### 4.7 The budget notification payload is prose, not structured data

> Message body: `... your budget "BudgetAlert" is greater than $50000 ...`
> — *AWS Cloud Operations Blog, "Smart Budgeting using Lambda and Service Catalog"*

The budget name is embedded in an English sentence. **The Lambda therefore
defaults to a full region-wide sweep** and uses only best-effort regex on the
message to *narrow* to a single service. It never depends on clean fields.

### 4.8 The SNS topic needs a resource policy, must not be encrypted, and needs a confirmed subscription

From *"Creating an Amazon SNS topic for budget notifications"*:

- The topic needs a resource policy allowing `budgets.amazonaws.com` to
  `SNS:Publish`, guarded by `aws:SourceAccount` and
  `ArnLike aws:SourceArn arn:aws:budgets::<account>:*` (confused-deputy). Omitting
  this silently breaks all notifications — the single most common failure.
- **A KMS-encrypted topic silently breaks budget publishing** without an extra
  key grant. The topic stays unencrypted; these are cost alerts, not secrets. A
  code comment records the reason.
- An email subscription sits in `PendingConfirmation` until the member clicks a
  link SNS emails them. **Until then, nothing flows.** This is the most likely
  "why didn't it work?" moment for a clone-and-deploy tool, so `cdk deploy` output
  and the README both call it out as a required post-deploy step.

### 4.9 Stopping an ASG member does not stop it; RDS stop expires

> "If a budget action is used to stop an EC2 instance in an Auto Scaling Group,
> EC2 Auto Scaling restarts the instance." — *Best practices for AWS Budgets*

**ASGs must be scaled to zero before EC2 instances are touched.** Separately,
`StopDBInstance` is a 7-day snooze, not an off switch; AWS restarts RDS after
seven days. Reported as such; not worked around.

### 4.10 Recovery runs as the Lambda's role, which the deny never touches

The deny attaches to the member's IAM users/groups/roles — never to the Lambda's
own execution role (§7.7 validates this). So the deny does not restrict the
Lambda. **Recovery is therefore a mode of the Lambda** (§7.6), not a script run
with the member's denied credentials: it detaches the deny and restarts resources
in one pass, with no need to wait for IAM propagation, because the acting
principal was never denied.

### 4.11 `cdk destroy` does not restart stopped resources, and can conflict

Two facts that govern teardown (§6):

- The resources the Lambda stops (EC2, RDS, ASG, ECS, Lambda concurrency) are the
  **member's own resources, not stack resources.** CloudFormation deletes only
  what it created, so `cdk destroy` removes the watchdog and the deny policy but
  **restarts nothing** — stopped resources stay off.
- A managed policy cannot be deleted while attached (`DeletePolicy`: "you must
  first detach the policy from all users, groups, and roles"). The console
  auto-detaches; **CloudFormation, using the API, does not.** So if the deny is
  applied at teardown, `cdk destroy` can fail with a `DeleteConflict`.
- The restore record (§7.5) is a stack resource, so `cdk destroy` deletes it —
  the map of what to restart is gone afterward.

**Consequence: recover before you destroy.** Recovery (§7.6) detaches the deny and
restarts resources; only then is `cdk destroy` clean. The README documents this
ordering. (If a full budget period has elapsed, the deny has already
auto-detached per §4.2, so destroy is clean — but stopped resources still need a
restore first, while the record still exists.)

## 5. Architecture

One SNS topic is the spine; one action is the trigger.

```
   Budget                       ┌──────────────────────────────────────┐
   ─────────                    │  AWS::Budgets::BudgetsAction           │
   Path A: existing, by name ──►│   ActionThreshold: e.g. 100% ACTUAL    │
   Path B: we create ($0.01) ──►│   Definition: APPLY_IAM_POLICY  ───────┼─► blocks NEW spend
                                │   ApprovalModel: MANUAL | AUTOMATIC     │
                                │   Subscribers: [ our SNS topic ]  ──────┼─► SNS ─► Lambda
                                └──────────────────────────────────────┘        │
                                                                                 ▼
                                                          full region-wide sweep; reversibly
                                                          STOP running resources; email report

   (Path B only) extra budget thresholds ──► SNS ──► email     (warn-only, free)
   (Path A) the member's own existing alerts keep working, untouched
```

The IAM deny and the Lambda fire from the same action at the same threshold. The
deny handles the future; the Lambda handles the present. Both fully reversible.

## 6. Deployment

CDK is the whole delivery mechanism. `cdk deploy` synthesizes a CloudFormation
template into `cdk.out/` (gitignored) and hands it to CloudFormation. No
hand-written template is committed.

```bash
git clone https://github.com/Njones27/AWS_Budget_Radar && cd AWS_Budget_Radar
npm install
cp .env.example .env        # edit: email, path A/B, threshold, safety level
npx cdk bootstrap           # once per account/region — easy to forget; README step
npx cdk deploy
# then: confirm the SNS subscription email AWS sends you (§4.8)
```

Editing `.env` and re-running `cdk deploy` is also how settings change; there is
no separate update path.

**Teardown.** `npx cdk destroy` removes the watchdog. But it does not restart
resources the Lambda stopped, and it can conflict on a still-attached deny policy
(§4.11). So the order matters:

1. If the deny is applied or resources are stopped, **run recovery first** (§7.6)
   — it detaches the deny and restarts everything while the record still exists.
2. Then `npx cdk destroy`.

If a full budget period has passed the deny has already self-detached (§4.2), but
stopped resources still need a recovery run before destroy deletes the record.

## 7. Components

### 7.1 Repository layout

```
bin/budget-radar.ts           CDK entrypoint; loads and validates .env
lib/budget-radar-stack.ts     stack definition
lib/deny-policy.ts            the Deny policy document, isolated deliberately
lib/config.ts                 .env parsing and validation
lambda/handler.py             zero-dependency remediation handler (boto3 only)
.env.example                  the only file a member edits
restore.sh                    optional 3-line wrapper: aws lambda invoke restore mode
test-fire.sh                  publishes a synthetic budget notification
test/budget-radar.test.ts     CDK assertions (jest)
tests/test_handler.py         handler logic (pytest, stubbed boto3)
package.json  tsconfig.json  cdk.json  .gitignore
```

### 7.2 Stack resources

| Resource | Purpose |
|---|---|
| `SNS::Topic` | Alert spine. **Unencrypted** (§4.8), with a comment saying why |
| `SNS::TopicPolicy` | Allows `budgets.amazonaws.com` to publish, with confused-deputy conditions (§4.8) |
| `SNS::Subscription` | Email, from `ALERT_EMAIL`. Needs confirmation (§4.8) |
| `Lambda::Function` | Python 3.13, 512 MB, 300 s, `Code.fromAsset('lambda/')`, no deps |
| `IAM::Role` (Lambda) | Describe + reversible-stop actions; `Resource:"*"` (targets discovered at runtime) |
| `IAM::ManagedPolicy` | The Deny policy. Created but **not attached**; the action attaches it |
| `IAM::Role` (action) | Trusted by `budgets.amazonaws.com` with confused-deputy conditions |
| `Budgets::Budget` | **Path B only** — zero-spend cost budget + optional thresholds |
| `Budgets::BudgetsAction` | The trigger (§5). `BudgetName` = existing (A) or created (B) |
| `Budgets::Budget` ×N | Optional per-service notification-only budgets (free) |
| `SSM::Parameter` ×2 | Restore record (§7.5) and snooze timestamp (§7.6) |

### 7.3 The Deny policy

**A positive list of spend-causing actions. Never `Deny: *`.** Denies
`ec2:RunInstances`, `ec2:StartInstances`, `rds:CreateDBInstance`,
`rds:StartDBInstance`, `sagemaker:Create*`, `emr:RunJobFlow`,
`ecs:CreateService`, `ecs:UpdateService`, `autoscaling:UpdateAutoScalingGroup`,
`lambda:CreateFunction`.

**Explicitly untouched**, so the member can always recover: all `iam:*`, all
`budgets:*`, all read-only (`Describe*`/`List*`/`Get*`), `cloudformation:*`.

A test asserts the synthesized policy does **not** deny `iam:DetachUserPolicy` —
the difference between a safety tool and a lockout.

### 7.4 The Lambda handler

The handler dispatches on the event: `{"action":"restore"}` runs recovery (§7.6);
anything else is a budget-notification **stop**, described here.

0. **Check the snooze parameter** (§7.6). If snoozed and unexpired, publish
   "snoozed until X — taking no action" and exit.
1. **Best-effort scope.** Regex the budget name from the prose message (§4.7) to
   narrow to a single service if possible; otherwise **full sweep**.
2. **Enumerate enabled regions** via `DescribeRegions`. Sweeping every region is
   essential — forgotten resources hide in regions the owner never opens.
3. **Discover and filter.** Skip `BudgetRadar:Protect=true`. Skip anything with no
   reversible off switch.
4. **Act**, strictly in this order:
   1. ASG → `UpdateAutoScalingGroup` min/desired = 0 — **before EC2** (§4.9)
   2. EC2 → `StopInstances`
   3. Lambda → `PutFunctionConcurrency` reserved = 0
   4. ECS → `UpdateService` desiredCount = 0
   5. RDS → `StopDBInstance`
   6. SageMaker notebooks → `StopNotebookInstance`
5. **Record and report.** Merge into the SSM record (§7.5); email a summary that
   includes how to recover (§7.6).

**Never touched, always reported** under "still costing you money — needs your
decision": EMR clusters, SageMaker endpoints, NAT Gateways, unattached EIPs, S3
storage, stopped-instance EBS volumes.

**Idempotency.** The budget re-notifies up to three times daily; stopping an
already-stopped resource is a swallowed no-op.

**`DRY_RUN=true`** makes step 4 report-only: no mutating call is made.

### 7.5 Restore record

One SSM Parameter, JSON, keyed by budget period. **Writes merge; never replace** —
a second notification must not erase the first run's record, or recovery finds
nothing to undo. Missing/empty record: recovery still detaches the policy and
reports there was nothing to restart; it must not error. The record lives in the
stack, so it is deleted by `cdk destroy` — recover before you destroy (§4.11).

### 7.6 Recovery (Lambda restore mode)

The Lambda is dual-purpose. A normal budget notification triggers a **stop**; an
invocation carrying `{"action": "restore"}` triggers a **restore**. The member
runs it either from the Lambda console's Test button or with one command:

```bash
aws lambda invoke --function-name BudgetRadar \
  --payload '{"action":"restore"}' /dev/stdout
```

`restore.sh` is an optional three-line wrapper around exactly that call, for
members who prefer a script. It is not a separate implementation.

Restore, running as the Lambda's un-denied role (§4.10):

1. **Detach the Deny policy** from every configured target, so new launches work
   again. No IAM-propagation wait is needed — the Lambda was never denied.
2. **Restart from the SSM record** — start instances, restore Lambda reserved
   concurrency, scale ASGs and ECS services back to their *recorded* values (not
   guesses), start RDS instances, start SageMaker notebooks, across all regions.
3. **Apply a snooze** — write a snooze-until timestamp to SSM, **capped at 72
   hours**, so the still-breached budget does not immediately re-stop everything.
   Optional; the payload may set `{"action":"restore","snoozeHours":24}`.
4. **Report** by email: what was restarted, the snooze window, and the reminder
   that the deny also self-clears at the next budget period (§4.2).

**Recover before `cdk destroy`** (§4.11): destroy deletes the SSM record and can
conflict on the still-attached policy, so restore must run first.

**Total lockout escape hatch.** The Lambda's role is never a deny target, so it
can always detach the policy. If even that is somehow lost, the documented
fallback is to sign in as root and detach the policy in the IAM console.

### 7.7 Configuration

`.env`, read at synth time by `lib/config.ts`, validated before any construct is
created. Ships defaulting to the **safest posture**: zero-spend, ACTUAL,
report-only.

```bash
ALERT_EMAIL=you@uky.edu

# Path switch (§4.5). Empty = Path B: create a zero-spend budget below.
#                     Set   = Path A: attach to this existing budget by name.
EXISTING_BUDGET_NAME=

# Path B budget (ignored in Path A). 0.01 = zero-spend tripwire.
MONTHLY_BUDGET_USD=0.01
WARN_AT_PERCENT=80              # extra warn-only email threshold (Path B)

# When the teeth bite.
ACTION_THRESHOLD_PERCENT=100
ACTION_THRESHOLD_TYPE=ACTUAL    # ACTUAL, or FORECASTED to act before crossing (§4.1)

# Safety level (§8): watch | confirm | armed
SAFETY=watch

# Who the deny attaches to. Cannot restrain the root user (§8).
IAM_DENY_TARGET_USERS=
IAM_DENY_TARGET_GROUPS=
IAM_DENY_TARGET_ROLES=

# Optional per-service notification-only budgets. Exact AWS service names.
SERVICE_BUDGETS=

PROTECTED_TAG_KEY=BudgetRadar:Protect
```

**Validation (fails synth with an actionable message):** valid email; in Path B,
`MONTHLY_BUDGET_USD` > 0 and `WARN_AT_PERCENT` in 1–99; `ACTION_THRESHOLD_PERCENT`
in 1–100; `FORECASTED` warns it is meaningless on a zero-spend budget (§4.1);
`SAFETY` is one of the three values; the Lambda's own execution role is **not**
among the deny targets (would disable remediation silently); if all deny targets
are empty, warn loudly that new-spend blocking is off and skip the action's IAM
definition — the Lambda half still works.

### 7.8 `SAFETY` maps to two independent knobs

| `SAFETY` | Action `ApprovalModel` | Lambda `DRY_RUN` | Behavior on breach |
|---|---|---|---|
| `watch` (default) | `MANUAL` | `true` | Nothing mutates. You get a region-wide report and a deny action pending your console approval. |
| `confirm` | `MANUAL` | `false` | Lambda reversibly stops running resources automatically; the account-wide deny waits for your console approval. |
| `armed` | `AUTOMATIC` | `false` | Deny and stop-running both fire automatically. Full protection. |

Rationale: stopping *your own* running resources is reversible and low-regret, so
`confirm` automates it; the broader deny is the bigger hammer, so it asks first.

**Resolved (does not depend on path):** a `MANUAL` action notifies its SNS
subscribers at *trigger* time, in the `pending` state — not only after approval:

> "You receive a notification to inform you that an action is pending or has
> already run on your behalf, regardless of your action preferences."
> — *Reviewing and approving your budget action*

So in `confirm`, the Lambda fires immediately (stops running resources) while the
deny waits for console approval, and this works in **both** paths through the
action's own subscriber — no separate trigger. The action may notify a second
time when it later executes post-approval; the Lambda's idempotency (§7.4)
absorbs the duplicate.

## 8. Safety

1. **Default `SAFETY=watch`.** Out of the box, nothing mutates.
2. **Three graduated levels** (§7.8) — genuine escalating trust.
3. **Positive-list Deny policy** (§7.3), with a self-lockout test.
4. **Auto-detach at next period** (§4.2) — never a permanent lockout.
5. **`BudgetRadar:Protect=true`** exempts any resource.
6. **Recovery is a Lambda mode** (§7.6) running as the un-denied Lambda role, so
   it detaches the deny and restarts resources to recorded values in one pass,
   with a bounded 72-hour snooze. Recover before `cdk destroy` (§4.11).
7. **Reversible actions only.** No code path deletes or terminates anything.
8. **Cannot restrain the root user** (IAM deny does not apply to root). Documented
   prominently; a member operating as root gets the Lambda half only.

## 9. Testing

- **`tests/test_handler.py`** (pytest, stubbed boto3) — ordering (ASG before EC2),
  protect-tag exemption, `DRY_RUN` makes no mutating calls, idempotency, SSM
  merge-not-replace, prose-message parse + full-sweep fallback, no-op while
  snoozed.
- **`test/budget-radar.test.ts`** (jest + CDK assertions) — topic policy permits
  `budgets.amazonaws.com` with confused-deputy conditions; topic is unencrypted;
  exactly one action-enabled budget; Path A creates the action but **no** budget;
  Path B creates both; **deny policy does not deny `iam:*`**; `SAFETY` maps to the
  right `ApprovalModel`/`DRY_RUN`; config validation rejects bad input.
- **Restore-mode coverage** (pytest) — an `{"action":"restore"}` event detaches
  the deny and restarts ASG/ECS to their *recorded* values (not guesses) across
  regions; 72-hour snooze cap enforced; empty/missing SSM record exits cleanly
  without error.
- **`test-fire.sh`** — publishes a realistic **prose** budget notification (§4.7)
  to the live topic, exercising the deployed Lambda end to end.

## 10. Cost

| Item | Cost |
|---|---|
| The one action-enabled budget | Free — 1 of 2 free |
| Optional per-service budgets ×N | Free — no actions |
| Lambda / SNS email / SSM Standard | Free tier |
| **Total** | **$0** |

## 11. Future work

Deferred: Discord/Slack webhook; Cost Anomaly Detection as a faster second
trigger; a run-rate watcher for real-time protection (§4.1); Service Catalog
launch-type constraints as an alternative remediation (§3); opt-in destructive
tier for EMR and SageMaker endpoints; multi-account support.
