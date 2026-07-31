import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  ensureBillingWelcome,
  notifyReferralClaim,
  BillingServiceError,
} from "../../src/lib/billing-service-client.js";

describe("ensureBillingWelcome", () => {
  const savedUrl = process.env.BILLING_SERVICE_URL;
  const savedKey = process.env.BILLING_SERVICE_API_KEY;
  const fetchMock = vi.fn();

  beforeEach(() => {
    process.env.BILLING_SERVICE_URL = "https://billing.test";
    process.env.BILLING_SERVICE_API_KEY = "billing_key";
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    process.env.BILLING_SERVICE_URL = savedUrl;
    process.env.BILLING_SERVICE_API_KEY = savedKey;
    vi.unstubAllGlobals();
  });

  it("GETs billing /v1/accounts with org+user+api-key headers", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, text: async () => "{}" });
    await ensureBillingWelcome("11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("https://billing.test/v1/accounts");
    expect(opts.method).toBe("GET");
    expect(opts.headers["x-org-id"]).toBe("11111111-1111-1111-1111-111111111111");
    expect(opts.headers["x-user-id"]).toBe("22222222-2222-2222-2222-222222222222");
    expect(opts.headers["x-api-key"]).toBe("billing_key");
  });

  it("omits x-api-key when BILLING_SERVICE_API_KEY unset", async () => {
    delete process.env.BILLING_SERVICE_API_KEY;
    fetchMock.mockResolvedValueOnce({ ok: true, text: async () => "{}" });
    await ensureBillingWelcome("org-uuid", "user-uuid");
    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.headers["x-api-key"]).toBeUndefined();
  });

  it("throws BillingServiceError (fail loud) on a non-2xx", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, text: async () => "billing down" });
    const err = await ensureBillingWelcome("o", "u").catch((e) => e);
    expect(err).toBeInstanceOf(BillingServiceError);
    expect(err.status).toBe(500);
    expect(err.body).toBe("billing down");
  });

  it("throws when BILLING_SERVICE_URL not configured", async () => {
    delete process.env.BILLING_SERVICE_URL;
    await expect(ensureBillingWelcome("o", "u")).rejects.toThrow("BILLING_SERVICE_URL not configured");
  });
});

describe("notifyReferralClaim", () => {
  const savedUrl = process.env.BILLING_SERVICE_URL;
  const savedKey = process.env.BILLING_SERVICE_API_KEY;
  const fetchMock = vi.fn();
  const INVITER = "11111111-1111-1111-1111-111111111111";
  const INVITEE = "22222222-2222-2222-2222-222222222222";

  beforeEach(() => {
    process.env.BILLING_SERVICE_URL = "https://billing.test";
    process.env.BILLING_SERVICE_API_KEY = "billing_key";
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    process.env.BILLING_SERVICE_URL = savedUrl;
    process.env.BILLING_SERVICE_API_KEY = savedKey;
    vi.unstubAllGlobals();
  });

  it("POSTs both org identities to billing's referral-claim endpoint", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, text: async () => "{}" });
    await notifyReferralClaim({ inviterOrgId: INVITER, inviteeOrgId: INVITEE });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("https://billing.test/internal/referrals/claim");
    expect(opts.method).toBe("POST");
    expect(opts.headers["x-api-key"]).toBe("billing_key");
    // billing's field names: `orgId` is the org being referred, `referrerOrgId`
    // is the inviter. Getting these backwards silently credits the wrong side.
    expect(JSON.parse(opts.body)).toEqual({ orgId: INVITEE, referrerOrgId: INVITER });
  });

  it("throws BillingServiceError (fail loud) on a non-2xx", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503, text: async () => "billing down" });
    const err = await notifyReferralClaim({ inviterOrgId: INVITER, inviteeOrgId: INVITEE }).catch((e) => e);
    expect(err).toBeInstanceOf(BillingServiceError);
    expect(err.status).toBe(503);
    expect(err.body).toBe("billing down");
  });

  it("surfaces a 409 (already referred by a different org) rather than absorbing it", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 409,
      text: async () => "already referred by another org",
    });
    const err = await notifyReferralClaim({ inviterOrgId: INVITER, inviteeOrgId: INVITEE }).catch((e) => e);
    expect(err).toBeInstanceOf(BillingServiceError);
    expect(err.status).toBe(409);
  });

  it("throws when BILLING_SERVICE_URL not configured", async () => {
    delete process.env.BILLING_SERVICE_URL;
    await expect(
      notifyReferralClaim({ inviterOrgId: INVITER, inviteeOrgId: INVITEE }),
    ).rejects.toThrow("BILLING_SERVICE_URL not configured");
  });

  it("throws when BILLING_SERVICE_API_KEY not configured", async () => {
    delete process.env.BILLING_SERVICE_API_KEY;
    await expect(
      notifyReferralClaim({ inviterOrgId: INVITER, inviteeOrgId: INVITEE }),
    ).rejects.toThrow("BILLING_SERVICE_API_KEY not configured");
  });
});
