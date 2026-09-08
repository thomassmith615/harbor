/**
 * Inferring events, and assigning observations to them.
 *
 * Three stages, and the middle one is the change of algorithm.
 *
 * **Birth.** Some observations assert that an occurrence exists: a calendar
 * entry, a booking confirmation, a proposal somebody agreed to. Each becomes a
 * hypothesis with whatever slots it can fill and open slots for what it cannot.
 * This generalises the frame layer, which had three hard-coded detectors and
 * could not represent an occurrence that none of them recognised.
 *
 * **Assignment.** Every remaining observation is scored against every live
 * hypothesis in its temporal neighbourhood and goes to the best one, if the
 * best one is good enough and clearly better than the second. This is the
 * replacement for connected components, and the two properties that matter are
 * both absent from the old design.
 *
 *   *Nothing is transitive.* An observation is compared to a hypothesis, never
 *   to another observation, so A relating to B and B to C never makes A and C
 *   one occurrence.
 *
 *   *Hypotheses compete.* An observation that fits two evenings almost equally
 *   well is evidence about neither, and attaching it to both is precisely how a
 *   shared person fuses two unrelated evenings. Below the margin it attaches to
 *   nothing and the margin is recorded, so a person can see that Harbor knew it
 *   was ambiguous rather than guessing silently.
 *
 * **Separation.** Two hypotheses that match on everything except being
 * different occurrences are linked, never merged. Four weekly syncs are one
 * pattern and four events; two dinners at the same restaurant a fortnight apart
 * are two dinners. Every similarity measure says these are one thing and every
 * one of them is wrong, which is the clearest possible demonstration that
 * similarity is the wrong definition of an event.
 */
import { anchorsFor } from "../store/anchors.js";
import { NodeResolver, nodeKey } from "../store/nodes.js";
import { NoiseIndex } from "../derive/noise.js";
import { readPlans } from "../derive/plans.js";
import { tripFrames } from "../derive/frames.js";
import { attach, createEvent, liveEvents, link, load, refreshTime, addSlot, setStatus, clearEvents, EVENT_VERSION } from "./model.js";
import { combine, featuresFor, loadWeights, type Candidate } from "./features.js";
import type { DB } from "../kernel/db.js";
import type { NodeRef } from "../store/nodes.js";
import type { Anchor } from "../derive/anchors.js";
import type { Hypothesis, SlotInput } from "./model.js";

const HOUR = 3_600_000;
const DAY = 86_400_000;

/**
 * How sure the model has to be before an observation joins.
 *
 * A probability now, which means it can be argued about against data. The old
 * 0.6 was a sum of points in no units at all.
 */
const ADMIT = 0.72;

/**
 * How much better the winner has to be than the runner-up.
 *
 * The competition rule, and the single most important guard against fusion. An
 * observation that scores 0.80 for one evening and 0.78 for another has told
 * you nothing about which, and giving it to the better one on a two point
 * difference is a coin toss dressed as a decision. Giving it to both is worse:
 * that is the edge through which two evenings become one.
 */
const MARGIN = 0.15;

/** How far from an event an observation may sit and still be considered. */
const ENVELOPE_MS = 21 * DAY;

/**
 * Two occurrences at the same place with the same people, this far apart.
 *
 * Twelve hours. Below it, two mentions of an evening are the same evening;
 * above it, they are two, however identical the language. This is the
 * recurrence boundary and it is deliberately generous: the failure it prevents
 * is a repeated dinner becoming one enormous event, and the cost of getting it
 * slightly wrong is a split, which is the cheaper error.
 */
const RECURRENCE_GAP_MS = 12 * HOUR;

export interface InferReport {
  readonly events: number;
  readonly attached: number;
  readonly contested: number;
  readonly recurrences: number;
  readonly cancelled: number;
}

function anchorsOf(db: DB, ref: NodeRef): readonly Anchor[] {
  return anchorsFor(db, ref);
}

