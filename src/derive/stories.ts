/**
 * The story pass.
 *
 * Four phases, in order, and the order is not negotiable.
 *
 *   1. Anchor every node that has not been anchored at this version. A node
 *      whose places and dates have not been extracted is invisible to every
 *      frame, so this runs to completion before a single frame is built.
 *
 *   2. Detect frames. Journeys pair into trips; the remaining calendar entries
 *      become occasions.
 *
 *   3. Gather. Each frame pulls evidence toward its own anchors, independently.
 *
 *   4. Settle competition, then carry identity forward.
 *
 * Phase 4 is the one that is easy to skip and expensive to skip. Frames gather
 * independently, so the same conversation can score well against two of them: a
 * text about dinner in Boston during the Boston trip belongs to both the trip
 * and the dinner. Left alone, that is how one node ends up in five stories and
 * the surface starts looking like it is padding. Each node goes to the frame it
 * scored highest against, ties broken toward the longer occasion, because the
 * containing thing is the more useful reading. A story that loses all its
 * gathered evidence to a stronger neighbour is dropped rather than shown empty.
 */
import { ANCHOR_VERSION, anchorsOf } from "./anchors.js";
import { STORY_VERSION, detectFrames } from "./frames.js";
import { gather } from "./gather.js";
import { pairProposals } from "./situations.js";
import { NoiseIndex } from "./noise.js";
import { addAnchors, anchorsFor } from "../store/anchors.js";
import { findPlace } from "../store/places.js";
import { resolvePlaces } from "./venues.js";
import { clockOf } from "./timing.js";
import { TermIndex } from "./terms.js";
import { NameIndex } from "./mentions.js";
import { NodeResolver, nodeKey } from "../store/nodes.js";
import { selfEntity } from "../store/entities.js";
import {
  countPendingAnchors,
  markAnchored,
  pendingAnchorNodes,
  replaceAnchors,
} from "../store/anchors.js";
import {
  deleteStory,
  digestOf,
  existingStories,
  newStoryId,
  saveStory,
} from "../store/stories.js";
import { rebuildPresence } from "./presence.js";
import type { DB } from "../kernel/db.js";
import type { NodeRef } from "../store/nodes.js";
import type { Frame } from "./frames.js";
import type { GatherResult, Member } from "./gather.js";
import type { StoryMember } from "../store/stories.js";
import type { PresenceReport } from "./presence.js";

const DAY = 86_400_000;

/** Nodes anchored per checkpoint. Only a checkpoint, not a batch of meaning. */
const ANCHOR_BATCH = 500;

export interface StoryOptions {
  readonly principalId: string;
  readonly timezone: string;
  /** Ignore anything whose occasion ended before this. */
  readonly since?: number | undefined;
  readonly shouldStop?: (() => boolean) | undefined;
  readonly onProgress?: ((done: number, total: number) => void) | undefined;
  readonly onNote?: ((message: string) => void) | undefined;
}

export interface StoryReport {
  readonly nodesAnchored: number;
  readonly anchorsWritten: number;
  readonly framesDetected: number;
  readonly trips: number;
  readonly occasions: number;
  /** Evenings read out of conversation, with no calendar entry behind them. */
  readonly plans: number;
  /** Of those, how many something else in the store pinned to an hour. */
  readonly plansResolved: number;
  readonly home: string | null;
  readonly storiesWritten: number;
  readonly carried: number;
  readonly created: number;
  readonly retired: number;
  readonly keptForState: number;
  readonly crossSource: number;
  readonly presence: PresenceReport;
  readonly durationMs: number;
}

/**
 * Anchoring, as its own resumable phase.
 *
 * Separated from the rest because it is the only expensive part on a cold store
 * and because it is versioned separately: a better gazetteer costs a re-anchor,
 * a better admission rule costs nothing but a rebuild of stories from anchors
 * already on disk.
 */
