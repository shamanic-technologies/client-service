export type TeardownProvider = "billing" | "campaign" | "runs" | "key";

type TeardownTarget = {
  provider: TeardownProvider;
  urlEnv: string;
  apiKeyEnv: string;
  path: (orgId: string) => string;
};

const TARGETS: Record<TeardownProvider, TeardownTarget> = {
  billing: {
    provider: "billing",
    urlEnv: "BILLING_SERVICE_URL",
    apiKeyEnv: "BILLING_SERVICE_API_KEY",
    path: (orgId) => `/internal/accounts/by-org/${encodeURIComponent(orgId)}`,
  },
  campaign: {
    provider: "campaign",
    urlEnv: "CAMPAIGN_SERVICE_URL",
    apiKeyEnv: "CAMPAIGN_SERVICE_API_KEY",
    path: (orgId) => `/internal/campaigns/by-org/${encodeURIComponent(orgId)}`,
  },
  runs: {
    provider: "runs",
    urlEnv: "RUNS_SERVICE_URL",
    apiKeyEnv: "RUNS_SERVICE_API_KEY",
    path: (orgId) => `/internal/runs/by-org/${encodeURIComponent(orgId)}`,
  },
  key: {
    provider: "key",
    urlEnv: "KEY_SERVICE_URL",
    apiKeyEnv: "KEY_SERVICE_API_KEY",
    path: (orgId) => `/internal/keys/by-org/${encodeURIComponent(orgId)}`,
  },
};

export class InternalServiceTeardownError extends Error {
  constructor(
    public readonly provider: TeardownProvider,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`[client-service] ${provider}-service org teardown failed (${status}): ${body}`);
    this.name = "InternalServiceTeardownError";
  }
}

export type InternalServiceDeleteResult = "deleted";

export async function deleteInternalServiceByOrg(
  provider: TeardownProvider,
  orgId: string,
): Promise<InternalServiceDeleteResult> {
  const target = TARGETS[provider];
  const baseUrl = process.env[target.urlEnv];
  const apiKey = process.env[target.apiKeyEnv];
  if (!baseUrl) {
    throw new Error(`[client-service] ${target.urlEnv} not configured`);
  }
  if (!apiKey) {
    throw new Error(`[client-service] ${target.apiKeyEnv} not configured`);
  }

  const url = `${baseUrl.replace(/\/$/, "")}${target.path(orgId)}`;
  const res = await fetch(url, {
    method: "DELETE",
    headers: { "x-api-key": apiKey },
  });

  if (res.ok) return "deleted";

  const body = await res.text();
  throw new InternalServiceTeardownError(provider, res.status, body);
}

export async function deleteBillingByOrg(orgId: string): Promise<InternalServiceDeleteResult> {
  return deleteInternalServiceByOrg("billing", orgId);
}

export async function deleteCampaignsByOrg(orgId: string): Promise<InternalServiceDeleteResult> {
  return deleteInternalServiceByOrg("campaign", orgId);
}

export async function deleteRunsByOrg(orgId: string): Promise<InternalServiceDeleteResult> {
  return deleteInternalServiceByOrg("runs", orgId);
}

export async function deleteKeysByOrg(orgId: string): Promise<InternalServiceDeleteResult> {
  return deleteInternalServiceByOrg("key", orgId);
}