/** Every node worth considering, with what is known about it. */
function corpus(db: DB, noise: NoiseIndex, resolver: NodeResolver): readonly Candidate[] {
  const refs: NodeRef[] = [];

  for (const row of db
    .prepare(`SELECT id FROM items WHERE deleted_at IS NULL`)
    .all() as { id: string }[]) {
    refs.push({ kind: "item", id: row.id });
  }

  for (const row of db.prepare(`SELECT id FROM episodes`).all() as { id: string }[]) {
    refs.push({ kind: "episode", id: row.id });
  }

  const out: Candidate[] = [];

  for (const ref of refs) {
    const node = resolver.node(ref);

    if (node === null) {
      continue;
    }

    out.push({
      node,
      anchors: anchorsOf(db, ref),
      threadId: null,
      broadcast: ref.kind === "item" && noise.isBroadcast(ref.id),
    });
  }

  return out;
}

function slotsFromAnchors(anchors: readonly Anchor[], at: number, ref: NodeRef): SlotInput[] {
  const slots: SlotInput[] = [];

  for (const anchor of anchors) {
    if (anchor.kind === "venue" && anchor.value.startsWith("e_")) {
      slots.push({
        slot: "place",
        value: anchor.value,
        display: anchor.display,
        confidence: anchor.confidence,
        source: ref,
        observedAt: at,
      });
    }

    if (anchor.kind === "ref" && anchor.value.startsWith("confirmation:")) {
      slots.push({
        slot: "ref",
        value: anchor.value,
        display: anchor.display,
        confidence: 0.95,
        source: ref,
        observedAt: at,
      });
    }

    if (anchor.kind === "going") {
      slots.push({
        slot: "person",
        value: anchor.value,
        display: anchor.display,
        confidence: anchor.confidence,
        source: ref,
        observedAt: at,
      });
    }
  }

  return slots;
}

/**
 * Observations that assert an occurrence.
 *
 * Deliberately narrow. A hypothesis born from something that is not an
 * assertion is a hypothesis that will attract observations and explain nothing,
 * and the cost of missing one is a split rather than a fusion.
 */