export function anchorNodes(
  db: DB,
  options: {
    /** Without this a time of day is read in UTC, which is a different evening. */
    readonly timezone?: string | undefined;
    readonly limit?: number | undefined;
    readonly shouldStop?: (() => boolean) | undefined;
    readonly onProgress?: ((done: number, total: number) => void) | undefined;
  } = {},
): { readonly nodes: number; readonly anchors: number } {
  const resolver = new NodeResolver(db);
  const terms = new TermIndex(db);
  const names = new NameIndex(db);

  const total = Math.min(
    countPendingAnchors(db, ANCHOR_VERSION),
    options.limit ?? Number.MAX_SAFE_INTEGER,
  );

  let done = 0;
  let written = 0;

  while (done < total) {
    if (options.shouldStop?.() === true) {
      break;
    }

    const refs = pendingAnchorNodes(db, ANCHOR_VERSION, Math.min(ANCHOR_BATCH, total - done));

    if (refs.length === 0) {
      break;
    }

    const work = db.transaction(() => {
      for (const ref of refs) {
        const node = resolver.node(ref);

        if (node === null) {
          continue;
        }

        const anchors = anchorsOf(db, node, { terms, names, timezone: options.timezone });
        replaceAnchors(db, ref, anchors);
        written += anchors.length;
      }

      markAnchored(db, refs, ANCHOR_VERSION);
    });

    work();

    done += refs.length;
    options.onProgress?.(done, total);
  }

  return { nodes: done, anchors: written };
}

/**
 * How much a story deserves attention.
 *
 * Breadth first, exactly as situations scored, because something touching three
 * sources is qualitatively different from something touching two. A trip
 * outranks an occasion of the same breadth: a trip is a week of someone's life
 * and a dinner is three hours, and if only one of them can be shown it should
 * be the one that reorganises the calendar around it.
 */
function salienceOf(
  kind: string,
  members: number,
  sources: number,
  spanStartsAt: number,
  now: number,
): number {
  const breadth = Math.min(0.8, (sources - 1) * 0.35);
  const size = Math.min(0.25, Math.log10(members + 1) * 0.15);
  // A trip reorganises a week and outranks everything. A plan is tonight, and
  // "tonight" is worth more than a dentist appointment in November precisely
  // because it is about to happen, which the nearness term already says.
  const weight = kind === "trip" ? 0.3 : kind === "plan" ? 0.1 : 0;

  // Symmetric around now: a trip next week matters as much as one last week,
  // and more than one six months ago in either direction.
  const days = Math.abs(now - spanStartsAt) / DAY;
  const nearness = Math.max(0, 0.4 - days * 0.006);

  return Number((breadth + size + weight + nearness).toFixed(4));
}

function titleFor(frame: Frame, members: readonly Member[], resolver: NodeResolver): string | null {
  if (frame.kind === "trip") {
    return frame.title;
  }

  if ((frame.title ?? "").trim().length > 2) {
    return frame.title;
  }

  for (const member of members) {
    const node = resolver.node(member.ref);

    if (node !== null && (node.title ?? "").trim().length > 3) {
      return node.title;
    }
  }

  return null;
}

interface Proposal {
  readonly frame: Frame;
  readonly members: readonly Member[];
  readonly nodes: readonly NodeRef[];
  readonly sourceCount: number;
  readonly startsAt: number;
  readonly endsAt: number;
  readonly title: string | null;
  readonly salience: number;
}

/**
 * One node, one story.
 *
 * Frames gather independently and therefore overlap. Resolving that here rather
 * than inside `gather` keeps each frame's scoring honest: a frame should judge a
 * candidate on its own merits and not on whether some other frame wanted it
 * more.
 *
 * A spine node is never taken away. A flight belongs to its trip even if a
 * conference occasion scored the same event higher, because the frame it
 * defines cannot survive losing it.
 */
