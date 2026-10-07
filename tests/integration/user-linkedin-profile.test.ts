import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createTestApp } from "../helpers/test-app.js";
import { cleanTestData, insertTestOrg, insertTestUser, closeDb, randomId } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { users } from "../../src/db/schema.js";

const lookup = vi.fn();
vi.mock("../../src/lib/apollo-service-client.js", async (orig) => ({
  ...(await orig<typeof import("../../src/lib/apollo-service-client.js")>()),
  lookupPersonIdentity: (...a: unknown[]) => lookup(...a),
}));

const API_KEY = "test_api_key";
const identity = (over: Record<string, unknown> = {}) => ({
  email: "kevin@distribute.you",
  matched: true,
  matchConfidence: "high",
  linkedinUrl: "http://www.linkedin.com/in/kevinlourd",
  apolloPersonId: "ap1",
  name: "Kevin Lourd",
  cached: false,
  ...over,
});

describe("a user's own LinkedIn profile", () => {
  const app = createTestApp();
  const get = (id: string) => request(app).get(`/internal/users/${id}/linkedin-profile`).set("x-api-key", API_KEY);
  const resolve = (id: string) => request(app).post(`/internal/users/${id}/linkedin-profile/resolve`).set("x-api-key", API_KEY);

  beforeEach(async () => {
    await cleanTestData();
    lookup.mockReset();
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  async function user(email: string | null = "Kevin@Distribute.you") {
    const org = await insertTestOrg({ externalId: `org-${randomId()}` });
    return insertTestUser({ externalId: `user-${randomId()}`, email: email ?? undefined, orgId: org.id });
  }

  it("not_looked_up, then found by email once, and the second call asks nobody", async () => {
    const u = await user();
    const before = await get(u.id);
    expect(before.status).toBe(200);
    expect(before.body).toEqual({ userId: u.id, status: "not_looked_up", linkedinUrl: null, noneFoundReason: null, provenance: null });

    lookup.mockResolvedValue(identity());
    const first = await resolve(u.id);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      userId: u.id,
      status: "found",
      linkedinUrl: "https://www.linkedin.com/in/kevinlourd",
      noneFoundReason: null,
      lookedUpNow: true,
      provenance: { source: "apollo_people_match_by_email", matchedOnEmail: "kevin@distribute.you", matchConfidence: "high", apolloPersonId: "ap1" },
    });
    expect(lookup).toHaveBeenCalledWith("kevin@distribute.you");

    const second = await resolve(u.id);
    expect(second.body).toMatchObject({ status: "found", lookedUpNow: false });
    expect(lookup).toHaveBeenCalledTimes(1);

    const read = await get(u.id);
    expect(read.body.status).toBe("found");
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("a weak match is stored as none_found with its reason, and reused", async () => {
    const u = await user();
    lookup.mockResolvedValue(identity({ matchConfidence: "low" }));
    const res = await resolve(u.id);
    expect(res.body).toMatchObject({ status: "none_found", linkedinUrl: null, noneFoundReason: "weak_match", lookedUpNow: true });
    expect((await resolve(u.id)).body).toMatchObject({ status: "none_found", noneFoundReason: "weak_match", lookedUpNow: false });
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("no email on record: none_found without asking any vendor", async () => {
    const u = await user(null);
    const res = await resolve(u.id);
    expect(res.body).toMatchObject({ status: "none_found", noneFoundReason: "no_email_on_record", provenance: { source: "user_record", matchedOnEmail: null } });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("an email change makes the stored answer stale: not_looked_up, then asked again", async () => {
    const u = await user();
    lookup.mockResolvedValue(identity());
    await resolve(u.id);
    await db.update(users).set({ email: "kevin@other.com" }).where(eq(users.id, u.id));
    expect((await get(u.id)).body.status).toBe("not_looked_up");
    lookup.mockResolvedValue(identity({ email: "kevin@other.com", matched: false, matchConfidence: "none", linkedinUrl: null, apolloPersonId: null }));
    const again = await resolve(u.id);
    expect(again.body).toMatchObject({ status: "none_found", noneFoundReason: "no_match", lookedUpNow: true });
    expect(lookup).toHaveBeenLastCalledWith("kevin@other.com");
  });

  it("a vendor failure is a 502 and stores nothing", async () => {
    const u = await user();
    lookup.mockRejectedValue(new Error("apollo down"));
    const res = await resolve(u.id);
    expect(res.status).toBe(502);
    expect(res.body.reason).toBe("person_lookup_unavailable");
    expect((await get(u.id)).body.status).toBe("not_looked_up");
  });

  it("unknown user is 404, bad id 400, no key 401", async () => {
    expect((await get(randomId())).status).toBe(404);
    expect((await resolve(randomId())).body.reason).toBe("user_not_found");
    expect((await get("nope")).status).toBe(400);
    expect((await request(app).get(`/internal/users/${randomId()}/linkedin-profile`)).status).toBe(401);
  });
});
