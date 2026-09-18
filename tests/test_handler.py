import datetime as dt
import time
from botocore.stub import Stubber
import botocore.config
import boto3
import handler

def _budgets_stub(status):
    client = boto3.client("budgets", region_name="us-east-1")
    stub = Stubber(client)
    stub.add_response("describe_budget_action",
        {"AccountId": "111122223333", "BudgetName": "b",
         "Action": {"ActionId": "11111111-1111-1111-1111-111111111111", "BudgetName": "b",
                    "NotificationType": "ACTUAL",
                    "ActionType": "APPLY_IAM_POLICY",
                    "ActionThreshold": {"ActionThresholdValue": 100.0, "ActionThresholdType": "PERCENTAGE"},
                    "Definition": {}, "ExecutionRoleArn": "arn:aws:iam::111122223333:role/r",
                    "ApprovalModel": "MANUAL", "Status": status,
                    "Subscribers": [{"SubscriptionType": "EMAIL", "Address": "test@example.com"}]}},
        {"AccountId": "111122223333", "ActionId": "11111111-1111-1111-1111-111111111111", "BudgetName": "b"})
    return client, stub

def test_observe_action_status_reads_observed_status(monkeypatch):
    client, stub = _budgets_stub("EXECUTION_SUCCESS")
    stub.activate()
    monkeypatch.setattr(handler, "_client", lambda svc, region=None: client)
    monkeypatch.setenv("ACCOUNT_ID", "111122223333")
    status, ts, details = handler.observe_action_status("111122223333", "b", "11111111-1111-1111-1111-111111111111")
    assert status == "EXECUTION_SUCCESS"
    assert ts  # ISO timestamp present
    assert details["threshold_value"] == 100.0
    assert details["threshold_type"] == "PERCENTAGE"
    assert details["notification_type"] == "ACTUAL"  # real, separate top-level Action field

def test_observe_action_status_unknown_on_failure(monkeypatch):
    def boom(svc, region=None):
        raise RuntimeError("no perms")
    monkeypatch.setattr(handler, "_client", boom)
    status, ts, details = handler.observe_action_status("x", "b", "a")
    assert status == "UNKNOWN"
    assert details is None

def test_handler_ignores_events_not_from_trigger_topic(monkeypatch):
    monkeypatch.setenv("TRIGGER_TOPIC_ARN", "arn:aws:sns:us-east-1:111122223333:Trigger")
    # An event from a different topic must not proceed to inventory/publish.
    called = {"inventory": False}
    monkeypatch.setattr(handler, "enabled_regions", lambda: (_ for _ in ()).throw(AssertionError("should not run")))
    event = {"Records": [{"Sns": {"TopicArn": "arn:aws:sns:us-east-1:111122223333:SomethingElse", "Message": "x"}}]}
    result = handler.handler(event, None)
    assert result["status"] == "ignored"


def test_from_trigger_topic_false_when_unset(monkeypatch):
    monkeypatch.delenv("TRIGGER_TOPIC_ARN", raising=False)
    event = {"Records": [{"Sns": {"TopicArn": "", "Message": "x"}}]}
    assert handler._from_trigger_topic(event) is False


def test_handler_calls_enabled_regions_and_inventory_when_triggered(monkeypatch):
    monkeypatch.setenv("TRIGGER_TOPIC_ARN", "arn:aws:sns:us-east-1:111122223333:Trigger")
    monkeypatch.setenv("ACCOUNT_ID", "111122223333")
    monkeypatch.setenv("BUDGET_NAME", "b")
    monkeypatch.setenv("ACTION_ID", "11111111-1111-1111-1111-111111111111")
    monkeypatch.setenv("REPORT_TOPIC_ARN", "arn:aws:sns:us-east-1:111122223333:Report")
    called = {"enabled_regions": False, "inventory": False, "publish": False}

    def fake_enabled_regions():
        called["enabled_regions"] = True
        return ["us-east-1"]

    def fake_inventory(regions, deadline_epoch):
        called["inventory"] = True
        assert regions == ["us-east-1"]
        return {"areas": [], "generated": "2024-01-01T00:00:00+00:00"}

    def fake_observe_action_status(account_id, budget_name, action_id):
        return "EXECUTION_SUCCESS", "2024-01-01T00:00:00+00:00", None

    def fake_publish(topic_arn, subject, body):
        called["publish"] = True

    monkeypatch.setattr(handler, "enabled_regions", fake_enabled_regions)
    monkeypatch.setattr(handler, "inventory", fake_inventory)
    monkeypatch.setattr(handler, "observe_action_status", fake_observe_action_status)
    monkeypatch.setattr(handler, "s3_bucket_sizes", lambda deadline_epoch=None: [])
    monkeypatch.setattr(handler, "publish", fake_publish)
    event = {"Records": [{"Sns": {"TopicArn": "arn:aws:sns:us-east-1:111122223333:Trigger", "Message": "x"}}]}
    result = handler.handler(event, None)
    assert result["status"] == "reported"
    assert result["action_status"] == "EXECUTION_SUCCESS"
    assert called["enabled_regions"] is True
    assert called["inventory"] is True
    assert called["publish"] is True


# --- Task 8: region enumeration + inventory coverage-state framework ---

def test_enabled_regions(monkeypatch):
    client = boto3.client("ec2", region_name="us-east-1")
    stub = Stubber(client)
    stub.add_response("describe_regions",
        {"Regions": [{"RegionName": "us-east-1"}, {"RegionName": "eu-west-1"}]}, {})
    stub.activate()
    monkeypatch.setattr(handler, "_client", lambda svc, region=None: client)
    assert handler.enabled_regions() == ["us-east-1", "eu-west-1"]


def test_denied_read_is_reported_failed_not_zero(monkeypatch):
    def adapter_fail(region, deadline=None):
        raise RuntimeError("AccessDenied")
    monkeypatch.setattr(handler, "ADAPTERS", {"ec2-instances": adapter_fail})
    monkeypatch.setattr(handler, "enabled_regions", lambda: ["us-east-1"])
    result = handler.inventory(["us-east-1"], deadline_epoch=time.time() + 60)
    areas = result["areas"]
    ec2 = [a for a in areas if a["service"] == "ec2-instances"][0]
    assert ec2["state"] == "failed"
    assert "AccessDenied" in ec2.get("error", "")


def test_deadline_marks_unscanned(monkeypatch):
    monkeypatch.setattr(handler, "ADAPTERS", {"ec2-instances": lambda r, deadline=None: []})
    result = handler.inventory(["us-east-1", "eu-west-1"], deadline_epoch=time.time() - 1)  # already past
    assert any(a["state"] == "not_scanned" for a in result["areas"])


def test_deadline_marks_unscanned_mid_scan(monkeypatch):
    """A real mid-scan expiry (not a pre-expired deadline): the deadline is
    still fine for the first region/adapter combo, then crossed partway
    through the scan -> earlier areas complete, later ones are not_scanned."""
    monkeypatch.setattr(handler, "ADAPTERS", {
        "svc-a": lambda r, deadline=None: [f"item-a-{r}"],
        "svc-b": lambda r, deadline=None: [f"item-b-{r}"],
    })
    clock = {"t": 0.0}

    def fake_time():
        clock["t"] += 1
        return clock["t"]

    monkeypatch.setattr(handler.time, "time", fake_time)
    # tick 1 (pre-check for region1/svc-a) = 1.0, not past; tick 2 (pre-check
    # for region1/svc-b) = 2.0, past -> everything from there on is not_scanned.
    result = handler.inventory(["us-east-1", "eu-west-1"], deadline_epoch=1.5)
    areas = result["areas"]
    assert areas[0]["state"] == "complete"
    assert areas[0]["items"] == ["item-a-us-east-1"]
    assert all(a["state"] == "not_scanned" for a in areas[1:])


