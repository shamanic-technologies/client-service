import { fetchWithRetry } from "./fetch-retry.js";

/**
 * apollo-service `POST /internal/person-identity` (org-less, platform-billed):
 * Apollo people/match by EMAIL only. apollo-service declares the spend on its
 * own platform run (1 apollo-credit when matched, 0 otherwise) and caches per
 * email, so this service declares nothing (see CLAUDE.md: no cost declaration
 * here).
 */
export interface PersonIdentity {
  email: string;
  matched: boolean;
  matchConfidence: string | null;
  linkedinUrl: string | null;
  apolloPersonId: string | null;
  name: string | null;
  cached: boolean;
}

export class ApolloServiceError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`[client-service] apollo-service person-identity failed (${status}): ${body}`);
    this.name = "ApolloServiceError";
  }
}

function isPersonIdentity(v: unknown): v is PersonIdentity {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  const strOrNull = (x: unknown) => x === null || typeof x === "string";
  return (
    typeof o.email === "string" &&
    typeof o.matched === "boolean" &&
    strOrNull(o.matchConfidence) &&
    strOrNull(o.linkedinUrl) &&
    strOrNull(o.apolloPersonId) &&
    typeof o.cached === "boolean"
  );
}

export async function lookupPersonIdentity(email: string): Promise<PersonIdentity> {
  const baseUrl = process.env.APOLLO_SERVICE_URL;
  const apiKey = process.env.APOLLO_SERVICE_API_KEY;
  if (!baseUrl) throw new Error("[client-service] APOLLO_SERVICE_URL not configured");
  if (!apiKey) throw new Error("[client-service] APOLLO_SERVICE_API_KEY not configured");

  const res = await fetchWithRetry(`${baseUrl.replace(/\/$/, "")}/internal/person-identity`, {
    method: "POST",
    headers: { "x-api-key": apiKey, "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
  const text = await res.text();
  if (!res.ok) throw new ApolloServiceError(res.status, text);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new ApolloServiceError(res.status, `unparseable body: ${text.slice(0, 500)}`);
  }
  if (!isPersonIdentity(body)) {
    throw new ApolloServiceError(res.status, `unexpected shape: ${text.slice(0, 500)}`);
  }
  return body;
}
