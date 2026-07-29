import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getPlatformKey } from "../../src/lib/key-service-client.js";

const CALLER = { method: "DELETE", path: "/internal/orgs/:orgId" };

describe("getPlatformKey", () => {
  beforeEach(() => {
    process.env.KEY_SERVICE_URL = "https://key.test/";
    process.env.KEY_SERVICE_API_KEY = "key_key";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the decrypted key and sends the caller headers key-service requires", async () => {
    const fn = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ provider: "clerk", key: "sk_live_x" }),
    }));
    vi.stubGlobal("fetch", fn);

    await expect(getPlatformKey("clerk", CALLER)).resolves.toBe("sk_live_x");

    const [url, opts] = fn.mock.calls[0] as unknown as [string, RequestInit];
    // Trailing slash on the base URL must not double up.
    expect(url).toBe("https://key.test/keys/platform/clerk/decrypt");
    expect(opts.method).toBe("GET");
    expect(opts.headers).toMatchObject({
      "x-api-key": "key_key",
      "x-caller-service": "client-service",
      "x-caller-method": "DELETE",
      "x-caller-path": "/internal/orgs/:orgId",
    });
  });

  it("url-encodes the provider name", async () => {
    const fn = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ provider: "a/b", key: "k" }),
    }));
    vi.stubGlobal("fetch", fn);

    await getPlatformKey("a/b", CALLER);
    expect((fn.mock.calls[0] as unknown as [string])[0]).toBe(
      "https://key.test/keys/platform/a%2Fb/decrypt",
    );
  });

  it("throws on 404 — a provider that is not registered is not a silent empty key", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 404, text: async () => "not found" })),
    );
    await expect(getPlatformKey("clerk", CALLER)).rejects.toThrow(
      "key-service GET /keys/platform/clerk/decrypt failed (404): not found",
    );
  });

  it("throws on a malformed body (no key field)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ provider: "clerk" }) })),
    );
    await expect(getPlatformKey("clerk", CALLER)).rejects.toThrow("malformed platform key");
  });

  it("throws on an empty-string key", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ key: "" }) })),
    );
    await expect(getPlatformKey("clerk", CALLER)).rejects.toThrow("malformed platform key");
  });

  it("throws when KEY_SERVICE_URL is not configured", async () => {
    delete process.env.KEY_SERVICE_URL;
    await expect(getPlatformKey("clerk", CALLER)).rejects.toThrow("KEY_SERVICE_URL not configured");
  });

  it("throws when KEY_SERVICE_API_KEY is not configured", async () => {
    delete process.env.KEY_SERVICE_API_KEY;
    await expect(getPlatformKey("clerk", CALLER)).rejects.toThrow(
      "KEY_SERVICE_API_KEY not configured",
    );
  });
});