def _assert_adapter_failure(monkeypatch, service, adapter_name, adapter_fn, error_op, error_code="AccessDenied"):
    """Shared helper: stub `error_op` to fail, run the single named adapter through
    the real inventory() framework, and assert the failure surfaces as FAILED
    (never silently as EMPTY/zero)."""
    client = boto3.client(service, region_name="us-east-1")
    stub = Stubber(client)
    stub.add_client_error(error_op, service_error_code=error_code, service_message=error_code)
    stub.activate()
    monkeypatch.setattr(handler, "_client", lambda svc, region=None: client)
    monkeypatch.setattr(handler, "ADAPTERS", {adapter_name: adapter_fn})
    result = handler.inventory(["us-east-1"], deadline_epoch=time.time() + 60)
    area = result["areas"][0]
    assert area["state"] == "failed"
    assert error_code in area.get("error", "")


# --- ec2-instances ---

def test_ec2_instances_returns_items(monkeypatch):
    client = boto3.client("ec2", region_name="us-east-1")
    stub = Stubber(client)
    stub.add_response("describe_instances",
        {"Reservations": [{"Instances": [{"InstanceId": "i-1", "InstanceType": "t3.micro"}]}]},
        {"Filters": [{"Name": "instance-state-name", "Values": ["running", "pending"]}]})
    stub.activate()
    monkeypatch.setattr(handler, "_client", lambda svc, region=None: client)
    assert handler._ec2_instances("us-east-1") == ["i-1 t3.micro in us-east-1"]


def test_ec2_instances_access_failure_is_failed(monkeypatch):
    _assert_adapter_failure(monkeypatch, "ec2", "ec2-instances", handler._ec2_instances, "describe_instances")


# --- rds-instances ---

def test_rds_instances_returns_items(monkeypatch):
    client = boto3.client("rds", region_name="us-east-1")
    stub = Stubber(client)
    stub.add_response("describe_db_instances",
        {"DBInstances": [{"DBInstanceIdentifier": "db1", "DBInstanceClass": "db.t3.micro"}]}, {})
    stub.activate()
    monkeypatch.setattr(handler, "_client", lambda svc, region=None: client)
    assert handler._rds_instances("us-east-1") == ["db1 db.t3.micro in us-east-1"]


def test_rds_instances_access_failure_is_failed(monkeypatch):
    _assert_adapter_failure(monkeypatch, "rds", "rds-instances", handler._rds_instances, "describe_db_instances")


# --- rds-clusters ---

def test_rds_clusters_returns_items(monkeypatch):
    client = boto3.client("rds", region_name="us-east-1")
    stub = Stubber(client)
    stub.add_response("describe_db_clusters",
        {"DBClusters": [{"DBClusterIdentifier": "cluster1", "EngineMode": "provisioned"}]}, {})
    stub.activate()
    monkeypatch.setattr(handler, "_client", lambda svc, region=None: client)
    assert handler._rds_clusters("us-east-1") == ["cluster1 provisioned in us-east-1"]


def test_rds_clusters_access_failure_is_failed(monkeypatch):
    _assert_adapter_failure(monkeypatch, "rds", "rds-clusters", handler._rds_clusters, "describe_db_clusters")


# --- ecs-services ---

def test_ecs_services_returns_items(monkeypatch):
    client = boto3.client("ecs", region_name="us-east-1")
    stub = Stubber(client)
    cluster_arn = "arn:aws:ecs:us-east-1:111122223333:cluster/c1"
    service_arn = "arn:aws:ecs:us-east-1:111122223333:service/c1/s1"
    stub.add_response("list_clusters", {"clusterArns": [cluster_arn]}, {})
    stub.add_response("list_services", {"serviceArns": [service_arn]}, {"cluster": cluster_arn})
    stub.add_response("describe_services",
        {"services": [{"serviceName": "s1", "runningCount": 2}], "failures": []},
        {"cluster": cluster_arn, "services": [service_arn]})
    stub.activate()
    monkeypatch.setattr(handler, "_client", lambda svc, region=None: client)
    assert handler._ecs_services("us-east-1") == ["s1 (2 running, REPLICA) in us-east-1"]


def test_ecs_services_access_failure_is_failed(monkeypatch):
    _assert_adapter_failure(monkeypatch, "ecs", "ecs-services", handler._ecs_services, "list_clusters")


# --- ecs-tasks (standalone, RunTask) ---

def test_ecs_tasks_returns_items(monkeypatch):
    client = boto3.client("ecs", region_name="us-east-1")
    stub = Stubber(client)
    cluster_arn = "arn:aws:ecs:us-east-1:111122223333:cluster/c1"
    task_arn = "arn:aws:ecs:us-east-1:111122223333:task/c1/abc123"
    stub.add_response("list_clusters", {"clusterArns": [cluster_arn]}, {})
    stub.add_response("list_tasks", {"taskArns": [task_arn]}, {"cluster": cluster_arn})
    stub.add_response("describe_tasks",
        {"tasks": [{"taskArn": task_arn, "lastStatus": "RUNNING"}], "failures": []},
        {"cluster": cluster_arn, "tasks": [task_arn]})
    stub.activate()
    monkeypatch.setattr(handler, "_client", lambda svc, region=None: client)
    assert handler._ecs_tasks("us-east-1") == ["abc123 RUNNING in us-east-1"]


def test_ecs_tasks_access_failure_is_failed(monkeypatch):
    _assert_adapter_failure(monkeypatch, "ecs", "ecs-tasks", handler._ecs_tasks, "list_clusters")


# --- lambda-functions ---

def test_lambda_functions_returns_items(monkeypatch):
    client = boto3.client("lambda", region_name="us-east-1")
    stub = Stubber(client)
    stub.add_response("list_functions", {"Functions": [{"FunctionName": "fn1", "Runtime": "python3.13"}]}, {})
    stub.add_response("get_function_concurrency", {"ReservedConcurrentExecutions": 5}, {"FunctionName": "fn1"})
    stub.activate()
    monkeypatch.setattr(handler, "_client", lambda svc, region=None: client)
    assert handler._lambda_functions("us-east-1") == ["fn1 python3.13 reserved=5 in us-east-1"]


def test_lambda_functions_access_failure_is_failed(monkeypatch):
    _assert_adapter_failure(monkeypatch, "lambda", "lambda-functions", handler._lambda_functions, "list_functions")


# --- lambda-provisioned-concurrency ---

def test_lambda_provisioned_concurrency_returns_items(monkeypatch):
    client = boto3.client("lambda", region_name="us-east-1")
    stub = Stubber(client)
    stub.add_response("list_functions", {"Functions": [{"FunctionName": "fn1", "Runtime": "python3.13"}]}, {})
    stub.add_response("list_provisioned_concurrency_configs",
        {"ProvisionedConcurrencyConfigs": [{
            "FunctionArn": "arn:aws:lambda:us-east-1:111122223333:function:fn1:LIVE",
            "AllocatedProvisionedConcurrentExecutions": 3}]},
        {"FunctionName": "fn1"})
    stub.activate()
    monkeypatch.setattr(handler, "_client", lambda svc, region=None: client)
    assert handler._lambda_provisioned_concurrency("us-east-1") == ["fn1:LIVE allocated=3 in us-east-1"]


def test_lambda_provisioned_concurrency_access_failure_is_failed(monkeypatch):
    _assert_adapter_failure(monkeypatch, "lambda", "lambda-provisioned-concurrency",
                             handler._lambda_provisioned_concurrency, "list_functions")


# --- sagemaker-notebooks ---

def test_sagemaker_notebooks_returns_items(monkeypatch):
    client = boto3.client("sagemaker", region_name="us-east-1")
    stub = Stubber(client)
    stub.add_response("list_notebook_instances", {"NotebookInstances": [{
        "NotebookInstanceName": "nb1",
        "NotebookInstanceArn": "arn:aws:sagemaker:us-east-1:111122223333:notebook-instance/nb1",
        "InstanceType": "ml.t3.medium"}]}, {})
    stub.activate()
    monkeypatch.setattr(handler, "_client", lambda svc, region=None: client)
    assert handler._sagemaker_notebooks("us-east-1") == ["nb1 ml.t3.medium in us-east-1"]


