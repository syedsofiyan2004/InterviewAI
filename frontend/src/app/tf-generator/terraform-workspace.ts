import * as XLSX from 'xlsx';

export type TfSeverity = 'error' | 'warning' | 'info';

export interface TfValidationMessage {
  severity: TfSeverity;
  title: string;
  detail: string;
}

export interface TfAccount {
  organization_unit: string;
  account_name: string;
  email_distribution_list: string;
  account_number: string;
  role_arn: string;
  primary_region: string;
  dr_region: string;
}

export interface TfVpc {
  logical_name: string;
  account_name: string;
  account_number: string;
  organization_unit: string;
  cidr: string;
  region: string;
  nat_gateway: boolean;
}

export interface TfSubnet {
  logical_name: string;
  vpc_logical_name: string;
  account_name: string;
  az_label: 'a' | 'b' | 'c';
  cidr: string;
  route_type: 'public' | 'private';
}

export interface TfManifest {
  deployment_name: string;
  primary_region: string;
  accounts: TfAccount[];
  vpcs: TfVpc[];
  subnets: TfSubnet[];
  tags: Record<string, string>;
}

export interface TfFile {
  filename: string;
  content: string;
}

export interface TfResourcePlanItem {
  label: string;
  count: number;
  detail: string;
}

export interface TfAdvisorFinding {
  severity: TfSeverity;
  title: string;
  detail: string;
  recommendation: string;
}

export interface TfReviewSummary {
  readiness: 'Blocked' | 'Review needed' | 'Ready for plan';
  headline: string;
  resource_plan: TfResourcePlanItem[];
  findings: TfAdvisorFinding[];
  next_steps: string[];
}

type SheetRow = string[];

function cell(value: unknown): string {
  return value === null || value === undefined ? '' : String(value).trim();
}

function rowsFromSheet(workbook: XLSX.WorkBook, sheetName: string): SheetRow[] {
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) return [];
  return XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '' })
    .map((row) => row.map(cell));
}

export async function parseTfWorkbook(file: File): Promise<TfManifest> {
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: 'array' });
  const accounts = parseAccounts(rowsFromSheet(workbook, 'Org.Account-Structucture'));
  const { vpcs, subnets } = parseVpcSubnets(rowsFromSheet(workbook, 'VPC-Subnet-Details'));
  const deploymentName = file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim() || 'Terraform deployment';
  const primaryRegion = vpcs[0]?.region || accounts[0]?.primary_region || 'us-east-1';

  return {
    deployment_name: deploymentName,
    primary_region: primaryRegion,
    accounts,
    vpcs,
    subnets,
    tags: {
      Project: deploymentName,
      ManagedBy: 'Terraform',
      Source: 'Minfy AI TF Generator',
    },
  };
}

function parseAccounts(rows: SheetRow[]): TfAccount[] {
  return rows.slice(1)
    .filter((row) => row.some(Boolean))
    .map((row) => ({
      organization_unit: row[1] || 'NA',
      account_name: row[2] || 'Unnamed account',
      email_distribution_list: row[3] || '',
      account_number: row[4] || '',
      role_arn: row[5] || '',
      primary_region: row[7] || '',
      dr_region: row[8] || '',
    }));
}

function parseVpcSubnets(rows: SheetRow[]) {
  const vpcs: TfVpc[] = [];
  const subnets: TfSubnet[] = [];
  let current: TfVpc | null = null;

  rows.slice(2).forEach((row) => {
    if (!row.some(Boolean)) return;

    const nextVpcName = row[4];
    if (nextVpcName) {
      current = {
        logical_name: nextVpcName,
        account_name: row[1] || 'Unknown',
        account_number: row[2] || '',
        organization_unit: row[3] || '',
        cidr: row[5] || '',
        region: row[6] || '',
        nat_gateway: /^yes$/i.test(row[7] || ''),
      };
      vpcs.push(current);
    }

    if (!current) return;

    const routeType = /^public$/i.test(row[14] || '') ? 'public' : 'private';
    const zones: Array<{ label: 'a' | 'b' | 'c'; name: string; cidr: string }> = [
      { label: 'a', name: row[8], cidr: row[9] },
      { label: 'b', name: row[10], cidr: row[11] },
      { label: 'c', name: row[12], cidr: row[13] },
    ];

    zones.forEach((zone) => {
      if (!zone.name && !zone.cidr) return;
      subnets.push({
        logical_name: zone.name || `${current!.logical_name}-${zone.label}`,
        vpc_logical_name: current!.logical_name,
        account_name: current!.account_name,
        az_label: zone.label,
        cidr: zone.cidr,
        route_type: routeType,
      });
    });
  });

  return { vpcs, subnets };
}

