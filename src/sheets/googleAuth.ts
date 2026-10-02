import { createSign } from "node:crypto";

export interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

const TOKEN_URI = "https://oauth2.googleapis.com/token";
const SKEW_MS = 60_000;

/**
 * Service-account access tokens, the whole of it: sign a JWT asserting who we
 * are and what we want, exchange it for a bearer token. Google's own SDK
 * brings a few hundred dependencies to do this; the protocol is small enough
 * that the standard library is a better trade for a service that already
 * speaks HTTP to everything else.
 */
export class GoogleServiceAccount {
  private cached: CachedToken | null = null;

  constructor(
    private readonly key: ServiceAccountKey,
    private readonly scopes: string[],
  ) {}

  get email(): string {
    return this.key.client_email;
  }

  async accessToken(now = Date.now()): Promise<string> {
    if (this.cached && this.cached.expiresAt - SKEW_MS > now) return this.cached.token;

    const iat = Math.floor(now / 1000);
    const claims = {
      iss: this.key.client_email,
      scope: this.scopes.join(" "),
      aud: this.key.token_uri ?? TOKEN_URI,
      iat,
      exp: iat + 3600,
    };
    const unsigned = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify(claims))}`;
    const signature = createSign("RSA-SHA256").update(unsigned).sign(this.key.private_key);
    const assertion = `${unsigned}.${signature.toString("base64url")}`;

    const res = await fetch(this.key.token_uri ?? TOKEN_URI, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
    });
    const body = (await res.json()) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
    if (!res.ok || !body.access_token) {
      throw new Error(`Google token exchange failed (${res.status}): ${body.error_description ?? body.error ?? "unknown error"}`);
    }
    this.cached = { token: body.access_token, expiresAt: now + (body.expires_in ?? 3600) * 1000 };
    return body.access_token;
  }

  /** Authenticated JSON call against a Google REST API. */
  async api<T>(url: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const token = await this.accessToken();
    const res = await fetch(url, {
      method: init.method ?? "GET",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const text = await res.text();
    if (!res.ok) {
      const detail = safeMessage(text);
      throw new Error(`Google API ${init.method ?? "GET"} ${new URL(url).pathname} failed (${res.status}): ${detail}`);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }
}

export function parseServiceAccountKey(raw: string): ServiceAccountKey {
  const key = JSON.parse(raw) as Partial<ServiceAccountKey> & { type?: string };
  if (!key.client_email || !key.private_key) {
    throw new Error("service account key is missing client_email/private_key — is this the JSON key file Google gave you?");
  }
  // Keys pasted into an env var arrive with literal \n in the PEM.
  return { ...key, private_key: key.private_key.replace(/\\n/g, "\n") } as ServiceAccountKey;
}

function b64url(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}

function safeMessage(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } };
    return parsed.error?.message ?? text.slice(0, 300);
  } catch {
    return text.slice(0, 300);
  }
}
