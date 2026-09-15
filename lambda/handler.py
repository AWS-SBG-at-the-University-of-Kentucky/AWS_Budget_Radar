"""Budget Radar reporter handler.

Read-only reporter: validates that invocation came from the TriggerTopic,
observes the current status of the configured budget action, and (in
Tasks 8-9) inventories running resources and publishes a report to SNS.

No workload or IAM mutation is ever performed here.
"""

import os
import time
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


# --- Area outcome constants (per-region/per-service coverage state) ---
COMPLETE, EMPTY, FAILED, UNSUPPORTED, NOT_SCANNED = "complete", "empty", "failed", "unsupported", "not_scanned"


def _ec2_instances(region):
    c = _client("ec2", region)
    lines = []
    for page in c.get_paginator("describe_instances").paginate(
            Filters=[{"Name": "instance-state-name", "Values": ["running", "pending"]}]):
        for res in page.get("Reservations", []):
            for inst in res.get("Instances", []):
                lines.append(f"{inst['InstanceId']} {inst.get('InstanceType', '?')} in {region}")
    return lines


def _rds_instances(region):
    c = _client("rds", region)
    lines = []
    for page in c.get_paginator("describe_db_instances").paginate():
        for db in page.get("DBInstances", []):
            lines.append(f"{db['DBInstanceIdentifier']} {db.get('DBInstanceClass', '?')} in {region}")
    return lines


def _rds_clusters(region):
    c = _client("rds", region)
    lines = []
    for page in c.get_paginator("describe_db_clusters").paginate():
        for cluster in page.get("DBClusters", []):
            lines.append(f"{cluster['DBClusterIdentifier']} {cluster.get('EngineMode', '?')} in {region}")
    return lines


def _list_cluster_arns(c):
    arns = []
    for page in c.get_paginator("list_clusters").paginate():
        arns.extend(page.get("clusterArns", []))
    return arns


def _ecs_services(region):
    c = _client("ecs", region)
    lines = []
    for cluster in _list_cluster_arns(c):
        service_arns = []
        for page in c.get_paginator("list_services").paginate(cluster=cluster):
            service_arns.extend(page.get("serviceArns", []))
        for i in range(0, len(service_arns), 10):  # describe_services caps at 10 per call
            chunk = service_arns[i:i + 10]
            resp = c.describe_services(cluster=cluster, services=chunk)
            for svc in resp.get("services", []):
                lines.append(f"{svc['serviceName']} ({svc.get('runningCount', 0)} running) in {region}")
    return lines


def _ecs_tasks(region):
    """Standalone tasks (RunTask), not owned by any ECS service."""
    c = _client("ecs", region)
    lines = []
    for cluster in _list_cluster_arns(c):
        task_arns = []
        for page in c.get_paginator("list_tasks").paginate(cluster=cluster):
            task_arns.extend(page.get("taskArns", []))
        for i in range(0, len(task_arns), 100):  # describe_tasks caps at 100 per call
            chunk = task_arns[i:i + 100]
            resp = c.describe_tasks(cluster=cluster, tasks=chunk)
            for task in resp.get("tasks", []):
                task_id = task.get("taskArn", "").rsplit("/", 1)[-1]
                lines.append(f"{task_id} {task.get('lastStatus', '?')} in {region}")
    return lines


def _lambda_functions(region):
    c = _client("lambda", region)
    lines = []
    for page in c.get_paginator("list_functions").paginate():
        for fn in page.get("Functions", []):
            name = fn["FunctionName"]
            reserved = c.get_function_concurrency(FunctionName=name).get("ReservedConcurrentExecutions")
            lines.append(f"{name} {fn.get('Runtime', '?')} reserved={reserved} in {region}")
    return lines


def _lambda_provisioned_concurrency(region):
    c = _client("lambda", region)
    lines = []
    for page in c.get_paginator("list_functions").paginate():
        for fn in page.get("Functions", []):
            name = fn["FunctionName"]
            for pc_page in c.get_paginator("list_provisioned_concurrency_configs").paginate(FunctionName=name):
                for cfg in pc_page.get("ProvisionedConcurrencyConfigs", []):
                    qualifier = cfg.get("FunctionArn", "").rsplit(":", 1)[-1]
                    allocated = cfg.get("AllocatedProvisionedConcurrentExecutions")
                    lines.append(f"{name}:{qualifier} allocated={allocated} in {region}")
    return lines


