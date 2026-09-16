"""Budget Radar reporter handler.

Read-only reporter: validates that invocation came from the TriggerTopic,
observes the current status of the configured budget action, and (in
Tasks 8-9) inventories running resources and publishes a report to SNS.

No workload or IAM mutation is ever performed here.
"""

import os
import time
import codecs
import datetime as dt
from urllib.parse import quote

import boto3
import botocore.config


# Bounded connect/read timeouts and retry count so a slow/unreachable region
# can never consume the whole Lambda budget on its own. Defined once and reused
# below (both in _BOTO_CONFIG and in the derived PUBLISH_MARGIN_SECONDS) so the
# two can never drift apart.
CONNECT_TIMEOUT_SECONDS = 5
READ_TIMEOUT_SECONDS = 15
MAX_ATTEMPTS = 2
_BOTO_CONFIG = botocore.config.Config(connect_timeout=CONNECT_TIMEOUT_SECONDS,
                                       read_timeout=READ_TIMEOUT_SECONDS,
                                       retries={"max_attempts": MAX_ATTEMPTS})


def _client(service, region=None):
    if region:
        return boto3.client(service, region_name=region, config=_BOTO_CONFIG)
    return boto3.client(service, config=_BOTO_CONFIG)


def _now_iso():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def _past(deadline):
    """True once `deadline` (an epoch seconds float) has been reached. A
    deadline of None means "no deadline" (never past)."""
    return deadline is not None and time.time() >= deadline


class DeadlineExceeded(Exception):
    """Raised by an adapter's pagination loop when the scan deadline is
    reached mid-scan. Carries whatever items were already collected so the
    caller can preserve partial coverage instead of losing it."""

    def __init__(self, items_so_far):
        super().__init__(f"scan deadline exceeded with {len(items_so_far)} item(s) already collected")
        self.items_so_far = items_so_far


class PartialCoverage(Exception):
    """Raised by an adapter when it collected BOTH successful items and
    in-band failures (e.g. ECS DescribeServices/DescribeTasks `failures[]`
    alongside real successes). Distinct from DeadlineExceeded: this always
    carries an explicit, non-deadline `reason` so the report never conflates
    "some items failed" with "ran out of scan time"."""

    def __init__(self, items, reason):
        super().__init__(reason)
        self.items = items
        self.reason = reason


def _iter_pages(paginator, deadline, items_so_far, **kwargs):
    """Drive a paginator while checking the scan deadline BEFORE each page is
    fetched, not after. `for page in paginator.paginate(...)` already fetches
    a page (a real network call) the moment the loop advances -- a deadline
    check inside the loop body only ever runs after that fetch has happened,
    so it can catch an expiry but can't prevent the next request. Checking
    here, before calling next() on the underlying iterator, actually stops
    the next page from ever being requested."""
    it = iter(paginator.paginate(**kwargs))
    while True:
        if _past(deadline):
            raise DeadlineExceeded(items_so_far)
        try:
            page = next(it)
        except StopIteration:
            return
        yield page


def observe_action_status(account_id, budget_name, action_id):
    """Return (observed_status, observation_iso, action_details).

    action_details is a dict with the action's threshold/approval/target
    info as reported by AWS Budgets (the report's header uses it), or None
    if the lookup failed — in which case status is 'UNKNOWN'.
    """
    try:
        c = _client("budgets")
        resp = c.describe_budget_action(AccountId=account_id, BudgetName=budget_name, ActionId=action_id)
        action = resp["Action"]
        threshold = action.get("ActionThreshold", {})
        iam_def = action.get("Definition", {}).get("IamActionDefinition", {})
        targets = []
        for kind in ("Users", "Groups", "Roles"):
            targets.extend(f"{kind[:-1].lower()}:{t}" for t in iam_def.get(kind, []))
        details = {
            "threshold_value": threshold.get("ActionThresholdValue"),
            "threshold_type": threshold.get("ActionThresholdType"),  # PERCENTAGE | ABSOLUTE_VALUE
            "notification_type": action.get("NotificationType"),  # ACTUAL | FORECASTED -- separate field
            "approval_model": action.get("ApprovalModel"),
            "targets": targets,
        }
        return action["Status"], _now_iso(), details
    except Exception:
        return "UNKNOWN", _now_iso(), None


