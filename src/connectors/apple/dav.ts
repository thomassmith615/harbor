/**
 * A CalDAV and CardDAV client for iCloud.
 *
 * No OAuth here, and no developer program. iCloud speaks both protocols over
 * HTTPS with Basic auth, and the credential is an app-specific password, which
 * any Apple ID with two-factor enabled can generate for free. The Apple
 * Developer Program is for EventKit and CloudKit, neither of which Harbor
 * needs and both of which would require a native macOS host.
 *
 * The tradeoff versus Google is real and worth naming. Google hands out a
 * `historyId` and a JSON API. DAV gives you XML, a discovery dance, and change
 * detection by ctag. It is more code for less. It is also the only free way to
 * read iCloud from a Linux box, and it is a genuinely different sync shape,
 * which is a useful thing to have proved the connector interface against.
 */
import { UpstreamError } from "../../kernel/errors.js";
import { escapeXml, findAll, findFirst, parseXml, textOf } from "./xml.js";
import type { XmlNode } from "./xml.js";

export const CALDAV_ROOT = "https://caldav.icloud.com";
export const CARDDAV_ROOT = "https://contacts.icloud.com";

export interface DavCredentials {
  readonly appleId: string;
  /** An app-specific password from appleid.apple.com. Not the account password. */
  readonly appPassword: string;
}

export function basicAuth(credentials: DavCredentials): string {
  const raw = `${credentials.appleId}:${credentials.appPassword}`;
  return `Basic ${Buffer.from(raw, "utf8").toString("base64")}`;
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 4;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface DavRequest {
  readonly method: "PROPFIND" | "REPORT" | "GET";
  readonly url: string;
  readonly authorization: string;
  readonly depth?: "0" | "1";
  readonly body?: string;
}

/**
 * One DAV request.
 *
 * 207 Multi-Status is the normal success code here, not 200, and treating it as
 * an error is the classic first mistake with WebDAV.
 */
export async function dav(request: DavRequest): Promise<XmlNode> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let response: Response;

    try {
      response = await fetch(request.url, {
        method: request.method,
        headers: {
          authorization: request.authorization,
          "content-type": "application/xml; charset=utf-8",
          ...(request.depth === undefined ? {} : { depth: request.depth }),
          // iCloud is noticeably happier when it recognises the client.
          "user-agent": "Harbor/0.9 (CalDAV)",
        },
        ...(request.body === undefined ? {} : { body: request.body }),
      });
    } catch (cause: unknown) {
      lastError = cause;

      if (attempt === MAX_ATTEMPTS) {
        break;
      }

      await sleep(2 ** attempt * 300);
      continue;
    }

    if (response.status === 207 || response.ok) {
      return parseXml(await response.text());
    }

    const body = await response.text();

    if (RETRYABLE.has(response.status) && attempt < MAX_ATTEMPTS) {
      await sleep(2 ** attempt * 400);
      continue;
    }

    throw new UpstreamError(
      `iCloud ${request.method} ${request.url} returned ${String(response.status)}: ${body.slice(0, 200)}`,
      {
        status: response.status,
        hint:
          response.status === 401
            ? "Apple rejected the credentials. The password must be an app-specific password " +
              "from appleid.apple.com, not your account password, and the account must have " +
              "two-factor authentication enabled."
            : response.status === 403
              ? "Authenticated but not permitted. Check the Apple ID is the one that owns the calendar."
              : undefined,
      },
    );
  }

  throw new UpstreamError(`iCloud ${request.method} failed after ${String(MAX_ATTEMPTS)} attempts`, {
    cause: lastError,
  });
}

function absolute(root: string, href: string): string {
  if (href.startsWith("http://") || href.startsWith("https://")) {
    return href;
  }

  return `${root.replace(/\/+$/, "")}${href.startsWith("/") ? "" : "/"}${href}`;
}

const PRINCIPAL_BODY = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop><d:current-user-principal/></d:prop>
</d:propfind>`;

/**
 * Step one of the discovery dance: which principal are these credentials?
 *
 * iCloud's URLs are keyed by an opaque numeric id that is not the Apple ID, so
 * every path has to be discovered rather than constructed.
 */
export async function discoverPrincipal(root: string, authorization: string): Promise<string> {
  const document = await dav({
    method: "PROPFIND",
    url: `${root}/`,
    authorization,
    depth: "0",
    body: PRINCIPAL_BODY,
  });

  const href = textOf(findFirst(findFirst(document, "current-user-principal") ?? document, "href"));

  if (href.length === 0) {
    throw new UpstreamError("iCloud did not return a principal URL", {
      hint: "The credentials were accepted but discovery failed. Try `harbor auth apple --check`.",
    });
  }

  return absolute(root, href);
}

const HOME_BODY = (namespace: string, property: string): string => `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:x="${namespace}">
  <d:prop><x:${property}/></d:prop>
