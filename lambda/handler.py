"""Budget Radar reporter handler.

Read-only reporter: validates that invocation came from the TriggerTopic,
observes the current status of the configured budget action, and (in
Tasks 8-9) inventories running resources and publishes a report to SNS.

No workload or IAM mutation is ever performed here.
"""

import os
import datetime as dt
import boto3


def _client(service, region=None):
    return boto3.client(service, region_name=region) if region else boto3.client(service)


def _now_iso():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def observe_action_status(account_id, budget_name, action_id):
    """Return (observed_status, observation_iso). ('UNKNOWN', ts) if the lookup fails."""
    try:
        c = _client("budgets")
        resp = c.describe_budget_action(AccountId=account_id, BudgetName=budget_name, ActionId=action_id)
        return resp["Action"]["Status"], _now_iso()
    except Exception:
        return "UNKNOWN", _now_iso()


def enabled_regions():
    """Discover enabled regions to inventory. Implemented in Task 8."""
    raise NotImplementedError("enabled_regions is implemented in Task 8")


def _from_trigger_topic(event):
    want = os.environ.get("TRIGGER_TOPIC_ARN")
    for rec in event.get("Records", []):
        if rec.get("Sns", {}).get("TopicArn") == want:
            return True
    return False


def handler(event, context):
    if not _from_trigger_topic(event):
        print("Event not from TriggerTopic; ignoring.")
        return {"status": "ignored"}
    # Inventory + report added in Tasks 8-9.
    return {"status": "ok"}