def test_sagemaker_notebooks_access_failure_is_failed(monkeypatch):
    _assert_adapter_failure(monkeypatch, "sagemaker", "sagemaker-notebooks",
                             handler._sagemaker_notebooks, "list_notebook_instances")


# --- sagemaker-endpoints ---

def test_sagemaker_endpoints_returns_items(monkeypatch):
    client = boto3.client("sagemaker", region_name="us-east-1")
    stub = Stubber(client)
    stub.add_response("list_endpoints", {"Endpoints": [{
        "EndpointName": "ep1",
        "EndpointArn": "arn:aws:sagemaker:us-east-1:111122223333:endpoint/ep1",
        "CreationTime": dt.datetime(2024, 1, 1),
        "LastModifiedTime": dt.datetime(2024, 1, 1),
        "EndpointStatus": "InService"}]}, {})
    stub.activate()
    monkeypatch.setattr(handler, "_client", lambda svc, region=None: client)
    assert handler._sagemaker_endpoints("us-east-1") == ["ep1 InService in us-east-1"]


def test_sagemaker_endpoints_access_failure_is_failed(monkeypatch):
    _assert_adapter_failure(monkeypatch, "sagemaker", "sagemaker-endpoints",
                             handler._sagemaker_endpoints, "list_endpoints")


# --- eips-unattached ---

def test_eips_unattached_returns_items(monkeypatch):
    client = boto3.client("ec2", region_name="us-east-1")
    stub = Stubber(client)
    stub.add_response("describe_addresses", {"Addresses": [
        {"PublicIp": "1.2.3.4", "AllocationId": "eipalloc-1"},  # unattached: no AssociationId
        {"PublicIp": "5.6.7.8", "AllocationId": "eipalloc-2", "AssociationId": "eipassoc-1"}  # attached
    ]}, {})
    stub.activate()
    monkeypatch.setattr(handler, "_client", lambda svc, region=None: client)
    assert handler._eips_unattached("us-east-1") == ["1.2.3.4 eipalloc-1 in us-east-1"]


def test_eips_unattached_access_failure_is_failed(monkeypatch):
    _assert_adapter_failure(monkeypatch, "ec2", "eips-unattached", handler._eips_unattached, "describe_addresses")


# --- load-balancers ---

def test_load_balancers_returns_items(monkeypatch):
    client = boto3.client("elbv2", region_name="us-east-1")
    stub = Stubber(client)
    stub.add_response("describe_load_balancers",
        {"LoadBalancers": [{"LoadBalancerName": "lb1", "Type": "application"}]}, {})
    stub.activate()
    monkeypatch.setattr(handler, "_client", lambda svc, region=None: client)
    assert handler._load_balancers("us-east-1") == ["lb1 application in us-east-1"]


def test_load_balancers_access_failure_is_failed(monkeypatch):
    _assert_adapter_failure(monkeypatch, "elbv2", "load-balancers", handler._load_balancers, "describe_load_balancers")


# --- ebs-volumes ---

def test_ebs_volumes_returns_items(monkeypatch):
    client = boto3.client("ec2", region_name="us-east-1")
    stub = Stubber(client)
    stub.add_response("describe_volumes",
        {"Volumes": [{"VolumeId": "vol-1", "Size": 100, "State": "in-use"}]}, {})
    stub.activate()
    monkeypatch.setattr(handler, "_client", lambda svc, region=None: client)
    assert handler._ebs_volumes("us-east-1") == ["vol-1 100GiB in-use in us-east-1"]


def test_ebs_volumes_access_failure_is_failed(monkeypatch):
    _assert_adapter_failure(monkeypatch, "ec2", "ebs-volumes", handler._ebs_volumes, "describe_volumes")


# --- nat-gateways ---

def test_nat_gateways_returns_items(monkeypatch):
    client = boto3.client("ec2", region_name="us-east-1")
    stub = Stubber(client)
    stub.add_response("describe_nat_gateways",
        {"NatGateways": [{"NatGatewayId": "nat-1", "State": "available"}]}, {})
    stub.activate()
    monkeypatch.setattr(handler, "_client", lambda svc, region=None: client)
    assert handler._nat_gateways("us-east-1") == ["nat-1 available in us-east-1"]


def test_nat_gateways_access_failure_is_failed(monkeypatch):
    _assert_adapter_failure(monkeypatch, "ec2", "nat-gateways", handler._nat_gateways, "describe_nat_gateways")


def test_adapters_registry_has_every_expected_service():
    assert set(handler.ADAPTERS.keys()) == {
        "ec2-instances", "rds-instances", "rds-clusters",
        "ecs-services", "ecs-tasks",
        "lambda-functions", "lambda-provisioned-concurrency",
        "sagemaker-notebooks", "sagemaker-endpoints",
        "eips-unattached", "load-balancers",
        "ebs-volumes", "nat-gateways",
    }


# --- Task 9: report assembly, byte budget, publish-failure semantics ---

def test_report_states_observed_status_and_running_reminder():
    inv = {"areas": [{"region": "us-east-1", "service": "ec2-instances", "state": "complete",
                      "items": ["i-1 t3.micro in us-east-1"]}], "generated": "2026-09-15T00:00:00+00:00"}
    body = handler.build_report("EXECUTION_SUCCESS", "2026-09-15T00:00:00+00:00", inv, "armed")
    assert "EXECUTION_SUCCESS" in body
    assert "still running" in body.lower() or "keep running" in body.lower()
    assert "i-1 t3.micro" in body


def test_fit_truncates_with_disclosure_over_limit():
    huge = "x\n" * 200000
    fitted = handler._fit(huge, limit=1000)
    assert len(fitted.encode("utf-8")) <= 1000
    assert "omitted" in fitted.lower() or "truncated" in fitted.lower()


def test_publish_failure_propagates(monkeypatch):
    class FailingSns:
        def publish(self, **kw): raise RuntimeError("SNS down")
    monkeypatch.setattr(handler, "_client", lambda svc, region=None: FailingSns())
    import pytest
    with pytest.raises(RuntimeError):
        handler.publish("arn:aws:sns:us-east-1:111122223333:Report", "subj", "body")


def test_s3_sizes_unknown_when_no_metric(monkeypatch):
    class CW:
        def get_metric_data(self, **kw): return {"MetricDataResults": [{"Values": [], "Timestamps": []}]}
        def list_buckets(self, **kw): return {"Buckets": [{"Name": "b1"}]}
    def fake_client(svc, region=None):
        return CW()
    monkeypatch.setattr(handler, "_client", fake_client)
    lines = handler.s3_bucket_sizes()
    assert any("unknown" in l.lower() for l in lines)


# --- Fix item 2: enabled_regions() failure must not abort reporting (spec 7.4) ---

def test_handler_reports_even_when_enabled_regions_raises(monkeypatch):
    monkeypatch.setenv("TRIGGER_TOPIC_ARN", "arn:aws:sns:us-east-1:111122223333:Trigger")
    monkeypatch.setenv("ACCOUNT_ID", "111122223333")
    monkeypatch.setenv("BUDGET_NAME", "b")
    monkeypatch.setenv("ACTION_ID", "11111111-1111-1111-1111-111111111111")
    monkeypatch.setenv("REPORT_TOPIC_ARN", "arn:aws:sns:us-east-1:111122223333:Report")

    published = {}

    def boom_enabled_regions():
        raise RuntimeError("region enumeration denied")

    def fake_observe_action_status(account_id, budget_name, action_id):
        return "EXECUTION_SUCCESS", "2024-01-01T00:00:00+00:00", None

    def fake_publish(topic_arn, subject, body):
        published["called"] = True
        published["body"] = body

    monkeypatch.setattr(handler, "enabled_regions", boom_enabled_regions)
    monkeypatch.setattr(handler, "observe_action_status", fake_observe_action_status)
    monkeypatch.setattr(handler, "s3_bucket_sizes", lambda deadline_epoch=None: [])
    monkeypatch.setattr(handler, "publish", fake_publish)

    event = {"Records": [{"Sns": {"TopicArn": "arn:aws:sns:us-east-1:111122223333:Trigger", "Message": "x"}}]}
    result = handler.handler(event, None)

    assert result["status"] == "reported"
    assert published.get("called") is True
    body = published["body"]
    assert "region-enumeration" in body.lower()
    assert "region enumeration denied" in body.lower()


