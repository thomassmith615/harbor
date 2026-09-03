/**
 * Turning a plan somebody made into a frame, and then answering it.
 *
 * Two steps, and the order is the whole design.
 *
 * **Detection.** A conversation carrying a `plan` anchor is a frame, with a
 * span taken from whatever the conversation said about when. That span is
 * usually terrible: "later" is five hours wide. It is still a frame, because a
 * frame's job is to state what it is about and then be judged against, and "an
 * evening out with these three people, sometime after quarter to six" is a
 * perfectly good thing to judge candidates against.
 *
 * **Resolution.** Something else in the store states an hour that falls inside
 * that window. The plan stops being vague. The span narrows from five hours to
 * two, and everything downstream -- what counts as getting ready, what counts as
 * during, what the upcoming surface says -- becomes answerable.
 *
 * The resolver is never chosen on time alone. Every evening contains a dozen
 * nodes stating an hour, most of them newsletters and none of them about this.
 * A candidate has to state a time inside the window *and* be the kind of thing
 * that arranges an evening: a booking, a calendar entry, something naming the
 * venue, or something from one of the people going. Time says which; the second
 * test says whether.
 *
 * What this deliberately does not do is let a plan resolve itself. The
 * conversation that says "later" also says "the game is on at 9", and reading
 * the second as an answer to the first would have the plan confidently assert
 * nine o'clock. A plan's own episode is excluded from its resolvers, and the
 * cost is that an evening whose time was settled purely in the chat stays
 * vague, which is the honest reading of a conversation that never agreed one.
 */
import { anchorsFor } from "../store/anchors.js";
import { nodeKey, NodeResolver } from "../store/nodes.js";
import { clockOf, narrowing, resolves, type TimeHint } from "./timing.js";
import { venueTokens } from "./plans.js";
import type { DB } from "../kernel/db.js";
import type { NodeRef } from "../store/nodes.js";
import type { Anchor } from "./anchors.js";
import type { Frame, PlanDetail } from "./frames.js";
import type { NoiseIndex } from "./noise.js";

const MINUTE = 60_000;
const HOUR = 3_600_000;

/** How long an evening runs, once its start is known. */
const OCCASION_LENGTH_MS = 2 * HOUR;

/**
 * How long an unresolved plan is assumed to last.
 *
 * Its stated window, capped. "later" runs to two in the morning and treating
 * all of it as the occasion would mean everything said all evening counts as
 * happening during it, which is the flat-rate mistake `gather.ts` already
 * corrected once for trips.
 */
const VAGUE_CAP_MS = 3 * HOUR;

/** How far either side of a plan's window a resolver may sit. */
const RESOLVER_LEAD_MS = 8 * HOUR;

/**
 * A plan that nobody ever pinned down, and that is now in the past.
 *
 * A plan is a claim that something is *about* to happen. Left alone, an
 * unresolved one sits on the upcoming surface forever asserting an evening that
 * either happened without being recorded or never happened at all, and there is
 * no way to tell which. Harbor has been bitten by exactly this before: a single
 * unpaired flight in April made every question afterwards answer "away in
 * Boston" four months later, because the sentence never changed and nothing
 * about it looked wrong.
 */
const VAGUE_EXPIRY_MS = 18 * HOUR;

interface PlanSeed {
  readonly ref: NodeRef;
  readonly anchors: readonly Anchor[];
  readonly plan: Anchor;
  readonly occurredAt: number;
}

function hintFrom(anchor: Anchor): TimeHint | null {
  if (anchor.startsAt === null || anchor.endsAt === null) {
    return null;
  }

  return {
    value: anchor.value,
    display: anchor.display,
    startsAt: anchor.startsAt,
    endsAt: anchor.endsAt,
    kind: anchor.endsAt - anchor.startsAt <= 2 * HOUR ? "clock" : "vague",
    confidence: anchor.confidence,
  };
}

function goingOf(anchors: readonly Anchor[]): readonly { id: string; name: string }[] {
  const going = new Map<string, string>();

  for (const anchor of anchors) {
    if (anchor.kind === "going") {
      going.set(anchor.value, anchor.display);
    }
  }

  return [...going.entries()].map(([id, name]) => ({ id, name }));
}

/**
 * Whether a candidate is the sort of thing that settles an evening.
 *
 * The second half of the resolution rule, and the half that does the work.
 * Stating a time inside the window is what makes a candidate *possible*; this
 * is what makes it *probable*, and without it every mass mail mentioning an
 * hour would resolve every plan made that day.
 */
