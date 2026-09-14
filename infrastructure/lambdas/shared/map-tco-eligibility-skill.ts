export const DEFAULT_MAP_TCO_ELIGIBILITY_SKILL = `---
name: map-tco-eligibility
description: Determine AWS MAP / MAP Lite eligibility and produce a MAP eligibility & funding estimate workbook from an AWS Pricing Calculator / TCO Calculator export (PDF). Use this skill whenever the user provides a TCO calculator PDF and asks to check MAP eligibility, qualify a deal for MAP or MAP Lite, "run this through the MAP calculator", "check if this TCO qualifies for MAP funding", "is this deal MAP eligible", or wants to know which services/spend in a TCO estimate are MAP-tagged/qualified spend. Also trigger on brief requests like "check MAP eligibility for this" or "is this MAP qualified" whenever a TCO calculator PDF is attached or referenced. Always use this skill for MAP/MAP Lite eligibility or funding-estimate requests — even if the user doesn't use the word "skill" or spell out every step.
---

# AWS MAP TCO Eligibility Checker

Given an AWS TCO/Pricing Calculator PDF export, determine:
1. Whether the deal qualifies for **MAP** or **MAP Lite** (and which sub-tier), based on ARR.
2. Which line-item services in the estimate are **MAP-eligible spend** (fully, partially, or not eligible), per the AWS Included Services List.
3. An **estimated** partner cash / credits breakdown across Assess, Mobilize, and Migrate & Modernize phases, applying the funding-modifier rules — using inputs the user supplies for anything not derivable from the PDF (Greenfield status, % VMware, % modernization scope).
4. An Excel workbook with an eligibility checklist tab and a calculation tab.

This is a partner-facing **funding estimate**, not a binding eligibility determination — the output should say so.

## Reference files

- references/included-services.md — which AWS services count as MAP-tagged spend, with notes on partial exclusions, plus the DB&A and SAP/Oracle included-service subsets and a name-matching table for translating TCO Calculator display names to this list.
- references/map-funding-construct.md — ARR tiers, phase-by-phase percentages, caps, and modifier conditions (Modernization, Greenfield, VMware, DB&A, SAP/Oracle).

Read both before starting — the numbers should come from these files, not from memory.

## Workflow

### 1. Extract data from the TCO Calculator PDF

Use the provided Calculator estimate evidence to obtain:
- Total 12 months cost from the Estimate Summary — this is the ARR used for tier determination unless the user says the deal has different terms.
- Every Detailed Estimate row: service name, group, region, and monthly cost. Sum monthly cost by unique service name.
- Use any group summary as a reconciliation cross-check.

### 2. Determine MAP tier

Compare ARR against the funding reference tier table: MAP ($500K–$10M), MAP Lite ($100K–$500K), MAP Lite small ($1–$100K), or not eligible/manual review.

### 3. Match services against the Included Services List

Classify each unique service as:
- **Eligible** — service and cost type match an included-service row with no disqualifying exclusion.
- **Partially eligible** — the service is eligible but a portion is excluded; explain the caveat without inventing a dollar split.
- **Not eligible** — explicitly excluded, data transfer, or third-party licensing.
- **Needs manual review** — no clear reference match; do not guess.

Also tag DB&A and SAP/Oracle subsets because they drive Migrate & Modernize modifiers.

### 4. Get modifier inputs from the user

Never infer or default these values:
- Is the customer AWS Greenfield-designated?
- What percentage of workloads are VMware-based?
- What percentage of migration scope is modern services?
- If VMware applies, how many VMs are being migrated?

If a value is unknown, treat that modifier as not claimed and say so.

### 5. Calculate estimated funding

Apply the funding reference formulas and caps:
- Assess: 5% of ARR, capped at $75K, for MAP and MAP Lite $100K–$500K only.
- Mobilize: applicable Modernization, Greenfield, VMware percentage, and VMware per-VM modifiers, individually capped and collectively capped at 20% of ARR where applicable.
- Migrate & Modernize: tier base credit plus DB&A, SAP/Oracle, and VMware modifiers where applicable, using eligible ARR when required by the reference.

Flag the $200/VM VMware cash line as internal-only.

### 6. Generate the result

Provide an eligibility checklist with service, product code, category, monthly cost, annual cost, eligibility, and notes. Provide ARR, tier, phase breakdown, total estimated partner cash, total estimated credits, explicit assumptions, modifier inputs, open questions, and the required disclaimer.

### 7. Present the result

Summarize ARR, tier, eligible versus excluded services, total estimated funding, manual-review items, and unclaimed modifiers.`;

export const MAP_FUNDING_REFERENCE = `MAP funding construct:
- ARR tiers: MAP $500K–$10M; MAP Lite $100K–$500K; MAP Lite small $1–$100K; below $1K or above $10M requires manual review.
- Assess: up to 5% of ARR, capped at $75,000, for MAP and MAP Lite $100K–$500K only.
- Mobilize modifiers, collectively capped at 20% of ARR for applicable tiers: Modernization +10% capped $100K when ARR is at least $500K and modern scope is at least 40%; Greenfield +10% capped $100K when explicitly designated; VMware +10% capped $200K when at least 75% of workloads are VMware; VMware per-VM $200 per migrated VM capped $1M, internal-only and payable after completion.
- Migrate & Modernize base credits: MAP 25% of ARR; MAP Lite $100K–$500K 15%; MAP Lite small 15% as its only confirmed benefit.
- Additional credits: DB&A +10%; SAP & Oracle +50%; VMware +10% for MAP Lite when conditions apply. Applicability to MAP Lite small is unconfirmed and must be flagged.
- Never infer Greenfield designation, VMware percentage, modernization percentage, or migrated VM count. Unknown values mean the modifier is not claimed.
- Treat the Calculator 12-month total as ARR unless evidence indicates ramp-up, multi-year, or non-standard terms.`;

