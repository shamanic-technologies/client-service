import { describe, it, expect, afterEach, vi } from "vitest";
import { fetchWithRetry } from "../../src/lib/fetch-retry.js";

function transient(code: string) {
  return Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error("connect"), { code }),
  });
}

describe("fetchWithRetry", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("returns the response on first success", async () => {
    const fn = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fn);

    await expect(fetchWithRetry("http://x.test")).resolves.toMatchObject({ status: 200 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries a Neon cold-start connect failure and succeeds", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(transient("ECONNREFUSED"))
      .mockRejectedValueOnce(transient("ETIMEDOUT"))
      .mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fn);

    await expect(fetchWithRetry("http://x.test")).resolves.toMatchObject({ status: 200 });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("walks an AggregateError's sub-errors for the transient code", async () => {
    const aggregate = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("aggregate"), {
        errors: [Object.assign(new Error("v6"), { code: "ETIMEDOUT" })],
      }),
    });
    const fn = vi.fn().mockRejectedValueOnce(aggregate).mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fn);

    await expect(fetchWithRetry("http://x.test")).resolves.toMatchObject({ status: 200 });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("gives up and rethrows after the last retry", async () => {
    const fn = vi.fn().mockRejectedValue(transient("ECONNRESET"));
    vi.stubGlobal("fetch", fn);

    await expect(fetchWithRetry("http://x.test")).rejects.toThrow("fetch failed");
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it("does NOT retry a non-transient rejection", async () => {
    const fn = vi.fn().mockRejectedValue(new TypeError("Invalid URL"));
    vi.stubGlobal("fetch", fn);

    await expect(fetchWithRetry("http://x.test")).rejects.toThrow("Invalid URL");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry a completed 5xx — an HTTP answer is the service's real answer", async () => {
    const fn = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    vi.stubGlobal("fetch", fn);

    await expect(fetchWithRetry("http://x.test")).resolves.toMatchObject({ status: 503 });
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