# --- Fix item 1: no-mutation guard on the triggered path (spec 11) ---

_MUTATING_VERBS = (
    "create", "put", "delete", "attach", "detach", "update",
    "start", "stop", "run", "terminate", "modify", "scale",
)


def _is_mutating(method_name: str) -> bool:
    name = method_name.lower()
    return any(name.startswith(verb) for verb in _MUTATING_VERBS)


class _RecordingClient:
    """A fake boto3 client that records every method name invoked on it and
    returns empty-but-well-shaped responses for the calls the handler needs."""

    def __init__(self, calls, service):
        self._calls = calls
        self._service = service

    def _record(self, name):
        self._calls.append(f"{self._service}.{name}")

    def get_paginator(self, op_name):
        self._record(op_name)

        class _Pager:
            def paginate(self, **kw):
                return iter([])
        return _Pager()

    def __getattr__(self, name):
        self._record(name)

        def _call(*args, **kwargs):
            if name == "describe_budget_action":
                return {"Action": {"Status": "EXECUTION_SUCCESS"}}
            if name == "list_buckets":
                return {"Buckets": []}
            if name == "describe_regions":
                return {"Regions": [{"RegionName": "us-east-1"}]}
            if name == "describe_addresses":
                return {"Addresses": []}
            if name == "publish":
                return {"MessageId": "fake"}
            return {}
        return _call


def test_triggered_path_makes_no_mutation_only_reads_and_publish(monkeypatch):
    monkeypatch.setenv("TRIGGER_TOPIC_ARN", "arn:aws:sns:us-east-1:111122223333:Trigger")
    monkeypatch.setenv("ACCOUNT_ID", "111122223333")
    monkeypatch.setenv("BUDGET_NAME", "b")
    monkeypatch.setenv("ACTION_ID", "11111111-1111-1111-1111-111111111111")
    monkeypatch.setenv("REPORT_TOPIC_ARN", "arn:aws:sns:us-east-1:111122223333:Report")

    calls = []

    def fake_client(service, region=None):
        return _RecordingClient(calls, service)

    monkeypatch.setattr(handler, "_client", fake_client)
    # Every adapter returns [] via the recording client's empty paginators;
    # exercise the real inventory()/build_report()/publish() code paths.
    monkeypatch.setattr(handler, "enabled_regions", lambda: ["us-east-1"])

    event = {"Records": [{"Sns": {"TopicArn": "arn:aws:sns:us-east-1:111122223333:Trigger", "Message": "x"}}]}
    result = handler.handler(event, None)

    assert result["status"] == "reported"
    assert len(calls) > 0  # actually exercised the client

    mutating = [c for c in calls if _is_mutating(c.split(".", 1)[1])]
    assert mutating == [], f"Unexpected mutating call(s) on the triggered path: {mutating}"

    # sns.publish is the one allowed "verb-like" call (starts with none of the
    # mutating verbs) and must actually have happened.
    assert any(c == "sns.publish" for c in calls)


# --- Task 13 (corrective) regression tests ---

import pytest


# --- F1: real deadline protects report delivery ---

def test_ec2_instances_deadline_exceeded_mid_pagination_preserves_partial(monkeypatch):
    client = boto3.client("ec2", region_name="us-east-1")
    stub = Stubber(client)
    filt = {"Filters": [{"Name": "instance-state-name", "Values": ["running", "pending"]}]}
    stub.add_response("describe_instances",
        {"Reservations": [{"Instances": [{"InstanceId": "i-1", "InstanceType": "t3.micro"}]}],
         "NextToken": "n1"},
        filt)
    stub.add_response("describe_instances",
        {"Reservations": [{"Instances": [{"InstanceId": "i-2", "InstanceType": "t3.micro"}]}]},
        {**filt, "NextToken": "n1"})
    stub.activate()
    monkeypatch.setattr(handler, "_client", lambda svc, region=None: client)

    clock = {"t": 0.0}

    def fake_time():
        clock["t"] += 1
        return clock["t"]

    monkeypatch.setattr(handler.time, "time", fake_time)

    with pytest.raises(handler.DeadlineExceeded) as exc_info:
        handler._ec2_instances("us-east-1", deadline=1.5)  # past by the 2nd page check
    assert exc_info.value.items_so_far == ["i-1 t3.micro in us-east-1"]


def test_inventory_reports_partial_state_when_adapter_raises_deadline_exceeded(monkeypatch):
    def half_scanned(region, deadline=None):
        raise handler.DeadlineExceeded(["partial-item"])
    monkeypatch.setattr(handler, "ADAPTERS", {"ec2-instances": half_scanned})
    result = handler.inventory(["us-east-1"], deadline_epoch=time.time() + 60)
    area = result["areas"][0]
    assert area["state"] == "partial"
    assert area["items"] == ["partial-item"]


def test_s3_bucket_sizes_stops_at_deadline_mid_scan(monkeypatch):
    class S3:
        def list_buckets(self):
            return {"Buckets": [{"Name": "b1"}, {"Name": "b2"}]}

        def get_bucket_location(self, Bucket):
            return {"LocationConstraint": ""}

    cw_calls = {"n": 0}

    class CW:
        def get_metric_data(self, **kw):
            cw_calls["n"] += 1
            return {"MetricDataResults": [{"Values": [1.0], "Timestamps": [dt.datetime(2026, 9, 15)]}]}

    def fake_client(svc, region=None):
        return S3() if svc == "s3" else CW()

    monkeypatch.setattr(handler, "_client", fake_client)

    clock = {"t": 0.0}

    def fake_time():
        clock["t"] += 1
        return clock["t"]

    monkeypatch.setattr(handler.time, "time", fake_time)

    # Task 15: s3_bucket_sizes() now checks the deadline THREE times per
    # bucket path (once before GetBucketLocation, once before GetMetricData),
    # plus once at function entry before ListBuckets -- so the tick sequence
    # that used to cross the deadline after bucket 1 needs a slightly later
    # deadline than before to still land the crossing between bucket 1 and
    # bucket 2: ticks are [entry=1.0, b1-pre-location=2.0, b1-pre-metric=3.0,
    # b2-pre-location=4.0] -- 3.5 lands past right at the top of bucket 2.
    lines = handler.s3_bucket_sizes(deadline_epoch=3.5)  # deadline crosses between the two buckets
    assert any("stopped early" in l.lower() for l in lines)
    assert cw_calls["n"] == 1  # only the first bucket was sized before the deadline hit


def test_handler_still_publishes_when_deadline_crosses_during_s3_sizing(monkeypatch):
    monkeypatch.setenv("TRIGGER_TOPIC_ARN", "arn:aws:sns:us-east-1:111122223333:Trigger")
    monkeypatch.setenv("ACCOUNT_ID", "111122223333")
    monkeypatch.setenv("BUDGET_NAME", "b")
    monkeypatch.setenv("ACTION_ID", "11111111-1111-1111-1111-111111111111")
    monkeypatch.setenv("REPORT_TOPIC_ARN", "arn:aws:sns:us-east-1:111122223333:Report")

    monkeypatch.setattr(handler, "enabled_regions", lambda: [])
    monkeypatch.setattr(handler, "observe_action_status",
                         lambda a, b, c: ("EXECUTION_SUCCESS", "2024-01-01T00:00:00+00:00", None))
    monkeypatch.setattr(handler, "inventory",
                         lambda regions, deadline_epoch: {"areas": [], "generated": "2024-01-01T00:00:00+00:00"})

    def slow_s3_bucket_sizes(deadline_epoch=None):
        assert deadline_epoch is not None  # the real deadline was threaded through
        return ["S3 bucket sizing stopped early (scan deadline reached); 1 of 2 bucket(s) not sized."]

    monkeypatch.setattr(handler, "s3_bucket_sizes", slow_s3_bucket_sizes)

    published = {}

    def fake_publish(topic_arn, subject, body):
        published["called"] = True
        published["body"] = body

    monkeypatch.setattr(handler, "publish", fake_publish)

    event = {"Records": [{"Sns": {"TopicArn": "arn:aws:sns:us-east-1:111122223333:Trigger", "Message": "x"}}]}
    result = handler.handler(event, None)

    assert result["status"] == "reported"
    assert published.get("called") is True
    assert "stopped early" in published["body"].lower()


