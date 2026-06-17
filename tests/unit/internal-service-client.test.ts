import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  deleteBillingByOrg,
  deleteCampaignsByOrg,
  deleteInternalServiceByOrg,
  deleteKeysByOrg,
  deleteRunsByOrg,
  InternalServiceTeardownError,
  type TeardownProvider,
} from "../../src/lib/internal-service-client.js";

const ORG = "11111111-1111-4111-8111-111111111111";

const ENV_KEYS = [
  "BILLING_SERVICE_URL",
  "BILLING_SERVICE_API_KEY",
  "CAMPAIGN_SERVICE_URL",
  "CAMPAIGN_SERVICE_API_KEY",
  "RUNS_SERVICE_URL",
  "RUNS_SERVICE_API_KEY",
  "KEY_SERVICE_URL",
  "KEY_SERVICE_API_KEY",
] as const;

const savedEnv = new Map<string, string | undefined>();

function mockFetch(status: number, body = "") {
  const fn = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("internal producer teardown client", () => {
  beforeEach(() => {
    savedEnv.clear();
    for (const key of ENV_KEYS) {
      savedEnv.set(key, process.env[key]);
    }

    process.env.BILLING_SERVICE_URL = "http://billing-service.test/";
    process.env.BILLING_SERVICE_API_KEY = "billing-key";
    process.env.CAMPAIGN_SERVICE_URL = "http://campaign-service.test/";
    process.env.CAMPAIGN_SERVICE_API_KEY = "campaign-key";
    process.env.RUNS_SERVICE_URL = "http://runs-service.test/";
    process.env.RUNS_SERVICE_API_KEY = "runs-key";
    process.env.KEY_SERVICE_URL = "http://key-service.test/";
    process.env.KEY_SERVICE_API_KEY = "key-key";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const [key, value] of savedEnv) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it.each([
    ["billing", deleteBillingByOrg, "http://billing-service.test/internal/accounts/by-org"],
    ["campaign", deleteCampaignsByOrg, "http://campaign-service.test/internal/campaigns/by-org"],
    ["runs", deleteRunsByOrg, "http://runs-service.test/internal/runs/by-org"],
    ["key", deleteKeysByOrg, "http://key-service.test/internal/keys/by-org"],
  ] as const)("calls %s-service locked path with x-api-key", async (provider, fn, basePath) => {
    const fetchMock = mockFetch(204);

    await expect(fn(ORG)).resolves.toBe("deleted");

    expect(fetchMock).toHaveBeenCalledWith(`${basePath}/${ORG}`, {
      method: "DELETE",
      headers: { "x-api-key": `${provider}-key` },
    });
  });

  it("throws InternalServiceTeardownError with provider, status, and body on non-2xx", async () => {
    mockFetch(503, "billing down");

    const error = await deleteInternalServiceByOrg("billing", ORG).catch((err) => err);

    expect(error).toBeInstanceOf(InternalServiceTeardownError);
    expect(error).toMatchObject({
      provider: "billing",
      status: 503,
      body: "billing down",
    });
  });

  it.each([
    ["billing", "BILLING_SERVICE_URL"],
    ["campaign", "CAMPAIGN_SERVICE_URL"],
    ["runs", "RUNS_SERVICE_URL"],
    ["key", "KEY_SERVICE_URL"],
  ] as const)("throws when %s-service URL is not configured", async (provider, envKey) => {
    delete process.env[envKey];

    await expect(deleteInternalServiceByOrg(provider as TeardownProvider, ORG)).rejects.toThrow(
      `${envKey} not configured`,
    );
  });

  it.each([
    ["billing", "BILLING_SERVICE_API_KEY"],
    ["campaign", "CAMPAIGN_SERVICE_API_KEY"],
    ["runs", "RUNS_SERVICE_API_KEY"],
    ["key", "KEY_SERVICE_API_KEY"],
  ] as const)("throws when %s-service API key is not configured", async (provider, envKey) => {
    delete process.env[envKey];

    await expect(deleteInternalServiceByOrg(provider as TeardownProvider, ORG)).rejects.toThrow(
      `${envKey} not configured`,
    );
  });

  it("propagates thrown fetch errors so route teardown fails loud", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));

    await expect(deleteRunsByOrg(ORG)).rejects.toThrow("fetch failed");
  });
});