export function validateTfManifest(manifest: TfManifest): TfValidationMessage[] {
  const messages: TfValidationMessage[] = [];
  if (!manifest.vpcs.length) {
    messages.push({ severity: 'error', title: 'No VPCs found', detail: 'The workbook must define at least one VPC before Terraform can be generated.' });
  }

  const regions = new Set(manifest.vpcs.map((vpc) => vpc.region).filter(Boolean));
  if (regions.size > 1) {
    messages.push({
      severity: 'error',
      title: 'Multiple regions found',
      detail: `This production review workspace currently supports one region per Terraform workspace. Found: ${Array.from(regions).join(', ')}.`,
    });
  }

  const vpcIds = new Map<string, string>();
  manifest.vpcs.forEach((vpc) => {
    const id = tfId(vpc.logical_name);
    const previous = vpcIds.get(id);
    if (previous) {
      messages.push({
        severity: 'error',
        title: `Duplicate Terraform VPC id: ${id}`,
        detail: `${previous} and ${vpc.logical_name} resolve to the same Terraform resource name. Rename one of the VPCs.`,
      });
    } else {
      vpcIds.set(id, vpc.logical_name);
    }
  });

  manifest.accounts.forEach((account) => {
    if (!account.role_arn) {
      messages.push({
        severity: 'warning',
        title: `Missing role ARN for ${account.account_name}`,
        detail: 'Code review can continue, but deployment will need a cross-account role ARN.',
      });
    } else if (!/^arn:aws:iam::\d{12}:role\/.+/.test(account.role_arn)) {
      messages.push({
        severity: 'error',
        title: `Invalid role ARN for ${account.account_name}`,
        detail: 'Role ARN must look like arn:aws:iam::123456789012:role/TerraformDeployRole.',
      });
    }
  });

  manifest.vpcs.forEach((vpc) => {
    if (!isValidCidr(vpc.cidr)) {
      messages.push({ severity: 'error', title: `Invalid VPC CIDR: ${vpc.logical_name}`, detail: `${vpc.cidr || 'Blank'} is not a valid IPv4 CIDR.` });
    }
    if (!vpc.region) {
      messages.push({ severity: 'error', title: `Missing region: ${vpc.logical_name}`, detail: 'Every VPC must specify an AWS region.' });
    }

    const relatedSubnets = manifest.subnets.filter((subnet) => subnet.vpc_logical_name === vpc.logical_name);
    if (!relatedSubnets.length) {
      messages.push({
        severity: 'error',
        title: `No subnets found: ${vpc.logical_name}`,
        detail: 'Every production VPC manifest must include at least one subnet.',
      });
    }

    const publicSubnets = relatedSubnets.filter((subnet) => subnet.route_type === 'public');
    const privateSubnets = relatedSubnets.filter((subnet) => subnet.route_type === 'private');
    if (vpc.nat_gateway && !publicSubnets.length) {
      messages.push({
        severity: 'error',
        title: `NAT requested without public subnet: ${vpc.logical_name}`,
        detail: 'A NAT Gateway must be placed in a public subnet with an Internet Gateway route.',
      });
    }
    if (vpc.nat_gateway && !privateSubnets.length) {
      messages.push({
        severity: 'warning',
        title: `NAT requested but no private subnets: ${vpc.logical_name}`,
        detail: 'The NAT Gateway flag is enabled, but no private subnet needs outbound NAT routing.',
      });
    }

    relatedSubnets.forEach((subnet) => {
      if (!subnet.logical_name) {
        messages.push({ severity: 'error', title: 'Blank subnet name', detail: `A subnet in ${vpc.logical_name} is missing its logical name.` });
      }
      if (!isValidCidr(subnet.cidr)) {
        messages.push({ severity: 'error', title: `Invalid subnet CIDR: ${subnet.logical_name}`, detail: `${subnet.cidr || 'Blank'} is not a valid IPv4 CIDR.` });
      } else if (isValidCidr(vpc.cidr) && !cidrContains(vpc.cidr, subnet.cidr)) {
        messages.push({ severity: 'error', title: `Subnet outside VPC: ${subnet.logical_name}`, detail: `${subnet.cidr} is not inside ${vpc.cidr}.` });
      }
    });

    for (let i = 0; i < relatedSubnets.length; i++) {
      for (let j = i + 1; j < relatedSubnets.length; j++) {
        if (isValidCidr(relatedSubnets[i].cidr) && isValidCidr(relatedSubnets[j].cidr) && cidrOverlaps(relatedSubnets[i].cidr, relatedSubnets[j].cidr)) {
          messages.push({
            severity: 'error',
            title: 'Overlapping subnet CIDRs',
            detail: `${relatedSubnets[i].logical_name} (${relatedSubnets[i].cidr}) overlaps ${relatedSubnets[j].logical_name} (${relatedSubnets[j].cidr}).`,
          });
        }
      }
    }
  });

  const subnetIds = new Map<string, string>();
  manifest.subnets.forEach((subnet) => {
    const id = subnetResourceId(subnet);
    const previous = subnetIds.get(id);
    if (previous) {
      messages.push({
        severity: 'error',
        title: `Duplicate Terraform subnet id: ${id}`,
        detail: `${previous} and ${subnet.logical_name} resolve to the same Terraform resource name. Rename one of the subnets.`,
      });
    } else {
      subnetIds.set(id, subnet.logical_name);
    }
  });

  if (!messages.some((message) => message.severity === 'error')) {
    messages.push({
      severity: 'info',
      title: 'Validation passed',
      detail: 'Manifest is ready for Terraform generation. Deployment still requires plan review and role verification.',
    });
  }

  return messages;
}

