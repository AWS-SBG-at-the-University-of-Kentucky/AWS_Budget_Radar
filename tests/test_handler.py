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

    lines = handler.s3_bucket_sizes(deadline_epoch=1.5)  # deadline crosses between the two buckets
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


def test_ecs_services_mixed_success_and_failure_both_visible(monkeypatch):
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

    lines = handler._ecs_services("us-east-1")
    assert any("s1" in l and "running" in l for l in lines)
    assert any("MISSING" in l and bad_arn in l for l in lines)


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


def test_ecs_tasks_mixed_success_and_failure_both_visible(monkeypatch):
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

    lines = handler._ecs_tasks("us-east-1")
    assert any("abc123" in l and "RUNNING" in l for l in lines)
    assert any("MISSING" in l and bad_arn in l for l in lines)


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
    action_details = {"threshold_value": 100.0, "threshold_type": "ACTUAL",
                       "approval_model": "AUTOMATIC", "targets": ["user:student"]}
    body = handler.build_report("EXECUTION_FAILURE", "2026-09-15T00:00:00+00:00", inv, "armed",
                                 account_id="111122223333", budget_name="my-budget",
                                 action_details=action_details)
    assert "auto-applied" not in body.lower()
    assert "FAILED" in body
    assert "111122223333" in body
    assert "my-budget" in body
    assert "100" in body and "%" in body


def test_format_threshold_renders_whole_number_without_decimal():
    assert handler._format_threshold({"threshold_value": 100.0, "threshold_type": "ACTUAL",
                                       "approval_model": "AUTOMATIC", "targets": []}).startswith("100%")
    assert handler._format_threshold({"threshold_value": 87.5, "threshold_type": "ACTUAL",
                                       "approval_model": "AUTOMATIC", "targets": []}).startswith("87.5%")


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
