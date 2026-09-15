# AWS Budget Radar — Design

**Date:** 2026-09-15 (rev 2, scope narrowed after external review)
**Status:** Approved for planning

## 1. Problem

A club member spins up AWS resources to learn, forgets about them, and discovers
the damage on a credit card statement. The dominant fear is "I'm going to wake up
having spent a ton of money." The common failure is a resource left running for
days because nobody was watching.

## 2. What Budget Radar is (and is not)

Budget Radar is a **low-cost safeguard for personal learning accounts.** When a
cost budget is breached, it **restricts new spend-causing operations by the IAM
identities you configure** and **emails you a region-wide inventory of what is
running and what is still costing money**, so you can investigate and shut things
down yourself.

It is **not a hard spending cap.** AWS budget data lags actual usage by hours;
charges can exceed the threshold before the alert arrives and continue after.
Unsupported services, storage, networking, commitments, and identities outside
the configured set can keep incurring charges. Budget Radar **never stops,
scales, or deletes any resource** — remediation is the member's, informed by the
report.

## 3. Goals

1. Clone, edit one `.env`, run `cdk deploy`. No console clicking.
2. Work whether or not a budget already exists (§2 paths below).
3. On breach: block new spend by the configured identities; email a complete,
   honest inventory including a "still costing you money" section.
4. Touch no running resource. Nothing to restore, nothing to break.
5. Safe to leave unattended: the block self-clears each budget period.
6. Fit typical free-tier usage; state the small costs that can still apply.

### Deployment paths

- **Path A — a budget already exists** (e.g. a zero-spend budget). Budget Radar
  attaches its action to that budget *by name* and never modifies the budget,
  its thresholds, or its alerts. The existing budget must be a **cost** budget
  (§5.6).
- **Path B — no budget exists.** Budget Radar creates a monthly USD **cost**
  budget with optional extra warn thresholds, plus the action.

Both resolve to the same action + trigger wiring (§6).

## 4. Non-goals

- **Stopping/scaling/deleting resources.** Report-only remediation in v1.
- **Real-time protection or a hard cap** (§5.1).
- **Multi-account / Organizations / SCPs.** Individual accounts.
- **A security/anti-bypass boundary.** The deny is accident-prevention for
  configured identities, not a control that a determined or differently-permed
  caller cannot route around (§7.3).
- **A portable hand-editable CloudFormation template.** CDK is the supported and
  only entry point (member decision). A CI-generated release template is possible
  future work, not v1.
- **Slack/Discord, dashboards, forecasting UI.**

## 5. Constraints that shaped the design

Verified facts, sources inline. Recorded so implementation does not "fix" a
deliberate choice.

### 5.1 Budget data lags; there is no hard cap

> "You might incur additional costs or usage that exceed your budget notification
> threshold before AWS Budgets can notify you, and your actual costs or usage may
> continue to increase … after you receive the notification." — *Billing & Cost Mgmt*

Data refreshes up to three times a day (8–12 h apart) and lags billing, which
lags usage. Polling faster cannot accelerate billing data. The tool is a
backstop, not a cap; the README says so plainly.

### 5.2 An ACTUAL alert fires once per period; the deny self-clears each period

> "Actual alerts are only sent out once per budget, per budget period, when a
> budget first reached the actual alert threshold." — *Best practices for AWS Budgets*
> "if no remediation action is taken, the restrictive IAM policy will be
> automatically detached at the start of the next budget period." — *AWS Cloud Ops Blog*

Two consequences: (a) v1 sends **one report per threshold per period** — there is
no re-notify loop, so no scheduler is built; a scheduled re-check is future work
(§13). FORECASTED thresholds can re-alert within a period and give earlier
warning (they need ~5 weeks of history). (b) The applied deny **auto-detaches at
the next period**, so the tool never permanently blocks the member.

### 5.3 A BudgetsAction is the trigger and requires an IAM definition + targets

> `ActionType`, `Definition`, `ExecutionRoleArn`, and `Subscribers` (min 1) are
> all **required**; `ActionType ∈ {APPLY_IAM_POLICY, APPLY_SCP_POLICY,
> RUN_SSM_DOCUMENTS}`. — *`AWS::Budgets::BudgetsAction` CFN reference*

There is **no notification-only action.** So blocking is core, and **IAM deny
targets are required** (validated at synth). The action references its budget by
a plain-string `BudgetName` (existing or created), so one wiring serves both
paths; a non-existent name fails at deploy — a free typo-guard.

### 5.4 Action-enabled budgets: first two free

> "Budgets without actions are free. You can create 2 actions-enabled budgets for
> free." — then $0.10/day. Adding an action to an already-action-enabled budget
> does not consume another slot. — *AWS Budgets pricing / FAQs*