</d:propfind>`;

/** Step two: where this principal's calendars or address books live. */
export async function discoverHome(
  root: string,
  principalUrl: string,
  authorization: string,
  kind: "calendar" | "addressbook",
): Promise<string> {
  const namespace =
    kind === "calendar"
      ? "urn:ietf:params:xml:ns:caldav"
      : "urn:ietf:params:xml:ns:carddav";

  const property = kind === "calendar" ? "calendar-home-set" : "addressbook-home-set";

  const document = await dav({
    method: "PROPFIND",
    url: principalUrl,
    authorization,
    depth: "0",
    body: HOME_BODY(namespace, property),
  });

  const home = findFirst(document, property);
  const href = textOf(findFirst(home ?? document, "href"));

  if (href.length === 0) {
    throw new UpstreamError(`iCloud did not return a ${property}`);
  }

  return absolute(root, href);
}

export interface DavCollection {
  readonly url: string;
  readonly displayName: string;
  /** Changes whenever anything inside changes. The cheap way to detect staleness. */
  readonly ctag: string | null;
  readonly components: readonly string[];
}

const COLLECTION_BODY = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/"
            xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:resourcetype/>
    <d:displayname/>
    <cs:getctag/>
    <c:supported-calendar-component-set/>
  </d:prop>
</d:propfind>`;

/**
 * Step three: the collections themselves.
 *
 * iCloud returns a mixture in one home: event calendars, task lists, and the
 * inbox and outbox scheduling collections. Filtering by supported component is
 * what separates a calendar you want from a reminders list you did not ask for.
 */
export async function listCollections(
  root: string,
  homeUrl: string,
  authorization: string,
  wanted: "VEVENT" | "VTODO" | "VCARD",
): Promise<readonly DavCollection[]> {
  const document = await dav({
    method: "PROPFIND",
    url: homeUrl,
    authorization,
    depth: "1",
    body: COLLECTION_BODY,
  });

  const collections: DavCollection[] = [];

  for (const response of findAll(document, "response")) {
    const href = textOf(findFirst(response, "href"));

    if (href.length === 0) {
      continue;
    }

    const url = absolute(root, href);

    if (url.replace(/\/+$/, "") === homeUrl.replace(/\/+$/, "")) {
      continue;
    }

    const resourceType = findFirst(response, "resourcetype");
    const isCalendar = resourceType !== null && findFirst(resourceType, "calendar") !== null;
    const isAddressBook = resourceType !== null && findFirst(resourceType, "addressbook") !== null;

    // Calendars and reminder lists are both calendar collections; only the
    // supported component set tells them apart.
    if ((wanted === "VEVENT" || wanted === "VTODO") && !isCalendar) {
      continue;
    }

    if (wanted === "VCARD" && !isAddressBook) {
      continue;
    }

    const components = findAll(response, "comp").map(
      (node) => node.attributes["name"] ?? "",
    );

    // A collection that declares components and does not include the one asked
    // for is the other thing. Silence about components means everything, which
    // is the conservative reading: better to look and find nothing than to skip
    // a list that simply did not advertise itself.
    if (
      (wanted === "VEVENT" || wanted === "VTODO") &&
      components.length > 0 &&
      !components.includes(wanted)
    ) {
      continue;
    }

    // iCloud omits displayname on some collections, and a bare URL is not a
    // name. The last path segment is at least recognisable.
    const declared = textOf(findFirst(response, "displayname"));
    const slug = url.replace(/\/+$/, "").split("/").pop() ?? url;

    collections.push({
      url,
      displayName: declared.length > 0 && declared !== "null" ? declared : slug,
      ctag: textOf(findFirst(response, "getctag")) || null,
      components,
    });
  }

  return collections;
}

