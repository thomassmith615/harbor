/**
 * Working out server settings from an email address.
 *
 * Thunderbird and Apple Mail do not ask for a hostname and a port, and neither
 * should Harbor. They check a handful of well-known locations keyed on the
 * domain, and so does this: a table of the providers people actually use, then
 * Mozilla's autoconfig service, then a guess at the conventional names.
 *
 * This turns the worst onboarding in the project into the best one. "Enter your
 * address and password" versus "enter your address, password, imap.host.com,
 * 993, and pick a TLS mode" is the whole difference between a source most
 * people can add and one most people cannot.
 */

export interface ImapSettings {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  /** How the settings were arrived at, so a failure message can be honest. */
  readonly source: "known" | "autoconfig" | "guess";
  readonly note?: string;
}

/**
 * Providers worth hardcoding.
 *
 * Not a completeness exercise: these are the ones where the answer is stable,
 * widely used, and where several also need an app-specific password, which is
 * worth saying up front rather than after a failed login.
 */
const KNOWN: Readonly<Record<string, ImapSettings>> = {
  "comcast.net": { host: "imap.comcast.net", port: 993, secure: true, source: "known" },
  "xfinity.com": { host: "imap.comcast.net", port: 993, secure: true, source: "known" },
  "gmail.com": {
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    source: "known",
    note: "Gmail needs an App Password, or connect it with `harbor auth google` instead, which is better.",
  },
  "yahoo.com": {
    host: "imap.mail.yahoo.com",
    port: 993,
    secure: true,
    source: "known",
    note: "Yahoo requires an app password generated in Account Security.",
  },
  "aol.com": {
    host: "imap.aol.com",
    port: 993,
    secure: true,
    source: "known",
    note: "AOL requires an app password.",
  },
  "icloud.com": {
    host: "imap.mail.me.com",
    port: 993,
    secure: true,
    source: "known",
    note: "Use the same app-specific password as iCloud Calendar.",
  },
  "me.com": { host: "imap.mail.me.com", port: 993, secure: true, source: "known" },
  "mac.com": { host: "imap.mail.me.com", port: 993, secure: true, source: "known" },
  "fastmail.com": {
    host: "imap.fastmail.com",
    port: 993,
    secure: true,
    source: "known",
    note: "Fastmail requires an app password.",
  },
  "outlook.com": {
    host: "outlook.office365.com",
    port: 993,
    secure: true,
    source: "known",
    note: "Microsoft has disabled password logins for personal accounts; this will likely fail.",
  },
  "hotmail.com": {
    host: "outlook.office365.com",
    port: 993,
    secure: true,
    source: "known",
    note: "Microsoft has disabled password logins for personal accounts; this will likely fail.",
  },
  "zoho.com": { host: "imap.zoho.com", port: 993, secure: true, source: "known" },
  "gmx.com": { host: "imap.gmx.com", port: 993, secure: true, source: "known" },
  "mail.com": { host: "imap.mail.com", port: 993, secure: true, source: "known" },
  "protonmail.com": {
    host: "127.0.0.1",
    port: 1143,
    secure: false,
    source: "known",
    note: "Proton requires their Bridge running locally; there is no direct IMAP.",
  },
  "proton.me": {
    host: "127.0.0.1",
    port: 1143,
    secure: false,
    source: "known",
    note: "Proton requires their Bridge running locally; there is no direct IMAP.",
  },
  "verizon.net": { host: "imap.aol.com", port: 993, secure: true, source: "known" },
  "att.net": { host: "imap.mail.att.net", port: 993, secure: true, source: "known" },
  "cox.net": { host: "imap.cox.net", port: 993, secure: true, source: "known" },
  "charter.net": { host: "mobile.charter.net", port: 993, secure: true, source: "known" },
  "spectrum.net": { host: "mobile.charter.net", port: 993, secure: true, source: "known" },
};

function domainOf(address: string): string | null {
  const at = address.lastIndexOf("@");
  return at === -1 ? null : address.slice(at + 1).trim().toLowerCase();
}

interface AutoconfigServer {
  readonly hostname: string;
  readonly port: number;
  readonly socketType: string;
}

/**
 * Mozilla's autoconfig database, as consulted by Thunderbird.
 *
 * Crude parsing on purpose: the fields wanted are three, the format is stable,
 * and a full XML reader here would be a dependency for one lookup that is
 * allowed to fail.
 */
async function fromAutoconfig(domain: string): Promise<AutoconfigServer | null> {
  const urls = [
    `https://autoconfig.thunderbird.net/v1.1/${domain}`,
    `https://autoconfig.${domain}/mail/config-v1.1.xml`,
    `https://${domain}/.well-known/autoconfig/mail/config-v1.1.xml`,
  ];

  for (const url of urls) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });

      if (!response.ok) {
        continue;
      }

      const text = await response.text();
      const block = /<incomingServer[^>]*type="imap"[\s\S]*?<\/incomingServer>/i.exec(text)?.[0];

      if (block === undefined) {
        continue;
      }

      const hostname = /<hostname>([^<]+)<\/hostname>/i.exec(block)?.[1];
      const port = /<port>(\d+)<\/port>/i.exec(block)?.[1];
      const socketType = /<socketType>([^<]+)<\/socketType>/i.exec(block)?.[1] ?? "SSL";

      if (hostname !== undefined && port !== undefined) {
        return { hostname: hostname.trim(), port: Number.parseInt(port, 10), socketType };
      }
    } catch {
      // Any of these may be absent, slow, or serving something else entirely.
      continue;
    }
  }

  return null;
}

/**
 * Settings for an address.
 *
 * Never throws. A guess is returned when nothing is known, because trying
 * imap.<domain> and failing with a clear message beats refusing to try.
 */
export async function discoverImap(address: string): Promise<ImapSettings> {
  const domain = domainOf(address);

  if (domain === null) {
    return { host: "", port: 993, secure: true, source: "guess", note: "That is not an address." };
  }

  const known = KNOWN[domain];

  if (known !== undefined) {
    return known;
  }

  const found = await fromAutoconfig(domain);

  if (found !== null) {
    return {
      host: found.hostname,
      port: found.port,
      // STARTTLS begins in the clear and upgrades, so the socket starts plain.
      secure: found.socketType.toUpperCase() === "SSL",
      source: "autoconfig",
    };
  }

  return {
    host: `imap.${domain}`,
    port: 993,
    secure: true,
    source: "guess",
    note: `Guessed imap.${domain}. If that is wrong, pass --host explicitly.`,
  };
}