function settleCompetition(results: readonly GatherResult[]): ReadonlyMap<string, Member[]> {
  const best = new Map<string, { frameKey: string; score: number; span: number }>();

  for (const result of results) {
    const span = result.frame.spanEndsAt - result.frame.spanStartsAt;

    for (const member of result.members) {
      const key = nodeKey(member.ref);
      const current = best.get(key);

      const wins =
        current === undefined ||
        member.role === "spine" ||
        member.score > current.score ||
        (member.score === current.score && span > current.span);

      if (wins && !(current !== undefined && current.score === 1 && member.role !== "spine")) {
        best.set(key, { frameKey: result.frame.key, score: member.score, span });
      }
    }
  }

  const assigned = new Map<string, Member[]>();

  for (const result of results) {
    const kept: Member[] = [];

    for (const member of result.members) {
      if (best.get(nodeKey(member.ref))?.frameKey === result.frame.key) {
        kept.push(member);
      }
    }

    assigned.set(result.frame.key, kept);
  }

  return assigned;
}

/**
 * The one sentence a plan is worth.
 *
 * Written from the frame's own fields and nothing else, so every clause in it
 * has a member underneath it that a person can open. "A group is going" would
 * be a summary; "Dave Mullen, Sam Ortiz and you, 8:00 PM" is a claim with
 * evidence attached to each half of it.
 */
function summaryOf(frame: Frame, tz: string): string | null {
  const plan = frame.plan;

  // Any frame carrying a plan, not only a frame whose kind is plan. When the
  // calendar also knows about the evening the occasion wins the spine and
  // absorbs the roster, and dropping the sentence at that point would mean the
  // better evidenced version of a story says less than the thinner one.
  if (plan === undefined) {
    return null;
  }

  const names = plan.going.filter((person) => !person.id.startsWith("name:me"));
  const listed = names.map((person) => (person.name.toLowerCase() === "me" ? "you" : person.name));

  const who =
    listed.length === 0
      ? "You"
      : listed.length === 1
        ? (listed[0] ?? "")
        : `${listed.slice(0, -1).join(", ")} and ${listed[listed.length - 1] ?? ""}`;

  const when = plan.resolvedBy === null
    ? (plan.statedTime === null ? null : `"${plan.statedTime}"`)
    : clockOf(frame.spanStartsAt, tz);

  const where = frame.title === null || frame.title === "Plans" ? null : ` to ${frame.title}`;

  return `${who} going${where ?? ""}${when === null ? "" : ` at ${when}`}.`;
}

/**
 * What the story layer learned, written back where the graph can see it.
 *
 * A plan says "the bar" and something else in the same evening says "Great
 * American Pub", and the plan layer works out that those are one evening by
 * resolving a time rather than by matching a word. That conclusion is real
 * evidence and it was being thrown away: the graph, which judges pairs on keys
 * they share, still saw two nodes with nothing in common.
 *
 * So the resolved place is added to the conversation as a second venue anchor,
 * beside the phrase somebody actually wrote. "the bar" is still not a place and
 * never becomes one; what is recorded is narrower and true: *this* conversation
 * was about *this* venue, on the evidence of the thing that pinned its time
 * down.
 *
 * The effect is that a conclusion reached once is available to every pass
 * afterwards, and the next `relate` can draw an edge between a group chat and a
 * reservation that share no word, no person and no identifier.
 */
function teachPlaces(db: DB, frames: readonly Frame[]): number {
  let written = 0;

  for (const frame of frames) {
    const plan = frame.plan;

    if (plan === undefined || plan.resolvedBy === null) {
      continue;
    }

    const ref: NodeRef = { kind: "episode", id: plan.episodeId };
    const held = anchorsFor(db, ref);

    for (const phrase of plan.venuePhrases) {
      const place = findPlace(db, phrase);

      if (place === null) {
        continue;
      }

      if (held.some((anchor) => anchor.kind === "venue" && anchor.value === place.entity.id)) {
        continue;
      }

      written += addAnchors(db, ref, [
        {
          kind: "venue",
          value: place.entity.id,
          display: place.entity.displayName,
          startsAt: null,
          endsAt: null,
          // Lower than a venue read directly out of text. This is a conclusion
          // rather than a reading, and the difference should be visible to
          // anything weighing it.
          confidence: 0.65,
        },
      ]);
    }
  }

  return written;
}

