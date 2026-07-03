/**
 * Shared Amazon Q Developer (Kiro / AWS CodeWhisperer) region resolution.
 *
 * CRITICAL AWS constraint — verified against the AWS docs
 * "Amazon Q Developer Pro Region support" → "Supported Regions for the Q Developer console and
 * Q Developer profile":
 *
 *   • An IAM Identity Center instance (and therefore the SSO OIDC token endpoint
 *     `oidc.{region}.amazonaws.com`) may live in MANY regions, e.g. eu-north-1 (Stockholm),
 *     us-west-1, ap-southeast-2, ...
 *   • The Amazon Q Developer PROFILE — which produces the `profileArn` and hosts EVERY
 *     CodeWhisperer runtime call (generateAssistantResponse, GetUsageLimits, ListAvailableModels,
 *     ListAvailableProfiles) — is only hosted in **us-east-1** and **eu-central-1**.
 *   • "Regardless of the IAM Identity Center Region, data is stored in the Region where you create
 *     the Amazon Q Developer profile." → the IdC region and the runtime region are frequently
 *     DIFFERENT (e.g. IdC in eu-north-1 → profile in eu-central-1).
 *
 * Consequences enforced here:
 *   • `providerSpecificData.region` is the IdC/OIDC/token region. It must ONLY be used for
 *     `oidc.{region}.amazonaws.com` token mint/refresh (see tokenRefresh.ts / oauth providers).
 *   • The RUNTIME region is the region embedded in the `profileArn` (us-east-1 / eu-central-1),
 *     NOT the IdC region. Routing a runtime call to `q.eu-north-1.amazonaws.com` — a host that
 *     does not exist as a Q Developer runtime endpoint — is the root cause of the
 *     "Kiro IAM shows no limits + every request returns 502" failure for enterprise IdC accounts
 *     whose IdC lives outside us-east-1 / eu-central-1.
 */

// Canonical AWS region shape — kept local (identical to AWS_REGION_PATTERN in
// src/lib/oauth/constants/oauth.ts) so this open-sse module has no cross-tree import just to
// validate a string. Guards against SSRF via region injection (GHSA-6mwv-4mrm-5p3m): the value
// is interpolated into upstream URLs.
export const AWS_REGION_PATTERN = /^[a-z]{2}-[a-z]+-\d{1,2}$/;

/**
 * Regions where the Amazon Q Developer *profile* (identity-aware / IdC Pro tier) can exist, and
 * therefore the only regions that host a Q Developer runtime endpoint for profile-bound calls.
 * Order is the default probe order (us-east-1 is CodeWhisperer's home region).
 */
export const KIRO_PROFILE_REGIONS = ["us-east-1", "eu-central-1"] as const;

/**
 * CodeWhisperer / Amazon Q runtime host for a region. us-east-1 keeps the legacy
 * codewhisperer.us-east-1 host (AWS Builder ID home region); other regions use the regional
 * Amazon Q endpoint `q.{region}.amazonaws.com` — codewhisperer.{region}.amazonaws.com does not
 * resolve for non-us-east-1 regions.
 */
export function kiroRuntimeHost(region: string): string {
  return region === "us-east-1"
    ? "https://codewhisperer.us-east-1.amazonaws.com"
    : `https://q.${region}.amazonaws.com`;
}

/** Extract the region from a CodeWhisperer profile ARN (`arn:aws:codewhisperer:{region}:...`). */
export function regionFromKiroProfileArn(profileArn?: string | null): string | undefined {
  if (typeof profileArn !== "string") return undefined;
  return profileArn.toLowerCase().match(/^arn:aws:codewhisperer:([a-z0-9-]+):/)?.[1];
}

function normalizeRegion(region: unknown): string {
  return typeof region === "string" ? region.trim().toLowerCase() : "";
}

/**
 * Resolve the RUNTIME region for CodeWhisperer / Amazon Q calls.
 *
 * Priority:
 *   1. The region embedded in the `profileArn` — authoritative, this is where the Q Developer
 *      profile (and thus the runtime) actually lives.
 *   2. A stored region ONLY when it is a valid Q Developer profile region (us-east-1 /
 *      eu-central-1). A stored IdC region that is not a Q profile region (e.g. eu-north-1) is
 *      deliberately IGNORED for runtime — it is a token/OIDC region, not a runtime region.
 *   3. us-east-1 (CodeWhisperer home region) as the final fallback.
 */