function corroborates(
  db: DB,
  candidate: readonly Anchor[],
  kind: string,
  plan: PlanDetail,
  going: ReadonlySet<string>,
  noise: NoiseIndex,
  ref: NodeRef,
): string | null {
  const booking = candidate.some(
    (anchor) =>
      anchor.kind === "ref" &&
      (anchor.value.startsWith("confirmation:") || anchor.value.startsWith("tracking:")),
  );

  if (booking) {
    return "is a booking";
  }

  if (kind === "event") {
    return "is on the calendar";
  }

  const wanted = new Set<string>();

  for (const phrase of plan.venuePhrases) {
    for (const token of venueTokens(phrase)) {
      wanted.add(token);
    }
  }

  for (const anchor of candidate) {
    if (anchor.kind !== "venue") {
      continue;
    }

    for (const token of venueTokens(anchor.value)) {
      if (wanted.has(token)) {
        return `names ${anchor.display}`;
      }
    }
  }

  for (const anchor of candidate) {
    if (anchor.kind === "person" && going.has(anchor.value)) {
      return `is from ${anchor.display}, who is going`;
    }
  }

  // Everything else has to be something, and a circular from a sender nobody
  // replies to is nothing. Checked last so the booking case above still gets
  // through: a reservation confirmation is mass mail by every structural test
  // there is, and it is the single most informative node in the evening.
  void db;
  void noise;
  void ref;

  return null;
}

interface Resolution {
  readonly ref: NodeRef;
  readonly hint: TimeHint;
  readonly why: string;
  readonly narrowing: number;
}

/**
 * The best answer to a plan's open question, if the store contains one.
 *
 * Ranked by how much it narrows rather than by how close it is. A confirmation
 * stating 8:00 PM narrows a five hour window to thirty minutes; a text saying
 * "tonight" narrows it not at all and is not a resolution however emphatic.
 */
function resolveTime(
  db: DB,
  frame: Frame,
  plan: PlanDetail,
  open: TimeHint,
  going: ReadonlySet<string>,
  resolver: NodeResolver,
  noise: NoiseIndex,
  tz: string,
): Resolution | null {
  const from = open.startsAt - RESOLVER_LEAD_MS;
  const to = open.endsAt + HOUR;

  const seen = new Set<string>();
  let best: Resolution | null = null;

  const consider = (ref: NodeRef): void => {
    const key = nodeKey(ref);

    if (seen.has(key) || key === `episode:${plan.episodeId}`) {
      return;
    }

    seen.add(key);

    const node = resolver.node(ref);

    if (node === null || node.occurredAt < from || node.occurredAt > to) {
      return;
    }

    if (ref.kind === "item" && noise.isRepeating(ref.id)) {
      return;
    }

    const anchors = anchorsFor(db, ref);

    for (const anchor of anchors) {
      if (anchor.kind !== "time_hint") {
        continue;
      }

      const stated = hintFrom(anchor);

      if (stated === null || !resolves(open, stated)) {
        continue;
      }

      const why = corroborates(db, anchors, node.kind, plan, going, noise, ref);

      if (why === null) {
        continue;
      }

      const gain = narrowing(open, stated);

      if (best === null || gain > best.narrowing) {
        best = { ref, hint: stated, why, narrowing: gain };
      }
    }
  };

  // Everything in the store that states any time of day in the window. The
  // anchor index makes this a lookup rather than a scan, which is the whole
  // reason time of day became an anchor kind rather than something read out of
  // text at comparison time.
  const rows = db
    .prepare(
      `SELECT DISTINCT a.node_kind AS kind, a.node_id AS id
       FROM node_anchors a
       WHERE a.kind = 'time_hint'
         AND a.starts_at IS NOT NULL
         AND a.starts_at BETWEEN @from AND @to`,
    )
    .all({ from: open.startsAt - HOUR, to: open.endsAt + HOUR }) as {
    kind: string;
    id: string;
  }[];

  for (const row of rows) {
    consider({ kind: row.kind as NodeRef["kind"], id: row.id });
  }

  void frame;
  void tz;

  return best;
}

export interface PlanFrameOptions {
  readonly since?: number | undefined;
  readonly timezone: string;
  readonly now?: number | undefined;
}

/**
 * Every plan in the store, as a frame, with its time answered where the store
 * can answer it.
 */