# --- F6: S3 sizing resolves bucket region, labels storage class, never guesses ---

def test_s3_bucket_sizes_resolves_region_and_labels_storage_class(monkeypatch):
    cw_regions = []

    class S3:
        def list_buckets(self):
            return {"Buckets": [{"Name": "eu-bucket"}]}

        def get_bucket_location(self, Bucket):
            return {"LocationConstraint": "eu-west-1"}

    class CW:
        def get_metric_data(self, **kw):
            return {"MetricDataResults": [{"Values": [12345.0], "Timestamps": [dt.datetime(2026, 9, 15)]}]}

    def fake_client(svc, region=None):
        if svc == "s3":
            return S3()
        if svc == "cloudwatch":
            cw_regions.append(region)
            return CW()
        raise AssertionError(f"unexpected service {svc}")

    monkeypatch.setattr(handler, "_client", fake_client)
    lines = handler.s3_bucket_sizes()
    assert cw_regions == ["eu-west-1"]
    assert any("eu-west-1" in l and "StandardStorage" in l for l in lines)


def test_s3_bucket_region_lookup_failure_is_unknown_not_guessed(monkeypatch):
    class S3:
        def list_buckets(self):
            return {"Buckets": [{"Name": "mystery-bucket"}]}

        def get_bucket_location(self, Bucket):
            raise RuntimeError("AccessDenied")

    def fake_client(svc, region=None):
        if svc == "s3":
            return S3()
        raise AssertionError("cloudwatch must not be queried when region resolution fails")

    monkeypatch.setattr(handler, "_client", fake_client)
    lines = handler.s3_bucket_sizes()
    assert any("unknown" in l.lower() for l in lines)
    assert not any("us-east-1" in l for l in lines)


# --- F7: ECS in-band failures[] must not read as empty/complete ---

def test_ecs_services_all_failures_not_reported_as_empty(monkeypatch):
    client = boto3.client("ecs", region_name="us-east-1")
    stub = Stubber(client)
    cluster_arn = "arn:aws:ecs:us-east-1:111122223333:cluster/c1"
    service_arn = "arn:aws:ecs:us-east-1:111122223333:service/c1/s1"
    stub.add_response("list_clusters", {"clusterArns": [cluster_arn]}, {})
    stub.add_response("list_services", {"serviceArns": [service_arn]}, {"cluster": cluster_arn})
    stub.add_response("describe_services",
        {"services": [], "failures": [{"arn": service_arn, "reason": "MISSING"}]},
        {"cluster": cluster_arn, "services": [service_arn]})
    stub.activate()
    monkeypatch.setattr(handler, "_client", lambda svc, region=None: client)
    monkeypatch.setattr(handler, "ADAPTERS", {"ecs-services": handler._ecs_services})

    result = handler.inventory(["us-east-1"], deadline_epoch=time.time() + 60)
    area = result["areas"][0]
    assert area["state"] != "empty"
    assert area["state"] == "failed"
    assert "MISSING" in area.get("error", "")


def test_ecs_services_mixed_success_and_failure_raises_partial_coverage(monkeypatch):
    """Defect A: a mix of successes and in-band failures must NOT be reported
    as a plain (COMPLETE-bound) list — it raises PartialCoverage with a
    failure-specific reason so inventory() marks the area PARTIAL, distinct
    from a deadline-caused PARTIAL."""
    client = boto3.client("ecs", region_name="us-east-1")
    stub = Stubber(client)
    cluster_arn = "arn:aws:ecs:us-east-1:111122223333:cluster/c1"
    ok_arn = "arn:aws:ecs:us-east-1:111122223333:service/c1/s1"
    bad_arn = "arn:aws:ecs:us-east-1:111122223333:service/c1/s2"
    stub.add_response("list_clusters", {"clusterArns": [cluster_arn]}, {})
    stub.add_response("list_services", {"serviceArns": [ok_arn, bad_arn]}, {"cluster": cluster_arn})
    stub.add_response("describe_services",
        {"services": [{"serviceName": "s1", "runningCount": 2}],
         "failures": [{"arn": bad_arn, "reason": "MISSING"}]},
        {"cluster": cluster_arn, "services": [ok_arn, bad_arn]})
    stub.activate()
    monkeypatch.setattr(handler, "_client", lambda svc, region=None: client)

    with pytest.raises(handler.PartialCoverage) as exc_info:
        handler._ecs_services("us-east-1")
    items = exc_info.value.items
    assert any("s1" in l and "running" in l for l in items)
    assert any("MISSING" in l and bad_arn in l for l in items)
    assert "fail" in exc_info.value.reason.lower()
    assert "deadline" not in exc_info.value.reason.lower()


def test_ecs_tasks_all_failures_not_reported_as_empty(monkeypatch):
    client = boto3.client("ecs", region_name="us-east-1")
    stub = Stubber(client)
    cluster_arn = "arn:aws:ecs:us-east-1:111122223333:cluster/c1"
    task_arn = "arn:aws:ecs:us-east-1:111122223333:task/c1/abc123"
    stub.add_response("list_clusters", {"clusterArns": [cluster_arn]}, {})
    stub.add_response("list_tasks", {"taskArns": [task_arn]}, {"cluster": cluster_arn})
    stub.add_response("describe_tasks",
        {"tasks": [], "failures": [{"arn": task_arn, "reason": "MISSING"}]},
        {"cluster": cluster_arn, "tasks": [task_arn]})
    stub.activate()
    monkeypatch.setattr(handler, "_client", lambda svc, region=None: client)
    monkeypatch.setattr(handler, "ADAPTERS", {"ecs-tasks": handler._ecs_tasks})

    result = handler.inventory(["us-east-1"], deadline_epoch=time.time() + 60)
    area = result["areas"][0]
    assert area["state"] != "empty"
    assert area["state"] == "failed"
    assert "MISSING" in area.get("error", "")


def test_ecs_tasks_mixed_success_and_failure_raises_partial_coverage(monkeypatch):
    """Defect A (tasks side): same PartialCoverage contract as ecs-services."""
    client = boto3.client("ecs", region_name="us-east-1")
    stub = Stubber(client)
    cluster_arn = "arn:aws:ecs:us-east-1:111122223333:cluster/c1"
    ok_arn = "arn:aws:ecs:us-east-1:111122223333:task/c1/abc123"
    bad_arn = "arn:aws:ecs:us-east-1:111122223333:task/c1/def456"
    stub.add_response("list_clusters", {"clusterArns": [cluster_arn]}, {})
    stub.add_response("list_tasks", {"taskArns": [ok_arn, bad_arn]}, {"cluster": cluster_arn})
    stub.add_response("describe_tasks",
        {"tasks": [{"taskArn": ok_arn, "lastStatus": "RUNNING"}],
         "failures": [{"arn": bad_arn, "reason": "MISSING"}]},
        {"cluster": cluster_arn, "tasks": [ok_arn, bad_arn]})
    stub.activate()
    monkeypatch.setattr(handler, "_client", lambda svc, region=None: client)

    with pytest.raises(handler.PartialCoverage) as exc_info:
        handler._ecs_tasks("us-east-1")
    items = exc_info.value.items
    assert any("abc123" in l and "RUNNING" in l for l in items)
    assert any("MISSING" in l and bad_arn in l for l in items)
    assert "fail" in exc_info.value.reason.lower()
    assert "deadline" not in exc_info.value.reason.lower()


