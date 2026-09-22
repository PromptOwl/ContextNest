"""
Generate a ~1000-document synthesized vault for the scaled determinism
experiment (E2 expanded).

Strategy:
  Replicate the existing 11-doc template across many service/team variants,
  varying threshold values, owners, tools, and SLAs to produce a corpus that
  is realistically structured and lexically heterogeneous, but with enough
  similarity between docs to crowd the dense embedding space.

Output:
  vaults-large/
    CONTEXT.md, context.yaml      (copied from vaults/)
    nodes/
      runbooks/<service>/deploy-rollback.md
      runbooks/<service>/database-migration.md
      runbooks/<service>/incident-response.md
      standards/api-design/<service>.md
      standards/security-review/<service>.md
      adrs/<service>/0003-grpc-internal-rest-external.md
      ... etc

Each doc gets:
  - A service-specific tag (#payments-service, #auth-service, etc.)
  - A topic tag (#runbook, #adr, #standards, ...)
  - A facet tag (#deploy, #database, #incident, #api, #security)
"""

import random
import shutil
from pathlib import Path

_HERE = Path(__file__).resolve().parent
SRC_VAULT = _HERE / "vaults"
DST_VAULT = _HERE / "vaults-large"

SERVICES = [
    "payments", "auth", "billing", "search", "catalog", "checkout", "cart",
    "inventory", "shipping", "notifications", "messaging", "analytics", "ml-features",
    "feed", "reporting", "audit-log", "settings", "feature-flags", "experimentation",
    "media", "uploads", "transcoder", "moderation", "ratings", "reviews", "recommendations",
    "subscriptions", "renewals", "refunds", "disputes", "tax", "invoicing", "ledger",
    "kyc", "identity", "sso", "oauth-proxy", "ratelimiter", "cdn-edge", "image-resize",
    "csv-export", "data-import", "etl-orchestrator", "warehouse-loader", "stream-processor",
    "kafka-relay", "schema-registry", "service-discovery", "config-store", "secrets-broker",
    "vault-proxy", "logger", "tracer", "metrics-shipper", "alerting", "oncall-router",
    "support-bot", "ticket-router", "knowledge-base", "doc-builder", "release-orchestrator",
    "build-cache", "deploy-gateway", "canary-controller", "shadow-traffic", "feature-store",
    "model-registry", "training-orchestrator", "inference-gateway", "embedding-service",
    "vector-index", "agent-runtime", "policy-engine", "consent-service", "personalization",
    "ab-testing", "campaigns", "ads-server", "billing-events", "fraud-detector",
    "risk-scorer", "anomaly-detector", "chargeback", "device-binding", "session-manager",
    "geo-router", "country-config", "currency-fx", "i18n", "translation-service",
    "content-cms", "asset-manager", "search-indexer", "ranker", "query-rewriter",
    "spelling", "suggester", "trending", "personal-shopper", "compare", "wishlist",
    "loyalty", "rewards-ledger", "promotions", "coupons", "gift-cards",
]
# 100 services × 10 doc types ≈ 1000 docs