# --- Area outcome constants (per-region/per-service coverage state) ---
COMPLETE, EMPTY, FAILED, UNSUPPORTED, NOT_SCANNED, PARTIAL = (
    "complete", "empty", "failed", "unsupported", "not_scanned", "partial",
)


def _ec2_instances(region, deadline=None):
    c = _client("ec2", region)
    lines = []
    for page in _iter_pages(c.get_paginator("describe_instances"), deadline, lines,
            Filters=[{"Name": "instance-state-name", "Values": ["running", "pending"]}]):
        for res in page.get("Reservations", []):
            for inst in res.get("Instances", []):
                asg_name = next((t.get("Value") for t in inst.get("Tags", [])
                                  if t.get("Key") == "aws:autoscaling:groupName"), None)
                asg_note = f" (ASG: {asg_name})" if asg_name else ""
                lines.append(f"{inst['InstanceId']} {inst.get('InstanceType', '?')}{asg_note} in {region}")
    return lines


def _rds_instances(region, deadline=None):
    c = _client("rds", region)
    lines = []
    for page in _iter_pages(c.get_paginator("describe_db_instances"), deadline, lines):
        for db in page.get("DBInstances", []):
            lines.append(f"{db['DBInstanceIdentifier']} {db.get('DBInstanceClass', '?')} in {region}")
    return lines


def _rds_clusters(region, deadline=None):
    c = _client("rds", region)
    lines = []
    for page in _iter_pages(c.get_paginator("describe_db_clusters"), deadline, lines):
        for cluster in page.get("DBClusters", []):
            lines.append(f"{cluster['DBClusterIdentifier']} {cluster.get('EngineMode', '?')} in {region}")
    return lines


def _list_cluster_arns(c, deadline=None):
    arns = []
    for page in _iter_pages(c.get_paginator("list_clusters"), deadline, arns):
        arns.extend(page.get("clusterArns", []))
    return arns


def _ecs_services(region, deadline=None):
    """Services per cluster. In-band `failures[]` from DescribeServices (a
    SUCCESSFUL response can still report failed lookups) are surfaced as
    explicit failure lines, never silently dropped: if every describe came
    back as a failure with nothing successful, this raises so inventory()
    marks the area FAILED instead of EMPTY. If there is a MIX of successes
    and failures, this raises PartialCoverage (not a plain return) so
    inventory() marks the area PARTIAL-for-failures, distinct from a
    deadline-caused PARTIAL, instead of silently reporting COMPLETE."""
    c = _client("ecs", region)
    lines = []
    failure_lines = []
    try:
        clusters = _list_cluster_arns(c, deadline)
    except DeadlineExceeded:
        raise DeadlineExceeded(lines)
    for cluster in clusters:
        if _past(deadline):
            raise DeadlineExceeded(lines)
        service_arns = []
        for page in _iter_pages(c.get_paginator("list_services"), deadline, lines, cluster=cluster):
            service_arns.extend(page.get("serviceArns", []))
        for i in range(0, len(service_arns), 10):  # describe_services caps at 10 per call
            if _past(deadline):
                raise DeadlineExceeded(lines)
            chunk = service_arns[i:i + 10]
            resp = c.describe_services(cluster=cluster, services=chunk)
            for svc in resp.get("services", []):
                lines.append(f"{svc['serviceName']} ({svc.get('runningCount', 0)} running, "
                              f"{svc.get('schedulingStrategy', 'REPLICA')}) in {region}")
            for fail in resp.get("failures", []):
                failure_lines.append(f"{fail.get('arn', '?')} FAILED: {fail.get('reason', 'unknown')} in {region}")
    if failure_lines:
        if not lines:
            raise RuntimeError("ECS DescribeServices returned only failures: " + "; ".join(failure_lines))
        raise PartialCoverage(lines + failure_lines,
                               "in-band failures reported by DescribeServices; partial results only")
    return lines