export function buildStories(db: DB, options: StoryOptions): StoryReport {
  const started = Date.now();
  const now = Date.now();

  const anchored = anchorNodes(db, {
    timezone: options.timezone,
    ...(options.shouldStop === undefined ? {} : { shouldStop: options.shouldStop }),
    ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
  });

  if (anchored.nodes > 0) {
    options.onNote?.(
      `${String(anchored.anchors)} anchors read from ${String(anchored.nodes)} things`,
    );
  }

  const noise = new NoiseIndex(db);
  const resolver = new NodeResolver(db);
  const terms = new TermIndex(db);
  const self = selfEntity(db);

  // Venues become places before frames are detected, and this call is here
  // rather than left to the `attributes` job for a reason worth writing down.
  //
  // Resolution rewrites a venue anchor to hold a place id instead of a phrase.
  // That is a *derived value living in an anchor*, and `dev stories --rebuild`
  // clears every anchor before recomputing them from text, which recreates the
  // phrase and silently destroys the resolution. The graph then loses every
  // edge that joined on a shared place, and the only symptom is fewer edges,
  // which is exactly the symptom this whole layer exists to fix.
  //
  // Ordering enforced in code beats ordering enforced in a runbook: anything
  // that rebuilds anchors now re-resolves them in the same pass, so there is no
  // sequence of commands that leaves the store half-resolved.
  const placed = resolvePlaces(db, {});

  if (placed.resolved > 0) {
    options.onNote?.(
      `${String(placed.resolved)} venue mentions resolved to ` +
        `${String(placed.created)} new places`,
    );
  }

  const detected = detectFrames(db, noise, {
    since: options.since,
    timezone: options.timezone,
  });

  const taught = teachPlaces(db, detected.frames);

  if (taught > 0) {
    options.onNote?.(
      `${String(taught)} conversations now name the place their plan resolved to`,
    );
  }

  if (detected.frames.length === 0) {
    options.onNote?.("nothing in the calendar looks like a journey or an occasion yet");
  } else {
    options.onNote?.(
      `${String(detected.report.trips)} journeys, ${String(detected.report.occasions)} occasions ` +
        `and ${String(detected.report.plans)} plans ` +
        `(${String(detected.report.plansResolved)} pinned to a time)`,
    );
  }

  const context = {
    resolver,
    noise,
    selfEntityId: self === null ? null : self.id,
    home: detected.report.home,
  };

  const results: GatherResult[] = [];

  for (const frame of detected.frames) {
    if (options.shouldStop?.() === true) {
      break;
    }

    results.push(gather(db, frame, context, terms.corpusSize));
  }

  const assigned = settleCompetition(results);

  const proposals: Proposal[] = [];

  for (const result of results) {
    const members = assigned.get(result.frame.key) ?? [];

    // A frame whose spine was taken by a stronger frame is not a story.
    const hasSpine = members.some((member) => member.role === "spine");

    if (!hasSpine || members.length < 2) {
      continue;
    }

    const streams = new Set<string>();
    let startsAt = result.frame.spanStartsAt;
    let endsAt = result.frame.spanEndsAt;

    for (const member of members) {
      const node = resolver.node(member.ref);

      if (node === null) {
        continue;
      }

      streams.add(node.streamId);
      startsAt = Math.min(startsAt, node.occurredAt);
      endsAt = Math.max(endsAt, node.endsAt ?? node.occurredAt);
    }

    proposals.push({
      frame: result.frame,
      members,
      nodes: members.map((member) => member.ref),
      sourceCount: streams.size,
      startsAt,
      endsAt,
      title: titleFor(result.frame, members, resolver),
      salience: salienceOf(
        result.frame.kind,
        members.length,
        streams.size,
        result.frame.spanStartsAt,
        now,
      ),
    });
  }

  // Identity, carried by membership overlap. Same matcher situations use,
  // deliberately: two implementations of "is this the same thing as before"
  // eventually disagree, and the disagreement is invisible until somebody's
  // dismissal comes back.
  const existing = existingStories(db, options.principalId);

  const paired = pairProposals(
    proposals.map((proposal) => ({ nodes: proposal.nodes })),
    existing.map((story) => ({ id: story.id, nodeKeys: story.nodeKeys })),
  );

  const byProposal = new Map<number, string>();
  const claimed = new Set<string>();

  for (const pairing of paired) {
    byProposal.set(pairing.proposalIndex, pairing.situationId);
    claimed.add(pairing.situationId);
  }

  const previous = new Map(existing.map((story) => [story.id, story]));

  let carried = 0;
  let created = 0;
  let crossSource = 0;

  // Which story each frame became, so a band on the timeline can open the
  // story it is. Without it, "where you have been" and "what happened" are two
  // lists a person has to join up by eye.
  const storyOf = new Map<string, string>();

  const write = db.transaction(() => {
    proposals.forEach((proposal, index) => {
      const matchedId = byProposal.get(index);
      const prior = matchedId === undefined ? undefined : previous.get(matchedId);
      const digest = digestOf(proposal.nodes);
      const id = matchedId ?? newStoryId();
      const changed = prior === undefined || prior.nodeDigest !== digest;

      storyOf.set(proposal.frame.key, id);

      if (prior === undefined) {
        created += 1;
      } else {
        carried += 1;
      }

      if (proposal.sourceCount > 1) {
        crossSource += 1;
      }

      const members: StoryMember[] = proposal.members.map((member) => ({
        ref: member.ref,
        role: member.role,
        score: member.score,
        evidence: member.contributions.map((contribution) => contribution.evidence),
      }));

      saveStory(
        db,
        {
          id,
          principalId: options.principalId,
          kind: proposal.frame.kind,
          // A title the person wrote is theirs, and no pass overwrites it.
          title: prior?.titleSource === "user" ? prior.title : proposal.title,
          titleSource: prior?.titleSource ?? "derived",
          // A plan says who and when in one sentence, built from the roster
          // and the resolved time rather than generated. `name.ts` refuses to
          // let a model write a title because a label outruns its evidence;
          // the same argument applies here and more sharply, because this
          // sentence names people and asserts they are going somewhere.
          summary: summaryOf(proposal.frame, options.timezone),
          place: proposal.frame.place,
          spanStartsAt: proposal.frame.spanStartsAt,
          spanEndsAt: proposal.frame.spanEndsAt,
          startsAt: proposal.startsAt,
          endsAt: proposal.endsAt,
          sourceCount: proposal.sourceCount,
          salience: proposal.salience,
          state: prior?.state ?? "open",
          firstSeenAt: prior?.firstSeenAt ?? now,
          lastChangedAt: changed ? now : (prior?.lastChangedAt ?? now),
          nodeDigest: digest,
          members,
        },
        now,
      );
    });
  });

  write();

  let retired = 0;
  let keptForState = 0;

  const sweep = db.transaction(() => {
    for (const story of existing) {
      if (claimed.has(story.id)) {
        continue;
      }

      // A decision the person made outranks the graph that produced it.
      // Deleting here is exactly how a dismissal silently comes back on the
      // next version bump.
      if (story.state !== "open" || story.titleSource === "user") {
        keptForState += 1;
        continue;
      }

      deleteStory(db, story.id);
      retired += 1;
    }
  });

  sweep();

  // Presence reads the frames as they ended up, not as they were detected.
  //
  // This one line is most of what "the layers should talk to each other" means
  // in practice. Gathering is where a frame finds out who it was with and where
  // it happened; handing presence the pre-gather frames meant the timeline was
  // built from a strictly worse picture than the stories on the same screen,
  // and every occasion that learned its location learned it too late to count.
  const presence = rebuildPresence(
    db,
    options.principalId,
    results.map((result) => result.frame),
    detected.report.home,
    now,
    storyOf,
  );

  return {
    nodesAnchored: anchored.nodes,
    anchorsWritten: anchored.anchors,
    framesDetected: detected.frames.length,
    trips: detected.report.trips,
    occasions: detected.report.occasions,
    plans: detected.report.plans,
    plansResolved: detected.report.plansResolved,
    home: detected.report.home,
    storiesWritten: proposals.length,
    carried,
    created,
    retired,
    keptForState,
    crossSource,
    presence,
    durationMs: Date.now() - started,
  };
}

