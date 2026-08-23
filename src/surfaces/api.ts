/**
 * The HTTP API.
 *
 * Every handler is a thin adapter over a function the CLI also calls. That is
 * the only reason a third surface stays cheap, and the rule to defend: the
 * moment logic lands here, the CLI and the API start disagreeing about what
 * Harbor does.
 *
 * Shape notes:
 *
 *   Long work returns a job id immediately rather than blocking. A phone that
 *   gets backgrounded during a fifteen-minute backfill must be able to come
 *   back and find out what happened.
 *
 *   `/ask` can stream. Tool calls arrive as events while they happen, so a
 *   client can say "searching your calendar" instead of showing a spinner for
 *   eleven seconds.
 *
 *   Read and write are separate scopes, and a read-only device cannot approve
 *   an action no matter how it asks.
 */
import { createServer } from "node:http";
import { createServer as createSecureServer } from "node:https";
import { serveStatic } from "./static.js";
import { builtinUiRoot } from "./app.js";
import { ask } from "../reasoning/ask.js";
import {
  allTurns,
  deleteConversation,
  getConversation,
  listConversations,
} from "../store/conversations.js";
import { composeBrief, dismissObservation, renderBrief } from "../derive/brief.js";
import { latestDigest, recentDigests } from "../derive/digest.js";
import { createEmbedder } from "../derive/embed/index.js";
import { search } from "../retrieval/search.js";
import { getItem } from "../store/items.js";
import { runTool } from "../reasoning/tools.js";
import { humanWhen, localIso } from "../kernel/time.js";
import { authenticate, listDevices, revokeDevice } from "../store/devices.js";
import { issueCode, redeem } from "../store/pairing.js";
import { credentialFor } from "../connectors/dispatch.js";
import { CONNECTORS } from "../connectors/registry.js";
import { listStreams } from "../store/streams.js";
import {
  connectionsFor,
  getThread,
  threadItemIds,
  threadNodes,
  topThreads,
} from "../store/relationships.js";
import { NodeResolver, nodeKey } from "../store/nodes.js";
import { nameHandles, nameTranscript } from "../store/entities.js";
import { episodeItems, getEpisode } from "../store/episodes.js";
import { getStream } from "../store/streams.js";
import { listAccounts, saveAccount } from "../store/accounts.js";
import { begin, complete } from "../connectors/google/remote-auth.js";
import { authorize } from "../connectors/google/oauth.js";
import { basicAuth, discover } from "../connectors/apple/dav.js";
import {
  available as imessageAvailable,
  chatDbPath,
  inspect as inspectMessages,
} from "../connectors/imessage/messages.js";
import { packCredential, probe as probeImap } from "../connectors/imap/mail.js";
import { discoverImap } from "../connectors/imap/autoconfig.js";
import { enqueue, JOB_TASKS, stop, stopAll, taskAvailability } from "../jobs/runner.js";
import { getJob, listJobs } from "../store/jobs.js";
import { overview, problems, setupState, systemStatus } from "./setup.js";
import { coverageByKind } from "../store/coverage.js";
import { addRule, listRules, removeRule, setRuleEnabled } from "../policy/rules.js";
import { detectorStats, setDetectorSuppressed } from "../store/signals.js";
import {
  addSchedule,
  listSchedules,
  removeSchedule,
  SCHEDULABLE,
  setScheduleEnabled,
} from "../scheduler/schedule.js";
import { qualityStats } from "../reasoning/router.js";
import { TASK_CLASSES } from "../reasoning/tasks.js";
import { capabilities } from "../reasoning/capabilities.js";
import { readRaw } from "../store/items.js";
import { unlinkIdentifier } from "../store/entities.js";
import { listCalendars } from "../connectors/google/calendar.js";
import { discoverWith } from "../connectors/apple/dav.js";
import type { ScheduledTask } from "../scheduler/schedule.js";
import type { Egress } from "../policy/rules.js";
import { egressSince, recent, spend } from "../store/audit.js";
import {
  addInterest,
  listInterests,
  saveInterestEmbedding,
  setInterestState,
} from "../store/signals.js";
import { toBlob } from "../derive/embed/index.js";
import {
  identifiersFor,
  lookupEntities,
  mergeEntities,
  pinEntity,
  topEntities,
} from "../store/entities.js";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { DB } from "../kernel/db.js";
import type { Device } from "../store/devices.js";
import type { Logger } from "../kernel/logger.js";
import type { JobTask } from "../jobs/runner.js";

export interface ApiOptions {
  readonly port: number;
  readonly host: string;
  readonly timezone: string;
  readonly principalId: string;
  readonly logger: Logger;
  /** TLS material, when serving HTTPS. */
  readonly tls?: { readonly key: string; readonly cert: string } | undefined;
  /** Directory of a built front end to serve at the root. Same origin, no CORS. */
  readonly uiRoot?: string | undefined;
  /**
   * Origins allowed to call the API from a browser.
   *
   * Only needed in development, when the UI dev server is on a different port.
   * In production the UI is served from `uiRoot` and is same origin, so this
   * stays empty and no browser other than the app can reach the API at all.
   */
  readonly allowedOrigins?: readonly string[] | undefined;
}

/**
 * CORS.
 *
 * An allow-list, never a wildcard. `*` with credentials is rejected by browsers
 * anyway, and more to the point: Harbor holds someone's entire mailbox, and any
 * page they happen to have open should not be able to read it because they once
 * paired a device.
 */
function corsHeaders(
  origin: string | undefined,
  allowed: readonly string[],
): Record<string, string> {
  if (origin === undefined || !allowed.includes(origin)) {
    return {};
  }

  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    "access-control-allow-headers": "authorization, content-type, accept",
    "access-control-max-age": "600",
    vary: "origin",
  };
}

interface Reply {
  readonly status: number;
  readonly body: unknown;
}

const ok = (body: unknown): Reply => ({ status: 200, body });
const bad = (message: string): Reply => ({ status: 400, body: { error: message } });
const missing = (message = "not found"): Reply => ({ status: 404, body: { error: message } });