function birth(db: DB, principalId: string, timezone: string, noise: NoiseIndex): number {
  const resolver = new NodeResolver(db);
  let born = 0;

  // Calendar entries: somebody wrote this down deliberately.
  for (const row of db
    .prepare(
      `SELECT id, title, occurred_at, ends_at FROM items
       WHERE kind = 'event' AND deleted_at IS NULL`,
    )
    .all() as { id: string; title: string | null; occurred_at: number; ends_at: number | null }[]) {
    const ref: NodeRef = { kind: "item", id: row.id };
    const anchors = anchorsOf(db, ref);

    createEvent(db, principalId, {
      kind: "occasion",
      title: row.title,
      status: "confirmed",
      slots: [
        {
          slot: "time",
          value: `${String(row.occurred_at)}`,
          display: row.title ?? "calendar entry",
          lower: row.occurred_at,
          upper: row.ends_at ?? row.occurred_at + 2 * HOUR,
          confidence: 0.95,
          source: ref,
          observedAt: row.occurred_at,
        },
        ...slotsFromAnchors(anchors, row.occurred_at, ref),
      ],
    });

    born += 1;
  }

  // Bookings: a confirmation code and a stated hour.
  for (const row of db
    .prepare(
      `SELECT id, title, body, occurred_at FROM items
       WHERE kind = 'message' AND deleted_at IS NULL AND body IS NOT NULL`,
    )
    .all() as { id: string; title: string | null; body: string; occurred_at: number }[]) {
    const ref: NodeRef = { kind: "item", id: row.id };
    const anchors = anchorsOf(db, ref);

    const hasRef = anchors.some(
      (anchor) => anchor.kind === "ref" && anchor.value.startsWith("confirmation:"),
    );

    if (!hasRef) {
      continue;
    }

    const clock = anchors
      .filter(
        (anchor) =>
          anchor.kind === "time_hint" &&
          anchor.startsAt !== null &&
          (anchor.endsAt ?? 0) - (anchor.startsAt ?? 0) <= 2 * HOUR,
      )
      .sort((a, b) => (a.endsAt ?? 0) - (a.startsAt ?? 0) - ((b.endsAt ?? 0) - (b.startsAt ?? 0)))[0];

    if (clock === undefined) {
      continue;
    }

    // A cancellation is not a new booking. It is evidence that an existing one
    // stopped existing, and treating it as a birth is how a cancelled dinner
    // and its replacement become one event with two times.
    const cancels = /\b(cancel(?:led|ed|lation)?)\b/i.test(`${row.title ?? ""} ${row.body}`);

    if (cancels) {
      continue;
    }

    createEvent(db, principalId, {
      kind: "booking",
      title: (row.title ?? "").replace(/^(?:your|re:|fwd:)\s+/i, "").trim() || null,
      status: "confirmed",
      slots: [
        {
          slot: "time",
          value: `${String(clock.startsAt ?? 0)}`,
          display: clock.display,
          lower: clock.startsAt,
          upper: clock.endsAt,
          confidence: 0.9,
          source: ref,
          quote: clock.display,
          observedAt: row.occurred_at,
        },
        ...slotsFromAnchors(anchors, row.occurred_at, ref),
      ],
    });

    born += 1;
  }

  // Which item in an episode a quoted line came from.
  //
  // A plan's spine is the messages that made it, not the conversation that
  // contains them. The distinction is the whole of the two-plans-in-one-chat
  // case: an episode is a container, so a hypothesis spined on the episode
  // claims every message in it, and a second plan arranged four lines later
  // claims the same ones. Both then contain both plans, which is a fusion
  // produced entirely by the choice of unit.
  //
  // Matched by quote, so it inherits the verification the stance extraction
  // already does: a line that is not in the transcript verbatim reaches no item.
  const itemsByBody = (episodeId: string): ReadonlyMap<string, string> => {
    const rows = db
      .prepare(
        `SELECT i.id AS id, i.body AS body FROM episode_items ei
         JOIN items i ON i.id = ei.item_id
         WHERE ei.episode_id = ? ORDER BY i.occurred_at`,
      )
      .all(episodeId) as { id: string; body: string | null }[];

    const held = new Map<string, string>();

    for (const row of rows) {
      const body = (row.body ?? "").trim();

      if (body.length > 0 && !held.has(body)) {
        held.set(body, row.id);
      }
    }

    return held;
  };

  // Journeys, from the flight pairing the frame layer already does well.
  //
  // Reused rather than rebuilt. Pairing an outbound with a return by reversed
  // route is one of the few genuinely strong rules in the store, it is tested,
  // and reimplementing it here would have been a rewrite of something that was
  // not wrong. What the hypothesis model adds is what happens afterwards: a
  // trip is now an event that competes for observations under the same rules as
  // everything else, rather than a frame with its own gathering pass.
  for (const frame of tripFrames(db, resolver, noise, 0)) {
    const slots: SlotInput[] = [
      {
        slot: "time",
        value: `${String(frame.spanStartsAt)}`,
        display: frame.title ?? "journey",
        lower: frame.spanStartsAt,
        upper: frame.spanEndsAt,
        confidence: 0.9,
        source: frame.spine[0] ?? null,
        observedAt: frame.spanStartsAt,
      },
    ];

    if (frame.place !== null) {
      slots.push({
        slot: "place",
        value: frame.place,
        display: frame.placeDisplay ?? frame.place,
        confidence: 0.85,
        source: frame.spine[0] ?? null,
        observedAt: frame.spanStartsAt,
      });
    }

    for (const anchor of frame.anchors) {
      if (anchor.kind === "ref") {
        slots.push({
          slot: "ref",
          value: anchor.value,
          display: anchor.display,
          confidence: 0.95,
          source: frame.spine[0] ?? null,
          observedAt: frame.spanStartsAt,
        });
      }
    }

    const event = createEvent(db, principalId, {
      kind: "trip",
      title: frame.title,
      status: "confirmed",
      slots,
    });

    // Every leg is the event itself, not evidence about it.
    for (const ref of frame.spine) {
      attach(db, event.id, {
        ref,
        role: "spine",
        probability: 1,
        logOdds: 9,
        margin: 1,
        features: [{ name: "spine", value: 1, contribution: 9 }],
        evidence: ["a leg of this journey"],
      });
    }

    born += 1;
  }

  // Plans: a proposal somebody agreed to.
  for (const row of db
    .prepare(`SELECT id, transcript, starts_at, title FROM episodes`)
    .all() as { id: string; transcript: string; starts_at: number; title: string | null }[]) {
    const ref: NodeRef = { kind: "episode", id: row.id };

    // Every proposal in the transcript, not the first. One conversation
    // arranging two things is one of the cases the old episode-shaped model
    // could not represent at all: the episode was the unit, so both plans
    // inherited the same anchors and fused.
    const bodies = itemsByBody(row.id);

    for (const plan of readPlans(row.transcript, row.starts_at, timezone, row.id)) {
      if (plan.time === null) {
        continue;
      }

      const itemFor = (quote: string): NodeRef => {
        const id = bodies.get(quote.trim());

        return id === undefined ? ref : { kind: "item", id };
      };

      const proposalRef = itemFor(plan.proposal);

      const people: SlotInput[] = plan.stances
        .filter((stance) => stance.verdict === "accept")
        .map((stance) => ({
          slot: "person" as const,
          value: `name:${stance.speaker.toLowerCase()}`,
          display: stance.speaker,
          confidence: stance.confidence,
          source: itemFor(stance.quote),
          quote: stance.quote,
          observedAt: plan.saidAt,
        }));

      createEvent(db, principalId, {
        kind: "occasion",
        title: plan.venuePhrases[0] ?? plan.activity ?? row.title,
        status: "proposed",
        slots: [
          {
            slot: "time",
            value: plan.time.value,
            display: plan.time.display,
            lower: plan.time.startsAt,
            upper: plan.time.endsAt,
            confidence: plan.time.confidence,
            // Open, not resolved. The conversation asked when; it did not
            // answer. Something else may, and an open slot is what makes that
            // possible rather than a guess that has to be overwritten.
            state: plan.time.kind === "vague" ? "open" : "resolved",
            source: proposalRef,
            quote: plan.proposal,
            observedAt: plan.saidAt,
          },
          ...people,
          {
            slot: "activity",
            value: plan.activity ?? "meeting",
            display: plan.proposal,
            confidence: 0.6,
            source: proposalRef,
            quote: plan.proposal,
            observedAt: plan.saidAt,
          },
        ],
      });

      born += 1;
    }
  }

  return born;
}