def _ecs_tasks(region, deadline=None):
    """Standalone tasks (RunTask), not owned by any ECS service — tasks whose
    startedBy begins with 'ecs-svc/' are service-owned and are filtered out
    here because ecs-services already reports them. In-band `failures[]` are
    handled the same way as _ecs_services, including raising PartialCoverage
    on a mix of successes and failures."""
    c = _client("ecs", region)
    lines = []
    failure_lines = []
    try:
        clusters = _list_cluster_arns(c, deadline)
    except DeadlineExceeded:
        raise DeadlineExceeded(lines)
    for cluster in clusters:
        if _past(deadline):
            raise DeadlineExceeded(lines)
        task_arns = []
        for page in _iter_pages(c.get_paginator("list_tasks"), deadline, lines, cluster=cluster):
            task_arns.extend(page.get("taskArns", []))
        for i in range(0, len(task_arns), 100):  # describe_tasks caps at 100 per call
            if _past(deadline):
                raise DeadlineExceeded(lines)
            chunk = task_arns[i:i + 100]
            resp = c.describe_tasks(cluster=cluster, tasks=chunk)
            for task in resp.get("tasks", []):
                if task.get("startedBy", "").startswith("ecs-svc/"):
                    continue  # service-owned; reported by ecs-services instead
                task_id = task.get("taskArn", "").rsplit("/", 1)[-1]
                lines.append(f"{task_id} {task.get('lastStatus', '?')} in {region}")
            for fail in resp.get("failures", []):
                failure_lines.append(f"{fail.get('arn', '?')} FAILED: {fail.get('reason', 'unknown')} in {region}")
    if failure_lines:
        if not lines:
            raise RuntimeError("ECS DescribeTasks returned only failures: " + "; ".join(failure_lines))
        raise PartialCoverage(lines + failure_lines,
                               "in-band failures reported by DescribeTasks; partial results only")
    return lines


def _lambda_functions(region, deadline=None):
    c = _client("lambda", region)
    lines = []
    for page in _iter_pages(c.get_paginator("list_functions"), deadline, lines):
        for fn in page.get("Functions", []):
            # Checked before EVERY per-function GetFunctionConcurrency call
            # (not just at page boundaries) so a deadline crossed mid-page
            # stops further per-item requests immediately.
            if _past(deadline):
                raise DeadlineExceeded(lines)
            name = fn["FunctionName"]
            reserved = c.get_function_concurrency(FunctionName=name).get("ReservedConcurrentExecutions")
            lines.append(f"{name} {fn.get('Runtime', '?')} reserved={reserved} in {region}")
    return lines


def _lambda_provisioned_concurrency(region, deadline=None):
    c = _client("lambda", region)
    lines = []
    for page in _iter_pages(c.get_paginator("list_functions"), deadline, lines):
        for fn in page.get("Functions", []):
            if _past(deadline):
                raise DeadlineExceeded(lines)
            name = fn["FunctionName"]
            for pc_page in _iter_pages(c.get_paginator("list_provisioned_concurrency_configs"),
                                        deadline, lines, FunctionName=name):
                for cfg in pc_page.get("ProvisionedConcurrencyConfigs", []):
                    qualifier = cfg.get("FunctionArn", "").rsplit(":", 1)[-1]
                    allocated = cfg.get("AllocatedProvisionedConcurrentExecutions")
                    lines.append(f"{name}:{qualifier} allocated={allocated} in {region}")
    return lines


def _sagemaker_notebooks(region, deadline=None):
    c = _client("sagemaker", region)
    lines = []
    for page in _iter_pages(c.get_paginator("list_notebook_instances"), deadline, lines):
        for nb in page.get("NotebookInstances", []):
            lines.append(f"{nb['NotebookInstanceName']} {nb.get('InstanceType', '?')} in {region}")
    return lines


def _sagemaker_endpoints(region, deadline=None):
    c = _client("sagemaker", region)
    lines = []
    for page in _iter_pages(c.get_paginator("list_endpoints"), deadline, lines):
        for ep in page.get("Endpoints", []):
            lines.append(f"{ep['EndpointName']} {ep.get('EndpointStatus', '?')} in {region}")
    return lines


