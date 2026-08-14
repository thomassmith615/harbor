/**
 * What Harbor is, in terms a model can relay.
 *
 * Asked "what are you connected to", the model previously said it had no way to
 * find out, which was true and embarrassing: Harbor knows exactly what it is
 * connected to and simply never told it.
 *
 * Two halves, deliberately separated by cost. The connected-sources summary is
 * short and true of this install, so it goes in the system prompt and costs one
 * line on every call. The capability and command catalog is long and rarely
 * needed, so it sits behind a tool.
 */
import { listAccounts } from "../store/accounts.js";
import { listStreams } from "../store/streams.js";
import { CONNECTORS } from "../connectors/registry.js";
import { ACTIONS } from "../actions/registry.js";
import type { DB } from "../kernel/db.js";

export interface ConnectedSource {
  readonly account: string;
  readonly sourceType: string;
  readonly connector: string;
  readonly reads: readonly string[];
  readonly lastSync: number | null;
}

export function connectedSources(db: DB): readonly ConnectedSource[] {
  const sources: ConnectedSource[] = [];

  for (const account of listAccounts(db)) {
    for (const stream of listStreams(db, account.id)) {
      const connector = CONNECTORS.find((entry) => entry.id === stream.connectorId);

      sources.push({
        account: account.label,
        sourceType: account.sourceType,
        connector: connector?.label ?? stream.connectorId,
        reads: connector?.kinds ?? [],
        lastSync: stream.lastSyncAt,
      });
    }
  }

  return sources;
}

/** One line for the system prompt. Cheap enough to send every time. */
export function sourceSummary(db: DB): string {
  const all = availableSources(db);
  const on = all.filter((source) => source.connected);
  const off = all.filter((source) => !source.connected);

  const connected =
    on.length === 0
      ? "No sources are connected yet, so the store is empty."
      : `Connected: ${connectedSources(db)
          .map((source) => `${source.connector} (${source.account})`)
          .join(", ")}.`;

  // Naming what is missing matters as much as naming what is there. Told only
  // what it has, a model asked about a source it lacks will invent a way to add
  // it.
  const missing =
    off.length === 0
      ? ""
      : ` Supported but not connected: ${off.map((source) => source.name).join(", ")}. ` +
        "Call about_harbor for how to connect any of them; never invent steps.";

  return `${connected}${missing}`;
}

/**
 * The command catalog.
 *
 * Hand maintained rather than derived from the CLI definition, which would be
 * the tidier answer and would drag the whole command tree into the reasoning
 * layer. Commands change rarely now; if this drifts, it drifts by a line.
 */
export interface CommandGroup {
  readonly group: string;
  readonly commands: readonly { readonly command: string; readonly does: string }[];
}

export const COMMANDS: readonly CommandGroup[] = [
  {
    group: "Connecting things",
    commands: [
      { command: "harbor auth google", does: "connect Gmail and Google Calendar" },
      { command: "harbor auth apple", does: "connect iCloud Calendar and Contacts with an app-specific password" },
      { command: "harbor auth imessage", does: "read iMessage from this Mac; needs Full Disk Access, no credential" },
      { command: "harbor calendars", does: "list every calendar Harbor can see" },
      { command: "harbor update", does: "pull what changed since last time" },
      { command: "harbor sync --backfill", does: "read everything, resumable" },
    ],
  },
  {
    group: "Making it usable",
    commands: [
      { command: "harbor dev classify", does: "label how sensitive each item is; no model calls" },
      { command: "harbor dev derive", does: "chunk and embed, so search works on meaning" },
      { command: "harbor dev resolve", does: "work out which addresses are the same person" },
      { command: "harbor remember <statement>", does: "tell Harbor a standing fact about you" },
      { command: "harbor facts", does: "what Harbor knows about you, and what it suspects" },
      { command: "harbor dev notice", does: "look through conversations for standing facts" },
      { command: "harbor topics", does: "subjects that keep coming up" },
      { command: "harbor doctor", does: "what is broken, what is exposed, and what to run" },
      { command: "harbor secrets", does: "where credentials are stored, and move them to the keychain" },
      { command: "harbor backup --encrypt", does: "an encrypted snapshot" },
      { command: "harbor dev extract", does: "pull purchases out of receipts and confirmations" },
      { command: "harbor purchases", does: "what has been bought" },
      { command: "harbor spend --days 90", does: "spending grouped by merchant" },
      { command: "harbor attachments", does: "files that arrived with your mail" },
      { command: "harbor digest", does: "the few things worth knowing, with a notification" },
      { command: "harbor weight <account> <n>", does: "how much a source is worth surfacing" },
      { command: "harbor dev commit", does: "build commitments from reminders, chats, and the calendar" },
      { command: "harbor commitments", does: "what has been said would happen and has not" },
      { command: "harbor commitment <id>", does: "one commitment and all its evidence" },
      { command: "harbor dev segment", does: "group messages into conversation episodes" },
      { command: "harbor conversations <query>", does: "search conversations rather than single messages" },
      { command: "harbor conversation <id>", does: "one full transcript" },
      { command: "harbor reminders", does: "what is still open, by due date" },
      { command: "harbor dev relate", does: "connect items across sources into situations" },
      {
        command: "harbor why <id>",
        does: "why one item is connected to what it is, and why not to the rest",
      },
      { command: "harbor situations", does: "things spanning more than one source" },
      { command: "harbor related <id>", does: "everything connected to one item, and why" },
      { command: "harbor status", does: "coverage, storage, and what is pending" },
    ],
  },
  {
    group: "Asking",
    commands: [
      { command: "harbor ask \"...\"", does: "answer from everything Harbor has read" },
      { command: "harbor ask --new", does: "start a fresh conversation instead of continuing" },
      { command: "harbor ask --trace", does: "show each tool call as it happens" },
      { command: "harbor ask --evidence", does: "list every item the model was shown" },
      { command: "harbor find \"...\"", does: "retrieval directly, with scores and why each matched; no model call" },
      { command: "harbor chats", does: "recent conversations" },
    ],
  },
  {
    group: "People",
    commands: [
      { command: "harbor people", does: "who Harbor knows, by how much you have written to them" },
      { command: "harbor person <name>", does: "one person: addresses, counts, last contact" },
      { command: "harbor merge <a> <b>", does: "declare two entities the same person" },
      { command: "harbor rename <id> <name>", does: "correct a name and pin it" },
    ],
  },
  {
    group: "Noticing things",
    commands: [
      { command: "harbor interest add \"...\"", does: "tell Harbor what you are working on" },
      { command: "harbor dev signals", does: "run the detectors over what has been ingested" },
      { command: "harbor brief", does: "what is worth your attention, at most three things" },
      { command: "harbor dismiss <id>", does: "say that was not worth mentioning" },
    ],
  },
  {
    group: "What leaves the machine",
    commands: [
      { command: "harbor policy list", does: "the egress rules, in the order they are evaluated" },
      { command: "harbor audit", does: "what was sent to a model, under which rule" },
      { command: "harbor cost", does: "spend by task class over the last month" },
    ],
  },
  {
    group: "Running unattended",
    commands: [
      { command: "harbor schedule add pipeline --at 06:00", does: "run the daily loop by itself" },
      { command: "harbor daemon", does: "scheduler plus the local API" },
      { command: "harbor device code", does: "pair a phone or browser" },
      { command: "harbor backup", does: "a consistent snapshot of the store" },
    ],
  },
];