def test_ecs_services_mixed_success_and_failure_inventory_state_is_partial_not_deadline(monkeypatch):
    """End-to-end through inventory()/build_report(): a mixed ECS area renders
    as PARTIAL with a failures-related reason -- never COMPLETE, and never
    worded as a deadline PARTIAL -- while both the running service and the
    failure line remain visible in the report body."""
    client = boto3.client("ecs", region_name="us-east-1")
    stub = Stubber(client)
    cluster_arn = "arn:aws:ecs:us-east-1:111122223333:cluster/c1"
    ok_arn = "arn:aws:ecs:us-east-1:111122223333:service/c1/s1"
    bad_arn = "arn:aws:ecs:us-east-1:111122223333:service/c1/s2"
    stub.add_response("list_clusters", {"clusterArns": [cluster_arn]}, {})
    stub.add_response("list_services", {"serviceArns": [ok_arn, bad_arn]}, {"cluster": cluster_arn})
    stub.add_response("describe_services",
        {"services": [{"serviceName": "s1", "runningCount": 2}],
         "failures": [{"arn": bad_arn, "reason": "MISSING"}]},
        {"cluster": cluster_arn, "services": [ok_arn, bad_arn]})
    stub.activate()
    monkeypatch.setattr(handler, "_client", lambda svc, region=None: client)
    monkeypatch.setattr(handler, "ADAPTERS", {"ecs-services": handler._ecs_services})

    result = handler.inventory(["us-east-1"], deadline_epoch=time.time() + 60)
    area = result["areas"][0]
    assert area["state"] == "partial"
    assert "fail" in area.get("reason", "").lower()
    assert "deadline" not in area.get("reason", "").lower()

    body = handler.build_report("EXECUTION_SUCCESS", "2026-09-15T00:00:00+00:00", result, "armed")
    assert "[PARTIAL] ecs-services" in body
    assert "s1" in body and "running" in body.lower()
    assert "MISSING" in body and bad_arn in body


# --- F8: truncation notice must be truthful (the full body is actually logged) ---

def test_fit_logs_full_report_before_truncating(capsys):
    huge = "MARKER-START " + ("x" * 5000 + "\n") * 100 + " MARKER-END"
    fitted = handler._fit(huge, limit=1000)
    assert len(fitted.encode("utf-8")) <= 1000
    assert "MARKER-END" not in fitted  # the fitted/truncated message itself is cut short

    captured = capsys.readouterr()
    assert "MARKER-START" in captured.out
    assert "MARKER-END" in captured.out  # content beyond the truncation point was logged


# --- F9: report wording follows OBSERVED status + required header fields ---

def test_build_report_execution_failure_does_not_claim_auto_applied_and_has_header_fields():
    inv = {"areas": [], "generated": "2026-09-15T00:00:00+00:00"}
    # Real DescribeBudgetAction shapes: ActionThresholdType is PERCENTAGE or
    # ABSOLUTE_VALUE (never "ACTUAL" -- that is a NotificationType value, a
    # separate field entirely).
    action_details = {"threshold_value": 100.0, "threshold_type": "PERCENTAGE",
                       "notification_type": "FORECASTED",
                       "approval_model": "AUTOMATIC", "targets": ["user:student"]}
    body = handler.build_report("EXECUTION_FAILURE", "2026-09-15T00:00:00+00:00", inv, "armed",
                                 account_id="111122223333", budget_name="my-budget",
                                 action_details=action_details)
    assert "auto-applied" not in body.lower()
    assert "no deny" not in body.lower()  # Defect C: reporter never asserts attachment state
    assert "unverified" in body.lower()
    assert "FAILED" in body
    assert "111122223333" in body
    assert "my-budget" in body
    assert "100" in body and "%" in body
    assert "PERCENTAGE" in body and "FORECASTED" in body


def test_format_threshold_renders_whole_number_without_decimal():
    assert handler._format_threshold({"threshold_value": 100.0, "threshold_type": "PERCENTAGE",
                                       "notification_type": "FORECASTED",
                                       "approval_model": "AUTOMATIC", "targets": []}).startswith("100%")
    assert handler._format_threshold({"threshold_value": 87.5, "threshold_type": "PERCENTAGE",
                                       "notification_type": "ACTUAL",
                                       "approval_model": "AUTOMATIC", "targets": []}).startswith("87.5%")


def test_format_threshold_renders_both_real_fields_without_conflating_them():
    """Defect B: ActionThreshold {ActionThresholdType, ActionThresholdValue}
    and the separate top-level NotificationType must both appear, using the
    REAL enum values (PERCENTAGE|ABSOLUTE_VALUE and ACTUAL|FORECASTED) --
    never a fabricated threshold_type like "ACTUAL"."""
    pct = handler._format_threshold({"threshold_value": 100.0, "threshold_type": "PERCENTAGE",
                                      "notification_type": "FORECASTED",
                                      "approval_model": "AUTOMATIC", "targets": []})
    assert "PERCENTAGE" in pct
    assert "FORECASTED" in pct
    assert "100%" in pct

    abs_ = handler._format_threshold({"threshold_value": 50.0, "threshold_type": "ABSOLUTE_VALUE",
                                       "notification_type": "ACTUAL",
                                       "approval_model": "MANUAL", "targets": []})
    assert "ABSOLUTE_VALUE" in abs_
    assert "ACTUAL" in abs_
    assert "$50" in abs_
    assert "PERCENTAGE" not in abs_  # not conflated with the other threshold type
    assert "FORECASTED" not in abs_  # not conflated with the other notification type


# --- Report defect C: EXECUTION_FAILURE wording + real REVERSE enum keys ---

def test_execution_failure_narrative_does_not_claim_no_deny_in_effect():
    narrative = handler._status_narrative("EXECUTION_FAILURE")
    assert "no deny" not in narrative.lower()
    assert "unverified" in narrative.lower()


def test_reverse_success_maps_to_real_status_narrative_entry():
    narrative = handler._status_narrative("REVERSE_SUCCESS")
    assert narrative == handler._STATUS_NARRATIVE["REVERSE_SUCCESS"]
    assert "reversed" in narrative.lower()


def test_reverse_failure_maps_to_real_status_narrative_entry():
    narrative = handler._status_narrative("REVERSE_FAILURE")
    assert narrative == handler._STATUS_NARRATIVE["REVERSE_FAILURE"]
    assert "failed" in narrative.lower()


def test_status_narrative_dict_uses_real_documented_enum_keys():
    expected_keys = {
        "STANDBY", "PENDING", "EXECUTION_IN_PROGRESS", "EXECUTION_SUCCESS", "EXECUTION_FAILURE",
        "REVERSE_IN_PROGRESS", "REVERSE_SUCCESS", "REVERSE_FAILURE",
        "RESET_IN_PROGRESS", "RESET_FAILURE", "UNKNOWN",
    }
    assert expected_keys.issubset(handler._STATUS_NARRATIVE.keys())
    # The fabricated keys from before Task 15 must be gone.
    assert "REVERSE_EXECUTION_SUCCESS" not in handler._STATUS_NARRATIVE
    assert "REVERSE_EXECUTION_FAILURE" not in handler._STATUS_NARRATIVE


# --- Coordinator follow-up: guard the bounded client Config against a silent drop ---

def test_client_passes_bounded_config_to_boto3(monkeypatch):
    real_client_fn = handler.boto3.client  # saved before patching, used below to reference-check retries
    captured = []

    def fake_boto3_client(service, **kwargs):
        captured.append((service, kwargs))
        return object()

    monkeypatch.setattr(handler.boto3, "client", fake_boto3_client)

    handler._client("ec2")
    handler._client("s3", "eu-west-1")

    assert len(captured) == 2
    for service, kwargs in captured:
        assert kwargs.get("config") is handler._BOTO_CONFIG
    assert captured[0] == ("ec2", {"config": handler._BOTO_CONFIG})
    assert captured[1] == ("s3", {"region_name": "eu-west-1", "config": handler._BOTO_CONFIG})

    cfg = handler._BOTO_CONFIG
    assert cfg.connect_timeout == 5
    assert cfg.read_timeout == 15
    # botocore normalizes (and mutates in place) a Config's `retries` dict the first
    # time it's used to build a real client -- other tests in this session may have
    # already done that to this same shared singleton, so a literal
    # {"max_attempts": 2} equality check here would be test-order-dependent. Push an
    # equivalent throwaway Config through the same real normalization path instead,
    # then compare shapes -- robust regardless of what state _BOTO_CONFIG is in.
    throwaway = botocore.config.Config(retries={"max_attempts": 2})
    real_client_fn("ec2", region_name="us-east-1", config=throwaway)
    assert cfg.retries == throwaway.retries


