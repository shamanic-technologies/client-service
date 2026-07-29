import { fetchWithRetry } from "./fetch-retry.js";

/**
 * Resolve a decrypted PLATFORM key from key-service — the fleet's single home for
 * secrets shared across services. The dashboard app owns each secret in its own
 * Vercel env and registers it into key-service at startup; every backend then
 * reads it here instead of duplicating the secret into its own Railway env.
 *
 * Platform keys are global, so no org/user identity is involved — but the
 * `X-Caller-*` headers are REQUIRED (key-service 400s without them) because it
 * records which service/route depends on which provider.
 *
 * FAIL LOUD at every step: missing config, transport failure, any non-2xx
 * (including 404 = provider not registered yet), or a malformed body all throw.
 * A secret we cannot resolve must block the operation, never degrade it.
 */

export interface CallerInfo {
  /** Route method this key is being resolved for, e.g. "DELETE". */
  method: string;
  /** Route path this key is being resolved for, e.g. "/internal/orgs/:orgId". */
  path: string;
}

const CALLER_SERVICE = "client-service";
const TIMEOUT_MS = 30_000;

export async function getPlatformKey(provider: string, caller: CallerInfo): Promise<string> {
  const baseUrl = process.env.KEY_SERVICE_URL;
  const apiKey = process.env.KEY_SERVICE_API_KEY;
  if (!baseUrl) {
    throw new Error("[client-service] KEY_SERVICE_URL not configured");
  }
  if (!apiKey) {
    throw new Error("[client-service] KEY_SERVICE_API_KEY not configured");
  }

  const url = `${baseUrl.replace(/\/$/, "")}/keys/platform/${encodeURIComponent(provider)}/decrypt`;
  const res = await fetchWithRetry(url, {
    method: "GET",
    headers: {
      "x-api-key": apiKey,
      "x-caller-service": CALLER_SERVICE,
      "x-caller-method": caller.method,
      "x-caller-path": caller.path,
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `[client-service] key-service GET /keys/platform/${provider}/decrypt failed (${res.status}): ${body}`,
    );
  }

  const data = (await res.json()) as { provider?: unknown; key?: unknown };
  if (typeof data.key !== "string" || data.key.length === 0) {
    throw new Error(`[client-service] key-service returned a malformed platform key for "${provider}"`);
  }
  return data.key;
}