export function planFrames(
  db: DB,
  noise: NoiseIndex,
  options: PlanFrameOptions,
): readonly Frame[] {
  const resolver = new NodeResolver(db);
  const now = options.now ?? Date.now();
  const since = options.since ?? 0;

  const seeds: PlanSeed[] = [];

  const rows = db
    .prepare(
      `SELECT node_kind AS kind, node_id AS id FROM node_anchors WHERE kind = 'plan'`,
    )
    .all() as { kind: string; id: string }[];

  for (const row of rows) {
    const ref: NodeRef = { kind: row.kind as NodeRef["kind"], id: row.id };
    const node = resolver.node(ref);

    if (node === null || node.occurredAt < since) {
      continue;
    }

    const anchors = anchorsFor(db, ref);

    // Not merely the first `plan` anchor. The refinement pass writes a marker
    // of the same kind so it does not read a transcript twice, and the marker
    // sorts ahead of the real thing often enough that taking `find` gave a
    // frame with no window and no proposal underneath it.
    const plan = anchors.find(
      (anchor) => anchor.kind === "plan" && !anchor.value.startsWith("plan_read:"),
    );

    if (plan === undefined) {
      continue;
    }

    seeds.push({ ref, anchors, plan, occurredAt: node.occurredAt });
  }

  const frames: Frame[] = [];

  for (const seed of seeds) {
    const going = goingOf(seed.anchors);

    // A plan is two or more people. One person saying they will do something is
    // a commitment and `commitments.ts` already holds it; promoting it to an
    // occasion would put "buy milk" on the same surface as an evening out.
    if (going.length < 2) {
      continue;
    }

    // The plan anchor carries the window; the time_hint anchor carries the
    // words. Both are needed, and reading the display off the plan gives an
    // evidence line that quotes the proposal where it should quote the time:
    // *you said "who's going to the bar later", and this says 8:00 PM* is true
    // and explains nothing, where *you said "8ish"* is the whole argument.
    const spoken = seed.anchors.find(
      (anchor) =>
        anchor.kind === "time_hint" &&
        anchor.startsAt === seed.plan.startsAt &&
        anchor.endsAt === seed.plan.endsAt,
    );

    const open = hintFrom(spoken ?? seed.plan);

    const detail: PlanDetail = {
      episodeId: seed.ref.id,
      proposal: seed.plan.display,
      going,
      openedAt: seed.occurredAt,
      statedTime: open?.display ?? null,
      resolvedBy: null,
      resolvedDisplay: null,
      venuePhrases: seed.anchors
        .filter((anchor) => anchor.kind === "venue")
        .map((anchor) => anchor.display),
    };

    // A plan with no time at all is not a frame. There is nothing to hold open
    // and therefore nothing anything else could answer, and its span would be
    // a guess sitting on the upcoming surface looking like a fact.
    if (open === null) {
      continue;
    }

    const goingIds = new Set(going.map((person) => person.id));

    const resolution = resolveTime(
      db,
      { ...blank(seed, detail, open), plan: detail },
      detail,
      open,
      goingIds,
      resolver,
      noise,
      options.timezone,
    );

    if (resolution === null) {
      // Unresolved and already in the past. Nothing ever said when, and now
      // nothing ever will.
      if (open.endsAt + VAGUE_EXPIRY_MS < now) {
        continue;
      }

      frames.push(blank(seed, detail, open));
      continue;
    }

    const middle = resolution.hint.startsAt + (resolution.hint.endsAt - resolution.hint.startsAt) / 2;
    const startsAt = Math.round(middle / MINUTE) * MINUTE;

    const resolved: PlanDetail = {
      ...detail,
      resolvedBy: resolution.ref,
      resolvedDisplay: clockOf(startsAt, options.timezone),
      venuePhrases: [
        ...detail.venuePhrases,
        ...anchorsFor(db, resolution.ref)
          .filter((anchor) => anchor.kind === "venue")
          .map((anchor) => anchor.display),
      ],
    };

    const title = titleFor(resolved, db, resolution.ref);

    frames.push({
      key: `plan:${seed.ref.id}:${seed.plan.value}`,
      kind: "plan",
      title,
      place: null,
      placeDisplay: null,
      spanStartsAt: startsAt,
      spanEndsAt: startsAt + OCCASION_LENGTH_MS,
      // Both the conversation that made the plan and the thing that pinned it
      // down are the plan. Neither alone is: the chat never said when and the
      // confirmation never said who.
      spine: [seed.ref, resolution.ref],
      anchors: [
        ...seed.anchors,
        ...anchorsFor(db, resolution.ref).filter(
          (anchor) => anchor.kind === "venue" || anchor.kind === "ref" || anchor.kind === "place",
        ),
      ],
      openEnded: false,
      plan: resolved,
    });
  }

  return frames;
}

function blank(seed: PlanSeed, detail: PlanDetail, open: TimeHint): Frame {
  return {
    key: `plan:${seed.ref.id}:${seed.plan.value}`,
    kind: "plan",
    title: detail.venuePhrases[0] ?? "Plans",
    place: null,
    placeDisplay: null,
    spanStartsAt: open.startsAt,
    spanEndsAt: Math.min(open.endsAt, open.startsAt + VAGUE_CAP_MS),
    spine: [seed.ref],
    anchors: seed.anchors,
    openEnded: true,
    plan: detail,
  };
}

/**
 * What to call it.
 *
 * The venue, if anything named one, and otherwise the words somebody actually
 * wrote. No model is asked to invent a title here for the same reason
 * `name.ts` refuses to: a generated label outruns its evidence, and on a plan
 * the evidence is four words long.
 */
function titleFor(detail: PlanDetail, db: DB, resolvedBy: NodeRef): string {
  const named = detail.venuePhrases.find((phrase) => /[A-Z]/.test(phrase.slice(1)));

  if (named !== undefined) {
    return named;
  }

  const row = db.prepare(`SELECT title FROM items WHERE id = ?`).get(resolvedBy.id) as
    | { title: string | null }
    | undefined;

  const title = (row?.title ?? "").replace(/^(?:your|re:|fwd:)\s+/i, "").trim();

  return detail.venuePhrases[0] ?? (title.length > 0 ? title : "Plans");
}

export { OCCASION_LENGTH_MS };
