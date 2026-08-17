import { PricingClient, GetProductsCommand } from '@aws-sdk/client-pricing';

/**
 * AWS Price List lookups for the Cost Calculator.
 *
 * Why this exists: the pricing-calculator MCP server saves an estimate to
 * calculator.aws and returns a shareable link, but the stored estimate holds no
 * money — `import_estimate` reads back configuration with an empty
 * `groupSubtotal`, because calculator.aws computes pricing in the browser when a
 * human opens the link. Verified directly against a real saved estimate. So the
 * link is authoritative for a person, and useless for a document.
 *
 * The Price List Query API is the supported, documented source of published AWS
 * rates. Asking it for a rate and multiplying by the hours a resource actually runs
 * is arithmetic we can show our working for — which is what makes a cost figure
 * defensible in front of a client, and what lets the runtime-hours feature mean
 * anything at all.
 *
 * The API is global and only answers in us-east-1 regardless of which region is
 * being priced.
 */

const pricing = new PricingClient({ region: 'us-east-1' });

/**
 * Hours in a billing month, as AWS defines it.
 *
 * Not 24 x 30.44 (= 730.56). AWS and the Pricing Calculator both treat a month as
 * exactly 730 hours, and partial-day usage as a percentage of that. Using days
 * would put our always-on figures 0.56 hours above the AWS link's — small, but it
 * compounds across an estimate, and a client comparing the PDF to the calculator
 * should not find a discrepancy to ask about.
 *
 * Partial days scale proportionally: 8h/day is 730 x 8/24 = 243.33 hours.
 */
export const HOURS_PER_MONTH = 730;

export interface PriceQuery {
  /** Price List service code, e.g. AmazonEC2, AmazonRDS, AmazonS3. */
  serviceCode: string;
  /** Region being priced, e.g. ap-south-1. */
  region: string;
  /** TERM_MATCH attribute filters, e.g. { instanceType: 't3.large' }. */
  filters?: Record<string, string>;
}

export interface PriceResult {
  found: boolean;
  /** Rate in USD per unit, as published. */
  ratePerUnit?: number;
  /** The unit the rate is per: Hrs, GB-Mo, Requests, and so on. */
  unit?: string;
  /** AWS's own description of the dimension, quoted verbatim in the report. */
  description?: string;
  sku?: string;
  message?: string;
}

/** Attributes every EC2 compute lookup needs, or the API returns dozens of SKUs. */
const EC2_DEFAULTS: Record<string, string> = {
  operatingSystem: 'Linux',
  tenancy: 'Shared',
  preInstalledSw: 'NA',
  // Without capacitystatus the reserved-capacity SKUs come back too.
  capacitystatus: 'Used',
  licenseModel: 'No License required',
};

const RDS_DEFAULTS: Record<string, string> = {
  deploymentOption: 'Single-AZ',
  databaseEdition: 'NA',
  licenseModel: 'No license required',
};

function withDefaults(query: PriceQuery): Record<string, string> {
  const base = query.serviceCode === 'AmazonEC2' && query.filters?.instanceType
    ? EC2_DEFAULTS
    : query.serviceCode === 'AmazonRDS' && query.filters?.instanceType
      ? RDS_DEFAULTS
      : {};
  // Caller wins: an explicit Multi-AZ or Windows must override the default.
  return { ...base, ...(query.filters || {}), regionCode: query.region };
}

/**
 * Picks the on-demand dimension out of a Price List product.
 *
 * A product carries OnDemand and Reserved terms, each keyed by opaque offer codes.
 * We take on-demand: it is the only term whose cost can be stated without also
 * committing to a term length, and a commitment is a decision for the client to
 * make rather than an assumption to bury in an estimate.
 *
 * Dimensions priced at 0 are skipped — several SKUs carry a $0 placeholder
 * alongside the real rate, and returning that would read as free.
 */