# --- Task 15 (corrective 2): F1 -- deadline must bound EVERY request ---

def test_lambda_functions_stops_mid_page_and_stops_calling_concurrency(monkeypatch):
    """(a) A per-item deadline check must run before EVERY GetFunctionConcurrency
    call, not just at page boundaries: once the clock crosses the deadline
    partway through a single page's functions, the adapter must stop
    immediately, preserve whatever it already collected, and must NOT call
    GetFunctionConcurrency again for the remaining functions on that page."""
    client = boto3.client("lambda", region_name="us-east-1")
    stub = Stubber(client)
    stub.add_response("list_functions", {"Functions": [
        {"FunctionName": "fn1", "Runtime": "python3.13"},
        {"FunctionName": "fn2", "Runtime": "python3.13"},
        {"FunctionName": "fn3", "Runtime": "python3.13"},
    ]}, {})
    stub.add_response("get_function_concurrency", {"ReservedConcurrentExecutions": 5}, {"FunctionName": "fn1"})
    stub.activate()
    monkeypatch.setattr(handler, "_client", lambda svc, region=None: client)

    concurrency_calls = {"n": 0}
    real_get_concurrency = client.get_function_concurrency

    def counting_get_concurrency(*args, **kwargs):
        concurrency_calls["n"] += 1
        return real_get_concurrency(*args, **kwargs)

    client.get_function_concurrency = counting_get_concurrency

    clock = {"t": 0.0}

    def fake_time():
        clock["t"] += 1
        return clock["t"]

    monkeypatch.setattr(handler.time, "time", fake_time)

    # Ticks: 1.0 = _iter_pages pre-fetch check (not past) -> fetch the one page;
    # 2.0 = pre-check for fn1 (not past) -> GetFunctionConcurrency(fn1) called;
    # 3.0 = pre-check for fn2 (past, deadline=2.5) -> raises before any 2nd/3rd call.
    with pytest.raises(handler.DeadlineExceeded) as exc_info:
        handler._lambda_functions("us-east-1", deadline=2.5)

    assert exc_info.value.items_so_far == ["fn1 python3.13 reserved=5 in us-east-1"]
    assert concurrency_calls["n"] == 1  # fn2/fn3 must never have been queried


def test_s3_bucket_sizes_already_expired_does_not_call_list_buckets(monkeypatch):
    """(b) An already-expired deadline must skip ListBuckets entirely --
    scanning must not even begin -- and still emit an explicit line saying
    the deadline was reached, rather than silently returning nothing."""
    def must_not_be_called(svc, region=None):
        raise AssertionError(f"_client({svc!r}) must not be called once the deadline has passed")

    monkeypatch.setattr(handler, "_client", must_not_be_called)
    lines = handler.s3_bucket_sizes(deadline_epoch=time.time() - 1)  # already past
    assert any("deadline" in l.lower() for l in lines)


def test_publish_margin_derived_from_shared_timeout_constants_covers_worst_case():
    """(d) PUBLISH_MARGIN_SECONDS must be derived from the SAME timeout
    constants used to build _BOTO_CONFIG (so they cannot drift apart), and
    must be large enough to cover one fully-retried worst-case request."""
    assert handler.WORST_REQUEST_SECONDS == handler.MAX_ATTEMPTS * (
        handler.CONNECT_TIMEOUT_SECONDS + handler.READ_TIMEOUT_SECONDS)
    assert handler.PUBLISH_MARGIN_SECONDS >= handler.WORST_REQUEST_SECONDS
    # The old fixed 30s margin was smaller than one worst-case retried request
    # (2 attempts * (5s connect + 15s read) = 40s) -- guard against regressing
    # to a hardcoded value that happens to look plausible but isn't derived.
    assert handler.PUBLISH_MARGIN_SECONDS >= handler.MAX_ATTEMPTS * (
        handler.CONNECT_TIMEOUT_SECONDS + handler.READ_TIMEOUT_SECONDS)


def test_handler_publishes_even_when_margin_is_the_binding_constraint(monkeypatch):
    """(d), continued: with remaining time only slightly larger than the
    margin, the derived deadline must still leave room for build_report()/
    publish() to run -- i.e. publish() must still be reached and succeed."""
    monkeypatch.setenv("TRIGGER_TOPIC_ARN", "arn:aws:sns:us-east-1:111122223333:Trigger")
    monkeypatch.setenv("ACCOUNT_ID", "111122223333")
    monkeypatch.setenv("BUDGET_NAME", "b")
    monkeypatch.setenv("ACTION_ID", "11111111-1111-1111-1111-111111111111")
    monkeypatch.setenv("REPORT_TOPIC_ARN", "arn:aws:sns:us-east-1:111122223333:Report")

    monkeypatch.setattr(handler, "enabled_regions", lambda: [])
    monkeypatch.setattr(handler, "observe_action_status",
                         lambda a, b, c: ("EXECUTION_SUCCESS", "2024-01-01T00:00:00+00:00", None))
    monkeypatch.setattr(handler, "inventory",
                         lambda regions, deadline_epoch: {"areas": [], "generated": "2024-01-01T00:00:00+00:00"})
    monkeypatch.setattr(handler, "s3_bucket_sizes", lambda deadline_epoch=None: [])

    published = {}

    def fake_publish(topic_arn, subject, body):
        published["called"] = True

    monkeypatch.setattr(handler, "publish", fake_publish)

    class SlowContext:
        # Remaining time is exactly the worst-case request length plus a
        # sliver -- the margin must still be enough to derive a valid,
        # future deadline and reach publish().
        def get_remaining_time_in_millis(self):
            return int((handler.WORST_REQUEST_SECONDS + 1) * 1000)

    event = {"Records": [{"Sns": {"TopicArn": "arn:aws:sns:us-east-1:111122223333:Trigger", "Message": "x"}}]}
    result = handler.handler(event, SlowContext())

    assert result["status"] == "reported"
    assert published.get("called") is True


# --- Report defect D: UTF-8-safe chunked logging ---

def test_log_full_report_preserves_multibyte_char_split_across_chunk_boundary(monkeypatch, capsys):
    """A naive per-chunk `bytes.decode("utf-8", "ignore")` silently drops a
    multibyte character whose bytes straddle a chunk boundary. Force a tiny
    chunk size so a euro sign ("€", 3 UTF-8 bytes) lands exactly on one."""
    monkeypatch.setattr(handler, "_LOG_CHUNK_BYTES", 10)
    body = "A" * 9 + "€" + "B" * 9  # euro sign's bytes span the byte-10 boundary
    handler._log_full_report(body)
    captured = capsys.readouterr()
    assert "€" in captured.out  # the euro sign survived intact
    assert "�" not in captured.out  # no replacement character from a mangled/dropped byte
    assert "A" * 9 in captured.out
    # The B's may be split across two print()/chunk boundaries (the euro sign
    # itself straddles the boundary, shifting where the B run gets cut), so
    # check the total count rather than requiring one contiguous run.
    assert captured.out.count("B") == 9


def test_log_full_report_preserves_emoji_split_across_chunk_boundary(monkeypatch, capsys):
    """Same as above with a 4-byte UTF-8 character (an emoji, surrogate pair
    in UTF-16 but a single 4-byte sequence in UTF-8) to cover a wider split."""
    monkeypatch.setattr(handler, "_LOG_CHUNK_BYTES", 12)
    body = "X" * 11 + "\U0001F600" + "Y" * 11  # grinning-face emoji, 4 UTF-8 bytes
    handler._log_full_report(body)
    captured = capsys.readouterr()
    assert "\U0001F600" in captured.out
    assert "�" not in captured.out