export function generateTerraformFiles(manifest: TfManifest): TfFile[] {
  return [
    { filename: 'provider.tf', content: providerTf(manifest) },
    { filename: 'variables.tf', content: variablesTf() },
    { filename: 'vpc.tf', content: vpcTf(manifest) },
    { filename: 'subnets.tf', content: subnetsTf(manifest) },
    { filename: 'routing.tf', content: routingTf(manifest) },
    { filename: 'outputs.tf', content: outputsTf(manifest) },
  ];
}

export function generateTfReviewSummary(manifest: TfManifest, messages: TfValidationMessage[]): TfReviewSummary {
  const errors = messages.filter((message) => message.severity === 'error');
  const warnings = messages.filter((message) => message.severity === 'warning');
  const publicSubnets = manifest.subnets.filter((subnet) => subnet.route_type === 'public');
  const privateSubnets = manifest.subnets.filter((subnet) => subnet.route_type === 'private');
  const natVpcs = manifest.vpcs.filter((vpc) => {
    const related = manifest.subnets.filter((subnet) => subnet.vpc_logical_name === vpc.logical_name);
    return vpc.nat_gateway && related.some((subnet) => subnet.route_type === 'public') && related.some((subnet) => subnet.route_type === 'private');
  });

  const resourcePlan: TfResourcePlanItem[] = [
    { label: 'VPCs', count: manifest.vpcs.length, detail: 'DNS support and DNS hostnames enabled.' },
    { label: 'Subnets', count: manifest.subnets.length, detail: `${publicSubnets.length} public, ${privateSubnets.length} private.` },
    { label: 'Internet gateways', count: vpcsWithPublicSubnets(manifest).length, detail: 'Created only for VPCs with public subnets.' },
    { label: 'NAT gateways', count: natVpcs.length, detail: 'Created only when NAT is requested and private subnets exist.' },
    { label: 'Route tables', count: routeTableCount(manifest), detail: 'Separate public/private route tables per VPC where needed.' },
    { label: 'Route associations', count: manifest.subnets.length, detail: 'Every parsed subnet is attached to the matching route table.' },
  ];

  const findings: TfAdvisorFinding[] = [
    ...messages.map((message) => ({
      severity: message.severity,
      title: message.title,
      detail: message.detail,
      recommendation: recommendationFor(message),
    })),
    ...architectureFindings(manifest),
  ];

  const readiness: TfReviewSummary['readiness'] = errors.length ? 'Blocked' : warnings.length ? 'Review needed' : 'Ready for plan';
  const headline = errors.length
    ? `${errors.length} blocking issue${errors.length === 1 ? '' : 's'} must be fixed before Terraform is trusted.`
    : warnings.length
      ? `Terraform can be generated, but ${warnings.length} warning${warnings.length === 1 ? '' : 's'} should be reviewed before plan.`
      : 'Manifest passed workspace checks and is ready for Terraform plan validation.';

  return {
    readiness,
    headline,
    resource_plan: resourcePlan,
    findings,
    next_steps: nextStepsFor(readiness),
  };
}

