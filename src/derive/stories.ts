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

        const anchors = anchorsOf(db, node, { terms, names });
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
  const weight = kind === "trip" ? 0.3 : 0;

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

export function buildStories(db: DB, options: StoryOptions): StoryReport {
  const started = Date.now();
  const now = Date.now();

  const anchored = anchorNodes(db, {
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

  const detected = detectFrames(db, noise, { since: options.since });

  if (detected.frames.length === 0) {
    options.onNote?.("nothing in the calendar looks like a journey or an occasion yet");
  } else {
    options.onNote?.(
      `${String(detected.report.trips)} journeys and ${String(detected.report.occasions)} occasions`,
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
          summary: null,
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

  const detected = detectFrames(db, noise, { since: options.since });

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
