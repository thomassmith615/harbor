/**
 * Drawing edges between two nodes.
 *
 * Every linker here is deterministic and every edge carries the reason it was
 * drawn. That is a deliberate constraint rather than a limitation of effort: a
 * graph over someone's entire correspondence is only trustworthy if a person
 * can read why any particular edge exists, and "the model thought so" fails
 * that test in a way that "these share a flight number" does not.
 *
 * A linker judges one pair at a time against a candidate set generated from the
 * whole store, and returns either an edge or the reason it declined. The
 * rejection is not decoration: `harbor why` is the only tool there is for "why
 * did Harbor not connect these two obviously related things", and a linker that
 * fails silently cannot answer it.
 *
 * The linkers are ordered by how much they claim. `same_thread` restates what
 * the source already told us. `shares_reference` requires an identifier both
 * carry. `arranges` requires people and a plausible window. `about_same`
 * requires distinctive shared vocabulary across a source boundary. `adjacent`
 * is the weakest and is confined to crossing a source boundary, because within
 * one source it would connect everything to everything.
 */
import type { Candidate } from "./candidates.js";
import type { GraphNode } from "../store/nodes.js";
import type { RelationshipInput } from "../store/relationships.js";
import type { TermIndex } from "./terms.js";

/**
 * Bump to redraw the whole graph. Independent of every other derivation.
 *
 * 3: nodes may be episodes, conversational messages are no longer subjects, and
 * `about_same` exists.
 */
export const RELATIONSHIP_VERSION = 3;

export interface LinkerContext {
  readonly principalId: string;
  readonly timezone: string;
  /** The entity that is the user, if resolution has found one. */
  readonly selfEntityId: string | null;
  readonly terms: TermIndex;
  /** Everyone on a node, the user excluded. Cached by the caller. */
  entitiesOf(node: GraphNode): ReadonlySet<string>;
}

/**
 * What a linker decided.
 *
 * `null` means the pair is not this linker's business at all (a linker about
 * reminders looking at two calendar events). A rejection means the pair was the
 * right shape and failed a test, which is the interesting case and the one
 * worth explaining.
 */
export type Judgement =
  | { readonly edge: RelationshipInput }
  | { readonly rejected: string }
  | null;

export interface PairLinker {
  readonly id: string;
  judge(subject: GraphNode, candidate: Candidate, context: LinkerContext): Judgement;
}

function sharedPeople(
  subject: GraphNode,
  candidate: GraphNode,
  context: LinkerContext,
): readonly string[] {
  const mine = context.entitiesOf(subject);
  const theirs = context.entitiesOf(candidate);

  return [...mine].filter((entity) => theirs.has(entity));
}

function describeGap(ms: number): string {
  const hours = Math.round(Math.abs(ms) / 3_600_000);

  if (hours < 24) {
    return `${String(Math.max(1, hours))} hours`;
  }

  return `${String(Math.round(hours / 24))} days`;
}

/**
 * Puts a pair in a known order by kind, or reports that it is not this shape.
 *
 * Candidate generation is symmetric, so a linker sees each pair from whichever
 * side happened to be pending. Without this, `arranges` would work when the
 * message was the subject and silently do nothing when the event was.
 *
 * `firstKind` and `secondKind` may each name several kinds, because a
 * conversation and an email are both things that can arrange a meeting.
 */
function orient(
  a: GraphNode,
  b: GraphNode,
  firstKinds: readonly string[],
  secondKinds: readonly string[],
): readonly [GraphNode, GraphNode] | null {
  if (firstKinds.includes(a.kind) && secondKinds.includes(b.kind)) {
    return [a, b];
  }

  if (firstKinds.includes(b.kind) && secondKinds.includes(a.kind)) {
    return [b, a];
  }

  return null;
}

const SAYS_SOMETHING = ["message", "conversation"];

/**
 * Same conversation, according to the source.
 *
 * The cheapest edge and the least interesting one. It earns its place by being
 * the scaffolding everything else hangs from: an email that arranges an event
 * pulls its reply chain in behind it.
 *
 * Only drawn between items the candidate generator found adjacent in the
 * thread, and never between conversational messages, which are not graph
 * subjects at all. That second restriction is what stopped this linker from
 * producing 99.7% of the edges in the store.
 */
const sameThread: PairLinker = {
  id: "same_thread",
  judge(subject, candidate) {
    if (subject.threadId === null || subject.threadId !== candidate.node.threadId) {
      return null;
    }

    if (subject.ref.kind !== "item" || candidate.node.ref.kind !== "item") {
      return null;
    }

    if (!candidate.via.includes("thread_adjacent")) {
      return { rejected: "same thread, but not the nearest item either side of it" };
    }

    return {
      edge: {
        from: subject.ref,
        to: candidate.node.ref,
        kind: "same_thread",
        confidence: 1,
        evidence: "the source puts these in one conversation",
        detector: "same_thread",
      },
    };
  },
};