def _sagemaker_notebooks(region):
    c = _client("sagemaker", region)
    lines = []
    for page in c.get_paginator("list_notebook_instances").paginate():
        for nb in page.get("NotebookInstances", []):
            lines.append(f"{nb['NotebookInstanceName']} {nb.get('InstanceType', '?')} in {region}")
    return lines


def _sagemaker_endpoints(region):
    c = _client("sagemaker", region)
    lines = []
    for page in c.get_paginator("list_endpoints").paginate():
        for ep in page.get("Endpoints", []):
            lines.append(f"{ep['EndpointName']} {ep.get('EndpointStatus', '?')} in {region}")
    return lines


def _eips_unattached(region):
    # describe_addresses has no paginator; it always returns the full set in one call.
    c = _client("ec2", region)
    lines = []
    for addr in c.describe_addresses().get("Addresses", []):
        if not addr.get("AssociationId"):
            lines.append(f"{addr.get('PublicIp', '?')} {addr.get('AllocationId', '?')} in {region}")
    return lines


def _load_balancers(region):
    c = _client("elbv2", region)
    lines = []
    for page in c.get_paginator("describe_load_balancers").paginate():
        for lb in page.get("LoadBalancers", []):
            lines.append(f"{lb['LoadBalancerName']} {lb.get('Type', '?')} in {region}")
    return lines


def _ebs_volumes(region):
    c = _client("ec2", region)
    lines = []
    for page in c.get_paginator("describe_volumes").paginate():
        for vol in page.get("Volumes", []):
            lines.append(f"{vol['VolumeId']} {vol.get('Size', '?')}GiB {vol.get('State', '?')} in {region}")
    return lines


def _nat_gateways(region):
    c = _client("ec2", region)
    lines = []
    for page in c.get_paginator("describe_nat_gateways").paginate():
        for gw in page.get("NatGateways", []):
            lines.append(f"{gw['NatGatewayId']} {gw.get('State', '?')} in {region}")
    return lines


# Adapter registry. Each fn(region)->list[str]; raises on failure.
# S3 sizes are global via CloudWatch and handled separately in Task 9's report.
ADAPTERS = {
    "ec2-instances": _ec2_instances,
    "rds-instances": _rds_instances,
    "rds-clusters": _rds_clusters,
    "ecs-services": _ecs_services,
    "ecs-tasks": _ecs_tasks,
    "lambda-functions": _lambda_functions,
    "lambda-provisioned-concurrency": _lambda_provisioned_concurrency,
    "sagemaker-notebooks": _sagemaker_notebooks,
    "sagemaker-endpoints": _sagemaker_endpoints,
    "eips-unattached": _eips_unattached,
    "load-balancers": _load_balancers,
    "ebs-volumes": _ebs_volumes,
    "nat-gateways": _nat_gateways,
}


def enabled_regions():
    """Discover enabled regions to inventory."""
    c = _client("ec2")
    return [r["RegionName"] for r in c.describe_regions()["Regions"]]


def inventory(regions, deadline_epoch):
    areas = []
    for region in regions:
        for name, fn in ADAPTERS.items():
            if time.time() >= deadline_epoch:
                areas.append({"region": region, "service": name, "state": NOT_SCANNED, "items": []})
                continue
            try:
                items = fn(region)
                areas.append({"region": region, "service": name,
                              "state": COMPLETE if items else EMPTY, "items": items})
            except Exception as e:  # denied/throttled/unavailable -> FAILED, never zero
                areas.append({"region": region, "service": name, "state": FAILED,
                              "items": [], "error": str(e)})
    return {"areas": areas, "generated": _now_iso()}


def _from_trigger_topic(event):
    want = os.environ.get("TRIGGER_TOPIC_ARN")
    if not want:
        return False
    for rec in event.get("Records", []):
        if rec.get("Sns", {}).get("TopicArn") == want:
            return True
    return False


def handler(event, context):
    if not _from_trigger_topic(event):
        print("Event not from TriggerTopic; ignoring.")
        return {"status": "ignored"}
    regions = enabled_regions()
    deadline = time.time() + 780  # leave headroom under the 900s Lambda timeout for the report publish (Task 9)
    inventory(regions, deadline)
    # Report rendering + SNS publish added in Task 9.
    return {"status": "ok"}
