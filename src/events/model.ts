/**
 * Events as hypotheses about the world.
 *
 * The two things this replaces were both approximating the same object from
 * different directions and neither of them named it.
 *
 * `threads` took connected components of a relationship graph. Membership was
 * transitive, so a node joined by resembling *some other member* rather than by
 * having anything to do with the occurrence, and single-linkage clustering
 * chains: A relates to B and B to C, correctly, and A and C are now the same
 * evening. Measured on the coordination suite it fuses two Boston trips three
 * months apart and two Daves who share a first name.
 *
 * `stories` fixed the transitivity by scoring every candidate against a frame's
 * own anchors instead of against other members, which was the right move and
 * left three things unsolved. A frame needs a seed artifact, so an occurrence
 * with no calendar entry and no explicit proposal does not exist. Membership is
 * an additive score against two hand-set thresholds, which cannot express that
 * one contradiction should defeat four weak similarities. And a frame's
 * attributes are fixed at detection, so nothing can be learned about it
 * afterwards.
 *
 * ## What an event is here
 *
 * A row asserting that something happened or will happen, with a set of slots
 * that may be unknown, partially known, resolved, or contradicted, and a set of
 * observations that are evidence about it. The distinction that matters: an
 * observation belongs because it helps explain *this occurrence*, not because
 * it resembles another observation. That is the frame insight, generalised from
 * three hard-coded detectors to any attribute of any event.
 *
 * ## Slots
 *
 * A slot is a claim with a state, not a value with a confidence. "Nobody has
 * said when" and "two sources disagree about when" are different situations
 * needing different behaviour, and a nullable column collapses them. The states
 * are `open` (the question is live and something may answer it), `resolved`
 * (answered), `superseded` (answered, then answered differently by something
 * later and more authoritative), and `contradicted` (answered incompatibly by
 * something that is not more authoritative, which is a reason to distrust the
 * event rather than to overwrite the slot).
 *
 * Times are intervals throughout. A slot filled by "later" is a real claim four
 * hours wide, and the whole reason vague language used to be unusable is that
 * it had to be collapsed to an instant before anything could hold it.
 *
 * ## What is deliberately not here
 *
 * No model decides membership. Models may propose stances, resolve coreference
 * and extract claims, and every one of those arrives as a slot with a quote
 * attached. The decision about what belongs is a function of named features
 * with published weights, and it is reproducible from the stored features
 * without re-running anything.
 */
import { randomUUID } from "node:crypto";
import type { DB } from "../kernel/db.js";
import type { NodeRef } from "../store/nodes.js";

/** Bump to rebuild every event from the observations underneath. */
export const EVENT_VERSION = 1;

export type EventKind = "occasion" | "trip" | "meeting" | "booking";

export type EventStatus = "proposed" | "confirmed" | "cancelled" | "superseded";

export type SlotName = "time" | "place" | "person" | "activity" | "ref" | "party_size";

export type SlotState = "open" | "resolved" | "superseded" | "contradicted";

export interface Slot {
  readonly id: string;
  readonly slot: SlotName;
  /** Comparable form: an entity id, a normalized code, an interval key. */
  readonly value: string;
  /** What somebody actually wrote. Used in every sentence shown to a person. */
  readonly display: string;
  readonly lower: number | null;
  readonly upper: number | null;
  readonly confidence: number;
  readonly state: SlotState;
  readonly source: NodeRef | null;
  readonly quote: string | null;
  readonly observedAt: number;
}

export interface EventRow {
  readonly id: string;
  readonly kind: EventKind;
  readonly title: string | null;
  readonly status: EventStatus;
  readonly startsAt: number | null;
  readonly endsAt: number | null;
  readonly timeWidthMs: number | null;
  readonly confidence: number;
}

export interface Hypothesis extends EventRow {
  readonly slots: readonly Slot[];
}

export interface SlotInput {
  readonly slot: SlotName;
  readonly value: string;
  readonly display: string;
  readonly lower?: number | null;
  readonly upper?: number | null;
  readonly confidence: number;
  readonly state?: SlotState;
  readonly source?: NodeRef | null;
  readonly quote?: string | null;
  readonly observedAt: number;
}