DOC_TEMPLATES = {
    "deploy-rollback": {
        "path": "runbooks/{service}/deploy-rollback",
        "topic_tags": ["#runbook", "#deploy", "#ops"],
        "title_fmt": "Deploy Rollback Runbook --- {service}-service",
        "body_fmt": """# Deploy Rollback Runbook --- {service}-service

How to roll back a bad production deploy of the {service}-service.

## Trigger
Roll back if any of the following are true within {window} minutes of deploy:
- Error rate exceeds {error_pct}% on `/api/{service}/*` endpoints
- P99 latency exceeds {p99}ms
- {monitor} alert fires on the `{service}-prod-deploy-health` monitor

## Steps
1. Open the deploy pipeline for {service}-service in {ci}.
2. Click "Rerun previous successful build" on the most recent green deploy.
3. Confirm rollback by checking the version header on `/api/{service}/healthz`.
4. Post a #incidents update with the rolled-back SHA and cause.

Owner: {owner} team. Mean rollback time: {rb_time} minutes.
""",
    },
    "database-migration": {
        "path": "runbooks/{service}/database-migration",
        "topic_tags": ["#runbook", "#database", "#ops"],
        "title_fmt": "Database Migration Runbook --- {service}-service",
        "body_fmt": """# Database Migration Runbook --- {service}-service

Step-by-step process for running schema migrations against the {service}-service Postgres cluster.

## Pre-flight
- Confirm migration is reviewed and approved in the standards/api-design pipeline.
- Snapshot the database to S3 bucket `{service}-db-backups-prod` before any DDL.
- Notify #{service}-ops in Slack {notify} minutes before window.

## Run
1. Connect via bastion: `ssh {service}-bastion-prod`.
2. Apply the migration with `./scripts/migrate-{service}.sh up <version>`.
3. Verify with `./scripts/migrate-{service}.sh status`.

## Rollback
If the migration fails partway, run `./scripts/migrate-{service}.sh down <version>` then restore from the snapshot.

Owner: {owner} team. SLA: rollback complete within {sla} minutes.
""",
    },
    "incident-response": {
        "path": "runbooks/{service}/incident-response",
        "topic_tags": ["#runbook", "#incident", "#ops"],
        "title_fmt": "Incident Response Runbook --- {service}-service",
        "body_fmt": """# Incident Response Runbook --- {service}-service

Process for responding to a production incident affecting the {service}-service.

## Severity levels
- **SEV1**: customer-facing outage of {service}-service. Page on-call immediately.
- **SEV2**: degraded {service} functionality, partial impact. Page during business hours.
- **SEV3**: internal-only impact. File a ticket, no page.

## First {first_window} minutes
1. Open an incident in {paging_tool}.
2. Start a {bridge_tool} bridge and post the link in #{service}-incidents.
3. Assign an Incident Commander (IC) --- usually the on-call engineer for {service}.
4. The IC's only job is coordination. They do not debug.

## Post-incident
Within {pm_window} hours, the IC publishes a blameless postmortem to the eng wiki under the {service}-service section.
""",
    },
    "api-design": {
        "path": "standards/{service}/api-design",
        "topic_tags": ["#standards", "#api", "#engineering"],
        "title_fmt": "API Design Standards --- {service}-service",
        "body_fmt": """# API Design Standards --- {service}-service

Conventions every public {service}-service API endpoint must follow.

## Versioning
- All {service} endpoints are prefixed with `/v1/{service}/`, `/v2/{service}/`, etc.
- Breaking changes require a new version. We never remove fields from an existing version.
- Deprecation policy: announce {dep_days} days before removal.

## Response shape
Every JSON response from {service}-service is wrapped in an envelope:
```json
{{ "data": ..., "meta": {{ "request_id": "...", "service": "{service}" }} }}
```

## Errors
Errors use the RFC 7807 problem-details format. Error codes follow the convention `{service}.<resource>.<reason>` (e.g. `{service}.user.not_found`).

## Pagination
Cursor-based only. Offset pagination is forbidden because of consistency issues at high write rates on the {service} datastore.
""",
    },
    "security-review": {
        "path": "standards/{service}/security-review",
        "topic_tags": ["#standards", "#security", "#engineering"],
        "title_fmt": "Security Review Process --- {service}-service",
        "body_fmt": """# Security Review Process --- {service}-service

Process for getting a {service}-service feature security-reviewed before launch.

## When required
Mandatory review for any {service}-service feature that:
- Accepts user-uploaded files
- Issues or accepts authentication tokens
- Sends data to a third-party processor
- Touches PII or payment data

## How to request
File a ticket in the `{jira}` Jira project, tagged `{service}-review-request`. Attach the design doc and a threat model sketch.

## SLA
Initial response: {init_sla} business days. Full review: {full_sla} week(s) for standard features, {high_sla} weeks for anything in the mandatory list above.
""",
    },
    "grpc-rest-adr": {
        "path": "adrs/{service}/0003-grpc-internal-rest-external",
        "topic_tags": ["#adr", "#decision", "#api"],
        "title_fmt": "ADR 0003: gRPC internal, REST external --- {service}-service",
        "body_fmt": """# ADR 0003: gRPC internal, REST external --- {service}-service

Status: accepted, {adr_year}-{adr_month:02d}-{adr_day:02d}.

## Context
Service-to-service calls to {service}-service were a mix of REST and gRPC. The split was historical, not principled.

## Decision
All internal traffic to {service}-service uses gRPC. All external-facing {service} APIs use REST.

## Rationale
- gRPC's typed contracts catch breakages at compile time, which matters more inside the cluster where services change together.
- REST is what our customers expect and what their SDK tooling assumes. Forcing gRPC on customers would slow adoption.

## Consequences
- The {service}-service gateway layer translates between gRPC and REST.
- New internal callers of {service}-service get a generated gRPC client; we no longer hand-roll HTTP clients between services.
""",
    },
    "architecture": {
        "path": "architecture/{service}/architecture-overview",
        "topic_tags": ["#architecture", "#overview"],
        "title_fmt": "Architecture Overview --- {service}-service",
        "body_fmt": """# Architecture Overview --- {service}-service

The {service}-service handles {primary_responsibility} for the platform.

## Components
- **{service}-api**: REST gateway, written in Go.
- **{service}-worker**: background job processor consuming from Kafka topic `{service}.events`.
- **{service}-db**: dedicated Postgres cluster with {replicas} read replicas.
- **{service}-cache**: Redis cluster, {cache_size} GB working set.

## Dependencies
- Upstream: {upstream}
- Downstream: {downstream}

## Scale
The {service}-service handles approximately {qps} QPS at peak with p99 latency under {p99}ms.
""",
    },
    "onboarding": {
        "path": "onboarding/{service}/getting-started",
        "topic_tags": ["#onboarding", "#getting-started", "#setup"],
        "title_fmt": "Getting Started --- {service}-service",
        "body_fmt": """# Getting Started --- {service}-service

How to set up a development environment for the {service}-service.

## Prerequisites
- Docker {docker_v} or later
- Go {go_v} or later
- Access to the {service}-dev Postgres cluster (request via #{service}-team)

## Setup
1. Clone the repo: `git clone git@github.com:org/{service}-service.git`
2. Run `make {service}-bootstrap` to set up local config.
3. Start the service: `make {service}-dev`.

## First commit
Push a no-op change to verify your dev loop. The {service}-service CI takes about {ci_min} minutes for a full build.
""",
    },
    "monitoring": {
        "path": "runbooks/{service}/monitoring",
        "topic_tags": ["#runbook", "#monitoring", "#ops"],
        "title_fmt": "Monitoring Runbook --- {service}-service",
        "body_fmt": """# Monitoring Runbook --- {service}-service

Dashboards and alerts for the {service}-service.

## Dashboards
- `{service}-service-overview` in {dashboard_tool} --- p50/p99 latency, error rate, throughput.
- `{service}-service-saturation` --- CPU, memory, disk, network utilization across pods.

## Alerts
- Error rate > {alert_err}% triggers PagerDuty page to {oncall_team}.
- p99 latency > {alert_p99}ms triggers a warning to #{service}-alerts.
- Pod restart loop triggers an immediate page.

## Common false positives
The {service}-service has a known spike pattern at {spike_time} UTC every day due to {spike_cause}. Suppress alerts for {suppress_min} minutes around that window.
""",
    },
    "disaster-recovery": {
        "path": "runbooks/{service}/disaster-recovery",
        "topic_tags": ["#runbook", "#disaster-recovery", "#ops"],
        "title_fmt": "Disaster Recovery Runbook --- {service}-service",
        "body_fmt": """# Disaster Recovery Runbook --- {service}-service

Procedures for recovering the {service}-service from regional outage or data loss.

## RTO and RPO
- RTO (Recovery Time Objective): {rto} minutes
- RPO (Recovery Point Objective): {rpo} minutes
- Backup retention: {retention} days

## Failover procedure
1. Confirm the primary region is unreachable via {check_tool}.
2. Execute `failover-{service}-service --to=secondary` on the deploy bastion.
3. Update the DNS record for `{service}.api.example.com` to point at the secondary region.
4. Notify {downstream_owners} downstream teams via #{service}-failover.

## Restore from backup
Backups are stored in `s3://{service}-backups-{region}` with versioning enabled. To restore: `restore-{service} --snapshot=<id>`.
""",
    },
}