/**
 * Path prefixes that belong to the API.
 *
 * Without this list, serving a front end swallows the API: an unauthenticated
 * `GET /setup` falls through to the static handler, which returns index.html
 * for any unknown path so client-side routing works. The client then gets HTML
 * where it expected a 401 and has no idea it needs to pair.
 */
export const API_PREFIXES: readonly string[] = [
  "ask",
  "audit",
  "about",
  "brief",
  "digest",
  "digests",
  "calendars",
  "conversations",
  "cost",
  "detectors",
  "coverage",
  "devices",
  "health",
  "interests",
  "items",
  "jobs",
  "nodes",
  "overview",
  "pair",
  "people",
  "policy",
  "router",
  "schedules",
  "problems",
  "search",
  "setup",
  "situations",
  "sources",
  "status",
];

function isApiPath(path: string): boolean {
  const head = path.split("/").filter((segment) => segment.length > 0)[0];
  return head !== undefined && API_PREFIXES.includes(head);
}

/**
 * Which of the three iMessage states this machine is in.
 *
 * Platform is only the answer when there is no database to look at; an explicit
 * HARBOR_IMESSAGE_DB is more informative than the operating system name.
 */
function messagesState(db: DB): Record<string, unknown> {
  if (!imessageAvailable()) {
    if (process.platform !== "darwin") {
      return {
        state: "unsupported",
        detail: "iMessage only exists on macOS, and Harbor is not running on a Mac.",
      };
    }

    return {
      state: "missing",
      path: chatDbPath(),
      detail: `No database at ${chatDbPath()}.`,
    };
  }

  try {
    const found = inspectMessages();

    return {
      state: "ready",
      path: chatDbPath(),
      messages: found.total,
      chats: found.chats.slice(0, 8),
      connected: listAccounts(db, "imessage").length > 0,
    };
  } catch {
    return {
      state: "denied",
      path: chatDbPath(),
      detail:
        "The database exists but cannot be read. Grant Full Disk Access to whatever runs " +
        "Harbor: System Settings, Privacy and Security, Full Disk Access.",
    };
  }
}

function bearer(header: string | undefined): string | null {
  if (header === undefined) {
    return null;
  }

  return /^Bearer\s+(.+)$/i.exec(header.trim())?.[1] ?? null;
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    size += (chunk as Buffer).length;

    if (size > 1_000_000) {
      throw new Error("request body too large");
    }

    chunks.push(chunk as Buffer);
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

async function embedderOrUndefined() {
  try {
    return await createEmbedder();
  } catch {
    return undefined;
  }
}

/**
 * A query parameter as a number, or the default.
 *
 * The explicit null check is the whole function. `URLSearchParams.get` returns
 * null for an absent parameter, `Number(null)` is 0, and 0 is finite, so the
 * fallback never fired and every one of these endpoints answered a request with
 * no query string as though the caller had asked for zero of everything.
 *
 * It failed silently and it failed as emptiness, which is the worst pairing
 * available: `GET /situations` returned no situations, `GET /brief` composed a
 * brief with a budget of nothing, `GET /jobs` listed no jobs. All of them look
 * exactly like a store with nothing in it, so the natural conclusion is that
 * Harbor has not found anything rather than that the query was wrong. Adding a
 * `?limit=20` made it work, which is why it survived every manual test anybody
 * ran with a URL they had typed out in full.
 */
export function number(value: unknown, fallback: number): number {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }

  const parsed = typeof value === "string" ? Number.parseInt(value, 10) : Number(value);

  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Streaming ask.
 *
 * Server-sent events rather than a websocket: one direction, trivially
 * proxyable, and every client platform has it built in.
 */
async function streamAsk(
  db: DB,
  device: Device,
  question: string,
  conversation: string | undefined,
  options: ApiOptions,
  response: ServerResponse,
  cors: Record<string, string> = {},
): Promise<void> {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    // For whatever is in front of this when Harbor is reached from a phone.
    //
    // `tailscale serve` streams correctly and does not need it. nginx buffers
    // proxied responses by default and Cloudflare Tunnel has done the same,
    // and a buffered event stream is the worst possible failure here: the
    // answer arrives complete, at the end, after the person has decided it is
    // broken. Meaningless to a proxy that does not read it, so it costs one
    // header to not care which one is there.
    "x-accel-buffering": "no",
    ...cors,
  });

  const send = (event: string, data: unknown): void => {
    response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const embedder = await embedderOrUndefined();

    const result = await ask(db, question, {
      principal: device.principalId,
      timezone: options.timezone,
      ...(embedder === undefined ? {} : { embedder }),
      ...(conversation === undefined ? {} : { conversation }),
      onToolCall: (name, input) => {
        send("tool", { name, input });
      },
    });

    send("answer", {
      answer: result.answer,
      model: result.model,
      tier: result.tier,
      evidence: result.evidence,
      withheld: result.withheld,
      redactions: result.redactions,
      costMicros: result.costMicros,
      conversationId: result.conversationId,
      continued: result.continued,
    });
  } catch (error: unknown) {
    send("error", { message: error instanceof Error ? error.message : String(error) });
  }

  send("done", {});
  response.end();
}

