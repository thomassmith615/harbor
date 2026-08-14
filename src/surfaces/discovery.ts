/**
 * Bonjour advertisement, hand rolled.
 *
 * A phone should find the box without anyone typing an IP address. mDNS is how
 * every other device on the network does that, and iOS has it built in through
 * NWBrowser, so advertising `_harbor._tcp` means the app gets discovery for
 * free rather than needing a bespoke protocol.
 *
 * Written rather than depended on because the responder side of mDNS is a small
 * subset: listen on 224.0.0.251:5353, answer PTR queries for our service name
 * with SRV, TXT, and A records. No caching, no conflict resolution, no probing.
 * Roughly two hundred lines of DNS wire format, and the alternative is a
 * dependency that does host discovery, service browsing, and multicast conflict
 * handling we will never use.
 */
import { createSocket } from "node:dgram";
import { hostname, networkInterfaces } from "node:os";
import type { Socket } from "node:dgram";

const MDNS_ADDRESS = "224.0.0.251";
const MDNS_PORT = 5353;
const SERVICE = "_harbor._tcp.local";

const TYPE_A = 1;
const TYPE_PTR = 12;
const TYPE_TXT = 16;
const TYPE_SRV = 33;
const TYPE_ANY = 255;
const CLASS_IN = 1;
/** Cache-flush bit, telling responders our answer supersedes theirs. */
const FLUSH = 0x8000;

function encodeName(name: string): Buffer {
  const parts = name.split(".").filter((part) => part.length > 0);
  const chunks: Buffer[] = [];

  for (const part of parts) {
    const bytes = Buffer.from(part, "utf8");
    chunks.push(Buffer.from([bytes.length]), bytes);
  }

  chunks.push(Buffer.from([0]));
  return Buffer.concat(chunks);
}

interface ParsedName {
  readonly name: string;
  readonly offset: number;
}

function decodeName(buffer: Buffer, start: number): ParsedName {
  const parts: string[] = [];
  let offset = start;
  let jumped = false;
  let end = start;

  for (let guard = 0; guard < 128; guard += 1) {
    const length = buffer[offset];

    if (length === undefined || length === 0) {
      offset += 1;
      break;
    }

    // Compression pointer: the top two bits set means the rest is an offset.
    if ((length & 0xc0) === 0xc0) {
      const pointer = ((length & 0x3f) << 8) | (buffer[offset + 1] ?? 0);

      if (!jumped) {
        end = offset + 2;
        jumped = true;
      }

      offset = pointer;
      continue;
    }

    parts.push(buffer.subarray(offset + 1, offset + 1 + length).toString("utf8"));
    offset += length + 1;
  }

  return { name: parts.join("."), offset: jumped ? end : offset };
}

interface Question {
  readonly name: string;
  readonly type: number;
}

function parseQuestions(message: Buffer): readonly Question[] {
  if (message.length < 12) {
    return [];
  }

  const flags = message.readUInt16BE(2);

  // Only queries, not other responders' answers.
  if ((flags & 0x8000) !== 0) {
    return [];
  }

  const count = message.readUInt16BE(4);
  const questions: Question[] = [];
  let offset = 12;

  for (let index = 0; index < count && offset < message.length; index += 1) {
    const parsed = decodeName(message, offset);
    offset = parsed.offset;

    if (offset + 4 > message.length) {
      break;
    }

    questions.push({ name: parsed.name.toLowerCase(), type: message.readUInt16BE(offset) });
    offset += 4;
  }

  return questions;
}

function record(name: string, type: number, ttl: number, data: Buffer, flush = true): Buffer {
  const encoded = encodeName(name);
  const header = Buffer.alloc(10);

  header.writeUInt16BE(type, 0);
  header.writeUInt16BE(CLASS_IN | (flush ? FLUSH : 0), 2);
  header.writeUInt32BE(ttl, 4);
  header.writeUInt16BE(data.length, 8);

  return Buffer.concat([encoded, header, data]);
}