# Stable RNG so the generated corpus is reproducible
rng = random.Random(20260520)

CI_TOOLS = ["GitHub Actions", "Jenkins", "CircleCI", "GitLab CI", "Buildkite"]
MONITORING_TOOLS = ["Datadog", "Grafana", "New Relic", "Honeycomb", "Lightstep"]
DASHBOARD_TOOLS = ["Datadog", "Grafana", "Looker", "Tableau", "Honeycomb"]
PAGING_TOOLS = ["PagerDuty", "Opsgenie", "Splunk On-Call", "incident.io"]
BRIDGE_TOOLS = ["Zoom", "Google Meet", "Slack Huddle", "Microsoft Teams"]
TEAMS = [
    "platform", "infra", "data-platform", "ml-platform", "growth",
    "core-services", "search-platform", "payments-platform", "identity",
    "messaging-platform", "developer-experience", "site-reliability",
    "trust-and-safety", "internationalization", "experimentation",
]
JIRA_PROJECTS = ["SEC", "SECURITY", "INFOSEC", "PRODSEC", "APPSEC"]
REGIONS = ["us-east-1", "us-west-2", "eu-west-1", "ap-south-1", "ap-northeast-1"]


def render(template: str, **kw) -> str:
    return template.format(**kw)


def write_doc(path_rel: str, title: str, topic_tags: list[str], service_tag: str, body: str):
    out = DST_VAULT / "nodes" / f"{path_rel}.md"
    out.parent.mkdir(parents=True, exist_ok=True)
    tags = topic_tags + [service_tag]
    fm = (
        "---\n"
        f'title: "{title}"\n'
        "type: document\n"
        "status: published\n"
        "version: 1\n"
        f"tags: {tags}\n"
        "---\n\n"
    )
    out.write_text(fm + body)