// ---- explanation ----

export interface StoryExplanation {
  readonly frame: Frame;
  readonly members: readonly Member[];
  readonly rejected: GatherResult["rejected"];
}

/**
 * What a frame gathered and what it turned down.
 *
 * Runs the real detectors and the real scorer, writes nothing, and reports both
 * halves. The near misses are the useful half: "why is this not in my trip" is
 * the question a person actually asks, and a layer that can only show what it
 * did include cannot answer it.
 */
export function explainStory(
  db: DB,
  storyId: string,
  options: StoryOptions,
): StoryExplanation | null {
  const noise = new NoiseIndex(db);
  const resolver = new NodeResolver(db);
  const terms = new TermIndex(db);
  const self = selfEntity(db);

  // Venues become places before frames are detected, and this call is here
  // rather than left to the `attributes` job for a reason worth writing down.
  //
  // Resolution rewrites a venue anchor to hold a place id instead of a phrase.
  // That is a *derived value living in an anchor*, and `dev stories --rebuild`
  // clears every anchor before recomputing them from text, which recreates the
  // phrase and silently destroys the resolution. The graph then loses every
  // edge that joined on a shared place, and the only symptom is fewer edges,
  // which is exactly the symptom this whole layer exists to fix.
  //
  // Ordering enforced in code beats ordering enforced in a runbook: anything
  // that rebuilds anchors now re-resolves them in the same pass, so there is no
  // sequence of commands that leaves the store half-resolved.
  const placed = resolvePlaces(db, {});

  if (placed.resolved > 0) {
    options.onNote?.(
      `${String(placed.resolved)} venue mentions resolved to ` +
        `${String(placed.created)} new places`,
    );
  }

  const detected = detectFrames(db, noise, {
    since: options.since,
    timezone: options.timezone,
  });

  const taught = teachPlaces(db, detected.frames);

  if (taught > 0) {
    options.onNote?.(
      `${String(taught)} conversations now name the place their plan resolved to`,
    );
  }

  const members = db
    .prepare(`SELECT node_kind, node_id FROM story_nodes WHERE story_id = ? AND role = 'spine'`)
    .all(storyId) as { node_kind: string; node_id: string }[];

  const spineKeys = new Set(members.map((row) => `${row.node_kind}:${row.node_id}`));

  const frame = detected.frames.find((candidate) =>
    candidate.spine.some((ref) => spineKeys.has(nodeKey(ref))),
  );

  if (frame === undefined) {
    return null;
  }

  const result = gather(
    db,
    frame,
    {
      resolver,
      noise,
      selfEntityId: self === null ? null : self.id,
      explain: true,
    },
    terms.corpusSize,
  );

  // The enriched frame, not the detected one. What a person wants to see is
  // what the pass was actually reasoning against by the time it decided,
  // including the people and subjects it worked out for itself.
  return { frame: result.frame, members: result.members, rejected: result.rejected };
}

export { ANCHOR_VERSION, STORY_VERSION };