def _eips_unattached(region, deadline=None):
    # describe_addresses has no paginator; it always returns the full set in one call.
    c = _client("ec2", region)
    lines = []
    for addr in c.describe_addresses().get("Addresses", []):
        if not addr.get("AssociationId"):
            lines.append(f"{addr.get('PublicIp', '?')} {addr.get('AllocationId', '?')} in {region}")
    return lines


def _load_balancers(region, deadline=None):
    c = _client("elbv2", region)
    lines = []
    for page in _iter_pages(c.get_paginator("describe_load_balancers"), deadline, lines):
        for lb in page.get("LoadBalancers", []):
            lines.append(f"{lb['LoadBalancerName']} {lb.get('Type', '?')} in {region}")
    return lines


def _ebs_volumes(region, deadline=None):
    c = _client("ec2", region)
    lines = []
    for page in _iter_pages(c.get_paginator("describe_volumes"), deadline, lines):
        for vol in page.get("Volumes", []):
            lines.append(f"{vol['VolumeId']} {vol.get('Size', '?')}GiB {vol.get('State', '?')} in {region}")
    return lines


def _nat_gateways(region, deadline=None):
    c = _client("ec2", region)
    lines = []
    for page in _iter_pages(c.get_paginator("describe_nat_gateways"), deadline, lines):
        for gw in page.get("NatGateways", []):
            lines.append(f"{gw['NatGatewayId']} {gw.get('State', '?')} in {region}")
    return lines


# Adapter registry. Each fn(region, deadline=None)->list[str]; raises on failure,
# raises DeadlineExceeded(items_so_far) if the scan deadline is hit mid-pagination.
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
            if _past(deadline_epoch):
                areas.append({"region": region, "service": name, "state": NOT_SCANNED, "items": []})
                continue
            try:
                items = fn(region, deadline_epoch)
            except PartialCoverage as e:  # some items failed in-band -> PARTIAL, reason distinct from deadline
                areas.append({"region": region, "service": name, "state": PARTIAL,
                              "items": e.items, "reason": e.reason})
                continue
            except DeadlineExceeded as e:  # deadline hit mid-pagination -> preserve partial items
                if e.items_so_far:
                    areas.append({"region": region, "service": name, "state": PARTIAL,
                                  "items": e.items_so_far,
                                  "reason": "scan deadline reached; partial results only"})
                else:
                    areas.append({"region": region, "service": name, "state": NOT_SCANNED, "items": []})
                continue
            except Exception as e:  # denied/throttled/unavailable -> FAILED, never zero
                areas.append({"region": region, "service": name, "state": FAILED,
                              "items": [], "error": str(e)})
                continue
            areas.append({"region": region, "service": name,
                          "state": COMPLETE if items else EMPTY, "items": items})
    return {"areas": areas, "generated": _now_iso()}


def _from_trigger_topic(event):
    want = os.environ.get("TRIGGER_TOPIC_ARN")
    if not want:
        return False
    for rec in event.get("Records", []):
        if rec.get("Sns", {}).get("TopicArn") == want:
            return True
    return False


# --- Report assembly, S3 sizing, byte budget, publish (Task 9) ---

SNS_MAX_BYTES = 262144
# Worst case for a single boto3 request under _BOTO_CONFIG: every attempt
# (including retries) can spend up to connect+read seconds before that
# attempt fails over to the next one.
WORST_REQUEST_SECONDS = MAX_ATTEMPTS * (CONNECT_TIMEOUT_SECONDS + READ_TIMEOUT_SECONDS)
# Reserved off the Lambda's remaining time for build_report()/publish(): must
# cover at least one worst-case (fully retried) request still in flight when
# the deadline is checked, plus a small allowance for report assembly and the
# publish() SNS call itself.
PUBLISH_MARGIN_SECONDS = WORST_REQUEST_SECONDS + 10
_LOG_CHUNK_BYTES = 200_000  # keep well under typical CloudWatch Logs per-event limits