def vars_for(service: str) -> dict:
    return {
        "service": service,
        # deploy-rollback
        "window": rng.choice([5, 10, 15]),
        "error_pct": rng.choice([0.5, 1, 2, 3]),
        "p99": rng.choice([300, 500, 600, 800, 1000, 1200]),
        "monitor": rng.choice(MONITORING_TOOLS),
        "ci": rng.choice(CI_TOOLS),
        "owner": rng.choice(TEAMS),
        "rb_time": rng.choice([2, 4, 6, 8, 10]),
        # database-migration
        "notify": rng.choice([15, 30, 45, 60, 90]),
        "sla": rng.choice([10, 15, 20, 30, 45, 60]),
        # incident-response
        "first_window": rng.choice([10, 15, 20]),
        "paging_tool": rng.choice(PAGING_TOOLS),
        "bridge_tool": rng.choice(BRIDGE_TOOLS),
        "pm_window": rng.choice([24, 48, 72, 96]),
        # api-design
        "dep_days": rng.choice([30, 60, 90, 120, 180]),
        # security-review
        "jira": rng.choice(JIRA_PROJECTS),
        "init_sla": rng.choice([1, 2, 3, 5]),
        "full_sla": rng.choice([1, 2, 3]),
        "high_sla": rng.choice([2, 3, 4]),
        # ADR
        "adr_year": rng.choice([2023, 2024, 2025]),
        "adr_month": rng.choice(range(1, 13)),
        "adr_day": rng.choice(range(1, 29)),
        # architecture
        "primary_responsibility": rng.choice([
            "transaction processing", "user authentication", "search and ranking",
            "media delivery", "feature flagging", "asynchronous task orchestration",
            "data ingestion", "analytics aggregation", "messaging delivery",
            "policy enforcement", "rate limiting and abuse prevention",
        ]),
        "replicas": rng.choice([2, 3, 4, 6, 8]),
        "cache_size": rng.choice([4, 8, 16, 32, 64, 128]),
        "upstream": rng.choice([
            "API gateway", "auth-service", "feature-flags", "policy-engine",
        ]),
        "downstream": rng.choice([
            "data warehouse", "alerting", "audit-log", "billing-events",
        ]),
        "qps": rng.choice([100, 500, 1_000, 5_000, 10_000, 50_000]),
        # onboarding
        "docker_v": rng.choice(["20", "24", "26", "27"]),
        "go_v": rng.choice(["1.20", "1.21", "1.22", "1.23"]),
        "ci_min": rng.choice([3, 5, 8, 12, 18, 25]),
        # monitoring
        "dashboard_tool": rng.choice(DASHBOARD_TOOLS),
        "alert_err": rng.choice([0.5, 1, 2, 5]),
        "alert_p99": rng.choice([500, 800, 1000, 1500]),
        "oncall_team": rng.choice(TEAMS),
        "spike_time": f"{rng.choice(range(0, 24)):02d}:00",
        "spike_cause": rng.choice([
            "scheduled batch run", "cron sweep", "cache warmup", "nightly aggregation",
        ]),
        "suppress_min": rng.choice([5, 10, 15, 20, 30]),
        # disaster-recovery
        "rto": rng.choice([15, 30, 60, 90, 120, 180]),
        "rpo": rng.choice([1, 5, 15, 30, 60]),
        "retention": rng.choice([30, 60, 90, 180, 365]),
        "check_tool": rng.choice(MONITORING_TOOLS),
        "downstream_owners": rng.choice([3, 5, 8, 12]),
        "region": rng.choice(REGIONS),
    }


def main():
    if DST_VAULT.exists():
        shutil.rmtree(DST_VAULT)

    # Copy the structural files from the source vault so ctx can index it
    (DST_VAULT / "nodes").mkdir(parents=True, exist_ok=True)
    for f in ("CONTEXT.md", "CLAUDE.md", "GEMINI.md"):
        src = SRC_VAULT / f
        if src.exists():
            shutil.copy(src, DST_VAULT / f)

    n_docs = 0
    for service in SERVICES:
        service_tag = f"#{service}-service"
        v = vars_for(service)
        for template_name, tpl in DOC_TEMPLATES.items():
            path_rel = tpl["path"].format(service=service)
            title = tpl["title_fmt"].format(**v)
            body = render(tpl["body_fmt"], **v)
            write_doc(path_rel, title, tpl["topic_tags"], service_tag, body)
            n_docs += 1
    print(f"Generated {n_docs} documents across {len(SERVICES)} services into {DST_VAULT}")


if __name__ == "__main__":
    main()