# --- F1: Billing-console-gate honesty -- concrete CLI recovery + named recovery principal ---

def test_reverse_cli_built_from_real_ids():
    cli = handler._reverse_cli("111122223333", "my-budget", "aaaa-bbbb")
    assert cli == (
        "aws budgets execute-budget-action --account-id 111122223333 "
        "--budget-name my-budget --action-id aaaa-bbbb --execution-type REVERSE_BUDGET_ACTION"
    )


def test_approve_cli_built_from_real_ids():
    cli = handler._approve_cli("111122223333", "my-budget", "aaaa-bbbb")
    assert cli == (
        "aws budgets execute-budget-action --account-id 111122223333 "
        "--budget-name my-budget --action-id aaaa-bbbb --execution-type APPROVE_BUDGET_ACTION"
    )


def test_report_contains_reverse_cli_with_real_ids_and_named_recovery_principal():
    inv = {"areas": [], "generated": "2026-09-15T00:00:00+00:00"}
    body = handler.build_report(
        "EXECUTION_SUCCESS", "2026-09-15T00:00:00+00:00", inv, "armed",
        account_id="111122223333", budget_name="my-budget", action_id="aaaa-bbbb",
        recovery_principal_arn="arn:aws:iam::111122223333:role/RecoveryAdmin"
    )
    assert handler._reverse_cli("111122223333", "my-budget", "aaaa-bbbb") in body
    assert "arn:aws:iam::111122223333:role/RecoveryAdmin" in body
    # The generic placeholder wording must be gone once a real ARN is known.
    assert "RECOVERY_PRINCIPAL_ARN; see README" not in body


def test_report_falls_back_to_generic_recovery_wording_when_arn_not_supplied():
    inv = {"areas": [], "generated": "2026-09-15T00:00:00+00:00"}
    body = handler.build_report(
        "EXECUTION_SUCCESS", "2026-09-15T00:00:00+00:00", inv, "armed",
        account_id="111122223333", budget_name="my-budget", action_id="aaaa-bbbb"
    )
    assert "RECOVERY_PRINCIPAL_ARN" in body


def test_pending_report_contains_approve_cli():
    inv = {"areas": [], "generated": "2026-09-15T00:00:00+00:00"}
    body = handler.build_report(
        "PENDING", "2026-09-15T00:00:00+00:00", inv, "watch",
        account_id="111122223333", budget_name="my-budget", action_id="aaaa-bbbb"
    )
    assert handler._approve_cli("111122223333", "my-budget", "aaaa-bbbb") in body


def test_report_puts_stop_spend_action_before_reverse_command():
    # The actionable stop-spend (approve) command comes first; the reverse/undo
    # command is the recovery route at the bottom of the report.
    inv = {"areas": [], "generated": "2026-09-15T00:00:00+00:00"}
    body = handler.build_report(
        "PENDING", "2026-09-15T00:00:00+00:00", inv, "watch",
        account_id="111122223333", budget_name="my-budget", action_id="aaaa-bbbb"
    )
    approve = handler._approve_cli("111122223333", "my-budget", "aaaa-bbbb")
    reverse = handler._reverse_cli("111122223333", "my-budget", "aaaa-bbbb")
    assert approve in body and reverse in body
    assert body.index(approve) < body.index(reverse)


# --- F3: subject/headline derived from the OBSERVED status ---

def test_report_subject_pending_and_execution_statuses():
    assert handler._report_subject("PENDING") == "AWS Budget Radar: budget threshold reached — action PENDING"
    assert handler._report_subject("EXECUTION_SUCCESS") == \
        "AWS Budget Radar: budget threshold reached — action EXECUTION_SUCCESS"
    assert handler._report_subject("EXECUTION_FAILURE") == \
        "AWS Budget Radar: budget threshold reached — action EXECUTION_FAILURE"


def test_report_subject_reverse_reset_standby_statuses():
    assert handler._report_subject("REVERSE_SUCCESS") == \
        "AWS Budget Radar: budget action status changed: REVERSE_SUCCESS"
    assert handler._report_subject("RESET_FAILURE") == \
        "AWS Budget Radar: budget action status changed: RESET_FAILURE"
    assert handler._report_subject("STANDBY") == \
        "AWS Budget Radar: budget action status changed: STANDBY"


def test_report_subject_unknown_status():
    assert handler._report_subject("UNKNOWN") == "AWS Budget Radar: budget action notification (status unknown)"


def test_handler_publishes_with_status_derived_subject(monkeypatch):
    monkeypatch.setenv("TRIGGER_TOPIC_ARN", "arn:aws:sns:us-east-1:111122223333:Trigger")
    monkeypatch.setenv("ACCOUNT_ID", "111122223333")
    monkeypatch.setenv("BUDGET_NAME", "b")
    monkeypatch.setenv("ACTION_ID", "11111111-1111-1111-1111-111111111111")
    monkeypatch.setenv("REPORT_TOPIC_ARN", "arn:aws:sns:us-east-1:111122223333:Report")

    monkeypatch.setattr(handler, "enabled_regions", lambda: [])
    monkeypatch.setattr(handler, "observe_action_status",
                         lambda a, b, c: ("REVERSE_SUCCESS", "2024-01-01T00:00:00+00:00", None))
    monkeypatch.setattr(handler, "inventory",
                         lambda regions, deadline_epoch: {"areas": [], "generated": "2024-01-01T00:00:00+00:00"})
    monkeypatch.setattr(handler, "s3_bucket_sizes", lambda deadline_epoch=None: [])

    published = {}

    def fake_publish(topic_arn, subject, body):
        published["subject"] = subject

    monkeypatch.setattr(handler, "publish", fake_publish)
    event = {"Records": [{"Sns": {"TopicArn": "arn:aws:sns:us-east-1:111122223333:Trigger", "Message": "x"}}]}
    handler.handler(event, None)
    assert published["subject"] == "AWS Budget Radar: budget action status changed: REVERSE_SUCCESS"


# --- F4: watch-mode call-to-action is status-conditional ---

def test_call_to_action_pending_says_nothing_blocked_yet_with_approve_cli():
    text = handler._call_to_action("PENDING", "111122223333", "my-budget", "aaaa-bbbb")
    assert "NOTHING IS BLOCKED YET" in text
    assert handler._approve_cli("111122223333", "my-budget", "aaaa-bbbb") in text


def test_call_to_action_execution_success_says_block_applied_without_inline_reverse_cli():
    text = handler._call_to_action("EXECUTION_SUCCESS", "111122223333", "my-budget", "aaaa-bbbb")
    assert "block is applied" in text.lower()
    # The reverse/undo command now lives in the report footer, not inline here.
    assert handler._reverse_cli("111122223333", "my-budget", "aaaa-bbbb") not in text


def test_call_to_action_reverse_success_and_standby_say_no_block_in_effect():
    for status in ("REVERSE_SUCCESS", "STANDBY"):
        text = handler._call_to_action(status, "111122223333", "my-budget", "aaaa-bbbb")
        assert text == "No block is in effect."


def test_pending_report_never_says_to_lift_the_block():
    inv = {"areas": [], "generated": "2026-09-15T00:00:00+00:00"}
    body = handler.build_report(
        "PENDING", "2026-09-15T00:00:00+00:00", inv, "watch",
        account_id="111122223333", budget_name="my-budget", action_id="aaaa-bbbb"
    )
    assert "to lift the block" not in body.lower()
    assert "nothing is blocked yet" in body.lower()


def test_execution_success_report_does_say_how_to_lift_the_block():
    inv = {"areas": [], "generated": "2026-09-15T00:00:00+00:00"}
    body = handler.build_report(
        "EXECUTION_SUCCESS", "2026-09-15T00:00:00+00:00", inv, "armed",
        account_id="111122223333", budget_name="my-budget", action_id="aaaa-bbbb"
    )
    assert "the block is applied" in body.lower()
    assert handler._reverse_cli("111122223333", "my-budget", "aaaa-bbbb") in body