async function route(
  db: DB,
  device: Device,
  method: string,
  path: string,
  query: URLSearchParams,
  body: Record<string, unknown>,
  options: ApiOptions,
): Promise<Reply> {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  const head = segments[0] ?? "";
  const writable = device.scopes.includes("act");

  // ---- setup and health ----

  if (method === "GET" && head === "setup") {
    return ok(setupState(db, device.principalId));
  }

  if (method === "GET" && head === "problems") {
    return ok({ problems: problems(db, device.principalId) });
  }

  if (method === "GET" && head === "status") {
    return ok(systemStatus(db, device.principalId));
  }

  /**
   * Everything a client needs to draw itself, in one call.
   *
   * The page polls this and nothing else. Six endpoints polled separately give
   * six instants and a screen that contradicts itself the moment a job
   * finishes.
   */
  if (method === "GET" && head === "overview") {
    return ok(overview(db, device.principalId));
  }

  if (method === "GET" && head === "coverage") {
    return ok({
      byKind: coverageByKind(db, device.principalId),
      // How far each source has actually been read. Onboarding shows the recent
      // pass; this is what says the history is still arriving.
      streams: listStreams(db).map((stream) => ({
        id: stream.id,
        connector: stream.connectorId,
        recentDone: stream.recentDone,
        historicalDone: stream.historicalDone,
        oldestReached: stream.oldestReached,
        lastSyncAt: stream.lastSyncAt,
      })),
    });
  }

  // ---- jobs ----

  if (head === "jobs") {
    if (method === "GET" && segments.length === 1) {
      return ok({
        jobs: listJobs(db, number(query.get("limit"), 20)),
        // What a client may start right now, and what is stopping it. Without
        // this the UI has to guess, and guessing means offering buttons that
        // quietly do less than they claim.
        availability: taskAvailability(db),
      });
    }

    if (method === "POST" && segments[1] !== undefined && segments[2] === "cancel") {
      if (segments[1] === "all") {
        return ok({ stopped: stopAll(db, body["force"] === true) });
      }

      return ok(stop(db, segments[1], body["force"] === true));
    }

    if (method === "GET" && segments[1] !== undefined) {
      const job = getJob(db, segments[1]);
      return job === null ? missing(`no job ${segments[1]}`) : ok(job);
    }

    if (method === "POST" && segments.length === 1) {
      const task = body["task"];

      if (typeof task !== "string" || !JOB_TASKS.includes(task as JobTask)) {
        return bad(`task must be one of: ${JOB_TASKS.join(", ")}`);
      }

      const started = enqueue(
        db,
        task as JobTask,
        {
          principalId: device.principalId,
          timezone: options.timezone,
          ...(typeof body["source"] === "string" ? { target: body["source"] } : {}),
        },
        device.id,
      );

      return ok({
        job: started.job,
        alreadyRunning: !started.started && started.blocked === null,
        blocked: started.blocked,
      });
    }
  }

  // ---- sources ----

  if (head === "sources") {
    if (method === "GET" && segments.length === 1) {
      return ok({
        accounts: listAccounts(db).map((account) => ({
          id: account.id,
          label: account.label,
          sourceType: account.sourceType,
        })),
      });
    }

    // Read-only probes, before the write gate.
    //
    // Discovering a mail server and checking whether iMessage is readable are
    // both questions, not changes, and gating them behind write scope meant a
    // read-only device could not even see what it might connect. Worse, the
    // client rendered the resulting 403 as "could not work out the server",
    // which sends someone to debug their email provider over a permissions bug.
    if (method === "GET" && segments[1] === "imap") {
      const address = query.get("address");

      if (address === null || !address.includes("@")) {
        return bad("address is required");
      }

      const settings = await discoverImap(address);

      return ok({
        host: settings.host,
        port: settings.port,
        secure: settings.secure,
        source: settings.source,
        note: settings.note ?? null,
      });
    }

    if (method === "GET" && segments[1] === "imessage") {
      return ok(messagesState(db));
    }

    if (!writable) {
      return { status: 403, body: { error: "this device may not change sources" } };
    }

    /**
     * Google, from a browser on the same machine as Harbor.
     *
     * The loopback flow needs the browser and the daemon to share a machine,
     * which is the normal case for someone running Harbor on their own Mac and
     * opening the UI there. It needs no redirect URI registered beyond what the
     * Desktop client type already allows, so it is the path that works with
     * zero setup.
     *
     * Blocking on purpose: the whole thing takes as long as a person takes to
     * click Allow, and a job would only add a polling loop around a wait.
     */
    if (method === "POST" && segments[1] === "google" && segments[2] === "local") {
      // The daemon has no browser of its own, so the URL is logged for whoever
      // is watching the process. On the same machine the platform opener that
      // `authorize` uses will already have taken care of it.
      const flow = await authorize((url) => {
        options.logger.print(`Authorize Google at: ${url}`);
      });

      const profile = (await (
        await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
          headers: { authorization: `Bearer ${flow.accessToken}` },
        })
      ).json()) as { emailAddress?: string };

      const account = saveAccount(db, {
        sourceType: "google",
        label: profile.emailAddress ?? "google",
        credentials: flow,
      });

      return ok({ account: { id: account.id, label: account.label } });
    }

    if (method === "POST" && segments[1] === "google" && segments[2] === "start") {
      /**
       * The redirect comes back to Harbor itself.
       *
       * A Desktop OAuth client accepts any loopback port and path, which is the
       * whole reason this works with nothing registered: Google will redirect to
       * `http://127.0.0.1:8484/sources/google/callback` because it is loopback,
       * not because anyone told it to. The CLI already relied on that for its
       * own listener; this points it at the daemon instead, so the browser can
       * be anywhere on the machine rather than the one the CLI spawned.
       */
      const redirectUri =
        typeof body["redirectUri"] === "string" && body["redirectUri"].length > 0
          ? (body["redirectUri"] as string)
          : `http://127.0.0.1:${String(options.port)}/sources/google/callback`;

      const flow = begin(db, redirectUri);

      return ok({
        ...flow,
        redirectUri,
        loopback: redirectUri.startsWith("http://127.0.0.1"),
        note: redirectUri.startsWith("http://127.0.0.1")
          ? "Finish sign-in in the browser on the machine running Harbor. Google only " +
            "redirects to loopback, so this cannot complete from a phone."
          : undefined,
      });
    }

    if (method === "POST" && segments[1] === "google" && segments[2] === "complete") {
      const state = body["state"];
      const code = body["code"];

      if (typeof state !== "string" || typeof code !== "string") {
        return bad("state and code are required");
      }

      const credentials = await complete(db, state, code);

      // Identity comes from the token, not from the client, so a caller cannot
      // attach someone else's mailbox by lying about the label.
      const profile = (await (
        await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
          headers: { authorization: `Bearer ${credentials.accessToken}` },
        })
      ).json()) as { emailAddress?: string };

      const account = saveAccount(db, {
        sourceType: "google",
        label: profile.emailAddress ?? "google",
        credentials,
      });

      return ok({ account: { id: account.id, label: account.label } });
    }

    if (method === "POST" && segments[1] === "imessage") {
      if (!writable) {
        return { status: 403, body: { error: "this device may not change sources" } };
      }

      if (!imessageAvailable()) {
        return bad(`No iMessage database at ${chatDbPath()}`);
      }

      const found = inspectMessages();

      const account = saveAccount(db, {
        sourceType: "imessage",
        label: "iMessage",
        credentials: { accessToken: "", refreshToken: "", expiresAt: 0, scope: "local" },
      });

      return ok({
        account: { id: account.id, label: account.label },
        messages: found.total,
        chats: found.chats.slice(0, 8),
      });
    }

    /**
     * The Google callback.
     *
     * Completes a flow the app started, so the redirect can land on the box
     * rather than needing a loopback listener next to the browser. The URI has
     * to be registered on the Google client, which is the one step this cannot
     * remove.
     */


    // Two steps, so the client can show the discovered server before asking for
    // a password: nobody should type a credential into a form that has not yet
    // said where it is going.
    if (method === "POST" && segments[1] === "imap") {
      if (!writable) {
        return { status: 403, body: { error: "this device may not change sources" } };
      }

      const address = body["address"];
      const password = body["password"];

      if (typeof address !== "string" || typeof password !== "string") {
        return bad("address and password are required");
      }

      const settings = await discoverImap(address);
      const host = typeof body["host"] === "string" ? body["host"] : settings.host;
      const port = typeof body["port"] === "number" ? body["port"] : settings.port;

      const credential = { host, port, secure: port === 993, user: address, pass: password };

      // Proved before it is stored, so a wrong password fails here with a
      // readable message rather than three commands later inside a sync.
      const found = await probeImap(credential);

      const account = saveAccount(db, {
        sourceType: "imap",
        label: address,
        credentials: {
          accessToken: packCredential(credential),
          refreshToken: "",
          expiresAt: 0,
          scope: "imap",
        },
      });

      return ok({
        account: { id: account.id, label: account.label },
        messages: found.total,
        folders: found.folders.slice(0, 10),
      });
    }

    if (method === "POST" && segments[1] === "apple") {
      const appleId = body["appleId"];
      const appPassword = body["appPassword"];

      if (typeof appleId !== "string" || typeof appPassword !== "string") {
        return bad("appleId and appPassword are required");
      }

      const found = await discover({ appleId, appPassword });

      const account = saveAccount(db, {
        sourceType: "apple",
        label: appleId,
        credentials: {
          accessToken: basicAuth({ appleId, appPassword }).replace(/^Basic /, ""),
          refreshToken: "",
          expiresAt: 0,
          scope: "caldav carddav",
        },
      });

      return ok({
        account: { id: account.id, label: account.label },
        calendars: found.calendars.map((calendar) => calendar.displayName),
        addressBooks: found.addressBooks.map((book) => book.displayName),
      });
    }
  }

  // ---- retrieval ----

  if (method === "GET" && head === "search") {
    const text = query.get("q") ?? undefined;
    const embedder = text === undefined ? undefined : await embedderOrUndefined();

    const vector =
      embedder === undefined || text === undefined
        ? undefined
        : (await embedder.embed([text]))[0];

    const kinds = query.get("kinds")?.split(",").filter((kind) => kind.length > 0);

    const hits = search(
      db,
      {
        principal: device.principalId,
        ...(text === undefined ? {} : { query: text }),
        ...(kinds === undefined || kinds.length === 0 ? {} : { kinds }),
        ...(query.get("person") === null ? {} : { personId: query.get("person") as string }),
        ...(query.get("since") === null
          ? {}
          : { since: Date.parse(query.get("since") as string) }),
        ...(query.get("until") === null
          ? {}
          : { until: Date.parse(query.get("until") as string) }),
        ...(query.get("order") === "oldest" ? { order: "oldest" as const } : {}),
        limit: number(query.get("limit"), 20),
      },
      embedder,
      vector,
    );

    return ok({
      count: hits.length,
      results: hits.map((hit) => ({
        id: hit.item.id,
        kind: hit.item.kind,
        title: hit.item.title,
        from: hit.item.author,
        when: humanWhen(hit.item.occurredAt, options.timezone),
        whenIso: localIso(hit.item.occurredAt, options.timezone),
        until:
          hit.item.endsAt === null ? null : localIso(hit.item.endsAt, options.timezone),
        snippet: (hit.item.snippet ?? "").slice(0, 300),
        link: hit.item.uri,
        score: hit.score,
        reasons: hit.reasons,
      })),
    });
  }

  // The verbatim source payload. Under the same gate as everything else: an
  // item policy withholds does not become readable by asking for it raw.
  if (method === "GET" && head === "items" && segments[2] === "raw") {
    const id = segments[1];

    if (id === undefined) {
      return missing();
    }

    const outcome = await runTool(
      db,
      { principal: device.principalId, timezone: options.timezone },
      { name: "get_item", input: { id } },
    );

    if (outcome.isError) {
      return missing();
    }

    const parsed = JSON.parse(outcome.content) as Record<string, unknown>;

    if (parsed["withheld"] === true) {
      return { status: 403, body: { error: "policy withholds this item" } };
    }

    return ok({ id, raw: readRaw(db, id) });
  }

  if (method === "GET" && head === "items" && segments[1] !== undefined) {
    const item = getItem(db, segments[1]);

    if (item === null) {
      return missing();
    }

    return ok({
      id: item.id,
      kind: item.kind,
      title: item.title,
      from: item.author,
      with: item.participants,
      when: localIso(item.occurredAt, options.timezone),
      link: item.uri,
      body: item.body,
    });
  }

  // ---- people ----

  if (head === "people") {
    if (method === "GET" && segments.length === 1) {
      const q = query.get("q");
      const limit = number(query.get("limit"), 25);

      const people = q === null ? topEntities(db, limit) : lookupEntities(db, q, limit);

      return ok({
        people: people.map((entry) => ({
          id: entry.entity.id,
          name: entry.entity.displayName,
          kind: entry.entity.kind,
          pinned: entry.entity.pinned,
          addresses: entry.addresses,
          aliases: entry.aliases,
          items: entry.items,
          received: entry.received,
          sent: entry.sent,
          lastSeen:
            entry.lastSeen === null ? null : localIso(entry.lastSeen, options.timezone),
        })),
      });
    }

    if (method === "GET" && segments[1] !== undefined) {
      const found = lookupEntities(db, segments[1], 1)[0];

      if (found === undefined) {
        return missing();
      }

      return ok({
        id: found.entity.id,
        name: found.entity.displayName,
        kind: found.entity.kind,
        items: found.items,
        identifiers: identifiersFor(db, found.entity.id),
      });
    }

    if (method === "POST" && segments[1] !== undefined && segments[2] === "merge") {
      if (!writable) {
        return { status: 403, body: { error: "this device may not edit people" } };
      }

      const into = body["into"];

      if (typeof into !== "string") {
        return bad("into is required");
      }

      mergeEntities(db, segments[1], into);
      return ok({ merged: segments[1], into });
    }

    if (method === "POST" && segments[1] !== undefined && segments[2] === "unlink") {
      if (!writable) {
        return { status: 403, body: { error: "this device may not edit people" } };
      }

      const address = body["address"];

      if (typeof address !== "string") {
        return bad("address is required");
      }

      const split = unlinkIdentifier(db, "email", address.trim().toLowerCase());
      return split === null ? missing(`no identifier for ${address}`) : ok({ entity: split });
    }

    if (method === "POST" && segments[1] !== undefined && segments[2] === "rename") {
      if (!writable) {
        return { status: 403, body: { error: "this device may not edit people" } };
      }

      const name = body["name"];

      if (typeof name !== "string" || name.trim().length === 0) {
        return bad("name is required");
      }

      pinEntity(db, segments[1], name.trim());
      return ok({ id: segments[1], name: name.trim() });
    }
  }

  // ---- situations ----

  /**
   * One situation, with why each thing is in it.
   *
   * The evidence is the point. A situation is a claim Harbor made about your
   * life, assembled by rules you did not write, and the difference between that
   * being useful and being unsettling is whether you can see what it was
   * reading. `harbor why` has always printed this; nothing but a terminal could
   * reach it.
   *
   * Links are restricted to pairs where both ends are inside the situation.
   * `connectionsFor` returns every edge a node has, and half of them point at
   * things that are not on screen, which reads as evidence for a claim nobody
   * made.
   */
  if (method === "GET" && head === "situations" && segments[1] !== undefined) {
    const thread = getThread(db, segments[1]);

    if (thread === null || thread.principalId !== device.principalId) {
      return missing();
    }

    const refs = threadNodes(db, thread.id);
    const inside = new Set(refs.map((ref) => nodeKey(ref)));
    const resolver = new NodeResolver(db);

    const members = refs.flatMap((ref) => {
      const node = resolver.node(ref);

      if (node === null) {
        return [];
      }

      const stream = getStream(db, node.streamId);

      return [
        {
          ref: nodeKey(ref),
          kind: node.kind,
          source: stream?.connectorId ?? "unknown",
          // A resolved name, not a handle. `+15551230001` makes somebody go and
          // look up who that is, which is work Harbor already did when it
          // resolved the entity.
          title: nameHandles(db, node.title ?? "") || null,
          // Enough to recognise the thing, not enough to be a reader. The
          // detail view is for understanding why it is here; reading it is
          // what asking about it is for.
          preview: nameTranscript(db, node.text).slice(0, 240),
          when: humanWhen(node.occurredAt, options.timezone),
          at: node.occurredAt,
        },
      ];
    });

    const links = refs.flatMap((ref) =>
      connectionsFor(db, ref)
        .filter((connection) => inside.has(nodeKey(connection.to)))
        .map((connection) => ({
          from: nodeKey(ref),
          to: nodeKey(connection.to),
          kind: connection.kind,
          confidence: connection.confidence,
          evidence: connection.evidence,
          also: connection.also,
        })),
    );

    return ok({
      id: thread.id,
      title: thread.title,
      summary: thread.summary,
      titleSource: thread.titleSource,
      kind: thread.kind,
      state: thread.state,
      startsAt: thread.startsAt,
      endsAt: thread.endsAt,
      itemCount: thread.itemCount,
      sourceCount: thread.sourceCount,
      sources: [...new Set(members.map((member) => member.source))],
      members,
      links,
    });
  }


  if (method === "GET" && head === "situations") {
    const days = number(query.get("days"), 0);

    const found = topThreads(db, device.principalId, {
      limit: number(query.get("limit"), 12),
      minSources: 2,
      ...(days > 0 ? { since: Date.now() - days * 86_400_000 } : {}),
    });

    return ok({
      situations: found.map((thread) => ({
        id: thread.id,
        title: thread.title,
        summary: thread.summary,
        kind: thread.kind,
        startsAt: thread.startsAt,
        endsAt: thread.endsAt,
        itemCount: thread.itemCount,
        sourceCount: thread.sourceCount,
        items: threadItemIds(db, thread.id).flatMap((id) => {
          const item = getItem(db, id);

          return item === null
            ? []
            : [
                {
                  id: item.id,
                  kind: item.kind,
                  title: nameHandles(db, item.title ?? "") || null,
                  when: humanWhen(item.occurredAt, options.timezone),
                },
              ];
        }),
      })),
    });
  }

  /**
   * The contents of one node in a situation.
   *
   * Reading is the point of the drill-down. Knowing that a conversation is in a
   * situation and why is half an answer; the other half is what was actually
   * said, and until now that meant `harbor find` in a terminal.
   *
   * Two shapes behind one route, because the caller has a node reference and
   * should not have to know that some of them are conversations. An episode
   * returns its messages with speakers named; an item returns its body.
   */
  if (method === "GET" && head === "nodes" && segments[1] !== undefined) {
    const [kind, id] = [segments[1], segments[2]];

    if (id === undefined || (kind !== "item" && kind !== "episode")) {
      return missing();
    }

    if (kind === "item") {
      const item = getItem(db, id);

      if (item === null) {
        return missing();
      }

      return ok({
        kind: "item",
        id: item.id,
        title: nameHandles(db, item.title ?? "") || null,
        from: item.author === null ? null : nameHandles(db, item.author),
        when: humanWhen(item.occurredAt, options.timezone),
        body: nameTranscript(db, item.body ?? ""),
      });
    }

    const episode = getEpisode(db, id);

    if (episode === null) {
      return missing();
    }

    const messages = episodeItems(db, id).flatMap((itemId) => {
      const item = getItem(db, itemId);

      return item === null
        ? []
        : [
            {
              id: item.id,
              // Outbound is the only one worth naming specially. Everything
              // else is somebody, and who it is is what the entity layer knows.
              from:
                item.direction === "outbound"
                  ? "You"
                  : nameHandles(db, item.author ?? "") || "Unknown",
              when: humanWhen(item.occurredAt, options.timezone),
              text: nameTranscript(db, item.body ?? ""),
            },
          ];
    });

    return ok({
      kind: "episode",
      id: episode.id,
      title: nameHandles(db, episode.title ?? "") || null,
      when: humanWhen(episode.startsAt, options.timezone),
      messages,
    });
  }

  // ---- conversations ----

  if (head === "conversations") {
    if (method === "GET" && segments.length === 1) {
      return ok({
        conversations: listConversations(db, device.principalId, number(query.get("limit"), 20)),
      });
    }

    if (method === "GET" && segments[1] !== undefined) {
      const conversation = getConversation(db, segments[1]);

      if (conversation === null) {
        return missing();
      }

      return ok({ conversation, turns: allTurns(db, conversation.id) });
    }

    if (method === "DELETE" && segments[1] !== undefined) {
      return ok({ forgotten: deleteConversation(db, segments[1]) });
    }
  }

  // ---- signals ----

  if (method === "GET" && head === "brief") {
    const brief = composeBrief(db, {
      principalId: device.principalId,
      timezone: options.timezone,
      budget: number(query.get("budget"), 3),
      // A client peeking must not consume the suppression that stops the user
      // being told the same thing twice.
      preview: query.get("consume") !== "true",
    });

    return ok({
      text: renderBrief(brief),
      withheld: brief.withheld,
      entries: brief.entries.map((entry) => ({
        id: entry.observation.id,
        detector: entry.observation.detectorId,
        summary: entry.observation.title,
        detail: entry.observation.detail,
        salience: entry.observation.salience,
        evidence: entry.evidence,
      })),
    });
  }

  // The phone surface. A digest is composed on a schedule and stored, so this
  // reads what was already said rather than composing on request: a client
  // polling must never be able to consume the suppression, and two devices
  // opening Harbor should see the same digest rather than two different ones.
  if (method === "GET" && head === "digest") {
    const digest = latestDigest(db, device.principalId);

    if (digest === null) {
      return ok({ digest: null, note: "Nothing said yet." });
    }

    return ok({
      digest: {
        id: digest.id,
        at: digest.createdAt,
        text: digest.text,
        entries: digest.entryCount,
        delivered: digest.deliveredAt !== null,
      },
    });
  }

  if (method === "GET" && head === "digests") {
    return ok({
      digests: recentDigests(db, device.principalId, 10).map((digest) => ({
        id: digest.id,
        at: digest.createdAt,
        entries: digest.entryCount,
        delivered: digest.deliveredAt !== null,
      })),
    });
  }

  if (method === "POST" && head === "brief" && segments[2] === "dismiss") {
    const id = segments[1];

    if (id === undefined) {
      return missing();
    }

    const entry = composeBrief(db, {
      principalId: device.principalId,
      timezone: options.timezone,
      budget: 50,
      preview: true,
    }).entries.find((candidate) => candidate.observation.id === id);

    if (entry === undefined) {
      return missing(`no pending observation ${id}`);
    }

    dismissObservation(db, id, entry.observation.detectorId);
    return ok({ id, state: "dismissed" });
  }

  if (head === "interests") {
    if (method === "GET") {
      return ok({ interests: listInterests(db, device.principalId) });
    }

    if (method === "POST" && segments.length === 1) {
      const statement = body["statement"];

      if (typeof statement !== "string" || statement.trim().length === 0) {
        return bad("statement is required");
      }

      const record = addInterest(db, {
        principalId: device.principalId,
        statement: statement.trim(),
      });

      const embedder = await embedderOrUndefined();

      if (embedder !== undefined) {
        const vector = (await embedder.embed([statement.trim()]))[0];

        if (vector !== undefined) {
          saveInterestEmbedding(db, record.id, embedder.model, toBlob(vector));
        }
      }

      return ok({ interest: record, matchable: embedder !== undefined });
    }

    if (method === "DELETE" && segments[1] !== undefined) {
      setInterestState(db, segments[1], "dismissed");
      return ok({ id: segments[1], state: "dismissed" });
    }
  }

  // ---- policy ----

  if (head === "policy") {
    if (method === "GET") {
      return ok({ rules: listRules(db, query.get("all") === "true") });
    }

    // Changing what may leave the machine is not a read-only act.
    if (!writable) {
      return { status: 403, body: { error: "this device may not change policy" } };
    }

    if (method === "POST" && segments.length === 1) {
      const id = body["id"];
      const egress = body["egress"];

      if (typeof id !== "string" || id.trim().length === 0) {
        return bad("id is required");
      }

      if (egress !== "local_only" && egress !== "redacted" && egress !== "allowed") {
        return bad("egress must be local_only, redacted, or allowed");
      }

      addRule(db, {
        id: id.trim(),
        priority: number(body["priority"], 100),
        egress: egress as Egress,
        ...(typeof body["sensitivity"] === "string"
          ? { matchSensitivity: body["sensitivity"] as "normal" | "sensitive" | "restricted" }
          : {}),
        ...(typeof body["kind"] === "string" ? { matchKind: body["kind"] } : {}),
        ...(typeof body["entity"] === "string" ? { matchEntity: body["entity"] } : {}),
        ...(typeof body["pattern"] === "string" ? { matchPattern: body["pattern"] } : {}),
        ...(typeof body["note"] === "string" ? { note: body["note"] } : {}),
      });

      return ok({ rules: listRules(db, true) });
    }

    if (method === "POST" && segments[1] !== undefined && segments[2] === "enabled") {
      setRuleEnabled(db, segments[1], body["enabled"] !== false);
      return ok({ rules: listRules(db, true) });
    }

    if (method === "DELETE" && segments[1] !== undefined) {
      return ok({ removed: removeRule(db, segments[1]), rules: listRules(db, true) });
    }
  }

  // ---- detectors ----

  if (head === "detectors") {
    if (method === "GET") {
      return ok({ detectors: detectorStats(db) });
    }

    if (!writable) {
      return { status: 403, body: { error: "this device may not change detectors" } };
    }

    if (method === "POST" && segments[1] !== undefined) {
      setDetectorSuppressed(db, segments[1], body["enabled"] === false);
      return ok({ detectors: detectorStats(db) });
    }
  }

  // ---- schedules ----

  if (head === "schedules") {
    if (method === "GET") {
      return ok({
        schedules: listSchedules(db),
        tasks: SCHEDULABLE,
        connectors: CONNECTORS.map((connector) => ({ id: connector.id, label: connector.label })),
      });
    }

    if (!writable) {
      return { status: 403, body: { error: "this device may not change schedules" } };
    }

    if (method === "POST" && segments.length === 1) {
      const task = body["task"];

      if (typeof task !== "string" || !SCHEDULABLE.includes(task as ScheduledTask)) {
        return bad(`task must be one of: ${SCHEDULABLE.join(", ")}`);
      }

      const every = body["everyMinutes"];
      const at = typeof body["at"] === "string" ? (body["at"] as string).split(":") : null;

      if (every === undefined && at === null) {
        return bad("give everyMinutes or at (HH:MM)");
      }

      const record = addSchedule(db, {
        principalId: device.principalId,
        task: task as ScheduledTask,
        timezone: options.timezone,
        ...(typeof body["target"] === "string" ? { target: body["target"] } : {}),
        ...(typeof every === "number" ? { intervalMinutes: every } : {}),
        ...(at === null
          ? {}
          : {
              atHour: number(at[0], 7),
              atMinute: number(at[1], 0),
            }),
      });

      return ok({ schedule: record, schedules: listSchedules(db) });
    }

    if (method === "POST" && segments[1] !== undefined && segments[2] === "enabled") {
      setScheduleEnabled(db, segments[1], body["enabled"] !== false);
      return ok({ schedules: listSchedules(db) });
    }

    if (method === "DELETE" && segments[1] !== undefined) {
      return ok({ removed: removeSchedule(db, segments[1]), schedules: listSchedules(db) });
    }
  }

  // ---- routing ----

  if (method === "GET" && head === "router") {
    return ok({ taskClasses: TASK_CLASSES, quality: qualityStats(db) });
  }

  if (method === "GET" && head === "about") {
    return ok(capabilities(db));
  }

  // ---- calendars ----

  if (method === "GET" && head === "calendars") {
    const found: { account: string; source: string; name: string; kind: string }[] = [];

    for (const account of listAccounts(db, "google")) {
      const credential = await credentialFor(db, account);

      for (const calendar of await listCalendars(credential.token)) {
        found.push({
          account: account.label,
          source: "google",
          name: calendar.summary ?? calendar.id,
          kind: "calendar",
        });
      }
    }

    for (const account of listAccounts(db, "apple")) {
      const discovery = await discoverWith(`Basic ${account.credentials.accessToken}`);

      for (const calendar of discovery.calendars) {
        found.push({
          account: account.label,
          source: "apple",
          name: calendar.displayName,
          kind: "calendar",
        });
      }

      for (const notebook of discovery.addressBooks) {
        found.push({
          account: account.label,
          source: "apple",
          name: notebook.displayName,
          kind: "contacts",
        });
      }
    }

    return ok({ collections: found });
  }

  // ---- transparency ----

  if (method === "GET" && head === "audit") {
    const days = number(query.get("days"), 30);
    const since = Date.now() - days * 86_400_000;

    return ok({
      summary: egressSince(db, since),
      entries: recent(db, number(query.get("limit"), 20)),
    });
  }

  if (method === "GET" && head === "cost") {
    const days = number(query.get("days"), 30);
    return ok({ spend: spend(db, Date.now() - days * 86_400_000) });
  }

  // ---- devices ----

  if (head === "devices") {
    if (method === "GET") {
      return ok({ devices: listDevices(db) });
    }

    if (!writable) {
      return { status: 403, body: { error: "this device may not manage devices" } };
    }

    if (method === "POST" && segments[1] === "code") {
      return ok(
        issueCode(db, {
          principalId: device.principalId,
          scopes: body["act"] === true ? ["read", "act"] : ["read"],
          ...(typeof body["label"] === "string" ? { label: body["label"] } : {}),
        }),
      );
    }

    if (method === "DELETE" && segments[1] !== undefined) {
      return ok({ revoked: revokeDevice(db, segments[1]) });
    }
  }

  return missing();
}

