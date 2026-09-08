/**
 * Deciding whether an observation is evidence about an event.
 *
 * ## What is wrong with adding points
 *
 * The old scorer added hand-set values (0.4 for a shared place, 0.45 for
 * sitting nearby in time, 0.5 for looking like preparation) and admitted
 * anything clearing 0.6 with two kinds of evidence. It works, it is readable,
 * and it has three properties that make it a dead end.
 *
 * It cannot express that something is evidence *against*. Every branch adds.
 * A stated time that contradicts the event's time, a decline, a different
 * confirmation code: none of them can subtract, so the only way to act on
 * negative evidence is a hard rejection somewhere else, which is why `admits`
 * grew a list of special cases that read as exceptions rather than as a model.
 *
 * The numbers do not compose. 0.4 plus 0.45 is 0.85 for no reason anybody can
 * defend; the units are not probabilities, not odds, not anything. Two weak
 * agreements outrank one strong one whenever the weights happen to say so.
 *
 * And they cannot be fitted. There is no procedure that takes labelled examples
 * and improves 0.45, because 0.45 is not a parameter of anything.
 *
 * ## What replaces it
 *
 * The same features, with the same sentences, combined in log-odds. Each
 * feature contributes `weight × value` to a sum, and a sigmoid turns the sum
 * into a probability. Three things follow immediately.
 *
 * Negative weights are ordinary. A contradiction is a feature with a large
 * negative weight, and one of them defeats several weak positives without any
 * special-case branch, because that is what adding logs does.
 *
 * The output means something. 0.8 is a claim that four out of five observations
 * scoring like this belong, which is a statement that can be checked against
 * the feedback table and found to be wrong.
 *
 * And the weights are data. They live in a table, seeded with stated priors,
 * and fitting them later is logistic regression over the stored feature vectors
 * with no change to any extraction code. The provenance improves rather than
 * degrades: an explanation now shows each feature's own contribution to the
 * final number instead of an unattributable 0.4.
 *
 * ## What has not changed
 *
 * Every feature is named, computed from stored anchors and slots, and carries a
 * sentence a person can check. Nothing here consults a model. The features that
 * a model helped produce (a stance, a resolved venue) arrived earlier as slots
 * with quotes attached, and this layer cannot tell the difference, which is the
 * point.
 */
import type { DB } from "../kernel/db.js";
import type { GraphNode } from "../store/nodes.js";
import type { Anchor } from "../derive/anchors.js";
import type { Hypothesis, Slot } from "./model.js";

const HOUR = 3_600_000;
const DAY = 86_400_000;

export interface Feature {
  readonly name: string;
  /** Usually 0 or 1; continuous where a degree is meaningful. */
  readonly value: number;
  /** The sentence shown to a person when this feature mattered. */
  readonly evidence: string;
}

export interface Scored {
  readonly probability: number;
  readonly logOdds: number;
  readonly features: readonly { name: string; value: number; contribution: number }[];
  readonly evidence: readonly string[];
  readonly role: string;
}

/**
 * Stated priors.
 *
 * Beliefs about how much each feature is worth, written where they can be seen
 * together and replaced by a fit. The magnitudes are in log-odds: 2.2 is about
 * nine to one, 4.6 about a hundred to one.
 *
 * The negative ones are the reason this file exists. `time_conflict` at -4 is
 * the statement that two incompatible stated times outweigh a shared venue, a
 * shared roster and a shared vocabulary put together, which is correct and
 * which the old scorer could not say at all.
 */
