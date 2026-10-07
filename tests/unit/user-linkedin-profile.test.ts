import { describe, it, expect, vi, afterEach } from "vitest";
import { judgePersonIdentity, normalizeLinkedinProfileUrl } from "../../src/lib/user-linkedin-profile.js";
import { lookupPersonIdentity, ApolloServiceError } from "../../src/lib/apollo-service-client.js";

describe("normalizeLinkedinProfileUrl", () => {
  it("normalizes Apollo's member URL to https://www.linkedin.com/in/<slug>", () => {
    expect(normalizeLinkedinProfileUrl("http://www.linkedin.com/in/patrickcollison")).toBe("https://www.linkedin.com/in/patrickcollison");
    expect(normalizeLinkedinProfileUrl("https://fr.linkedin.com/in/Kevin-Lourd/")).toBe("https://www.linkedin.com/in/kevin-lourd");
    expect(normalizeLinkedinProfileUrl("linkedin.com/in/someone?trk=x")).toBe("https://www.linkedin.com/in/someone");
  });

  it("refuses anything that is not a member profile", () => {
    expect(normalizeLinkedinProfileUrl("https://www.linkedin.com/company/stripe")).toBeNull();
    expect(normalizeLinkedinProfileUrl("https://www.linkedin.com/in/")).toBeNull();
    expect(normalizeLinkedinProfileUrl("https://evil-linkedin.com/in/x")).toBeNull();
    expect(normalizeLinkedinProfileUrl("not a url at all")).toBeNull();
  });
});

describe("judgePersonIdentity", () => {
  const url = "http://www.linkedin.com/in/patrickcollison";
  it("found only on a high-confidence match with a member URL", () => {
    expect(judgePersonIdentity({ matched: true, matchConfidence: "high", linkedinUrl: url })).toEqual({
      status: "found",
      linkedinUrl: "https://www.linkedin.com/in/patrickcollison",
    });
  });
  it("every weaker answer is none_found with its reason, never a guess", () => {
    expect(judgePersonIdentity({ matched: false, matchConfidence: "none", linkedinUrl: null })).toEqual({ status: "none_found", reason: "no_match" });
    expect(judgePersonIdentity({ matched: true, matchConfidence: "low", linkedinUrl: url })).toEqual({ status: "none_found", reason: "weak_match" });
    expect(judgePersonIdentity({ matched: true, matchConfidence: null, linkedinUrl: url })).toEqual({ status: "none_found", reason: "weak_match" });
    expect(judgePersonIdentity({ matched: true, matchConfidence: "high", linkedinUrl: null })).toEqual({ status: "none_found", reason: "no_linkedin_on_match" });
    expect(judgePersonIdentity({ matched: true, matchConfidence: "high", linkedinUrl: "https://www.linkedin.com/company/x" })).toEqual({
      status: "none_found",
      reason: "unrecognised_linkedin_url",
    });
  });
});

describe("lookupPersonIdentity (apollo-service client)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.APOLLO_SERVICE_URL;
    delete process.env.APOLLO_SERVICE_API_KEY;
  });

  const ok = { email: "a@b.co", matched: true, matchConfidence: "high", linkedinUrl: "x", apolloPersonId: "p", name: "A", cached: false };

  it("posts the email with the service key and returns the parsed answer", async () => {
    process.env.APOLLO_SERVICE_URL = "http://apollo/";
    process.env.APOLLO_SERVICE_API_KEY = "k";
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(ok), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(lookupPersonIdentity("a@b.co")).resolves.toEqual(ok);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://apollo/internal/person-identity");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("k");
    expect(JSON.parse(init.body as string)).toEqual({ email: "a@b.co" });
  });

  it("fails loud on a non-2xx and on an unexpected shape", async () => {
    process.env.APOLLO_SERVICE_URL = "http://apollo";
    process.env.APOLLO_SERVICE_API_KEY = "k";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 502 })));
    await expect(lookupPersonIdentity("a@b.co")).rejects.toBeInstanceOf(ApolloServiceError);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ email: "a@b.co" }), { status: 200 })));
    await expect(lookupPersonIdentity("a@b.co")).rejects.toThrow(/unexpected shape/);
  });

  it("refuses to run unconfigured", async () => {
    await expect(lookupPersonIdentity("a@b.co")).rejects.toThrow(/APOLLO_SERVICE_URL/);
  });
});