/**
 * Both name the same arbitrary identifier.
 *
 * The strongest edge in the set. Two things do not share `AA4608` by
 * coincidence, and unlike everything else here it holds across any distance in
 * time, which is exactly what a booking made in March and a trip taken in
 * August need.
 *
 * The ceiling that stops a template string from connecting forty items lives in
 * the reference index, not here.
 */
const sharesReference: PairLinker = {
  id: "shares_reference",
  judge(subject, candidate) {
    const via = candidate.via.find((entry) => entry.startsWith("reference:"));

    if (via === undefined) {
      return null;
    }

    const value = via.slice("reference:".length);

    return {
      edge: {
        from: subject.ref,
        to: candidate.node.ref,
        kind: "shares_reference",
        confidence: 0.95,
        evidence: `both mention ${value}`,
        detector: "shares_reference",
      },
    };
  },
};

/** A message and an event may be at most this far apart to have arranged it. */
const ARRANGES_WINDOW_MS = 21 * 86_400_000;

/**
 * A message or conversation that appears to have arranged a calendar entry.
 *
 * The edge the product exists for: an intention expressed in conversation and a
 * commitment recorded on a calendar are the same thing in two systems, and
 * neither system knows about the other.
 *
 * The original test was people plus time, which is why it never fired. A
 * calendar entry someone typed for themselves has no attendees, so "the same
 * person is on both" is unsatisfiable for exactly the events that matter most.
 * Shared distinctive vocabulary now counts as evidence in its own right, and a
 * shared person raises confidence rather than being required.
 */
const arranges: PairLinker = {
  id: "arranges",
  judge(subject, candidate, context) {
    const pair = orient(subject, candidate.node, SAYS_SOMETHING, ["event"]);

    if (pair === null) {
      return null;
    }

    const [message, event] = pair;
    const gap = event.occurredAt - (message.endsAt ?? message.occurredAt);

    if (gap <= 0) {
      return { rejected: "the conversation happened after the event, so it did not arrange it" };
    }

    if (gap > ARRANGES_WINDOW_MS) {
      return {
        rejected: `${describeGap(gap)} before the event, past the window for arranging it`,
      };
    }

    const shared = sharedPeople(message, event, context);
    const words = sharedDistinctive(message, event, context.terms);

    // Naming the event is the strongest signal available and does not need a
    // person: an event called "Dinner at the Kearneys" mentioned in a text is
    // not a coincidence.
    const title = (event.title ?? "").toLowerCase().trim();
    const named = title.length > 6 && message.text.toLowerCase().includes(title);

    if (!named && words.length === 0 && shared.length === 0) {
      return { rejected: "nothing in common: no shared person, no shared distinctive word" };
    }

    if (named) {
      return {
        edge: {
          from: message.ref,
          to: event.ref,
          kind: "arranges",
          confidence: 0.85,
          evidence: `this names "${event.title ?? ""}", which is on the calendar ${describeGap(gap)} later`,
          detector: "arranges",
        },
      };
    }

    if (words.length > 0) {
      const strong = words.length > 1 || context.terms.frequency(words[0] ?? "") <= 3;

      return {
        edge: {
          from: message.ref,
          to: event.ref,
          kind: strong ? "arranges" : "mentions_when",
          confidence: strong ? 0.7 : 0.45,
          evidence:
            `both mention ${words.join(" and ")}, ${describeGap(gap)} before ` +
            `"${event.title ?? "the event"}"`,
          detector: "arranges",
        },
      };
    }

    return {
      edge: {
        from: message.ref,
        to: event.ref,
        kind: "mentions_when",
        confidence: 0.4,
        evidence: `same people, ${describeGap(gap)} before "${event.title ?? "the event"}"`,
        detector: "arranges",
      },
    };
  },
};

const TRACKS_WINDOW_MS = 21 * 86_400_000;

/**
 * A reminder covering the same commitment as something that was said.
 *
 * A reminder is the one item kind that is explicitly a commitment rather than
 * something that implies one, which makes it unusually good evidence. Matching
 * is on the words of the reminder appearing in the other node, which is crude
 * and works because reminders are short and specific.
 */