function providerTf(manifest: TfManifest) {
  return `terraform {
  required_version = ">= 1.7.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.primary_region

  assume_role {
    role_arn = var.role_arn
  }

  default_tags {
    tags = {
      Project     = var.deployment_name
      Environment = var.environment
      ManagedBy   = "Terraform"
      GeneratedBy = "Minfy AI TF Generator"
    }
  }
}

# Generated by Minfy AI TF Generator for ${hclString(manifest.deployment_name)}.
# Apply is intentionally gated until human review and controlled runner approval are enabled.
`;
}

function variablesTf() {
  return `variable "deployment_name" {
  type = string
}

variable "primary_region" {
  type = string
}

variable "role_arn" {
  type = string
}

variable "environment" {
  type    = string
  default = "dev"
}

variable "common_tags" {
  type    = map(string)
  default = {}
}
`;
}

function vpcTf(manifest: TfManifest) {
  return manifest.vpcs.map((vpc) => {
    const id = tfId(vpc.logical_name);
    return `resource "aws_vpc" "${id}" {
  cidr_block           = ${hclString(vpc.cidr)}
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = merge(var.common_tags, {
    Name = ${hclString(vpc.logical_name)}
  })

  lifecycle {
    prevent_destroy = true
  }
}`;
  }).join('\n\n') || '# No VPC resources parsed yet.';
}

function subnetsTf(manifest: TfManifest) {
  return manifest.subnets.map((subnet) => {
    const id = subnetResourceId(subnet);
    const vpcId = tfId(subnet.vpc_logical_name);
    return `resource "aws_subnet" "${id}" {
  vpc_id            = aws_vpc.${vpcId}.id
  cidr_block        = ${hclString(subnet.cidr)}
  availability_zone = "\${var.primary_region}${subnet.az_label}"

  tags = merge(var.common_tags, {
    Name = ${hclString(subnet.logical_name)}
    Tier = ${hclString(subnet.route_type)}
  })

  lifecycle {
    prevent_destroy = true
  }
}`;
  }).join('\n\n') || '# No subnet resources parsed yet.';
}