export const PRIORS: Readonly<Record<string, { weight: number; note: string }>> = {
  // Where every judgement starts.
  //
  // Most pairs of things in a store are unrelated, so the prior is against
  // belonging. Calibrated against the suite rather than chosen: at -3.2 a
  // reminder set fifteen minutes before a meeting could not join it, because
  // one strong feature could not overcome the prior and there is no second
  // feature a one-word reminder can offer.
  bias: { weight: -2.2, note: "most pairs of things are unrelated; start from no" },

  ref_shared: {
    weight: 4.6,
    note: "the same confirmation code is the strongest evidence available",
  },
  time_resolves: {
    weight: 3.0,
    note: "a narrow stated time falling inside an open one answers its question",
  },
  time_agrees: { weight: 2.6, note: "two resolved times within the hour" },
  place_same: { weight: 2.0, note: "the same place entity, not a similar phrase" },
  roster_member: { weight: 1.1, note: "from somebody who agreed to be there" },
  people_overlap: { weight: 1.3, note: "share the people involved" },
  // Enough on its own, and deliberately.
  //
  // Somebody who sets a reminder for the twenty minutes before a table they
  // booked has said what it is for by choosing that minute. No content rule
  // will ever match "wallet" to a pub, so if position cannot carry this alone
  // it cannot carry it at all.
  prep_window: { weight: 3.4, note: "set for shortly before a known start" },
  in_span: { weight: 1.0, note: "happened while it was happening" },
  topic_overlap: { weight: 0.8, note: "share a distinctive word" },
  party_size: { weight: 0.9, note: "the number of people matches the roster" },
  same_thread: { weight: 1.4, note: "the same conversation that arranged it" },

  time_conflict: {
    weight: -4.0,
    note: "states a time the event cannot have; defeats any number of similarities",
  },
  place_conflict: { weight: -3.4, note: "states a different place" },
  ref_conflict: { weight: -4.2, note: "carries a different confirmation code" },
  recurrence_gap: {
    weight: -3.6,
    note: "matches on everything except being a different occurrence",
  },
  cancelled: { weight: -2.5, note: "the event it would join has been called off" },
  broadcast: { weight: -1.2, note: "mass mail, which resembles everything" },
  distance: { weight: -0.9, note: "far enough away in time to need a reason" },
};

export interface WeightSet {
  get(feature: string): number;
}

/**
 * Loads the weights, seeding the priors on first use.
 *
 * Read from the table rather than the constant, always, so that a fitted set
 * takes effect without a code change and so that what actually ran can be
 * reconstructed from the store afterwards.
 */