def _bucket_region(s3_client, name):
    """Resolve a bucket's region via GetBucketLocation. Returns (region, resolved).
    resolved=False means the lookup failed — callers must label the size as
    unknown rather than silently guessing us-east-1."""
    try:
        loc = s3_client.get_bucket_location(Bucket=name).get("LocationConstraint")
        region = loc or "us-east-1"  # AWS returns null/empty for us-east-1
        if region == "EU":  # legacy constraint value
            region = "eu-west-1"
        return region, True
    except Exception:
        return None, False


def s3_bucket_sizes(deadline_epoch=None):
    """S3 sizes from daily CloudWatch BucketSizeBytes, queried in each bucket's
    OWN region. Only the StandardStorage class is queried; the label says so
    explicitly so a reader isn't misled that it's the bucket's total size.
    Never enumerate objects. Honors the scan deadline: checked before
    ListBuckets even runs, before each bucket's GetBucketLocation, and before
    each bucket's GetMetricData -- never just at the top of the bucket loop."""
    if _past(deadline_epoch):
        # Already past deadline: do not even call ListBuckets.
        return ["S3 bucket sizing stopped early (scan deadline already reached before it began); "
                "0 bucket(s) sized."]
    try:
        s3 = _client("s3")
        buckets = s3.list_buckets().get("Buckets", [])
    except Exception as e:  # denied/unavailable -> unknown, never silent 0/omission
        return [f"S3 bucket sizing unavailable: {e}"]
    lines = []
    for idx, b in enumerate(buckets):
        if _past(deadline_epoch):  # before GetBucketLocation
            remaining = len(buckets) - idx
            lines.append(f"S3 bucket sizing stopped early (scan deadline reached); "
                          f"{remaining} of {len(buckets)} bucket(s) not sized.")
            break
        name = b["Name"]
        region, resolved = _bucket_region(s3, name)
        if not resolved:
            lines.append(f"s3://{name}: size unknown (bucket region lookup failed)")
            continue
        if _past(deadline_epoch):  # before GetMetricData
            remaining = len(buckets) - idx
            lines.append(f"S3 bucket sizing stopped early (scan deadline reached); "
                          f"{remaining} of {len(buckets)} bucket(s) not sized.")
            break
        try:
            cw = _client("cloudwatch", region)
            resp = cw.get_metric_data(MetricDataQueries=[{
                "Id": "size",
                "MetricStat": {
                    "Metric": {"Namespace": "AWS/S3", "MetricName": "BucketSizeBytes",
                               "Dimensions": [{"Name": "BucketName", "Value": name},
                                              {"Name": "StorageType", "Value": "StandardStorage"}]},
                    "Period": 86400, "Stat": "Average"}
            }], StartTime=dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=2),
               EndTime=dt.datetime.now(dt.timezone.utc))
            vals = resp["MetricDataResults"][0].get("Values", [])
            ts = resp["MetricDataResults"][0].get("Timestamps", [])
            if vals:
                lines.append(f"s3://{name} ({region}): StandardStorage bytes as of {ts[0] if ts else '?'}: "
                              f"{int(vals[0])} (StandardStorage only — other storage classes not included)")
            else:
                lines.append(f"s3://{name} ({region}): size unknown (no recent CloudWatch metric)")
        except Exception as e:  # denied/throttled -> unknown, never silent 0
            lines.append(f"s3://{name} ({region}): size unknown ({e})")
    return lines


def _log_full_report(body):
    """Emit the full, untruncated report to the Lambda log in bounded chunks
    so the truncation notice's claim ("see CloudWatch Logs for the complete
    report") is actually true. Uses an incremental UTF-8 decoder across chunk
    boundaries: decoding each byte slice independently (with errors="ignore")
    would silently drop a multibyte character that happens to be split across
    two chunks -- the incremental decoder instead buffers the incomplete tail
    bytes and completes the character once the next chunk arrives."""
    data = body.encode("utf-8")
    decoder = codecs.getincrementaldecoder("utf-8")()
    for i in range(0, len(data), _LOG_CHUNK_BYTES):
        chunk = data[i:i + _LOG_CHUNK_BYTES]
        is_last = i + _LOG_CHUNK_BYTES >= len(data)
        print(decoder.decode(chunk, final=is_last))