function routingTf(manifest: TfManifest) {
  return manifest.vpcs.map((vpc) => {
    const id = tfId(vpc.logical_name);
    const relatedSubnets = manifest.subnets.filter((subnet) => subnet.vpc_logical_name === vpc.logical_name);
    const publicSubnets = relatedSubnets.filter((subnet) => subnet.route_type === 'public');
    const privateSubnets = relatedSubnets.filter((subnet) => subnet.route_type === 'private');
    const hasPublic = publicSubnets.length > 0;
    const shouldCreateNat = vpc.nat_gateway && hasPublic && privateSubnets.length > 0;
    const blocks: string[] = [];

    if (hasPublic) {
      const igwName = derivedAwsName(vpc.logical_name, 'igw');
      const publicRouteName = derivedAwsName(vpc.logical_name, 'rt-public');
      blocks.push(`resource "aws_internet_gateway" "${id}" {
  vpc_id = aws_vpc.${id}.id

  tags = merge(var.common_tags, {
    Name = ${hclString(igwName)}
  })
}`);

      blocks.push(`resource "aws_route_table" "${id}_public" {
  vpc_id = aws_vpc.${id}.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.${id}.id
  }

  tags = merge(var.common_tags, {
    Name = ${hclString(publicRouteName)}
  })
}`);

      publicSubnets.forEach((subnet) => {
        blocks.push(`resource "aws_route_table_association" "${subnetResourceId(subnet)}_public" {
  subnet_id      = aws_subnet.${subnetResourceId(subnet)}.id
  route_table_id = aws_route_table.${id}_public.id
}`);
      });
    }

    if (shouldCreateNat) {
      const natSubnet = publicSubnets[0];
      const eipName = derivedAwsName(vpc.logical_name, 'eip-nat');
      const natName = derivedAwsName(vpc.logical_name, 'nat');
      blocks.push(`resource "aws_eip" "${id}_nat" {
  domain = "vpc"

  tags = merge(var.common_tags, {
    Name = ${hclString(eipName)}
  })

  depends_on = [aws_internet_gateway.${id}]
}`);

      blocks.push(`resource "aws_nat_gateway" "${id}" {
  allocation_id = aws_eip.${id}_nat.id
  subnet_id     = aws_subnet.${subnetResourceId(natSubnet)}.id

  tags = merge(var.common_tags, {
    Name = ${hclString(natName)}
  })

  depends_on = [aws_internet_gateway.${id}]
}`);
    }

    if (privateSubnets.length) {
      const privateRouteName = derivedAwsName(vpc.logical_name, 'rt-private');
      blocks.push(`resource "aws_route_table" "${id}_private" {
  vpc_id = aws_vpc.${id}.id
${shouldCreateNat ? `
  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.${id}.id
  }
` : ''}

  tags = merge(var.common_tags, {
    Name = ${hclString(privateRouteName)}
  })
}`);

      privateSubnets.forEach((subnet) => {
        blocks.push(`resource "aws_route_table_association" "${subnetResourceId(subnet)}_private" {
  subnet_id      = aws_subnet.${subnetResourceId(subnet)}.id
  route_table_id = aws_route_table.${id}_private.id
}`);
      });
    }

    return blocks.join('\n\n') || `# No routing resources parsed for ${vpc.logical_name}.`;
  }).join('\n\n') || '# No routing resources parsed yet.';
}

function outputsTf(manifest: TfManifest) {
  const vpcOutputs = manifest.vpcs.map((vpc) => `  ${tfId(vpc.logical_name)} = aws_vpc.${tfId(vpc.logical_name)}.id`).join('\n');
  return `output "vpc_ids" {
  value = {
${vpcOutputs || '    none = null'}
  }
}
`;
}

function vpcsWithPublicSubnets(manifest: TfManifest) {
  return manifest.vpcs.filter((vpc) => manifest.subnets.some((subnet) => subnet.vpc_logical_name === vpc.logical_name && subnet.route_type === 'public'));
}

function routeTableCount(manifest: TfManifest) {
  return manifest.vpcs.reduce((count, vpc) => {
    const related = manifest.subnets.filter((subnet) => subnet.vpc_logical_name === vpc.logical_name);
    const hasPublic = related.some((subnet) => subnet.route_type === 'public');
    const hasPrivate = related.some((subnet) => subnet.route_type === 'private');
    return count + (hasPublic ? 1 : 0) + (hasPrivate ? 1 : 0);
  }, 0);
}

function architectureFindings(manifest: TfManifest): TfAdvisorFinding[] {
  const findings: TfAdvisorFinding[] = [];

  manifest.vpcs.forEach((vpc) => {
    const related = manifest.subnets.filter((subnet) => subnet.vpc_logical_name === vpc.logical_name);
    const publicAzs = new Set(related.filter((subnet) => subnet.route_type === 'public').map((subnet) => subnet.az_label));
    const privateAzs = new Set(related.filter((subnet) => subnet.route_type === 'private').map((subnet) => subnet.az_label));

    if (privateAzs.size > 1 && vpc.nat_gateway) {
      findings.push({
        severity: 'warning',
        title: `Single NAT design for ${vpc.logical_name}`,
        detail: 'The generated Terraform creates one NAT Gateway in the first public subnet for this VPC.',
        recommendation: 'For production high availability, confirm whether one NAT per AZ is required before apply.',
      });
    }

    if (publicAzs.size === 0 && privateAzs.size > 0 && !vpc.nat_gateway) {
      findings.push({
        severity: 'info',
        title: `Private-only VPC: ${vpc.logical_name}`,
        detail: 'Private subnets will receive private route table associations without internet egress.',
        recommendation: 'Confirm this is intended, or enable NAT and add a public subnet for outbound access.',
      });
    }

    if (related.length && new Set(related.map((subnet) => subnet.az_label)).size < 2) {
      findings.push({
        severity: 'warning',
        title: `Single-AZ coverage: ${vpc.logical_name}`,
        detail: 'All parsed subnets for this VPC are in one availability zone.',
        recommendation: 'For production resilience, consider at least two AZs for application workloads.',
      });
    }
  });

  return findings;
}