export function loadWeights(db: DB, model = "membership.v1"): WeightSet {
  const rows = db
    .prepare(`SELECT feature, weight FROM model_weights WHERE model = ?`)
    .all(model) as { feature: string; weight: number }[];

  if (rows.length === 0) {
    const insert = db.prepare(
      `INSERT OR REPLACE INTO model_weights (model, feature, weight, origin, note, updated_at)
       VALUES (?, ?, ?, 'prior', ?, ?)`,
    );

    for (const [feature, prior] of Object.entries(PRIORS)) {
      insert.run(model, feature, prior.weight, prior.note, Date.now());
    }

    return loadWeights(db, model);
  }

  const held = new Map(rows.map((row) => [row.feature, row.weight]));

  return { get: (feature) => held.get(feature) ?? 0 };
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

export function combine(features: readonly Feature[], weights: WeightSet, role: string): Scored {
  let logOdds = weights.get("bias");

  const contributions = features.map((feature) => {
    const contribution = weights.get(feature.name) * feature.value;

    logOdds += contribution;

    return { name: feature.name, value: feature.value, contribution };
  });

  return {
    probability: sigmoid(logOdds),
    logOdds,
    features: contributions,
    // Only features that actually moved the number get a sentence. A list
    // including every term that scored zero is a worse explanation than one
    // naming the three that decided it.
    evidence: features
      .filter((feature) => Math.abs(weights.get(feature.name) * feature.value) > 0.2)
      .map((feature) => feature.evidence),
    role,
  };
}

/* -------------------------------------------------------------------------
 * Feature extraction.
 * ---------------------------------------------------------------------- */

export interface Candidate {
  readonly node: GraphNode;
  readonly anchors: readonly Anchor[];
  readonly threadId: string | null;
  readonly broadcast: boolean;
}

function intervalsOverlap(a: Slot, b: { lower: number; upper: number }): boolean {
  return (a.lower ?? 0) <= b.upper && (a.upper ?? 0) >= b.lower;
}

function timeAnchors(anchors: readonly Anchor[]): readonly { lower: number; upper: number; display: string }[] {
  return anchors
    .filter((anchor) => anchor.kind === "time_hint" && anchor.startsAt !== null && anchor.endsAt !== null)
    .map((anchor) => ({
      lower: anchor.startsAt ?? 0,
      upper: anchor.endsAt ?? 0,
      display: anchor.display,
    }));
}

function refs(anchors: readonly Anchor[]): readonly string[] {
  return anchors
    .filter((anchor) => anchor.kind === "ref" && anchor.value.startsWith("confirmation:"))
    .map((anchor) => anchor.value);
}

function places(anchors: readonly Anchor[]): readonly Anchor[] {
  return anchors.filter((anchor) => anchor.kind === "venue" && anchor.value.startsWith("e_"));
}

/**
 * Every feature that fires between one candidate and one event.
 *
 * Returns the role alongside, because what an observation *is* to an event
 * (the thing itself, preparation, aftermath, the booking) is a different
 * question from whether it belongs, and conflating them is how a reminder set
 * twenty minutes beforehand ended up scored as though it happened during.
 */
export function featuresFor(candidate: Candidate, event: Hypothesis): {
  features: readonly Feature[];
  role: string;
} {
  const features: Feature[] = [];

  const eventRefs = new Set(
    event.slots.filter((slot) => slot.slot === "ref" && slot.state !== "contradicted").map((slot) => slot.value),
  );

  const candidateRefs = refs(candidate.anchors);

  if (candidateRefs.some((ref) => eventRefs.has(ref))) {
    features.push({
      name: "ref_shared",
      value: 1,
      evidence: `carries the same confirmation as this booking`,
    });
  } else if (candidateRefs.length > 0 && eventRefs.size > 0) {
    // A different code for the same kind of thing is a strong signal that this
    // is a different booking, which is the duplicate-versus-distinct problem.
    features.push({
      name: "ref_conflict",
      value: 1,
      evidence: `carries a different confirmation code`,
    });
  }

  // Time.
  const resolvedTimes = event.slots.filter(
    (slot) => slot.slot === "time" && slot.state === "resolved" && slot.lower !== null,
  );

  const openTimes = event.slots.filter(
    (slot) => slot.slot === "time" && slot.state === "open" && slot.lower !== null,
  );

  const stated = timeAnchors(candidate.anchors);

  let timeHandled = false;

  for (const open of openTimes) {
    const openWidth = (open.upper ?? 0) - (open.lower ?? 0);

    for (const claim of stated) {
      const width = claim.upper - claim.lower;
      const middle = claim.lower + width / 2;

      // The asymmetry that makes vague language usable: a narrow interval
      // inside a wide one is an answer to it, and two wide intervals
      // overlapping is a coincidence that every plan on a Thursday shares.
      if (width < openWidth && middle >= (open.lower ?? 0) && middle <= (open.upper ?? 0)) {
        features.push({
          name: "time_resolves",
          value: 1,
          evidence: `you said "${open.display}", and this says ${claim.display}`,
        });

        timeHandled = true;
      }
    }
  }

  for (const resolved of resolvedTimes) {
    for (const claim of stated) {
      if (intervalsOverlap(resolved, claim)) {
        if (!timeHandled) {
          features.push({
            name: "time_agrees",
            value: 1,
            evidence: `states ${claim.display}, which is when this is`,
          });

          timeHandled = true;
        }
      } else if (
        Math.abs(claim.lower - (resolved.lower ?? 0)) < 3 * DAY &&
        Math.abs(claim.lower - (resolved.lower ?? 0)) > 2 * HOUR
      ) {
        // Near enough to be about the same day and far enough to be a
        // different occasion. A week away is not a conflict, it is unrelated.
        features.push({
          name: "time_conflict",
          value: 1,
          evidence: `says ${claim.display}, which this is not`,
        });
      }
    }
  }

  // Place.
  const eventPlaces = new Set(
    event.slots.filter((slot) => slot.slot === "place" && slot.state === "resolved").map((slot) => slot.value),
  );

  const candidatePlaces = places(candidate.anchors);

  const sharedPlace = candidatePlaces.find((anchor) => eventPlaces.has(anchor.value));

  if (sharedPlace !== undefined) {
    features.push({
      name: "place_same",
      value: 1,
      evidence: `both about ${sharedPlace.display}`,
    });
  } else if (candidatePlaces.length > 0 && eventPlaces.size > 0) {
    features.push({
      name: "place_conflict",
      value: 1,
      evidence: `about ${candidatePlaces[0]?.display ?? "somewhere else"} instead`,
    });
  }

  // People.
  const roster = new Set(
    event.slots.filter((slot) => slot.slot === "person" && slot.state === "resolved").map((slot) => slot.value),
  );

  const candidatePeople = candidate.anchors.filter((anchor) => anchor.kind === "person");
  const shared = candidatePeople.filter((anchor) => roster.has(anchor.value));

  if (shared.length > 0 && roster.size > 0) {
    features.push({
      name: "people_overlap",
      value: Math.min(1, shared.length / roster.size),
      evidence: `involves ${shared
        .slice(0, 3)
        .map((anchor) => anchor.display)
        .join(", ")}`,
    });
  }

  const going = new Set(
    event.slots.filter((slot) => slot.slot === "person" && slot.confidence >= 0.7).map((slot) => slot.value),
  );

  if (candidatePeople.some((anchor) => going.has(anchor.value))) {
    features.push({
      name: "roster_member",
      value: 1,
      evidence: `from somebody who is going`,
    });
  }

  // Where it sits, relative to when the event is.
  const start = event.startsAt;
  let role = "context";

  if (start !== null) {
    const before = start - candidate.node.occurredAt;
    const width = event.timeWidthMs ?? HOUR;

    if (before > 0 && before <= 2 * HOUR && candidate.node.kind === "task") {
      features.push({
        name: "prep_window",
        value: 1,
        evidence: `set for ${String(Math.round(before / 60_000))} minutes before it starts`,
      });

      role = "preparation";
    } else if (Math.abs(candidate.node.occurredAt - start) <= Math.max(width, 2 * HOUR)) {
      features.push({ name: "in_span", value: 1, evidence: `happened while it was happening` });
      role = "during";
    } else {
      const days = Math.abs(candidate.node.occurredAt - start) / DAY;

      if (days > 1) {
        features.push({
          name: "distance",
          value: Math.min(3, days / 7),
          evidence: `${String(Math.round(days))} days away`,
        });
      }

      role = before > 0 ? "planning" : "aftermath";
    }
  }

  // Words the event and the candidate share.
  //
  // The weakest feature here and the one that most needs the others: a shared
  // rare word alone admitted most of the old relationship graph. It earns its
  // place by carrying cases where nothing structural is available, such as a
  // mail proposing a meeting that a calendar entry then records under the same
  // name.
  const eventWords = new Set(
    `${event.title ?? ""} ${event.slots.map((slot) => slot.display).join(" ")}`
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length >= 5),
  );

  const sharedWords = [
    ...new Set(
      `${candidate.node.title ?? ""} ${candidate.node.text}`
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((word) => word.length >= 5 && eventWords.has(word)),
    ),
  ];

  if (sharedWords.length > 0) {
    features.push({
      name: "topic_overlap",
      value: Math.min(1, sharedWords.length / 2),
      evidence: `both mention ${sharedWords.slice(0, 2).join(" and ")}`,
    });
  }

  if (candidate.broadcast) {
    features.push({ name: "broadcast", value: 1, evidence: `mass mail` });
  }

  if (event.status === "cancelled") {
    features.push({ name: "cancelled", value: 1, evidence: `this was called off` });
  }

  return { features, role };
}
