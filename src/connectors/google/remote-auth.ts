/**
 * OAuth for a daemon that is not where the browser is.
 *
 * The existing flow assumes one machine: it opens a loopback listener on a
 * random port and points a local browser at it. That is right for a CLI on a
 * laptop and impossible for a box in a closet being set up from a phone.
 *
 * So the flow splits. `begin` returns a URL and stores the PKCE verifier
 * against a state value. Whoever has a browser does the browsing. `complete`
 * takes the code back and exchanges it. Neither half needs to be on the same
 * machine as the other, and the verifier never leaves the box.
 *
 * The loopback path in `oauth.ts` stays, because it is still the right thing
 * for `harbor auth google` at a terminal.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { ConfigurationError, UpstreamError } from "../../kernel/errors.js";
import { scopesFor } from "../registry.js";
import type { DB } from "../../kernel/db.js";
import type { OAuthCredentials } from "../../store/accounts.js";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

/** A started flow is only good for this long. Half-finished auth should not linger. */
const FLOW_TTL_MINUTES = 15;

function base64Url(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function client(): { readonly id: string; readonly secret: string } {
  const id = process.env["GOOGLE_CLIENT_ID"];
  const secret = process.env["GOOGLE_CLIENT_SECRET"];

  if (id === undefined || secret === undefined || id.length === 0 || secret.length === 0) {
    throw new ConfigurationError(
      "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set",
      "Put both in ~/.harbor/.env on the machine running Harbor.",
    );
  }

  return { id, secret };
}

export interface StartedFlow {
  readonly flowId: string;
  readonly authUrl: string;
  readonly state: string;
  readonly expiresAt: number;
}

/**
 * Begins a flow.
 *
 * `redirectUri` is supplied by the caller because only the caller knows where
 * it can receive a redirect: an app with a custom scheme, a web client on a
 * known origin, or the box's own API. Whatever it is has to be registered on
 * the Google client, which is the one setup step this cannot remove.
 */
export function begin(db: DB, redirectUri: string): StartedFlow {
  const id = `f_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  const state = base64Url(randomBytes(16));
  const expiresAt = Date.now() + FLOW_TTL_MINUTES * 60_000;

  db.prepare(
    `INSERT INTO auth_flows (id, source_type, oauth_state, verifier, redirect_uri, created_at, expires_at)
     VALUES (?, 'google', ?, ?, ?, ?, ?)`,
  ).run(id, state, verifier, redirectUri, Date.now(), expiresAt);

  const authUrl = `${AUTH_ENDPOINT}?${new URLSearchParams({
    client_id: client().id,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: scopesFor("google").join(" "),
    access_type: "offline",
    // Without this Google omits the refresh token on repeat authorizations,
    // and a flow that works once and silently fails after is worse than one
    // that always asks.
    prompt: "consent",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString()}`;

  return { flowId: id, authUrl, state, expiresAt };
}

interface TokenResponse {
  readonly access_token: string;
  readonly refresh_token?: string;
  readonly expires_in: number;
  readonly scope: string;
}

/**
 * Finishes a flow.
 *
 * Looked up by `state` rather than by flow id, because state is the value that
 * makes the round trip through Google and back to the client, and checking it
 * is what makes the callback trustworthy.
 */
export async function complete(
  db: DB,
  state: string,
  code: string,
): Promise<OAuthCredentials> {
  const row = db.prepare(`SELECT * FROM auth_flows WHERE oauth_state = ?`).get(state) as
    | {
        id: string;
        verifier: string;
        redirect_uri: string;
        expires_at: number;
        completed_at: number | null;
      }
    | undefined;

  if (row === undefined) {
    throw new UpstreamError("Unknown authorization state", {
      hint: "The flow was never started here, or the box restarted mid-flow. Start again.",
    });
  }

  if (row.completed_at !== null) {
    throw new UpstreamError("That authorization was already used");
  }

  if (row.expires_at < Date.now()) {
    throw new UpstreamError("That authorization expired", {
      hint: `Flows are good for ${String(FLOW_TTL_MINUTES)} minutes. Start again.`,
    });
  }

  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: client().id,
      client_secret: client().secret,
      redirect_uri: row.redirect_uri,
      grant_type: "authorization_code",
      code_verifier: row.verifier,
    }).toString(),
  });

  const text = await response.text();

  if (!response.ok) {
    throw new UpstreamError(`Google rejected the code: ${text.slice(0, 200)}`, {
      status: response.status,
    });
  }

  const token = JSON.parse(text) as TokenResponse;

  if (token.refresh_token === undefined) {
    throw new UpstreamError("Google did not return a refresh token", {
      hint: "Remove Harbor at https://myaccount.google.com/permissions and authorize again.",
    });
  }

  db.prepare(`UPDATE auth_flows SET completed_at = ? WHERE id = ?`).run(Date.now(), row.id);

  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt: Date.now() + token.expires_in * 1000,
    scope: token.scope,
  };
}

export function purgeExpiredFlows(db: DB): number {
  return db
    .prepare(`DELETE FROM auth_flows WHERE expires_at < ? AND completed_at IS NULL`)
    .run(Date.now()).changes;
}