function recommendationFor(message: TfValidationMessage) {
  const title = message.title.toLowerCase();
  if (title.includes('cidr')) return 'Correct the workbook CIDR value before generating or applying Terraform.';
  if (title.includes('outside vpc')) return 'Choose a subnet range that is fully contained inside the parent VPC CIDR.';
  if (title.includes('overlapping')) return 'Resize or move one of the subnet CIDRs so every subnet has a unique IP range.';
  if (title.includes('multiple regions')) return 'Split the workbook into separate Terraform workspaces, one per AWS region.';
  if (title.includes('nat requested without public subnet')) return 'Add at least one public subnet or disable NAT for this VPC.';
  if (title.includes('duplicate terraform')) return 'Rename the duplicate VPC or subnet in the workbook so Terraform resource names remain unique.';
  if (title.includes('role arn')) return 'Provide the cross-account deploy role ARN before enabling real plan/apply.';
  if (title.includes('validation passed')) return 'Export the files and run terraform fmt, validate, and plan in the controlled runner.';
  return 'Review the workbook value and confirm the generated Terraform still matches the intended architecture.';
}

function nextStepsFor(readiness: TfReviewSummary['readiness']) {
  if (readiness === 'Blocked') {
    return [
      'Fix blocking workbook issues shown in validation.',
      'Upload the corrected workbook and regenerate Terraform.',
      'Do not run Terraform plan or apply until all errors are cleared.',
    ];
  }

  if (readiness === 'Review needed') {
    return [
      'Review warnings with the network owner.',
      'Download the Terraform bundle for source review.',
      'Run terraform fmt and terraform validate in the controlled runner.',
    ];
  }

  return [
    'Download the generated Terraform bundle.',
    'Run terraform fmt, terraform validate, and terraform plan.',
    'Require human approval after plan output review before apply.',
  ];
}

function hclString(value: string) {
  return JSON.stringify(value);
}

function derivedAwsName(baseName: string, suffix: string) {
  return `${baseName}-${suffix}`;
}

function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'item';
}

function tfId(value: string) {
  const id = value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  return /^[a-z_]/.test(id) ? id : `r_${id || 'item'}`;
}

function subnetResourceId(subnet: TfSubnet) {
  return tfId(`${subnet.vpc_logical_name}_${subnet.logical_name}`);
}

function isValidCidr(cidr: string) {
  const parsed = parseCidr(cidr);
  return !!parsed && parsed.prefix >= 0 && parsed.prefix <= 32;
}

function parseCidr(cidr: string): { start: number; end: number; prefix: number } | null {
  const match = cidr.match(/^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/);
  if (!match) return null;
  const ip = ipToNumber(match[1]);
  const prefix = Number(match[2]);
  if (ip === null || prefix < 0 || prefix > 32) return null;
  const size = 2 ** (32 - prefix);
  const start = Math.floor(ip / size) * size;
  return { start, end: start + size - 1, prefix };
}

function ipToNumber(ip: string): number | null {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part) || part < 0 || part > 255)) return null;
  return (((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3]) >>> 0;
}

function cidrContains(parent: string, child: string) {
  const parentRange = parseCidr(parent);
  const childRange = parseCidr(child);
  if (!parentRange || !childRange) return false;
  return childRange.start >= parentRange.start && childRange.end <= parentRange.end;
}

function cidrOverlaps(a: string, b: string) {
  const first = parseCidr(a);
  const second = parseCidr(b);
  if (!first || !second) return false;
  return first.start <= second.end && second.start <= first.end;
}