export interface AvailableSource {
  readonly id: string;
  readonly name: string;
  readonly connected: boolean;
  readonly reads: readonly string[];
  readonly howToConnect: string;
}

/**
 * Every source Harbor supports, connected or not.
 *
 * Without this the model, asked about texts, correctly said it had no access
 * and then invented setup instructions for a phone app that does not exist.
 * Knowing what is missing and exactly how to add it is the difference between a
 * useful answer and a confident wrong one.
 */
export function availableSources(db: DB): readonly AvailableSource[] {
  const connected = new Set(connectedSources(db).map((source) => source.connector));

  return [
    {
      id: "gmail",
      name: "Gmail",
      connected: connected.has("Gmail"),
      reads: ["email"],
      howToConnect:
        "Run `harbor auth google` on the machine running Harbor. It opens a browser for " +
        "Google sign-in and needs a Desktop OAuth client in Google Cloud Console.",
    },
    {
      id: "gcal",
      name: "Google Calendar",
      connected: connected.has("Google Calendar"),
      reads: ["events"],
      howToConnect: "Included in `harbor auth google`; the same grant covers both.",
    },
    {
      id: "apple-calendar",
      name: "Apple Calendar",
      connected: connected.has("Apple Calendar"),
      reads: ["events"],
      howToConnect:
        "Settings, Add iCloud, using an app-specific password from appleid.apple.com. " +
        "Free, no developer program. Or `harbor auth apple` on the machine.",
    },
    {
      id: "apple-contacts",
      name: "Apple Contacts",
      connected: connected.has("Apple Contacts"),
      reads: ["contacts"],
      howToConnect: "Included with Apple Calendar; the same app-specific password covers both.",
    },
    {
      id: "apple-reminders",
      name: "Apple Reminders",
      connected: connected.has("Apple Reminders"),
      reads: ["tasks"],
      howToConnect: "Included with Apple Calendar; the same app-specific password covers both.",
    },
    {
      id: "imap",
      name: "Email (IMAP)",
      connected: connected.has("Email (IMAP)"),
      reads: ["email"],
      howToConnect:
        "Run `harbor auth imap you@yourprovider.com` on the machine running Harbor, or add it " +
        "from Settings. Harbor works out the server from the address; most providers need an " +
        "app-specific password rather than the account password. Covers Comcast, Yahoo, " +
        "Fastmail, AOL, iCloud Mail, and most ISP and university accounts.",
    },
    {
      id: "imessage",
      name: "iMessage",
      connected: connected.has("iMessage"),
      reads: ["texts"],
      howToConnect:
        "Settings, Connect iMessage. Harbor reads ~/Library/Messages/chat.db directly, so " +
        "it only works when Harbor runs on the Mac that has the messages, and that machine " +
        "needs Full Disk Access granted in System Settings, Privacy and Security.",
    },
  ];
}

export interface Capabilities {
  readonly what: string;
  readonly sources: readonly ConnectedSource[];
  readonly allSources: readonly AvailableSource[];
  readonly canRead: readonly string[];
  readonly canDo: readonly { readonly action: string; readonly description: string }[];
  readonly cannot: readonly string[];
  readonly commands: readonly CommandGroup[];
}

export function capabilities(db: DB): Capabilities {
  const sources = connectedSources(db);

  return {
    what:
      "Harbor is a self-hosted application running on the user's own computer. It reads the " +
      "accounts they have connected, keeps everything in a local database, and sends a model " +
      "only what its egress policy allows. It is driven by a command line on that machine and " +
      "by a web interface anything on the network can reach. It is not a phone app and there " +
      "is no account, no cloud service, and no app store listing.",
    sources,
    allSources: availableSources(db),
    canRead: [...new Set(sources.flatMap((source) => source.reads))],
    canDo: ACTIONS.map((action) => ({ action: action.id, description: action.description })),
    cannot: [
      "send, delete, or modify email",
      "read anything from a source that has not been connected",
      "act on anything without the user approving it first",
    ],
    commands: COMMANDS,
  };
}
