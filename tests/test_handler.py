import datetime as dt
import time
from botocore.stub import Stubber
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
    status, ts = handler.observe_action_status("111122223333", "b", "11111111-1111-1111-1111-111111111111")
    assert status == "EXECUTION_SUCCESS"
    assert ts  # ISO timestamp present

def test_observe_action_status_unknown_on_failure(monkeypatch):
    def boom(svc, region=None):
        raise RuntimeError("no perms")
    monkeypatch.setattr(handler, "_client", boom)
    status, ts = handler.observe_action_status("x", "b", "a")
    assert status == "UNKNOWN"

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
    called = {"enabled_regions": False, "inventory": False}

    def fake_enabled_regions():
        called["enabled_regions"] = True
        return ["us-east-1"]

    def fake_inventory(regions, deadline_epoch):
        called["inventory"] = True
        assert regions == ["us-east-1"]
        return {"areas": [], "generated": "2024-01-01T00:00:00+00:00"}

    monkeypatch.setattr(handler, "enabled_regions", fake_enabled_regions)
    monkeypatch.setattr(handler, "inventory", fake_inventory)
    event = {"Records": [{"Sns": {"TopicArn": "arn:aws:sns:us-east-1:111122223333:Trigger", "Message": "x"}}]}
    result = handler.handler(event, None)
    assert result["status"] == "ok"
    assert called["enabled_regions"] is True
    assert called["inventory"] is True


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
    def adapter_fail(region):
        raise RuntimeError("AccessDenied")
    monkeypatch.setattr(handler, "ADAPTERS", {"ec2-instances": adapter_fail})
    monkeypatch.setattr(handler, "enabled_regions", lambda: ["us-east-1"])
    result = handler.inventory(["us-east-1"], deadline_epoch=time.time() + 60)
    areas = result["areas"]
    ec2 = [a for a in areas if a["service"] == "ec2-instances"][0]
    assert ec2["state"] == "failed"
    assert "AccessDenied" in ec2.get("error", "")


def test_deadline_marks_unscanned(monkeypatch):
    monkeypatch.setattr(handler, "ADAPTERS", {"ec2-instances": lambda r: []})
    result = handler.inventory(["us-east-1", "eu-west-1"], deadline_epoch=time.time() - 1)  # already past
    assert any(a["state"] == "not_scanned" for a in result["areas"])


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
    assert handler._ecs_services("us-east-1") == ["s1 (2 running) in us-east-1"]


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
