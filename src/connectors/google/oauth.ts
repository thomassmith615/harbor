/**
 * Google OAuth, installed-application (loopback) flow.
 *
 * No SDK. The flow is four HTTP calls and a temporary local listener, and
 * hand-rolling it keeps the dependency surface at zero for the part of the
 * system that holds the keys to someone's mail.
 *
 * The refresh token is the durable credential. Access tokens are treated as
 * disposable and refreshed on demand, which is why callers ask for a token
 * rather than reading one.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import type { AddressInfo } from "node:net";
import { ConfigurationError, UpstreamError } from "../../kernel/errors.js";
import { scopesFor } from "../registry.js";
import { updateCredentials } from "../../store/accounts.js";
import type { DB } from "../../kernel/db.js";
import type { Account, OAuthCredentials } from "../../store/accounts.js";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

/**
 * Scopes come from the connector registry rather than a constant here, so
 * adding a source that needs new access is one line in registry.ts. Widening
 * what Harbor can reach stays a deliberate act; it is just declared next to the
 * code that needs it.
 */
function googleScopes(): readonly string[] {
  return scopesFor("google");
}

/** Access tokens are refreshed this long before they actually expire. */
const REFRESH_MARGIN_MS = 60_000;

interface TokenResponse {
  readonly access_token: string;
  readonly refresh_token?: string;
  readonly expires_in: number;
  readonly scope: string;
  readonly token_type: string;
}

function base64Url(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function openBrowser(url: string): void {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";

  try {
    const child = spawn(command, [url], { detached: true, stdio: "ignore", shell: process.platform === "win32" });
    child.unref();
  } catch {
    // Falling back to the printed URL is fine; the caller always prints it.
  }
}

export function googleClient(): { readonly id: string; readonly secret: string } {
  const id = process.env["GOOGLE_CLIENT_ID"];
  const secret = process.env["GOOGLE_CLIENT_SECRET"];

  if (id === undefined || secret === undefined || id.length === 0 || secret.length === 0) {
    throw new ConfigurationError(
      "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set",
      "Create a Desktop app OAuth client in Google Cloud Console and put both values in ~/.harbor/.env",
    );
  }

  return { id, secret };
}

async function exchange(body: Record<string, string>): Promise<TokenResponse> {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });

  const text = await response.text();

  if (!response.ok) {
    throw new UpstreamError(`Google token endpoint returned ${String(response.status)}: ${text}`, {
      status: response.status,
      hint:
        response.status === 400
          ? "The client id, client secret, or refresh token may be wrong. Re-run `harbor auth google`."
          : undefined,
    });
  }

  return JSON.parse(text) as TokenResponse;
}

/**
 * Runs the interactive consent flow and returns credentials.
 *
 * `prompt=consent` with `access_type=offline` is deliberate: without it Google
 * omits the refresh token on repeat authorizations, and a flow that works the
 * first time and silently fails the second is worse than one that always asks.
 */
export async function authorize(
  onUrl: (url: string) => void,
  timeoutMs = 300_000,
): Promise<OAuthCredentials> {
  const client = googleClient();
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  const state = base64Url(randomBytes(16));

  return await new Promise<OAuthCredentials>((resolvePromise, rejectPromise) => {
    let settled = false;

    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");

      if (url.pathname !== "/callback") {
        response.writeHead(404).end("not found");
        return;
      }

      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      const returnedState = url.searchParams.get("state");

      const finish = (message: string): void => {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(
          `<!doctype html><meta charset="utf-8"><title>Harbor</title>` +
            `<body style="font:16px system-ui;padding:3rem;max-width:32rem">` +
            `<h1 style="font-size:1.2rem">Harbor</h1><p>${message}</p></body>`,
        );
      };

      if (error !== null) {
        finish("Authorization was denied. You can close this tab.");
        settle(() => {
          rejectPromise(new UpstreamError(`Google returned an authorization error: ${error}`));
        });
        return;
      }

      if (returnedState !== state) {
        finish("State mismatch. You can close this tab.");
        settle(() => {
          rejectPromise(new UpstreamError("OAuth state did not match. Aborting."));
        });
        return;
      }

      if (code === null) {
        finish("No authorization code was returned. You can close this tab.");
        settle(() => {
          rejectPromise(new UpstreamError("Google did not return an authorization code"));
        });
        return;
      }

      finish("Connected. You can close this tab and return to your terminal.");

      const address = server.address() as AddressInfo;

      void exchange({
        code,
        client_id: client.id,
        client_secret: client.secret,
        redirect_uri: `http://127.0.0.1:${String(address.port)}/callback`,
        grant_type: "authorization_code",
        code_verifier: verifier,
      })
        .then((token) => {
          if (token.refresh_token === undefined) {
            settle(() => {
              rejectPromise(
                new UpstreamError(
                  "Google did not return a refresh token",
                  {
                    hint: "Remove Harbor at https://myaccount.google.com/permissions and authorize again.",
                  },
                ),
              );
            });
            return;
          }

          settle(() => {
            resolvePromise({
              accessToken: token.access_token,
              refreshToken: token.refresh_token as string,
              expiresAt: Date.now() + token.expires_in * 1000,
              scope: token.scope,
            });
          });
        })
        .catch((cause: unknown) => {
          settle(() => {
            rejectPromise(cause);
          });
        });
    });

    const timer = setTimeout(() => {
      settle(() => {
        rejectPromise(new UpstreamError("Timed out waiting for Google authorization"));
      });
    }, timeoutMs);

    function settle(action: () => void): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      server.close();
      action();
    }

    server.on("error", (cause: unknown) => {
      settle(() => {
        rejectPromise(cause);
      });
    });

    // Port 0: the OS picks. Google permits any port on the loopback interface
    // for installed apps, so there is nothing to register in the console.
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      const redirect = `http://127.0.0.1:${String(address.port)}/callback`;

      const authUrl = `${AUTH_ENDPOINT}?${new URLSearchParams({
        client_id: client.id,
        redirect_uri: redirect,
        response_type: "code",
        scope: googleScopes().join(" "),
        access_type: "offline",
        prompt: "consent",
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
      }).toString()}`;

      onUrl(authUrl);
      openBrowser(authUrl);
    });
  });
}

/**
 * Returns a usable access token, refreshing and persisting if needed.
 *
 * Callers never read `account.credentials.accessToken` directly. That is the
 * whole point: expiry handling lives in one place.
 */
export async function accessToken(db: DB, account: Account): Promise<string> {
  const credentials = account.credentials;

  if (credentials.expiresAt - REFRESH_MARGIN_MS > Date.now()) {
    return credentials.accessToken;
  }

  const client = googleClient();

  const token = await exchange({
    client_id: client.id,
    client_secret: client.secret,
    refresh_token: credentials.refreshToken,
    grant_type: "refresh_token",
  });

  const refreshed: OAuthCredentials = {
    accessToken: token.access_token,
    refreshToken: token.refresh_token ?? credentials.refreshToken,
    expiresAt: Date.now() + token.expires_in * 1000,
    scope: token.scope.length > 0 ? token.scope : credentials.scope,
  };

  updateCredentials(db, account.id, refreshed);

  return refreshed.accessToken;
}