/** Just the ctag, for deciding whether a collection is worth re-reading. */
export async function collectionCtag(
  url: string,
  authorization: string,
): Promise<string | null> {
  const document = await dav({
    method: "PROPFIND",
    url,
    authorization,
    depth: "0",
    body: `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/">
  <d:prop><cs:getctag/></d:prop>
</d:propfind>`,
  });

  return textOf(findFirst(document, "getctag")) || null;
}

function davDate(ms: number): string {
  return `${new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")}`;
}

/**
 * Fetches expanded event data for a window.
 *
 * `<C:expand>` is doing the heavy lifting: it makes the server materialize
 * recurring events into individual instances, in UTC, exactly as Google's
 * `singleEvents=true` does. Without it, Harbor would have to implement RRULE,
 * EXDATE, and RECURRENCE-ID overrides, which is a large amount of code whose
 * failure mode is quietly showing you the wrong day.
 */
export async function fetchEvents(
  collectionUrl: string,
  authorization: string,
  from: number,
  to: number,
): Promise<readonly { readonly href: string; readonly etag: string; readonly data: string }[]> {
  const start = davDate(from);
  const end = davDate(to);

  const body = `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:getetag/>
    <c:calendar-data>
      <c:expand start="${escapeXml(start)}" end="${escapeXml(end)}"/>
    </c:calendar-data>
  </d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT">
        <c:time-range start="${escapeXml(start)}" end="${escapeXml(end)}"/>
      </c:comp-filter>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`;

  const document = await dav({
    method: "REPORT",
    url: collectionUrl,
    authorization,
    depth: "1",
    body,
  });

  return collectResources(document, "calendar-data");
}

export async function fetchContacts(
  collectionUrl: string,
  authorization: string,
): Promise<readonly { readonly href: string; readonly etag: string; readonly data: string }[]> {
  const body = `<?xml version="1.0" encoding="utf-8"?>
<card:addressbook-query xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">
  <d:prop>
    <d:getetag/>
    <card:address-data/>
  </d:prop>
</card:addressbook-query>`;

  const document = await dav({
    method: "REPORT",
    url: collectionUrl,
    authorization,
    depth: "1",
    body,
  });

  return collectResources(document, "address-data");
}

function collectResources(
  document: XmlNode,
  dataElement: string,
): readonly { href: string; etag: string; data: string }[] {
  const resources: { href: string; etag: string; data: string }[] = [];

  for (const response of findAll(document, "response")) {
    const data = textOf(findFirst(response, dataElement));

    if (data.length === 0) {
      continue;
    }

    resources.push({
      href: textOf(findFirst(response, "href")),
      etag: textOf(findFirst(response, "getetag")),
      data,
    });
  }

  return resources;
}

export interface AppleDiscovery {
  readonly principalUrl: string;
  readonly calendarHome: string;
  readonly addressBookHome: string | null;
  readonly calendars: readonly DavCollection[];
  readonly addressBooks: readonly DavCollection[];
}

/**
 * The whole dance, once, so `harbor auth apple` can prove the credentials work
 * and show what it found rather than failing later inside a sync.
 */
export async function discover(credentials: DavCredentials): Promise<AppleDiscovery> {
  return await discoverWith(basicAuth(credentials));
}

/**
 * Discovery from a stored Authorization header.
 *
 * Separate from `discover` so that `--check` can verify a saved credential
 * without asking for the password again, which would defeat the point of
 * storing it.
 */
export async function discoverWith(authorization: string): Promise<AppleDiscovery> {
  const principalUrl = await discoverPrincipal(CALDAV_ROOT, authorization);
  const calendarHome = await discoverHome(CALDAV_ROOT, principalUrl, authorization, "calendar");
  const calendars = await listCollections(CALDAV_ROOT, calendarHome, authorization, "VEVENT");

  let addressBookHome: string | null = null;
  let addressBooks: readonly DavCollection[] = [];

  // Contacts live on a different host and are allowed to fail independently:
  // a working calendar connection should not be blocked by an address book.
  try {
    const cardPrincipal = await discoverPrincipal(CARDDAV_ROOT, authorization);
    addressBookHome = await discoverHome(
      CARDDAV_ROOT,
      cardPrincipal,
      authorization,
      "addressbook",
    );
    addressBooks = await listCollections(CARDDAV_ROOT, addressBookHome, authorization, "VCARD");
  } catch {
    addressBookHome = null;
  }

  return { principalUrl, calendarHome, addressBookHome, calendars, addressBooks };
}