export function createEvent(
  db: DB,
  principalId: string,
  input: {
    readonly kind: EventKind;
    readonly title?: string | null;
    readonly status?: EventStatus;
    readonly slots: readonly SlotInput[];
  },
): Hypothesis {
  const id = `ev_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const now = Date.now();

  db.prepare(
    `INSERT INTO events
       (id, principal_id, kind, title, status, starts_at, ends_at, time_width_ms,
        confidence, version, created_at, updated_at)
     VALUES (@id, @principalId, @kind, @title, @status, NULL, NULL, NULL, 0.5, @version, @now, @now)`,
  ).run({
    id,
    principalId,
    kind: input.kind,
    title: input.title ?? null,
    status: input.status ?? "proposed",
    version: EVENT_VERSION,
    now,
  });

  for (const slot of input.slots) {
    addSlot(db, id, slot);
  }

  refreshTime(db, id);

  return load(db, id) as Hypothesis;
}

export function addSlot(db: DB, eventId: string, input: SlotInput): void {
  db.prepare(
    `INSERT INTO event_slots
       (id, event_id, slot, value, display, lower, upper, confidence, state,
        source_kind, source_id, quote, observed_at, created_at)
     VALUES (@id, @eventId, @slot, @value, @display, @lower, @upper, @confidence, @state,
             @sourceKind, @sourceId, @quote, @observedAt, @now)`,
  ).run({
    id: randomUUID(),
    eventId,
    slot: input.slot,
    value: input.value,
    display: input.display,
    lower: input.lower ?? null,
    upper: input.upper ?? null,
    confidence: input.confidence,
    state: input.state ?? "resolved",
    sourceKind: input.source?.kind ?? null,
    sourceId: input.source?.id ?? null,
    quote: input.quote ?? null,
    observedAt: input.observedAt,
    now: Date.now(),
  });
}

function toSlot(row: Record<string, unknown>): Slot {
  const kind = row["source_kind"] as string | null;
  const id = row["source_id"] as string | null;

  return {
    id: row["id"] as string,
    slot: row["slot"] as SlotName,
    value: row["value"] as string,
    display: row["display"] as string,
    lower: (row["lower"] as number | null) ?? null,
    upper: (row["upper"] as number | null) ?? null,
    confidence: row["confidence"] as number,
    state: row["state"] as SlotState,
    source: kind === null || id === null ? null : { kind: kind as NodeRef["kind"], id },
    quote: (row["quote"] as string | null) ?? null,
    observedAt: row["observed_at"] as number,
  };
}

export function load(db: DB, eventId: string): Hypothesis | null {
  const row = db.prepare(`SELECT * FROM events WHERE id = ?`).get(eventId) as
    | Record<string, unknown>
    | undefined;

  if (row === undefined) {
    return null;
  }

  const slots = (
    db.prepare(`SELECT * FROM event_slots WHERE event_id = ?`).all(eventId) as Record<
      string,
      unknown
    >[]
  ).map(toSlot);

  return {
    id: row["id"] as string,
    kind: row["kind"] as EventKind,
    title: (row["title"] as string | null) ?? null,
    status: row["status"] as EventStatus,
    startsAt: (row["starts_at"] as number | null) ?? null,
    endsAt: (row["ends_at"] as number | null) ?? null,
    timeWidthMs: (row["time_width_ms"] as number | null) ?? null,
    confidence: row["confidence"] as number,
    slots,
  };
}

export function liveEvents(db: DB, principalId: string): readonly Hypothesis[] {
  const rows = db
    .prepare(`SELECT id FROM events WHERE principal_id = ? ORDER BY starts_at`)
    .all(principalId) as { id: string }[];

  return rows
    .map((row) => load(db, row.id))
    .filter((event): event is Hypothesis => event !== null);
}

/** The slots of one name that are still believed. */
export function believed(event: Hypothesis, slot: SlotName): readonly Slot[] {
  return event.slots.filter((entry) => entry.slot === slot && entry.state === "resolved");
}

export function openSlots(event: Hypothesis, slot: SlotName): readonly Slot[] {
  return event.slots.filter((entry) => entry.slot === slot && entry.state === "open");
}

/**
 * Recomputes the denormalised time from the slots.
 *
 * The narrowest resolved time wins, and an open one is used only when there is
 * no resolved one, which is what lets an event exist with an honest five hour
 * estimate rather than a made-up instant.
 */
export function refreshTime(db: DB, eventId: string): void {
  const event = load(db, eventId);

  if (event === null) {
    return;
  }

  const times = event.slots.filter(
    (slot) =>
      slot.slot === "time" &&
      (slot.state === "resolved" || slot.state === "open") &&
      slot.lower !== null &&
      slot.upper !== null,
  );

  const resolved = times.filter((slot) => slot.state === "resolved");
  const usable = resolved.length > 0 ? resolved : times;

  let best: Slot | null = null;

  for (const slot of usable) {
    const width = (slot.upper ?? 0) - (slot.lower ?? 0);

    if (best === null || width < (best.upper ?? 0) - (best.lower ?? 0)) {
      best = slot;
    }
  }

  if (best === null) {
    return;
  }

  const width = (best.upper ?? 0) - (best.lower ?? 0);
  const middle = (best.lower ?? 0) + width / 2;

  db.prepare(
    `UPDATE events SET starts_at = @startsAt, ends_at = @endsAt,
       time_width_ms = @width, updated_at = @now WHERE id = @id`,
  ).run({
    id: eventId,
    // The midpoint for a wide estimate, the stated start for a narrow one. An
    // event booked for 8:00 starts at 8:00; an event described as "later" has
    // no start and the midpoint is the least misleading single number.
    startsAt: width <= 2 * 3_600_000 ? (best.lower ?? 0) + width / 2 : middle,
    endsAt: (best.lower ?? 0) + width / 2 + 2 * 3_600_000,
    width,
    now: Date.now(),
  });
}

export interface Attachment {
  readonly ref: NodeRef;
  readonly role: string;
  readonly probability: number;
  readonly logOdds: number;
  readonly margin: number;
  readonly features: readonly { readonly name: string; readonly value: number; readonly contribution: number }[];
  readonly evidence: readonly string[];
}

export function attach(db: DB, eventId: string, attachment: Attachment): void {
  db.prepare(
    `INSERT OR REPLACE INTO event_observations
       (event_id, node_kind, node_id, role, probability, log_odds, margin,
        features, evidence, created_at)
     VALUES (@eventId, @kind, @id, @role, @probability, @logOdds, @margin,
             @features, @evidence, @now)`,
  ).run({
    eventId,
    kind: attachment.ref.kind,
    id: attachment.ref.id,
    role: attachment.role,
    probability: attachment.probability,
    logOdds: attachment.logOdds,
    margin: attachment.margin,
    features: JSON.stringify(attachment.features),
    evidence: JSON.stringify(attachment.evidence),
    now: Date.now(),
  });
}

export function observationsOf(db: DB, eventId: string): readonly Attachment[] {
  const rows = db
    .prepare(`SELECT * FROM event_observations WHERE event_id = ? ORDER BY probability DESC`)
    .all(eventId) as Record<string, unknown>[];

  return rows.map((row) => ({
    ref: { kind: row["node_kind"] as NodeRef["kind"], id: row["node_id"] as string },
    role: row["role"] as string,
    probability: row["probability"] as number,
    logOdds: row["log_odds"] as number,
    margin: row["margin"] as number,
    features: JSON.parse(row["features"] as string) as Attachment["features"],
    evidence: JSON.parse(row["evidence"] as string) as string[],
  }));
}

export function link(
  db: DB,
  from: string,
  to: string,
  kind: "recurrence_of" | "supersedes" | "cancels" | "part_of",
  evidence: string,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO event_links (from_id, to_id, kind, evidence, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(from, to, kind, evidence, Date.now());
}

export function setStatus(db: DB, eventId: string, status: EventStatus): void {
  db.prepare(`UPDATE events SET status = ?, updated_at = ? WHERE id = ?`).run(
    status,
    Date.now(),
    eventId,
  );
}

export function clearEvents(db: DB, principalId: string): number {
  const changed = db.prepare(`DELETE FROM events WHERE principal_id = ?`).run(principalId).changes;

  return changed;
}