def _fit(body, limit=SNS_MAX_BYTES):
    """Enforce the SNS byte budget. Never silently truncate into a completeness claim:
    if we have to cut, log the full report first, then say so explicitly."""
    data = body.encode("utf-8")
    if len(data) <= limit:
        return body
    _log_full_report(body)
    notice = ("\n\n[... report truncated/omitted to fit the 256 KB SNS message limit; "
               "this is NOT the full inventory — the complete report was written to "
               "CloudWatch Logs for this invocation ...]")
    keep = limit - len(notice.encode("utf-8"))
    return data[:keep].decode("utf-8", "ignore") + notice


def _safety_label(safety):
    return "automatic approval configured" if safety == "armed" else "manual approval configured"


_STATUS_NARRATIVE = {
    # Keys are the real DescribeBudgetAction ActionStatus enum values.
    "STANDBY": "the action is on standby and has not been applied.",
    "PENDING": "the action is pending approval and has not yet been applied.",
    "EXECUTION_IN_PROGRESS": "AWS Budgets is currently executing the action.",
    "EXECUTION_SUCCESS": "the configured action WAS applied by AWS Budgets.",
    # This reporter never inspects policy attachments directly, so it must not
    # assert what state the deny policy is actually in -- only that AWS
    # Budgets reports the execution failed.
    "EXECUTION_FAILURE": ("AWS Budgets reports the action FAILED to execute. The actual attachment/deny "
                          "state is UNVERIFIED by this reporter — check the AWS Budgets console and the "
                          "target IAM principals directly. Investigate immediately."),
    "REVERSE_IN_PROGRESS": "AWS Budgets is currently reversing the action.",
    "REVERSE_SUCCESS": "the action has been reversed; workloads are no longer restricted by it.",
    "REVERSE_FAILURE": "an attempt to reverse the action FAILED — the prior state may still be in effect.",
    "RESET_IN_PROGRESS": "AWS Budgets is currently resetting the action.",
    "RESET_FAILURE": "an attempt to reset the action FAILED — verify the action's state directly.",
    "UNKNOWN": "the action status could not be determined (the lookup failed or was denied); treat as unverified.",
}


def _status_narrative(status):
    if status in _STATUS_NARRATIVE:
        return _STATUS_NARRATIVE[status]
    if status.startswith("REVERSE_"):
        return f"observed status is {status} (a reversal outcome); verify directly in the AWS Budgets console."
    return f"observed status is {status}; verify directly in the AWS Budgets console."


def _format_threshold(action_details):
    """Render BOTH real, distinct DescribeBudgetAction fields: ActionThreshold
    (ActionThresholdType: PERCENTAGE|ABSOLUTE_VALUE, ActionThresholdValue) and
    the separate top-level NotificationType (ACTUAL|FORECASTED spend). These
    must never be conflated -- e.g. "100% (PERCENTAGE) on FORECASTED spend"
    or "$50 (ABSOLUTE_VALUE) on ACTUAL spend"."""
    if not action_details or action_details.get("threshold_value") is None:
        return "unknown (action lookup failed)"
    ttype = action_details.get("threshold_type") or "unknown"
    ntype = action_details.get("notification_type") or "unknown"
    mode = action_details.get("approval_model") or "unknown"
    value = action_details["threshold_value"]
    if isinstance(value, float) and value.is_integer():
        value = int(value)  # render a whole-number threshold as "100%", not "100.0%"
    unit = "%" if ttype == "PERCENTAGE" else ""
    prefix = "$" if ttype == "ABSOLUTE_VALUE" else ""
    return f"{prefix}{value}{unit} ({ttype}) on {ntype} spend; approval mode: {mode}"


def _format_targets(action_details):
    if not action_details or not action_details.get("targets"):
        return "unknown (action lookup failed or no targets configured)"
    return ", ".join(action_details["targets"])


def _budgets_console_url(account_id, budget_name):
    if not budget_name:
        return "https://console.aws.amazon.com/billing/home#/budgets (budget name unknown)"
    return f"https://console.aws.amazon.com/billing/home#/budgets/details?name={quote(budget_name)}"