One action-enabled budget → free. In Path A, our action consumes one of the
member's two free action slots (noted for anyone already using them).

### 5.5 The SNS facts that actually bite

From *"Creating an Amazon SNS topic for budget notifications"* and *SNS docs*:

- The topic needs a resource policy letting `budgets.amazonaws.com` `SNS:Publish`,
  guarded by `aws:SourceAccount` + `ArnLike aws:SourceArn arn:aws:budgets::<acct>:*`
  (confused-deputy). Omitting it silently breaks notifications.
- **Email** subscriptions require the member to click a confirmation link;
  until then that email endpoint gets nothing. The **same-account Lambda**
  subscription is auto-confirmed and the IAM action fires regardless — so it is
  wrong to say "nothing flows." The README calls out the email click as an
  onboarding step, scoped to email only.
- Encryption is **optional**, not forbidden: an encrypted topic works with an
  added KMS key grant. v1 leaves topics unencrypted as a simplicity choice (cost
  alerts, not secrets); a comment records the reason.

### 5.6 Validate the budget's semantics, not just its existence

> Budgets have a `BudgetType`, `TimeUnit`, `BudgetLimit` (amount + unit), and
> `CostTypes`; usage/RI/SP and service-filtered budgets do not protect total
> account cost. — *`Budget` / `CostTypes` API reference*

v1 supports **monthly USD COST** budgets. Path A validates the referenced budget
is a cost budget and warns if it is filtered/usage/non-USD; it never rewrites the
member's budget. Path B creates a monthly USD cost budget. **Credits and refunds**
are included by default and can hide gross usage behind a small net threshold;
the deployment summary records the chosen `CostTypes` treatment.

### 5.7 The IAM deny is identity-scoped, and CloudFormation can bypass it

The deny affects only the configured users/groups/roles and listed actions. Other
roles, AWS service roles, and — if configured — the CloudFormation service role
run under their own permissions and are unaffected; the root user ignores it
entirely. So it is accident-prevention, not a boundary. The deploy summary reports
exactly which identities are covered; the README recommends a dedicated learning
identity and keeping recovery/admin access separate.

## 6. Architecture

Two SNS topics keep triggers and reports from crossing (the single-topic design
would let an 80% warning invoke the Lambda and let the Lambda's report re-invoke
itself):

```
   Budget (Path A: existing by name | Path B: created, monthly USD cost)
        |
        |  ActionThreshold e.g. 100% ACTUAL
        v
   AWS::Budgets::BudgetsAction  (APPLY_IAM_POLICY; targets REQUIRED)
        |                                   \
        |  Definition attaches deny  ────────► blocks NEW spend by configured IDs
        |  Subscribers → TriggerTopic
        v
   TriggerTopic ──► Report Lambda (READ-ONLY inventory) ──► ReportTopic ──► email
                                                                 ^
   (Path B) extra warn thresholds ─────────────────────────────-┘  (email only)
```

- **TriggerTopic**: only the BudgetsAction publishes here; only the Lambda
  subscribes. The Lambda validates the message came from here and otherwise
  reports unconditionally (it never parses prose to decide scope).
- **ReportTopic**: the Lambda and any warn-only thresholds publish here; only
  email subscribes. The Lambda never subscribes to it → no recursion.

## 7. Components

### 7.1 Repository layout

```
bin/budget-radar.ts           CDK entrypoint; loads and validates .env
lib/budget-radar-stack.ts     stack definition
lib/deny-policy.ts            the Deny policy document, isolated for review
lib/config.ts                 .env parsing and validation
lambda/handler.py             read-only inventory reporter (boto3 only, no deps)
.env.example                  the only file a member edits
test/budget-radar.test.ts     CDK assertions (jest)
tests/test_handler.py         handler logic (pytest, stubbed boto3)
package.json  tsconfig.json  cdk.json  .gitignore
```

No `restore.sh`, no journal, no DynamoDB, no scheduler — none are needed when the
tool changes no resource.

### 7.2 Stack resources