function txtData(pairs: Readonly<Record<string, string>>): Buffer {
  const chunks: Buffer[] = [];

  for (const [key, value] of Object.entries(pairs)) {
    const entry = Buffer.from(`${key}=${value}`, "utf8");
    chunks.push(Buffer.from([entry.length]), entry);
  }

  return chunks.length === 0 ? Buffer.from([0]) : Buffer.concat(chunks);
}

function srvData(port: number, target: string): Buffer {
  const head = Buffer.alloc(6);
  head.writeUInt16BE(0, 0);
  head.writeUInt16BE(0, 2);
  head.writeUInt16BE(port, 4);

  return Buffer.concat([head, encodeName(target)]);
}

function localAddresses(): readonly string[] {
  const found: string[] = [];

  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) {
        found.push(entry.address);
      }
    }
  }

  return found;
}

export interface AdvertiseOptions {
  readonly port: number;
  readonly instance?: string;
  readonly tls: boolean;
  readonly fingerprint?: string | null;
}

export interface Advertisement {
  readonly instance: string;
  readonly addresses: readonly string[];
  stop(): void;
}

/**
 * Starts answering mDNS queries for the Harbor service.
 *
 * The TXT record carries the certificate fingerprint, so a client that has
 * pinned one can tell whether it has found the same box it paired with before
 * connecting to it.
 */
export function advertise(options: AdvertiseOptions): Advertisement {
  const shortHost = hostname().replace(/\.local$/i, "");
  const instance = `${options.instance ?? shortHost}.${SERVICE}`;
  const target = `${shortHost}.local`;
  const addresses = localAddresses();

  const socket: Socket = createSocket({ type: "udp4", reuseAddr: true });

  const answersFor = (questions: readonly Question[]): readonly Buffer[] => {
    const answers: Buffer[] = [];

    for (const question of questions) {
      const wantsService =
        question.name === SERVICE && (question.type === TYPE_PTR || question.type === TYPE_ANY);

      const wantsInstance =
        question.name === instance.toLowerCase() &&
        (question.type === TYPE_SRV || question.type === TYPE_TXT || question.type === TYPE_ANY);

      if (!wantsService && !wantsInstance) {
        continue;
      }

      if (wantsService) {
        answers.push(record(SERVICE, TYPE_PTR, 120, encodeName(instance), false));
      }

      answers.push(record(instance, TYPE_SRV, 120, srvData(options.port, target)));

      answers.push(
        record(
          instance,
          TYPE_TXT,
          120,
          txtData({
            v: "1",
            scheme: options.tls ? "https" : "http",
            port: String(options.port),
            ...(options.fingerprint === undefined || options.fingerprint === null
              ? {}
              : { fp: options.fingerprint.replace(/:/g, "") }),
          }),
        ),
      );

      for (const address of addresses) {
        answers.push(
          record(target, TYPE_A, 120, Buffer.from(address.split(".").map((part) => Number(part)))),
        );
      }
    }

    return answers;
  };

  const respond = (answers: readonly Buffer[]): void => {
    if (answers.length === 0) {
      return;
    }

    const header = Buffer.alloc(12);
    header.writeUInt16BE(0, 0);
    // Authoritative response.
    header.writeUInt16BE(0x8400, 2);
    header.writeUInt16BE(0, 4);
    header.writeUInt16BE(answers.length, 6);

    const message = Buffer.concat([header, ...answers]);

    socket.send(message, 0, message.length, MDNS_PORT, MDNS_ADDRESS, () => undefined);
  };

  socket.on("message", (message: Buffer) => {
    try {
      respond(answersFor(parseQuestions(message)));
    } catch {
      // A malformed packet from anything else on the network is not our problem.
    }
  });

  socket.on("error", () => {
    // Discovery is a convenience. Losing it must never take the daemon down.
  });

  socket.bind(MDNS_PORT, () => {
    try {
      socket.addMembership(MDNS_ADDRESS);
      // Unsolicited announcement, so clients already browsing see us without
      // waiting for their next query.
      respond(answersFor([{ name: SERVICE, type: TYPE_PTR }]));
    } catch {
      // Another responder already holds the port. Harmless.
    }
  });

  return {
    instance,
    addresses,
    stop(): void {
      try {
        socket.close();
      } catch {
        // Already closed.
      }
    },
  };
}