export function startApi(db: DB, options: ApiOptions): Server {
  const allowed = options.allowedOrigins ?? [];

  const handler = (request: IncomingMessage, response: ServerResponse): void => {
    void (async () => {
      const cors = corsHeaders(request.headers.origin, allowed);

      const send = (status: number, body: unknown): void => {
        const payload = JSON.stringify(body);
        response.writeHead(status, {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(payload)),
          ...cors,
        });
        response.end(payload);
      };

      const url = new URL(request.url ?? "/", "http://local");
      const path = url.pathname;
      const method = request.method ?? "GET";

      if (method === "OPTIONS") {
        response.writeHead(Object.keys(cors).length > 0 ? 204 : 403, cors);
        response.end();
        return;
      }

      // Unauthenticated on purpose: a supervisor needs to know the process is
      // alive without holding a credential, and this leaks nothing.
      if (method === "GET" && path === "/health") {
        send(200, { ok: true, at: new Date().toISOString() });
        return;
      }

      /**
       * The OAuth callback, unauthenticated by necessity.
       *
       * Google redirects a browser here and that browser carries no device
       * token. Safe because the `state` value was minted by this process and is
       * single use: without it the request is refused, and with it the flow was
       * already started by an authenticated client.
       */
      if (method === "GET" && path === "/sources/google/callback") {
        const query = url.searchParams;
        const state = query.get("state");
        const code = query.get("code");
        const error = query.get("error");

        const page = (title: string, detail: string): void => {
          const body = `<!doctype html><meta charset="utf-8">
<title>Harbor</title>
<style>
  body { font: 16px/1.6 ui-sans-serif, system-ui, sans-serif; background: #f5f3ef;
         color: #24221f; display: grid; place-items: center; height: 100vh; margin: 0; }
  main { max-width: 26rem; padding: 2rem; text-align: center; }
  h1 { font-size: 1.3rem; margin: 0 0 .5rem; }
  p { color: #6f6a63; margin: 0; }
</style>
<main><h1>${title}</h1><p>${detail}</p></main>`;

          response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          response.end(body);
        };

        if (error !== null) {
          page("Sign-in cancelled", "Nothing was connected. You can close this tab.");
          return;
        }

        if (state === null || code === null) {
          page("Something went wrong", "That link was missing information. Try again from Harbor.");
          return;
        }

        try {
          const credentials = await complete(db, state, code);

          const profile = (await (
            await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
              headers: { authorization: `Bearer ${credentials.accessToken}` },
            })
          ).json()) as { emailAddress?: string };

          const account = saveAccount(db, {
            sourceType: "google",
            label: profile.emailAddress ?? "google",
            credentials,
          });

          page("Connected", `${account.label} is now connected. You can close this tab.`);
        } catch (cause: unknown) {
          page(
            "Could not finish",
            cause instanceof Error ? cause.message : "Google rejected the sign-in.",
          );
        }

        return;
      }

      // Also unauthenticated, because the whole point is that the caller has no
      // credential yet. The code is the credential, and it is single use.
      if (method === "POST" && path === "/pair") {
        try {
          const body = await readBody(request);
          const code = body["code"];
          const name = body["deviceName"];

          if (typeof code !== "string" || typeof name !== "string") {
            send(400, { error: "code and deviceName are required" });
            return;
          }

          const result = redeem(db, code, name);

          if (!result.ok || result.device === undefined) {
            send(401, { error: result.reason ?? "pairing failed" });
            return;
          }

          send(200, {
            token: result.device.token,
            device: result.device.device,
          });
        } catch (error: unknown) {
          send(400, { error: error instanceof Error ? error.message : "bad request" });
        }

        return;
      }

      // The app itself, before any credential check.
      //
      // It used to be served only on the unauthenticated path, which meant a
      // browser that had already paired asked for `/` and got a 404: the token
      // was present, `/` is not an API path, and nothing else claimed it. The
      // bundle is not secret, and the data behind it still needs a token.
      if (
        method === "GET" &&
        !isApiPath(path) &&
        serveStatic({ root: options.uiRoot ?? builtinUiRoot() }, path, response).handled
      ) {
        return;
      }

      const token = bearer(request.headers.authorization);

      if (token === null) {
        send(401, { error: "bearer token required" });
        return;
      }

      try {
        // Inside the try, not before it.
        //
        // This used to sit outside, so a transient SQLITE_BUSY while another
        // process held the write lock threw from the request handler and took
        // the whole daemon down. A long-running background job contending with
        // an HTTP request is normal operation, not a fatal condition, and the
        // correct response is a 503 the client can retry.
        const device = authenticate(db, token);

        if (device === null) {
          send(401, { error: "unknown or revoked token" });
          return;
        }

        const body =
          method === "POST" || method === "PUT"
            ? await readBody(request)
            : ({} as Record<string, unknown>);

        if (method === "POST" && path === "/ask") {
          const question = body["question"];

          if (typeof question !== "string" || question.trim().length === 0) {
            send(400, { error: "question is required" });
            return;
          }

          const thread =
            typeof body["conversationId"] === "string"
              ? (body["conversationId"] as string)
              : undefined;

          if ((request.headers.accept ?? "").includes("text/event-stream")) {
            await streamAsk(db, device, question, thread, options, response, cors);
            return;
          }

          const embedder = await embedderOrUndefined();

          const result = await ask(db, question, {
            principal: device.principalId,
            timezone: options.timezone,
            ...(embedder === undefined ? {} : { embedder }),
            ...(thread === undefined ? {} : { conversation: thread }),
          });

          send(200, {
            answer: result.answer,
            model: result.model,
            tier: result.tier,
            evidence: result.evidence,
            withheld: result.withheld,
            redactions: result.redactions,
            costMicros: result.costMicros,
            conversationId: result.conversationId,
            continued: result.continued,
          });
          return;
        }

        const reply = await route(db, device, method, path, url.searchParams, body, options);
        send(reply.status, reply.body);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        const busy = /SQLITE_BUSY|database is locked/i.test(message);

        options.logger.error(`api ${method} ${path}: ${message}`);

        send(busy ? 503 : 500, {
          error: busy
            ? "Harbor is busy writing; try again in a moment"
            : message,
          ...(busy ? { retryable: true } : {}),
        });
      }
    })();
  };

  // HTTPS when TLS material is supplied. Same handler either way; the only
  // difference is whether a token can be read off the wire by the router.
  const server =
    options.tls === undefined
      ? createServer(handler)
      : (createSecureServer({ key: options.tls.key, cert: options.tls.cert }, handler) as unknown as Server);

  // A port collision is an ordinary thing that happens (a daemon already
  // running, a stale one from before a wipe, something else on 8484), and it
  // used to surface as an unhandled 'error' event: a Node stack trace with no
  // indication of what to do. Handled here so the daemon says what is wrong.
  server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EADDRINUSE") {
      throw error;
    }

    process.stderr.write(
      `\nSomething is already listening on ${options.host}:${String(options.port)}.\n` +
        `\nIf it is another Harbor daemon, that one is doing the work and this one is\n` +
        `not needed. If it is a daemon left over from before a database wipe, it is\n` +
        `holding a store that no longer exists and should be stopped:\n` +
        `\n  lsof -nP -iTCP:${String(options.port)} -sTCP:LISTEN\n` +
        `  kill <pid>\n` +
        `\nOr run this one elsewhere: harbor daemon --port ${String(options.port + 1)}\n\n`,
    );

    process.exit(1);
  });

  server.listen(options.port, options.host);

  return server;
}