| Resource | Purpose |
|---|---|
| `SNS::Topic` TriggerTopic | Action → Lambda. Unencrypted (§5.5) |
| `SNS::Topic` ReportTopic | Lambda + warnings → email. Unencrypted |
| `SNS::TopicPolicy` ×2 | Allow `budgets.amazonaws.com` publish, confused-deputy conditions |
| `SNS::Subscription` (email) | On ReportTopic; needs confirmation (§5.5) |
| `SNS::Subscription` (lambda) | On TriggerTopic; auto-confirmed |
| `Lambda::Function` | Python 3.13, 512 MB, 300 s, `Code.fromAsset('lambda/')`, no deps |
| `Logs::LogGroup` | Explicit, short retention (e.g. 30 d) to bound log cost |
| `IAM::Role` (Lambda) | Read-only describe/list across services + publish to ReportTopic |
| `IAM::ManagedPolicy` | The Deny policy. Created unattached; the action attaches it |
| `IAM::Role` (action) | Trusted by `budgets.amazonaws.com`, confused-deputy conditions; may attach/detach the deny |
| `Budgets::Budget` | Path B only — monthly USD cost budget + optional warn thresholds |
| `Budgets::BudgetsAction` | Trigger + deny. Targets required |
| `Budgets::Budget` ×N | Optional per-service cost budgets, warn-only → ReportTopic (free) |

### 7.3 The Deny policy

**A positive list of new-spend actions. Never `Deny: *`.** e.g.
`ec2:RunInstances`, `rds:CreateDBInstance`, `rds:CreateDBCluster`,
`elasticmapreduce:RunJobFlow` (correct IAM prefix — not `emr:`),
`sagemaker:CreateNotebookInstance`/`CreateEndpoint`, `ecs:RunTask`/`CreateService`,
`autoscaling:CreateAutoScalingGroup`, `lambda:CreateFunction`. The exact list gets
a service-by-service review and a live test asserting it blocks a representative
launch. It deliberately **denies creation, not cost-reducing or cleanup APIs.**

**Explicitly untouched**, so the member never locks themselves out: all `iam:*`,
all `budgets:*`, all read-only (`Describe*`/`List*`/`Get*`), `cloudformation:*`.
A test asserts the synthesized policy does not deny `iam:DetachUserPolicy`.

### 7.4 The Lambda (read-only reporter)

1. **Validate** the event arrived via TriggerTopic; otherwise log and exit. It
   does **not** parse the message body — it always reports the full inventory.
2. **Enumerate enabled regions** (`DescribeRegions`), paginating every list call.
3. **Inventory**, resiliently (per-region/service failures are caught and
   reported, never fatal): running EC2 (+ ASG membership noted), RDS/Aurora,
   ECS services/tasks, Lambda functions with reserved/provisioned concurrency,
   SageMaker notebooks/endpoints, plus a **"still costing you money"** section:
   EBS volumes, NAT gateways, unattached EIPs, load balancers, S3 buckets by
   size class, and a catch-all "other services with spend — investigate."
4. **Email** via ReportTopic: what is running, per region, each line labeled
   **detected / unsupported / potential ongoing charge**, with a header stating
   the deny is now applied (or pending approval in `watch`), how to lift it, and
   that this inventory is not a guarantee that all spend was found.

The handler makes **no mutating call**, so there is no dry-run to gate and no
resource-safety ordering to get wrong.

### 7.5 Configuration

`.env`, read and validated at synth by `lib/config.ts`. Ships at the safest
posture: monthly cost budget, ACTUAL, `watch`.

```bash
ALERT_EMAIL=you@uky.edu

# Path switch. Empty = Path B (create). Set = Path A (attach by name).
EXISTING_BUDGET_NAME=

# Path B budget (ignored in Path A).
MONTHLY_BUDGET_USD=5            # user-set allowance; 0.01 = first-charge tripwire preset
WARN_AT_PERCENT=80              # extra warn-only email threshold

ACTION_THRESHOLD_PERCENT=100
ACTION_THRESHOLD_TYPE=ACTUAL    # or FORECASTED for earlier / repeatable alerts (§5.2)

SAFETY=watch                    # watch = deny waits for console approval; armed = deny auto-applies

# REQUIRED (§5.3): identities the deny attaches to. Root is never covered (§5.7).
IAM_DENY_TARGET_USERS=
IAM_DENY_TARGET_GROUPS=
IAM_DENY_TARGET_ROLES=

# Optional warn-only per-service cost budgets. Exact AWS service names.
SERVICE_BUDGETS=
```

**Validation (fails synth with an actionable message):** valid email; **at least
one IAM deny target** (§5.3); Path B `MONTHLY_BUDGET_USD` > 0 and `WARN_AT_PERCENT`
1–99; `ACTION_THRESHOLD_PERCENT` 1–100; `FORECASTED` warns it is meaningless on a
zero-spend budget and needs history; `SAFETY ∈ {watch, armed}`; the Lambda's own
execution role and the action role are **not** among the deny targets.

### 7.6 `SAFETY`

| `SAFETY` | Action `ApprovalModel` | On breach |
|---|---|---|
| `watch` (default) | `MANUAL` | You get the inventory email + a deny **pending your console approval**. Nothing is blocked until you approve. |
| `armed` | `AUTOMATIC` | Deny applies automatically; you get the inventory email. |