/**
 * Hard constraints, checked before anything is scored.
 *
 * A cannot-link is not a low score. It is a statement that no amount of
 * agreement elsewhere can make these one occurrence, and keeping it separate
 * from the weights is deliberate: a constraint that can be outvoted by enough
 * weak features is not a constraint.
 */
function cannotLink(a: Hypothesis, b: Hypothesis): string | null {
  // A cancelled event is closed. Whatever was arranged afterwards is a
  // different occurrence, however much it resembles the one that was called
  // off -- and it will resemble it closely, because it is usually the same
  // people rearranging the same evening.
  if ((a.status === "cancelled") !== (b.status === "cancelled")) {
    return "one of these was cancelled";
  }

  const refsOf = (event: Hypothesis): Set<string> =>
    new Set(event.slots.filter((slot) => slot.slot === "ref").map((slot) => slot.value));

  const left = refsOf(a);
  const right = refsOf(b);

  if (left.size > 0 && right.size > 0) {
    const shared = [...left].some((ref) => right.has(ref));

    if (!shared) {
      return "different confirmation codes";
    }
  }

  if (a.startsAt !== null && b.startsAt !== null) {
    const gap = Math.abs(a.startsAt - b.startsAt);
    const slack = Math.max(a.timeWidthMs ?? HOUR, b.timeWidthMs ?? HOUR);

    // A vague event and a precise one are not far apart merely because the
    // midpoint of a five hour window is not eight o'clock. The width is part of
    // the claim and has to be part of the comparison, or every event that
    // knows when it is refuses every conversation that does not.
    if (gap > Math.max(slack, RECURRENCE_GAP_MS)) {
      return "different occurrences";
    }
  }

  return null;
}

/**
 * Whether b states a time that answers an open question in a.
 *
 * Narrow inside wide, and only that direction. See the note at the call site.
 */
