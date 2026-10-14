import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from "vitest";
import request from "supertest";
import { createTestApp } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestOrg, randomId } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { orgOwnerTelegram, orgOwnerTelegramLinkCodes } from "../../src/db/schema.js";
import { resetBotUsernameCache } from "../../src/lib/org-owner-telegram.js";

const API_KEY = "test_api_key";

type Call = { url: string; body: Record<string, unknown> | null };

describe("org owner Telegram", () => {
  const app = createTestApp();
  let orgId: string;
  let calls: Call[];
  let sendReply: () => { status: number; json: unknown };

  const send = (text: string, o = orgId) =>
    request(app)
      .post(`/internal/orgs/${o}/owner-telegram/messages`)
      .set("x-api-key", API_KEY)
      .set("x-run-id", randomId())
      .send({ text });

  beforeEach(async () => {
    await cleanTestData();
    resetBotUsernameCache();
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_OWNER_CHAT_ID = "999";
    calls = [];
    sendReply = () => ({ status: 200, json: { ok: true, result: { message_id: 42 } } });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { body?: string }) => {
        calls.push({ url, body: init?.body ? JSON.parse(init.body) : null });
        const reply = url.endsWith("/getMe")
          ? { status: 200, json: { ok: true, result: { username: "distribute_you_bot" } } }
          : sendReply();
        return { ok: reply.status < 300, status: reply.status, json: async () => reply.json };
      }),
    );
    orgId = (await insertTestOrg({ externalId: "org_Client1", name: "Acme" })).id;
  });

  afterEach(() => vi.unstubAllGlobals());
  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("not reachable: the owner never linked a chat, nothing sent", async () => {
    const res = await send("Your post is live");
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe("not_reachable");
    expect(calls).toHaveLength(0);
    expect((await request(app).get(`/internal/orgs/${orgId}/owner-telegram`).set("x-api-key", API_KEY)).body).toEqual({ reachable: false });
  });

  it("platform owner org: sends to the platform owner chat", async () => {
    await db.insert(orgOwnerTelegram).values({ orgId, target: "platform_owner_chat" });
    const res = await send("Your post is live: https://x.com/a/status/1");
    expect(res.body).toEqual({ outcome: "sent", target: "platform_owner_chat", telegramMessageId: 42 });
    expect(calls[0].url).toBe("https://api.telegram.org/botbot-token/sendMessage");
    expect(calls[0].body).toMatchObject({ chat_id: "999", text: "Your post is live: https://x.com/a/status/1" });
  });

  it("self-serve link: code → bot /start → the owner's chat gets the lines", async () => {
    const code = await request(app)
      .post(`/internal/orgs/${orgId}/owner-telegram/link-codes`)
      .set("x-api-key", API_KEY)
      .send({ userId: randomId() });
    expect(code.status).toBe(201);
    expect(code.body.linkUrl).toBe(`https://t.me/distribute_you_bot?start=${code.body.code}`);

    const linked = await request(app)
      .post("/internal/owner-telegram/links")
      .set("x-api-key", API_KEY)
      .send({ code: code.body.code, chatId: 12345 });
    expect(linked.status).toBe(200);
    expect(linked.body).toMatchObject({ orgId, orgName: "Acme", confirmationSent: true });
    expect(calls.at(-1)!.body).toMatchObject({ chat_id: "12345" });

    // Same code, same chat: a replay, no second confirmation. Another chat: refused.
    const replay = await request(app).post("/internal/owner-telegram/links").set("x-api-key", API_KEY).send({ code: code.body.code, chatId: "12345" });
    expect(replay.body).toMatchObject({ orgId, confirmationSent: false });
    const other = await request(app).post("/internal/owner-telegram/links").set("x-api-key", API_KEY).send({ code: code.body.code, chatId: "777" });
    expect(other.status).toBe(409);
    expect(other.body.error).toBe("link_code_used");

    const res = await send("Posted");
    expect(res.body).toEqual({ outcome: "sent", target: "linked_chat", telegramMessageId: 42 });
    expect(calls.at(-1)!.body).toMatchObject({ chat_id: "12345", text: "Posted" });

    const status = await request(app).get(`/internal/orgs/${orgId}/owner-telegram`).set("x-api-key", API_KEY);
    expect(status.body).toMatchObject({ reachable: true, target: "linked_chat" });
    const unlink = await request(app).delete(`/internal/orgs/${orgId}/owner-telegram`).set("x-api-key", API_KEY);
    expect(unlink.body).toEqual({ unlinked: true });
    expect((await send("again")).body.outcome).toBe("not_reachable");
  });

  it("Telegram refusal is a named delivery_failed, never a 500", async () => {
    await db.insert(orgOwnerTelegram).values({ orgId, target: "linked_chat", chatId: "12345" });
    sendReply = () => ({ status: 403, json: { ok: false, description: "Forbidden: bot was blocked by the user" } });
    const res = await send("Posted");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      outcome: "delivery_failed",
      target: "linked_chat",
      reason: "Telegram refused (403): Forbidden: bot was blocked by the user",
    });
  });

  it("Telegram unreachable is a named delivery_failed too", async () => {
    await db.insert(orgOwnerTelegram).values({ orgId, target: "linked_chat", chatId: "12345" });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNRESET"); }));
    const res = await send("Posted");
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe("delivery_failed");
    expect(res.body.reason).toContain("ECONNRESET");
  });

  it("an unconfigured bot is delivery_failed, not a crash", async () => {
    await db.insert(orgOwnerTelegram).values({ orgId, target: "platform_owner_chat" });
    delete process.env.TELEGRAM_OWNER_CHAT_ID;
    const res = await send("Posted");
    expect(res.body.outcome).toBe("delivery_failed");
    expect(calls).toHaveLength(0);
  });

  it("refuses an unknown org, a bad body, unknown and expired codes", async () => {
    expect((await send("x", "00000000-0000-4000-8000-000000000001")).status).toBe(404);
    expect((await send("   ")).status).toBe(400);
    const unknown = await request(app).post("/internal/owner-telegram/links").set("x-api-key", API_KEY).send({ code: "nope", chatId: "1" });
    expect(unknown.status).toBe(404);
    const code = await request(app).post(`/internal/orgs/${orgId}/owner-telegram/link-codes`).set("x-api-key", API_KEY).send({ userId: randomId() });
    await db.update(orgOwnerTelegramLinkCodes).set({ expiresAt: new Date(Date.now() - 1000) });
    const expired = await request(app).post("/internal/owner-telegram/links").set("x-api-key", API_KEY).send({ code: code.body.code, chatId: "1" });
    expect(expired.status).toBe(410);
    expect(expired.body.error).toBe("link_code_expired");
  });
});
