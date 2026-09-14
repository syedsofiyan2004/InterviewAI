# AWS MAP Included Services Reference

Source: "AWS Migrations Included Services List", last updated 29 July 2026 (partner-provided PDF).
Use this to determine whether a service line item from a TCO Calculator export counts as
MAP-tagged/eligible spend. Always check the **Notes** column — many services are only
*partially* eligible (e.g. certain sub-features or usage types are excluded).

General rules that apply to ALL services unless a line item says otherwise:
- All data transfer costs are excluded (including data-transfer costs tied to a specific
  eligible service).
- All third-party software license costs are excluded.
- "AWS Services in Local Zones" eligibility is called out per-service in Notes when relevant.

## How to match a TCO line item to this table

TCO Calculator PDF line items use the AWS **service display name** (e.g. "Amazon Elastic Block
Store (EBS)", "Amazon EC2", "Amazon Aurora PostgreSQL-Compatible DB"), not the product service
code. Match on service name/family, using these known aliases:

| TCO Calculator display name | Maps to included-service row | Product code |
|---|---|---|
| Amazon Elastic Block Store (EBS) | Amazon EC2 (EBS is a sub-feature of EC2, not separate) | AmazonEC2 |
| Amazon EC2 | Amazon EC2 | AmazonEC2 |
| Amazon Aurora PostgreSQL-Compatible DB | Amazon RDS (RDS Aurora PostgreSQL) | AmazonRDS |
| Amazon Aurora MySQL-Compatible DB | Amazon RDS (RDS Aurora MySQL) | AmazonRDS |
| AWS Fargate | **Ambiguous** — eligible if launched via Amazon ECS ("Includes Fargate"); NOT eligible if launched via Amazon EKS ("Fargate is not included"). TCO PDF does not distinguish — flag as "needs confirmation: ECS or EKS Fargate?" | AmazonECS or AmazonEKS |
| Amazon Virtual Private Cloud (VPC) / "TGW" / Transit Gateway line items | AWS Transit Gateway | AmazonVPC |
| Elastic Load Balancing | Elastic Load Balancing | AWSELB |
| AWS Security Hub | AWS Security Hub | AWSSecurityHub |
| Amazon S3 | Amazon S3 (storage cost only; excludes Requests) | AmazonS3 |
| Amazon RDS (any engine) | Amazon RDS | AmazonRDS |

If a TCO line item's service name doesn't clearly match any row below, mark it **"Not
found — needs manual review"** rather than guessing.

## General AWS Migrations Included Services

| Service | Product Code | Notes / Exclusions |
|---|---|---|
| Amazon API Gateway | AmazonApiGateway | |
| Amazon AppStream | AmazonAppStream | Excludes User Fees |
| AWS AppSync | AWSAppSync | |
| Amazon Athena | AmazonAthena | |
| AWS Backup | AWSBackup | |
| AWS Certificate Manager | AWSCertificateManager | Includes Private CA |
| Amazon Cloud Directory | AmazonCloudDirectory | |
| AWS CloudHSM | CloudHSM | |
| Amazon CloudWatch | AmazonCloudWatch | Logs only |
| AWS CodeBuild | CodeBuild | |
| AWS CodePipeline | AWSCodePipeline | |
| AWS CodeStar | AWSCodeStar | |
| Amazon Cognito | AmazonCognito | Excludes Cognito add-ons |
| Amazon Comprehend | comprehend | |
| AWS Data Pipeline | datapipeline | |
| AWS Database Migration Service (DMS) | AWSDatabaseMigrationSvc | |
| AWS DataSync | AWSDataSync | |
| AWS Direct Connect | AWSDirectConnect | Excludes AWS Local Zones |
| AWS Directory Service | AWSDirectoryService | |
| Amazon DynamoDB | AmazonDynamoDB | |
| Amazon DynamoDB Accelerator (DAX) | AmazonDAX | Eligible after 27-Mar-2026 |
| Amazon EC2 | AmazonEC2 | Includes EBS, EBS Snapshots, EC2 Mac, Local Zones deployment, Savings Plan for ML instance types. Excludes Capacity Block for ML |
| Amazon Elastic VMware Service (EVS) | — | Only underlying EC2 use included; excludes VCF licenses from Broadcom/resellers, VPC Route Server Endpoints, EVS control plane |
| Amazon ECR | AmazonECR | |
| Amazon EKS | AmazonEKS | Fargate is NOT included. Includes AWS App Mesh |
| Amazon ECS | AmazonECS | Includes Fargate. Includes AWS App Mesh |
| AWS Elastic Beanstalk | AWSElasticBeanstalk | |
| Amazon Elastic File System (EFS) | AmazonEFS | |
| Elastic Load Balancing | AWSELB | |
| Amazon ElastiCache | AmazonElastiCache | |
| Amazon EMR | ElasticMapReduce | Includes Local Zones deployment |
| Amazon S3 Glacier | AmazonGlacier | Excludes Glacier Deep Archive |
| AWS Glue | AWSGlue | |
| AWS KMS | awskms | Cross-account request costs excluded |
| Amazon Kinesis Data Streams | AmazonKinesis | |
| Amazon Kinesis Data Analytics | AmazonKinesisAnalytics | |
| Amazon Kinesis Data Firehose | AmazonKinesisFirehose | |
| Amazon Kinesis Video Streams | AmazonKinesisVideo | Eligible after 19-Sep-2025 |
| AWS Lambda | AWSLambda | |
| Amazon MQ | AmazonMQ | |
| Amazon MSK | AmazonMSK | |
| Amazon Neptune | AmazonNeptune | |
| AWS Network Firewall | AWSNetworkFirewall | |
| Amazon OpenSearch Service | AmazonES | Includes Elasticsearch Service. Excludes Serverless & Ingestion |
| Amazon Redshift | AmazonRedshift | Provisioned + Serverless |
| Amazon RDS (all engines incl. Aurora, Oracle, SQL Server, Db2, Custom) | AmazonRDS | Includes Local Zones deployment. RDS for Db2 excludes Db2 licensing fees |
| Amazon Route 53 | AmazonRoute53 | Excludes Resolver, Traffic Flow, CIDR block storage |
| Amazon S3 | AmazonS3 | Storage cost only, all tiers. Excludes Requests |
| Amazon SageMaker | AmazonSageMaker | Excludes training plans for training jobs/HyperPod clusters |
| AWS Secrets Manager | AWSSecretsManager | |
| AWS Security Hub | AWSSecurityHub | |
| Amazon SNS | AmazonSNS | |
| Amazon SQS | AWSQueueService | |
| AWS Step Functions | AmazonStates | |
| AWS Storage Gateway | AWSStorageGateway | |
| AWS Systems Manager | AWSSystemsManager | OpsCenter only |
| AWS Transfer Family | AWSTransfer | Excludes AWSDataTransfer |
| AWS Transit Gateway | AmazonVPC | Includes TGW VPN/VPC/Peering/DirectConnect/DX |
| Amazon WorkSpaces | AmazonWorkSpaces | Includes WorkSpaces Core. Excludes 3rd-party VDI/OS/software license |
| Amazon WorkSpaces Core Managed Instances | AmazonWorkSpacesInstances | Eligible after 5-Mar-2026. Excludes hourly metering, 3rd-party VDI/OS license |
| Amazon CloudFront | AmazonCloudFront | Excludes Lambda@Edge |
| Amazon Kendra | AmazonKendra | |
| Amazon Keyspaces (Cassandra) | AmazonMCS | |
| AWS Mainframe Modernization | AWSM2 | Excludes 'M2 Custom', per-line-of-code conversion, per-week Blu Age charges |
| AWS Elastic Disaster Recovery (DRS) | AWSElasticDisasterRecovery | |
| AWS Elemental MediaLive/MediaPackage/MediaConvert | AWSElementalMedia... | |
| Amazon DocumentDB (MongoDB compatible) | AmazonDocDB | |
| Amazon Omics | AmazonOmics | |
| Amazon Timestream | AmazonTimestream | |
| Amazon QuickSight | AmazonQuickSight | Excludes Region fee for Q, SPICE, unused subscription charges, Pro user/author/admin |
| AWS Resilience Hub | AWSResilienceHub | |
| Amazon FinSpace | AmazonFinSpace | Excludes kdb Insights software license |
| Amazon GameLift / GameLift Streams | AmazonGameLift(Streams) | Excludes Anywhere, FleetIQ, FlexMatch (GameLift); excludes Game Data Storage Hours (Streams) |
| Amazon MemoryDB for Redis | AmazonMemoryDB | Excludes Snapshot Storage |
| AWS HealthImaging | AmazonMedicalImaging | |
| Amazon VPC Lattice | AmazonVPC | |
| Amazon Bedrock | AmazonBedrock | Must use tagging guide; console/API only for model access and volume discounts; excludes AWS Marketplace Private Offers |
| AWS Deadline Cloud | AmazonDeadline | Excludes BYOL 3rd-party creative tool licenses |
| AWS HealthLake | AmazonHealthLake | Excludes FHIR export/transformation |
| Aurora DSQL | AuroraDSQL | |
| AWS IoT Core | AWSIoT | Excludes Registry operations |
| AWS IoT SiteWise | AWSIoTSiteWise | Multiple usage-type exclusions — see full PDF |
| Amazon Bedrock AgentCore | AmazonBedrockAgentCore | Excludes Data Transfer; Observability billed as CloudWatch |
| AWS Payment Cryptography | PaymentCryptography | Excludes several list/get/delete APIs |
| AWS Cloud WAN | AWSCloudWAN | Excludes Core Network Edge Hours |
| AWS End User Messaging | AmazonPinpoint | Excludes carrier fees, number validation, phone numbers, SMS inbound |
| AWS RTB Fabric | AWSRTBFabric | |
| Amazon Simple Email Service (SES) | AmazonSES | Excludes Dedicated IPs, Recipients-Validation Insight Count, Virtual Deliverability Manager items |

## DB&A (Database & Analytics) Included Services

Used for the "+10% of ARR in credits for database & analytics" modifier. A deal qualifies for
this modifier when a meaningful share of ARR comes from these services:

Amazon RDS (all engines) · Amazon Athena · Amazon DynamoDB · Amazon DynamoDB Accelerator (DAX) ·
Amazon ElastiCache · Amazon OpenSearch Service · Amazon EMR (EC2/EKS spend under EMR excluded from
DB&A specifically) · Amazon Kinesis Data Streams · Amazon DocumentDB · Amazon MSK · Amazon Neptune
· Amazon Redshift · AWS DMS · AWS Glue · Amazon Keyspaces · Amazon Timestream · Amazon QuickSight
· Amazon FinSpace · Amazon MemoryDB for Redis · AWS HealthImaging · Aurora DSQL

## SAP and Oracle Applications Included Services

Used for the "+50% of ARR in credits for SAP & Oracle apps" modifier:

Amazon RDS (all engines) · Amazon CloudWatch (Logs only) · Amazon EC2 (incl. EBS/Snapshots/Mac/
Local Zones/Savings Plans, excl. Capacity Block for ML) · Amazon EFS · Elastic Load Balancing ·
Amazon FSx · Amazon S3 Glacier (excl. Deep Archive) · Amazon S3 (storage only) · AWS Backup ·
AWS Elastic Disaster Recovery (DRS) · Amazon Route 53 · AWS Direct Connect · AWS Transit Gateway

## Amazon Bedrock foundation models

Only Amazon-provided models (Titan, Nova) and specifically-listed third-party FMs (various Claude,
GPT, Cohere, Meta Llama, Mistral, etc. versions, each with an "eligible after" date) count.
Consult the full PDF's foundation-model table if a deal includes GenAI/Bedrock spend — this is
out of scope for a typical infra TCO calculator export but relevant for GenAI implementation deals.