function answers(a: Hypothesis, b: Hypothesis): boolean {
  const open = a.slots.filter(
    (slot) => slot.slot === "time" && slot.state === "open" && slot.lower !== null,
  );

  const stated = b.slots.filter(
    (slot) => slot.slot === "time" && slot.state === "resolved" && slot.lower !== null,
  );

  for (const question of open) {
    const openWidth = (question.upper ?? 0) - (question.lower ?? 0);

    for (const answer of stated) {
      const width = (answer.upper ?? 0) - (answer.lower ?? 0);
      const middle = (answer.lower ?? 0) + width / 2;

      if (width < openWidth && middle >= (question.lower ?? 0) && middle <= (question.upper ?? 0)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Two events whose resolved times are the same moment.
 *
 * The same asymmetry `answers` uses, applied to two resolved slots: the
 * narrower interval's midpoint has to fall inside the wider one, and the
 * narrower one has to be precise enough to be worth believing.
 *
 * Bare overlap is not enough and the reason is the cancel-and-replace case. A
 * dinner proposed for "7" spans a quarter past six to a quarter to eight; a
 * replacement proposed for "8" spans a quarter past seven to a quarter to nine.
 * They overlap by half an hour, they are two different evenings, and every
 * feature they have agrees because it is the same people rearranging the same
 * night. Requiring one side to be booking-grade means two approximate times
 * never merge each other, which is correct: two guesses agreeing is not
 * evidence.
 */
const PRECISE_MS = 45 * 60_000;

function sameMoment(a: Hypothesis, b: Hypothesis): boolean {
  const resolved = (event: Hypothesis) =>
    event.slots.filter(
      (slot) => slot.slot === "time" && slot.state === "resolved" && slot.lower !== null,
    );

  for (const left of resolved(a)) {
    for (const right of resolved(b)) {
      const leftWidth = (left.upper ?? 0) - (left.lower ?? 0);
      const rightWidth = (right.upper ?? 0) - (right.lower ?? 0);

      const [narrow, wide] = leftWidth <= rightWidth ? [left, right] : [right, left];
      const narrowWidth = Math.min(leftWidth, rightWidth);

      if (narrowWidth > PRECISE_MS) {
        continue;
      }

      const middle = (narrow.lower ?? 0) + narrowWidth / 2;

      if (middle >= (wide.lower ?? 0) && middle <= (wide.upper ?? 0)) {
        return true;
      }
    }
  }

  return false;
}

function placesOf(event: Hypothesis): Set<string> {
  return new Set(
    event.slots.filter((slot) => slot.slot === "place" && slot.state === "resolved").map((slot) => slot.value),
  );
}

function peopleOf(event: Hypothesis): Set<string> {
  return new Set(event.slots.filter((slot) => slot.slot === "person").map((slot) => slot.value));
}

function overlaps(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  for (const value of a) {
    if (b.has(value)) {
      return true;
    }
  }

  return false;
}

/**
 * Merges hypotheses that are the same occurrence seen twice.
 *
 * A booking and the plan it confirms are one event described by two
 * observations, and birth cannot tell: it sees an assertion and makes a
 * hypothesis. Merging afterwards, under the same constraints that govern
 * everything else, is safer than trying to be clever about which assertions to
 * skip.
 */
function consolidate(db: DB, principalId: string): { merged: number; recurrences: number } {
  let merged = 0;
  let recurrences = 0;

  let events = [...liveEvents(db, principalId)];

  for (let i = 0; i < events.length; i += 1) {
    for (let j = i + 1; j < events.length; j += 1) {
      const a = events[i];
      const b = events[j];

      if (a === undefined || b === undefined) {
        continue;
      }

      const blocked = cannotLink(a, b);

      const sharePlace = overlaps(placesOf(a), placesOf(b));
      const sharePeople = overlaps(peopleOf(a), peopleOf(b));

      if (blocked !== null) {
        // Same place, same people, different time: a pattern, not an event.
        // Recorded as a link so the relationship is visible without either
        // event claiming the other's evidence.
        if (blocked === "different occurrences" && (sharePlace || sharePeople)) {
          link(db, b.id, a.id, "recurrence_of", "same place and people, a different occurrence");
          recurrences += 1;
        }

        continue;
      }

      // One answering the other's open question.
      //
      // A conversation says "later" and a confirmation says 8:00 PM. Neither
      // shares a word, a place or a person with the other, and one is plainly
      // an answer to the other. This is the same asymmetry the membership
      // scorer uses, applied between two hypotheses: a narrow interval falling
      // inside a wide one resolves it, and two wide intervals overlapping is a
      // coincidence every plan that evening shares.
      const resolvesEachOther = answers(a, b) || answers(b, a);

      // Or agreeing about when, precisely.
      //
      // Two resolved times that overlap, having already survived the
      // constraints above, are the same occurrence: a different booking would
      // have a different code, and a different occasion would be hours away.
      // This is what puts a chat that said "at 8 tonight" together with the
      // confirmation for eight o'clock, and a confirmation together with the
      // reminder mail that repeats it.
      const agreeOnTime = sameMoment(a, b);

      // Overlapping in time and agreeing on something specific.
      const sameRef = overlaps(
        new Set(a.slots.filter((s) => s.slot === "ref").map((s) => s.value)),
        new Set(b.slots.filter((s) => s.slot === "ref").map((s) => s.value)),
      );

      if (!sameRef && !sharePlace && !sharePeople && !resolvesEachOther && !agreeOnTime) {
        continue;
      }

      // Fold b into a: a keeps its id, gains b's slots, and b is gone.
      for (const slot of b.slots) {
        addSlot(db, a.id, {
          slot: slot.slot,
          value: slot.value,
          display: slot.display,
          lower: slot.lower,
          upper: slot.upper,
          confidence: slot.confidence,
          state: slot.state,
          source: slot.source,
          quote: slot.quote,
          observedAt: slot.observedAt,
        });
      }

      if (b.status === "confirmed" && a.status === "proposed") {
        setStatus(db, a.id, "confirmed");
      }

      if (a.title === null && b.title !== null) {
        db.prepare(`UPDATE events SET title = ? WHERE id = ?`).run(b.title, a.id);
      }

      db.prepare(`DELETE FROM events WHERE id = ?`).run(b.id);

      refreshTime(db, a.id);

      merged += 1;
      events = [...liveEvents(db, principalId)];
      i = -1;
      break;
    }
  }

  return { merged, recurrences };
}

/**
 * A cancellation ends the event it names.
 *
 * Matched on the confirmation code, which is the only join specific enough to
 * be safe: cancelling by venue and day would end the replacement booked twenty
 * minutes later at the same restaurant.
 */
function applyCancellations(db: DB, principalId: string): number {
  let cancelled = 0;

  const rows = db
    .prepare(
      `SELECT id, title, body, occurred_at FROM items
       WHERE kind = 'message' AND deleted_at IS NULL AND body IS NOT NULL`,
    )
    .all() as { id: string; title: string | null; body: string; occurred_at: number }[];

  for (const row of rows) {
    if (!/\bcancel(?:led|ed|lation)\b/i.test(`${row.title ?? ""} ${row.body}`)) {
      continue;
    }

    const ref: NodeRef = { kind: "item", id: row.id };

    const codes = anchorsOf(db, ref)
      .filter((anchor) => anchor.kind === "ref" && anchor.value.startsWith("confirmation:"))
      .map((anchor) => anchor.value);

    if (codes.length === 0) {
      continue;
    }

    for (const event of liveEvents(db, principalId)) {
      const held = event.slots.filter((slot) => slot.slot === "ref").map((slot) => slot.value);

      if (!codes.some((code) => held.includes(code))) {
        continue;
      }

      setStatus(db, event.id, "cancelled");

      attach(db, event.id, {
        ref,
        role: "cancellation",
        probability: 0.98,
        logOdds: 4,
        margin: 1,
        features: [{ name: "ref_shared", value: 1, contribution: 4 }],
        evidence: ["cancels this booking, by its confirmation code"],
      });

      cancelled += 1;
    }
  }

  return cancelled;
}

export interface InferOptions {
  readonly principalId: string;
  readonly timezone: string;
  readonly onNote?: ((message: string) => void) | undefined;
}

export function inferEvents(db: DB, options: InferOptions): InferReport {
  clearEvents(db, options.principalId);

  const noise = new NoiseIndex(db);
  const resolver = new NodeResolver(db);
  const weights = loadWeights(db);

  birth(db, options.principalId, options.timezone, noise);

  // Cancellations before consolidation, deliberately.
  //
  // A cancelled event has stopped accepting evidence, and that has to be true
  // before anything tries to fold hypotheses together. The other order fuses
  // a cancelled dinner at seven with the replacement booked for eight, because
  // the vague hour on the replacement overlaps the precise one on the dead
  // booking and nothing yet knows the first is dead.
  // Consolidate, then cancel, then consolidate again.
  //
  // The first pass puts each plan together with the booking that confirms it,
  // which has to happen before a cancellation can find the whole event rather
  // than only the mail with the code in it. The second pass runs with the
  // statuses known, so a cancelled evening can no longer absorb the
  // replacement arranged twenty minutes later.
  const first = consolidate(db, options.principalId);
  const cancelled = applyCancellations(db, options.principalId);
  const second = consolidate(db, options.principalId);

  const recurrences = first.recurrences + second.recurrences;

  const events = liveEvents(db, options.principalId);
  const claimed = new Set<string>();

  // Anything a hypothesis was born from is already its own evidence.
  for (const event of events) {
    for (const slot of event.slots) {
      if (slot.source !== null) {
        const key = nodeKey(slot.source);

        if (!claimed.has(key)) {
          attach(db, event.id, {
            ref: slot.source,
            role: "spine",
            probability: 1,
            logOdds: 9,
            margin: 1,
            features: [{ name: "spine", value: 1, contribution: 9 }],
            evidence: ["this is what says the event exists"],
          });

          claimed.add(key);
        }
      }
    }
  }

  // Which episodes each event already has message-level evidence from.
  //
  // An episode is a container, not an observation, so attaching one asserts
  // every message in it. Where an event's spine is individual messages -- which
  // is how a plan is built, so that two plans arranged in one conversation stay
  // two events -- letting the whole episode join afterwards puts the other
  // plan's messages back in, and the careful work of separating them is undone
  // in a single step.
  const episodesOf = new Map<string, Set<string>>();

  for (const event of liveEvents(db, options.principalId)) {
    const held = new Set<string>();

    for (const observation of db
      .prepare(
        `SELECT ei.episode_id AS id FROM event_observations eo
         JOIN episode_items ei ON ei.item_id = eo.node_id
         WHERE eo.event_id = ? AND eo.node_kind = 'item'`,
      )
      .all(event.id) as { id: string }[]) {
      held.add(observation.id);
    }

    episodesOf.set(event.id, held);
  }

  let attached = 0;
  let contested = 0;

  for (const candidate of corpus(db, noise, resolver)) {
    if (claimed.has(nodeKey(candidate.node.ref))) {
      continue;
    }

    const scores = events
      .filter(
        (event) =>
          event.startsAt === null ||
          Math.abs(event.startsAt - candidate.node.occurredAt) <= ENVELOPE_MS,
      )
      .filter(
        (event) =>
          candidate.node.ref.kind !== "episode" ||
          !(episodesOf.get(event.id)?.has(candidate.node.ref.id) ?? false),
      )
      .map((event) => {
        const { features, role } = featuresFor(candidate, event);

        return { event, scored: combine(features, weights, role) };
      })
      .sort((a, b) => b.scored.probability - a.scored.probability);

    const winner = scores[0];

    if (winner === undefined || winner.scored.probability < ADMIT) {
      continue;
    }

    const runnerUp = scores[1]?.scored.probability ?? 0;
    const margin = winner.scored.probability - runnerUp;

    if (scores.length > 1 && margin < MARGIN) {
      // Ambiguous, and recorded as such rather than guessed. This is the edge
      // through which two evenings would otherwise become one.
      contested += 1;
      continue;
    }

    attach(db, winner.event.id, {
      ref: candidate.node.ref,
      role: winner.scored.role,
      probability: winner.scored.probability,
      logOdds: winner.scored.logOdds,
      margin,
      features: winner.scored.features,
      evidence: winner.scored.evidence,
    });

    attached += 1;
  }

  for (const event of liveEvents(db, options.principalId)) {
    refreshTime(db, event.id);
  }

  options.onNote?.(
    `${String(events.length)} events, ${String(attached)} observations attached, ` +
      `${String(contested)} contested`,
  );

  return {
    events: liveEvents(db, options.principalId).length,
    attached,
    contested,
    recurrences,
    cancelled,
  };
}

export { EVENT_VERSION, load };