function readOnDemandRate(product: any): { rate: number; unit: string; description: string } | undefined {
  const terms = product?.terms?.OnDemand;
  if (!terms) return undefined;
  for (const offer of Object.values<any>(terms)) {
    for (const dimension of Object.values<any>(offer?.priceDimensions || {})) {
      const rate = Number(dimension?.pricePerUnit?.USD);
      if (Number.isFinite(rate) && rate > 0) {
        return {
          rate,
          unit: String(dimension.unit || ''),
          description: String(dimension.description || ''),
        };
      }
    }
  }
  return undefined;
}

/**
 * One published rate, or a clear reason there isn't one.
 *
 * Never throws and never guesses: an unpriced line has to stay visibly unpriced,
 * because a plausible invented number in a cost document is worse than a gap.
 */
export async function lookupPrice(query: PriceQuery): Promise<PriceResult> {
  if (!query.serviceCode || !query.region) {
    return { found: false, message: 'serviceCode and region are both required.' };
  }

  const attributes = withDefaults(query);
  try {
    const response = await pricing.send(new GetProductsCommand({
      ServiceCode: query.serviceCode,
      MaxResults: 20,
      Filters: Object.entries(attributes).map(([Field, Value]) => ({
        Type: 'TERM_MATCH' as const,
        Field,
        Value,
      })),
    }));

    const products = (response.PriceList || []).map((entry: unknown) => JSON.parse(String(entry)));
    if (!products.length) {
      return {
        found: false,
        message: `No ${query.serviceCode} price found in ${query.region} for ${JSON.stringify(query.filters || {})}. Check the attribute names and values against the Price List API.`,
      };
    }

    // Several SKUs can match a loose filter; the cheapest on-demand dimension is
    // the plain usage rate rather than a surcharge variant.
    type Rate = { rate: number; unit: string; description: string };
    const rates = products
      .map(readOnDemandRate)
      .filter((entry: Rate | undefined): entry is Rate => !!entry)
      .sort((left: Rate, right: Rate) => left.rate - right.rate);

    if (!rates.length) {
      return { found: false, message: 'Matching products carried no on-demand price dimension.' };
    }

    return {
      found: true,
      ratePerUnit: rates[0].rate,
      unit: rates[0].unit,
      description: rates[0].description,
      sku: products[0]?.product?.sku,
    };
  } catch (error) {
    // A permissions or throttling failure must not fail the estimate — the line
    // stays unpriced and says why.
    return { found: false, message: `Price lookup failed: ${(error as Error).message}` };
  }
}

/**
 * Monthly cost of a resource that is billed by the hour.
 *
 * This is where the runtime hours finally do their job: a box at 8h/day costs a
 * third of the same box at 24h. Returns the derivation as well as the total so the
 * report can show its working instead of asserting a number.
 */
export function monthlyFromHourly(input: {
  ratePerHour: number;
  hoursPerDay: number;
  quantity?: number;
}): { monthly: number; monthlyHours: number; workings: string } {
  const quantity = Math.max(1, Math.round(input.quantity || 1));
  const hours = Math.min(24, Math.max(0, input.hoursPerDay));
  // Proportion of the billing month this resource is up: exactly 730 at 24h/day.
  const monthlyHours = HOURS_PER_MONTH * (hours / 24);
  const monthly = input.ratePerHour * monthlyHours * quantity;
  const scale = quantity > 1 ? ` x ${quantity}` : '';
  const utilisation = hours >= 24
    ? `${HOURS_PER_MONTH} hrs/month`
    : `${hours}h/day (${monthlyHours.toFixed(1)} of ${HOURS_PER_MONTH} hrs/month)`;
  return {
    monthly,
    monthlyHours,
    workings: `$${input.ratePerHour.toFixed(4)}/hr x ${utilisation}${scale} = $${monthly.toFixed(2)}/mo`,
  };
}

/** Monthly cost of something billed per GB-month, where hours do not apply. */
export function monthlyFromGbMonth(input: {
  ratePerGbMonth: number;
  gigabytes: number;
}): { monthly: number; workings: string } {
  const monthly = input.ratePerGbMonth * Math.max(0, input.gigabytes);
  return {
    monthly,
    workings: `$${input.ratePerGbMonth.toFixed(4)}/GB-month x ${input.gigabytes} GB = $${monthly.toFixed(2)}/mo`,
  };
}
