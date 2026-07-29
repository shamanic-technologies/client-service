/**
 * Connect-phase retry wrapper around `fetch` for outbound calls to Neon-backed
 * sibling services.
 *
 * Those services scale their Neon compute to zero after ~300s idle. The first
 * request after a suspend lands while the compute is still resuming and the
 * socket is reset/refused/timed out, so `fetch` REJECTS (`TypeError: fetch
 * failed`) with a transient code on `cause`. Retrying is write-safe because the
 * request never reached the server.
 *
 * Only a THROWN rejection is retried. A completed HTTP response — including a
 * 5xx — is a real answer from the service and is returned untouched: the caller
 * decides, and we never mask a genuine upstream failure behind a retry.
 */

const TRANSIENT_CODES = new Set([
  "ETIMEDOUT",
  "ECONNREFUSED",
  "ECONNRESET",
  "EAI_AGAIN",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

const BACKOFF_MS = [250, 500, 1000];

function hasTransientCode(error: unknown, depth = 0): boolean {
  if (depth > 5 || error === null || typeof error !== "object") return false;

  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && TRANSIENT_CODES.has(code)) return true;

  const errors = (error as { errors?: unknown }).errors;
  if (Array.isArray(errors) && errors.some((e) => hasTransientCode(e, depth + 1))) return true;

  return hasTransientCode((error as { cause?: unknown }).cause, depth + 1);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function fetchWithRetry(url: string, init?: RequestInit): Promise<Response> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {
    try {
      return await fetch(url, init);
    } catch (error) {
      if (!hasTransientCode(error)) throw error;
      lastError = error;
      if (attempt < BACKOFF_MS.length) await sleep(BACKOFF_MS[attempt]);
    }
  }

  throw lastError;
}