A `MANUAL` action notifies subscribers at *pending* time (verified: *"a
notification to inform you that an action is pending … regardless of your action
preferences"*), so the report is sent in both modes.

## 8. Coverage and honest gaps

The report **describes**; it does not act. Coverage is "what we detect and label,"
with explicit gaps so the inventory is never mistaken for a full bill assessment.

| Area | Reported | Note |
|---|---|---|
| EC2 (standalone / ASG) | Running instances, ASG membership | Not stopped; EBS/addressing costs continue |
| RDS / Aurora | Instances and clusters | Aurora is a cluster; storage/backups bill regardless |
| ECS / Fargate | Services, standalone tasks | REPLICA/DAEMON distinguished in text |
| Lambda | Functions; reserved vs provisioned concurrency | Provisioned concurrency bills separately |
| SageMaker | Notebooks, endpoints | Endpoints/Studio/jobs bill regardless |
| Storage/network | EBS, S3 size class, NAT GW, EIP, LB | Common silent spend |
| Not enumerated | EKS control plane, OpenSearch, ElastiCache, commitments/SP/RI, data transfer | Listed in README as known gaps |

## 9. Safety

1. **Default `SAFETY=watch`** — nothing is blocked without your approval.
2. **Touches no resource** — the entire stop/scale/delete failure class is out of
   scope, so ASG termination, self-throttle, and lost data cannot occur.
3. **Positive-list deny** (§7.3) with a self-lockout test; never restrains itself,
   IAM, budgets, or read access.
4. **Deny auto-detaches next period** (§5.2) — never a permanent block.
5. **Identity-scoped, honestly framed** (§5.7).

## 10. Teardown

`npx cdk destroy` removes the watchdog and the deny policy resource. But a managed
policy cannot be deleted while attached, and CloudFormation (via the API) does not
auto-detach. So **if the deny is currently applied, first reverse the budget
action in the console (or wait for the period reset, when it self-detaches), then
`cdk destroy`.** No resource restart is ever required to uninstall, because
nothing was stopped. (Whether deleting the action detaches the policy cleanly is a
live-test item.)

## 11. Testing / acceptance

- **`tests/test_handler.py`** (pytest, stubbed boto3) — full-inventory regardless
  of message body; per-region/service failure is caught and still reports;
  pagination; **no mutating call is ever made**; publishes only to ReportTopic.
- **`test/budget-radar.test.ts`** (jest + CDK assertions) — two distinct topics
  with correct publisher/subscriber wiring; both topic policies carry
  confused-deputy conditions; Path A creates the action but no budget, Path B
  creates both; the action has ≥1 target or synth fails; **deny does not deny
  `iam:*`** and uses `elasticmapreduce:`; `SAFETY` maps to the right
  `ApprovalModel`; config validation rejects empty targets, bad email, self-target.
- **Live acceptance (disposable account), before "plug-and-play":** email
  confirmation gates only email; a warn threshold and the Lambda's report **never**
  invoke a second run; deploy works Path A (budget + subs preserved) and Path B;
  in `watch` nothing is attached until approval; capture real pending/executed/
  reversed/reset action events; confirm teardown works while armed and while
  tripped.

## 12. Cost

Designed for near-zero cost on a learning account; **not guaranteed $0.**

| Item | Cost |
|---|---|
| One action-enabled budget | Free (1 of 2) |
| Optional per-service budgets | Free (no actions) |
| Lambda, SNS email | Free tier for this volume |
| CloudWatch Logs | Small; bounded by 30-day retention |
| CDK bootstrap S3 assets | Small storage cost, shared |

The deploy summary publishes an estimate. Note: on a $0.01 tripwire, the
watchdog's own trivial usage could itself trip the budget — call this out.

## 13. Prior art and future work

**Prior art:** AWS's own *Budget Controls for AWS* (awslabs) does automated,
tagged remediation with separate action/report topics — but single-region, with
an AWS Config dependency and higher run cost. Budget Radar is intentionally
smaller: report-only remediation, cross-region inventory, existing-budget reuse,
near-zero cost. Compare before extending.

**Future work (each its own spec):** scheduled re-check / reconciliation via
EventBridge Scheduler; an opt-in *safe* stop subset (EC2/RDS/notebook stop only,
with a durable DynamoDB journal, write-before-mutate, and hard self-exclusion;
ASG/ECS/Aurora would stay report-only because scale-in terminates); a
CI-generated portable release template; Slack/Discord; Cost Anomaly Detection as
a faster trigger.