def build_report(status, status_ts, inv, safety, account_id=None, budget_name=None,
                  action_details=None, deadline_epoch=None):
    lines = []
    lines.append("AWS Budget Radar - budget threshold reached.")
    lines.append("")
    lines.append(f"AWS account: {account_id or 'unknown'}")
    lines.append(f"Budget: {budget_name or 'unknown'}")
    lines.append(f"Action threshold: {_format_threshold(action_details)}")
    lines.append(f"Covered identities (deny targets): {_format_targets(action_details)}")
    lines.append(f"View/manage in the AWS Budgets console: {_budgets_console_url(account_id, budget_name)}")
    lines.append("To reverse the action: assume the RECOVERY_PRINCIPAL_ARN principal configured at "
                  "deploy time (see README) and detach the deny policy, or use the console link above.")
    lines.append("")
    lines.append(f"Safety configuration: {safety} ({_safety_label(safety)}).")
    lines.append(f"Observed action status (from AWS Budgets, authoritative): {status} at {status_ts} "
                 f"-- {_status_narrative(status)}")
    lines.append("")
    lines.append("IMPORTANT: Workloads that are already running KEEP running until you stop them yourself.")
    lines.append("This report does not stop anything - it only observes and informs.")
    lines.append("This is a best-effort inventory with explicit coverage gaps, not a complete bill or a")
    lines.append("guarantee that every costing resource is listed below.")
    lines.append("")
    lines.append(f"Inventory generated: {inv.get('generated', status_ts)}")
    lines.append("")
    for area in inv["areas"]:
        head = f"[{area['state'].upper()}] {area['service']} @ {area['region']}"
        if area["state"] == FAILED:
            head += f" - {area.get('error', '')}"
        if area["state"] == PARTIAL:
            head += f" - {area.get('reason', 'partial results only')}"
        lines.append(head)
        for it in area["items"]:
            lines.append(f"    - {it}")
    lines.append("")
    lines.append("Still costing you money (investigate):")
    for s in s3_bucket_sizes(deadline_epoch):
        lines.append(f"    - {s}")
    lines.append("")
    lines.append("To lift the block: reverse the budget action in the console (admin route), "
                  "or it clears automatically at the next budget period.")
    return _fit("\n".join(lines))


def publish(topic_arn, subject, body):
    """Publish the report. MUST NOT swallow errors: a failed publish must raise so the
    async Lambda invocation is marked failed, retries fire, and exhausted retries land
    on the on-failure destination (the dead-letter queue)."""
    _client("sns").publish(TopicArn=topic_arn, Subject=subject[:100], Message=body)


def handler(event, context):
    if not _from_trigger_topic(event):
        print("Event not from TriggerTopic; ignoring.")
        return {"status": "ignored"}

    account_id = os.environ["ACCOUNT_ID"]
    budget_name = os.environ["BUDGET_NAME"]
    action_id = os.environ["ACTION_ID"]
    report_topic = os.environ["REPORT_TOPIC_ARN"]
    safety = os.environ.get("SAFETY", "watch")

    status, status_ts, action_details = observe_action_status(account_id, budget_name, action_id)

    # Real deadline derived from the Lambda context's remaining time (falls back
    # to a full 900s budget when no context is supplied, e.g. in tests), minus a
    # margin reserved for build_report()/publish() so the report always ships.
    remaining = context.get_remaining_time_in_millis() / 1000 if context is not None else 900
    deadline = time.time() + max(1, remaining - PUBLISH_MARGIN_SECONDS)

    try:
        regions = enabled_regions()
        region_failure_area = None
    except Exception as e:  # never abort reporting just because region discovery failed
        regions = []
        region_failure_area = {"region": "(all)", "service": "region-enumeration",
                                "state": FAILED, "items": [], "error": str(e)}
    inv = inventory(regions, deadline_epoch=deadline)
    if region_failure_area is not None:
        inv["areas"].insert(0, region_failure_area)
    body = build_report(status, status_ts, inv, safety, account_id=account_id, budget_name=budget_name,
                         action_details=action_details, deadline_epoch=deadline)
    publish(report_topic, "AWS Budget Radar: budget threshold reached", body)  # raises on failure
    return {"status": "reported", "action_status": status}
