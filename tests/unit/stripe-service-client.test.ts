import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { deleteStripeCustomerByOrg, StripeServiceError } from "../../src/lib/stripe-service-client.js";

const ORG = "11111111-1111-4111-8111-111111111111";

function mockFetch(status: number, body = "") {
  const fn = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("deleteStripeCustomerByOrg", () => {
  const savedUrl = process.env.STRIPE_SERVICE_URL;
  const savedKey = process.env.STRIPE_SERVICE_API_KEY;

  beforeEach(() => {
    process.env.STRIPE_SERVICE_URL = "http://stripe-service.test";
    process.env.STRIPE_SERVICE_API_KEY = "sk-test";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env.STRIPE_SERVICE_URL = savedUrl;
    process.env.STRIPE_SERVICE_API_KEY = savedKey;
  });

  it("returns 'deleted' on 2xx and calls the locked path with x-api-key", async () => {
    const fn = mockFetch(200);
    const result = await deleteStripeCustomerByOrg(ORG);
    expect(result).toBe("deleted");
    expect(fn).toHaveBeenCalledWith(
      `http://stripe-service.test/internal/customers/by-org/${ORG}`,
      { method: "DELETE", headers: { "x-api-key": "sk-test" } },
    );
  });

  it("throws (fail loud) on 404 — does NOT swallow as already-gone", async () => {
    mockFetch(404, "Not Found");
    await expect(deleteStripeCustomerByOrg(ORG)).rejects.toBeInstanceOf(StripeServiceError);
    await expect(deleteStripeCustomerByOrg(ORG)).rejects.toMatchObject({ status: 404 });
  });

  it("throws StripeServiceError with upstream status + body on 5xx", async () => {
    mockFetch(500, "boom");
    await expect(deleteStripeCustomerByOrg(ORG)).rejects.toMatchObject({ status: 500, body: "boom" });
  });

  it("throws when STRIPE_SERVICE_URL is not configured", async () => {
    delete process.env.STRIPE_SERVICE_URL;
    await expect(deleteStripeCustomerByOrg(ORG)).rejects.toThrow("STRIPE_SERVICE_URL not configured");
  });

  it("throws when STRIPE_SERVICE_API_KEY is not configured", async () => {
    delete process.env.STRIPE_SERVICE_API_KEY;
    await expect(deleteStripeCustomerByOrg(ORG)).rejects.toThrow("STRIPE_SERVICE_API_KEY not configured");
  });
});