export function resolveKiroRuntimeRegion(
  providerSpecificData: { region?: unknown; profileArn?: unknown } | null | undefined
): string {
  const fromArn = regionFromKiroProfileArn(
    typeof providerSpecificData?.profileArn === "string"
      ? providerSpecificData.profileArn
      : undefined
  );
  if (fromArn) return fromArn;

  const stored = normalizeRegion(providerSpecificData?.region);
  if (stored && (KIRO_PROFILE_REGIONS as readonly string[]).includes(stored)) return stored;

  return "us-east-1";
}

/**
 * Build the ordered list of Q Developer profile regions to probe for `ListAvailableProfiles`.
 * The IdC/token region is only useful here as a hint for geographic proximity — the actual
 * profile always lives in one of KIRO_PROFILE_REGIONS, so those are the only regions probed.
 */
export function buildKiroProfileDiscoveryRegions(storedRegion?: string | null): string[] {
  const regions: string[] = [];
  const stored = normalizeRegion(storedRegion);

  // If the IdC/token region happens to be a Q profile region itself, probe it first.
  if (stored && (KIRO_PROFILE_REGIONS as readonly string[]).includes(stored)) {
    regions.push(stored);
  }

  // Otherwise order the two known profile regions by rough geographic proximity to the IdC
  // region so an EU IdC (e.g. eu-north-1) hits eu-central-1 first.
  const preferEu = /^(eu|af|me|il)-/.test(stored);
  const ordered = preferEu ? ["eu-central-1", "us-east-1"] : ["us-east-1", "eu-central-1"];
  for (const r of ordered) {
    if (!regions.includes(r)) regions.push(r);
  }
  return regions;
}

async function listKiroProfileArnForRegion(
  accessToken: string,
  region: string,
  fetchImpl: typeof fetch
): Promise<string | undefined> {
  // Defensive: region comes from a hardcoded allowlist here, but validate before it is
  // interpolated into the runtime host (SSRF guard, GHSA-6mwv-4mrm-5p3m).
  if (!AWS_REGION_PATTERN.test(region)) return undefined;
  try {
    const response = await fetchImpl(`${kiroRuntimeHost(region)}/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-amz-json-1.0",
        Accept: "application/json",
        "x-amz-target": "AmazonCodeWhispererService.ListAvailableProfiles",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ maxResults: 10 }),
      // Never let a hung/region-mismatched profile lookup block login or the quota refresh.
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return undefined;

    const data = (await response.json()) as { profiles?: unknown };
    const profiles = Array.isArray(data?.profiles) ? data.profiles : [];
    // Prefer a profile whose ARN region matches the region we queried; else take the first.
    const matched =
      profiles.find((profile: unknown) => {
        const arn = (profile as { arn?: unknown })?.arn;
        return typeof arn === "string" && regionFromKiroProfileArn(arn) === region;
      }) || profiles[0];
    const arn = (matched as { arn?: unknown })?.arn;
    return typeof arn === "string" && arn.length > 0 ? arn : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Discover a Kiro/CodeWhisperer profile ARN by probing the Q Developer profile regions
 * (us-east-1 / eu-central-1) with the account's access token. The SSO bearer token minted from
 * the IdC region works cross-region against the Q Developer profile's region (AWS's documented
 * multi-region IdC ⇄ profile setup). Returns the first ARN found (its embedded region is the
 * authoritative runtime region), or undefined when no profile is available (e.g. AWS Builder ID
 * accounts, or an org/token with no Kiro entitlement). Best-effort: never throws.
 */
export async function discoverKiroProfileArnAcrossRegions(
  accessToken: string | null | undefined,
  storedRegion?: string | null,
  fetchImpl?: typeof fetch
): Promise<string | undefined> {
  const token = typeof accessToken === "string" ? accessToken.trim() : "";
  if (!token) return undefined;

  // Resolve fetch at call time (not module-load) so callers/tests that swap globalThis.fetch
  // are honored when no explicit implementation is injected.
  const doFetch = fetchImpl ?? globalThis.fetch;

  for (const region of buildKiroProfileDiscoveryRegions(storedRegion)) {
    const arn = await listKiroProfileArnForRegion(token, region, doFetch);
    if (arn) return arn;
  }
  return undefined;
}