export const MAP_INCLUDED_SERVICES_REFERENCE = `AWS MAP included-services reference (29 July 2026):
- Always exclude data transfer and third-party software license costs.
- Eligible general service families include API Gateway, AppStream excluding user fees, AppSync, Athena, Backup, Certificate Manager including Private CA, Cloud Directory, CloudHSM, CloudWatch Logs only, CodeBuild, CodePipeline, CodeStar, Cognito excluding add-ons, Comprehend, Data Pipeline, DMS, DataSync, Direct Connect excluding Local Zones, Directory Service, DynamoDB, DAX, EC2 including EBS and snapshots, ECR, ECS including Fargate, Elastic Beanstalk, EFS, ELB, ElastiCache, EMR, S3 Glacier excluding Deep Archive, Glue, KMS with exclusions, Kinesis services, Lambda, MQ, MSK, Neptune, Network Firewall, OpenSearch excluding Serverless and Ingestion, Redshift, RDS/Aurora, Route 53 with exclusions, S3 storage only, SageMaker with exclusions, Secrets Manager, Security Hub, SNS, SQS, Step Functions, Storage Gateway, Systems Manager OpsCenter only, Transfer Family, Transit Gateway, WorkSpaces with exclusions, CloudFront excluding Lambda@Edge, Kendra, Keyspaces, Mainframe Modernization with exclusions, DRS, DocumentDB, Omics, Timestream, QuickSight with exclusions, Resilience Hub, FinSpace, GameLift with exclusions, MemoryDB excluding snapshot storage, HealthImaging, VPC Lattice, Bedrock subject to tagging rules, Deadline Cloud, HealthLake, Aurora DSQL, IoT Core, IoT SiteWise with exclusions, Bedrock AgentCore excluding data transfer, Payment Cryptography, Cloud WAN, End User Messaging with exclusions, RTB Fabric, and SES with exclusions.
- EKS Fargate is not included; ECS Fargate is included. If Fargate's orchestrator is unknown, classify it as Needs manual review.
- EVS includes only underlying EC2 use and excludes VCF licensing, VPC Route Server Endpoints, and the EVS control plane.
- Known aliases: EBS maps to EC2/AmazonEC2; Aurora maps to RDS/AmazonRDS; VPC/TGW maps to Transit Gateway/AmazonVPC; ELB maps to AWSELB.
- DB&A subset includes RDS, Athena, DynamoDB/DAX, ElastiCache, OpenSearch, EMR with stated exclusions, Kinesis Data Streams, DocumentDB, MSK, Neptune, Redshift, DMS, Glue, Keyspaces, Timestream, QuickSight, FinSpace, MemoryDB, HealthImaging, and Aurora DSQL.
- SAP/Oracle subset includes RDS, CloudWatch Logs, EC2/EBS, EFS, ELB, FSx, Glacier, S3 storage, Backup, DRS, Route 53, Direct Connect, and Transit Gateway.
- If a service does not clearly match, classify it as Needs manual review rather than guessing.`;

export const LEGACY_MAP_RULES = `AWS MAP reference rules:
- ARR tiers: MAP $500K-$10M; MAP Lite $100K-$500K; MAP Lite small $1-$100K; below $1K or above $10M is not eligible / manual review.
- Assess: 5% of ARR capped at $75K for MAP and MAP Lite $100K-$500K; unavailable to MAP Lite small.
- Mobilize: for MAP and MAP Lite $100K-$500K, stackable cash modifiers up to 20% ARR total: Modernization +10% capped $100K only at MAP tier when modernization scope is at least 40%; Greenfield +10% capped $100K; VMware +10% capped $200K when at least 75% of workloads are VMware; VMware per-VM is $200 per VM capped $1M and internal-only.
- Migrate & Modernize: MAP +25% ARR credits; MAP Lite $100K-$500K +15%; MAP Lite small +15% only. DB&A +10%, SAP & Oracle +50%, and VMware +10% for MAP Lite when conditions apply. Use eligible annual spend where appropriate.
- General included services include EC2/EBS, RDS/Aurora, ECS/Fargate, S3 storage, Lambda, DynamoDB, EKS excluding Fargate, ELB, EFS, VPC/Transit Gateway, CloudWatch Logs, DMS, Glue, Redshift, OpenSearch, SageMaker with exclusions, Bedrock with tagging rules, and other AWS services. Data transfer and third-party software licenses are excluded. Fargate is ambiguous unless ECS or EKS is known. Unknown services require manual review.
- Do not infer Greenfield, VMware percentage, modernization percentage, or VM count. Use only the supplied inputs and state missing values as open questions.`;
