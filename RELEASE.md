# Release acceptance — AWS Budget Radar

## ⚠️ AUTHORIZATION BOUNDARY — READ FIRST

**Every check in this document deploys or mutates real AWS resources**
(budgets, budget actions, IAM policies, Lambda, SNS, S3, CloudWatch). Some
checks deliberately trigger the deny policy against a real IAM identity and
verify recovery from it.

- Run these checks **ONLY in a disposable AWS account** — one with no
  production workloads, no shared identities, and nothing you'd mind
  breaking or being billed for.
- Run these checks **ONLY after the maintainer has explicitly authorized
  deployment** for this purpose. This document does not itself constitute
  that authorization.
- **Passing unit tests (`npm test`, `pytest`) does NOT authorize these
  checks.** 55 Jest tests and 39 pytest tests passing locally means the code
  is internally consistent — it says nothing about what a live AWS account
  does when a budget action actually fires. Task 1–11 unit coverage and this
  release gate are separate, non-substitutable forms of verification.
- Nobody may run any check below — including the "no spurious runs" and
  "bounds" checks that don't obviously look destructive — without a
  maintainer's go-ahead for that specific session, on that specific
  disposable account.

If you are reading this to decide whether it's safe to deploy Budget Radar
to your own account: it is not "tested" in the live sense until every item
below has been executed and recorded, in a disposable account, with
sign-off. Until then, treat it as unit-tested code that has never touched
real AWS budget-action behavior.

---

## Contract under test

Budget Radar's deny policy blocks **selected creation and start operations**
by the IAM identities you configure — not resource creation only, and not
"all spend." Concretely, the deny includes actions such as `ec2:RunInstances`,
`ec2:StartInstances`, and `rds:StartDBInstance` (see `lib/` for the exact
action list) scoped to the identities in `IAM_DENY_TARGET_USERS`/`_GROUPS`/
`_ROLES`. It does **not** stop, terminate, or scale down anything already
running, and it does not affect identities outside the configured set (or
the root user, ever). Every acceptance check below should be read against
this contract, not a broader or narrower one.

---

## Release requirements (all must pass)

### 1. Deploy both paths
- **Path B** (`EXISTING_BUDGET_NAME` empty): Radar creates the monthly USD
  cost budget and attaches the action.
- **Path A** (a pre-made monthly USD cost budget supplied via
  `EXISTING_BUDGET_NAME`): Radar attaches the action to the existing budget
  and leaves the budget and its existing alerts/notifications unchanged.

Confirm both paths deploy cleanly and produce the expected budget/action
state in the Budgets console.

### 2. Preflight gate
`npm run deploy` must abort **before** `cdk deploy` runs when:
- a configured target identity cannot be resolved,
- an `AWSReservedSSO_*` role is targeted,
- (Path A only) the existing budget is non-monthly, non-USD, or scoped
  (has a cost filter) rather than an account-wide cost budget.

Run this twice:
- once with the student's **direct IAM credentials** (`aws configure` /
  environment credentials), confirming `preflight.ts` itself rejects the bad
  config before any AWS mutation;
- once through the actual **`npm run deploy` / CDK deploy path**, confirming
  the preflight gate is wired into the real deploy command and not just
  callable in isolation.

### 3. Email confirmation scope
Before confirming the SNS email subscription:
- Trip the budget (or simulate the action threshold) and verify the Lambda
  still runs and the deny action still fires. Email confirmation must gate
  **only the email deliverable**, not the action itself.

After confirming the SNS email subscription:
- Verify the inventory report email actually arrives in the inbox.

### 4. No spurious runs (two-topic isolation)
Confirm that:
- a warn-threshold budget notification (below the action threshold) does
  **not** invoke a second inventory run, and
- the Lambda's own report/notification traffic (its SNS publish, its own
  CloudWatch Logs) does **not** loop back and invoke a second inventory run.

The warn topic and the action/report topic must stay isolated in practice,
not just in code review.

### 5. Observed status
Confirm the emailed report shows the **real, observed** action status from
`DescribeBudgetAction` (e.g. `EXECUTION_SUCCESS`, or pending approval under
`watch`) — not merely the `SAFETY` mode from configuration. Verify this
under both `SAFETY=watch` (pending) and `SAFETY=armed` (executed).

### 6. Bounds
- **Denied read:** force a region/service call to return `AccessDenied` (e.g.
  strip a permission from the reporting role for one service) and confirm
  the report shows that region/service as **`failed`**, never silently
  reported as zero/empty.
- **Byte limit:** force a run whose report would exceed the SNS/email byte
  limit (e.g. a region with many resources) and confirm the report is
  summarized or split, and that the truncation/splitting is disclosed in the
  email itself.
- **Forced publish failure:** force the SNS publish to fail and confirm the
  Lambda invocation fails (is not swallowed), is retried per its configured
  retry policy, and ultimately lands in the failure/dead-letter queue.

### 7. Block + recovery, including RESTART
- **Block:** with `SAFETY=armed` (or after console approval under `watch`),
  confirm a covered identity's new-launch attempts
  (`ec2:RunInstances`, etc.) are denied.
- **Recovery → restart (required):** after the block is armed/applied,
  have the **recovery principal** (`RECOVERY_PRINCIPAL_ARN`) reverse the
  budget action / detach the deny policy. Then, using a **targeted
  (previously-denied) identity**, confirm it can now successfully:
  - **restart a previously-stopped EC2 instance** (`ec2:StartInstances`), and
  - **restart a previously-stopped RDS instance** (`rds:StartDBInstance`).

  This is the check that proves the deliberate start-blocking side effect
  documented in README §1 ("a targeted identity cannot restart its own
  stopped EC2/RDS instances while the block is active") is genuinely
  recoverable, not just theoretically reversible. Do not skip this — it is
  a required release item, not an optional nice-to-have.
- **Auto-detach:** separately, confirm (or document the observed timing of)
  the deny auto-detaching at the next budget period without any recovery
  action.

### 8. Teardown
Run `npx cdk destroy`:
- once while the deny is **armed/applied**,
- once while the deny is **tripped but not yet reversed**.

For each, record whether `cdk destroy` detaches and deletes the IAM policy
cleanly on its own, or requires reversing the budget action first (a managed
policy cannot be deleted while attached). Update spec §10 / README §8 with
the observed behavior — do not leave this as an assumption.

### 9. Capture artifacts
Save the **real** budget-action notification payloads observed during the
above runs — `pending`, `executed`, `reversed`, and `reset` — as fixtures for
regression tests. These should be actual payloads captured from the
disposable account, not hand-authored samples.

---

## Recording results

For each numbered item above, capture: date, account (redacted/disposable
account alias), the exact command(s) run, the observed outcome, and a
pass/fail. Attach or link the captured artifacts from item 9. A release is
not "accepted" until every item has a recorded pass in the same disposable
account within a single acceptance session (or a documented set of sessions
covering all items).