const tracks: PairLinker = {
  id: "tracks",
  judge(subject, candidate) {
    const pair = orient(subject, candidate.node, ["task"], [...SAYS_SOMETHING, "event"]);

    if (pair === null) {
      return null;
    }

    const [task, other] = pair;
    const gap = Math.abs(task.occurredAt - other.occurredAt);

    if (gap > TRACKS_WINDOW_MS) {
      return { rejected: `${describeGap(gap)} apart, past the window for a reminder` };
    }

    // Content words only. Matching on "the" would connect a reminder to every
    // message ever written.
    const words = (task.title ?? "")
      .toLowerCase()
      .split(/\W+/)
      .filter((word) => word.length > 4);

    if (words.length === 0) {
      return { rejected: "the reminder has no content words long enough to match on" };
    }

    const text = other.text.toLowerCase();
    const hits = words.filter((word) => text.includes(word));

    // Most of the reminder's content words, and at least two. One shared word
    // is a coincidence.
    if (hits.length < 2 || hits.length < words.length * 0.6) {
      return {
        rejected: `only ${String(hits.length)} of ${String(words.length)} words from the reminder appear`,
      };
    }

    return {
      edge: {
        from: task.ref,
        to: other.ref,
        kind: "tracks",
        confidence: 0.7,
        evidence: `the reminder "${task.title ?? ""}" and this share ${hits.join(", ")}`,
        detector: "tracks",
      },
    };
  },
};

/**
 * Words both nodes use that almost nothing else in the store does.
 *
 * Computed from the candidate's `via` entries rather than by re-reading both
 * texts, because the generator already established which term produced the
 * pair and re-deriving it would let the two disagree.
 */
function sharedDistinctive(
  subject: GraphNode,
  other: GraphNode,
  terms: TermIndex,
): readonly string[] {
  const text = other.text.toLowerCase();

  return terms.distinctive(subject.text).filter((term) => text.includes(term));
}

/** Two shared rare words, or one that is nearly unique, is a real signal. */
function isStrongOverlap(words: readonly string[], terms: TermIndex): boolean {
  if (words.length >= 2) {
    return true;
  }

  const only = words[0];

  return only !== undefined && terms.frequency(only) <= 3;
}

/**
 * Both are about the same distinctive subject, across a source boundary.
 *
 * The linker that makes the product thesis work, and the one that had no
 * equivalent before. Restricted to crossing a source boundary on purpose:
 * within one mailbox, shared vocabulary usually means two mails from the same
 * sender, which the thread already covers and which nobody needs Harbor for.
 * Across sources it means the thing Harbor exists to notice.
 */
const aboutSame: PairLinker = {
  id: "about_same",
  judge(subject, candidate, context) {
    if (subject.streamId === candidate.node.streamId) {
      return null;
    }

    if (!candidate.via.some((entry) => entry.startsWith("word:"))) {
      return null;
    }

    const words = sharedDistinctive(subject, candidate.node, context.terms);

    if (words.length === 0) {
      return { rejected: "the shared word is too common in your store to mean anything" };
    }

    if (!isStrongOverlap(words, context.terms)) {
      return {
        rejected: `only "${words[0] ?? ""}" in common, which appears in ${String(context.terms.frequency(words[0] ?? ""))} other things`,
      };
    }

    // Rarer words are better evidence, and this is the only place the weights
    // are used for anything: they scale confidence, they never rank.
    const weight = words.reduce((total, word) => total + context.terms.weight(word), 0);
    const confidence = Math.min(0.8, 0.4 + weight / 30);

    return {
      edge: {
        from: subject.ref,
        to: candidate.node.ref,
        kind: "about_same",
        confidence: Number(confidence.toFixed(2)),
        evidence: `both mention ${words.slice(0, 4).join(", ")}, from different sources`,
        detector: "about_same",
      },
    };
  },
};

const ADJACENT_WINDOW_MS = 2 * 3_600_000;

/**
 * Close in time, same people, different sources.
 *
 * The weakest edge, and confined to crossing a source boundary because within
 * one source it would connect every message to its neighbours and say nothing.
 * Across sources it says something real: a text and an email with the same
 * person twenty minutes apart are usually one exchange that moved channels.
 */
const adjacent: PairLinker = {
  id: "adjacent",
  judge(subject, candidate, context) {
    if (subject.streamId === candidate.node.streamId) {
      return null;
    }

    const gap = Math.abs(subject.occurredAt - candidate.node.occurredAt);

    if (gap > ADJACENT_WINDOW_MS) {
      return null;
    }

    const shared = sharedPeople(subject, candidate.node, context);

    if (shared.length === 0) {
      return { rejected: "close in time across sources, but no shared person other than you" };
    }

    return {
      edge: {
        from: subject.ref,
        to: candidate.node.ref,
        kind: "adjacent",
        confidence: 0.35,
        evidence: `same person, ${String(Math.max(1, Math.round(gap / 60_000)))} minutes apart, different sources`,
        detector: "adjacent",
      },
    };
  },
};

export const LINKERS: readonly PairLinker[] = [
  sameThread,
  sharesReference,
  arranges,
  tracks,
  aboutSame,
  adjacent,
];

export type { Candidate };
export type { RelationshipInput };
