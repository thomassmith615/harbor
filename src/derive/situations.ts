/**
 * Carrying a situation's identity across a rebuild.
 *
 * The relate pass produces *proposals*: connected components of the edge graph
 * that passed the breadth, spine, and ceiling tests in threads.ts. Those are
 * recomputed from scratch every pass and they are correct to recompute, because
 * an edge drawn today can legitimately change what belongs together.
 *
 * What must not be recomputed is which situation a proposal *is*. A person who
 * renamed something, dismissed it, or read an id off a digest is holding a
 * reference, and a reference that expires the moment one more text arrives is
 * not a reference at all.
 *
 * So this file is the seam. Proposals in, durable situations out, and the only
 * thing it decides is identity.
 *
 * ## The rule
 *
 * A proposal claims an existing situation when they overlap enough to be the
 * same real-world thing:
 *
 *   at least MIN_SHARED nodes in common, and
 *   that overlap is at least MIN_RATIO of whichever side is smaller
 *
 * Smaller side, not larger, and that asymmetry is the point. A situation that
 * doubles in size is still the same weekend; the two nodes that started it are
 * still in there. A situation that shares two nodes with something four times
 * its size and nothing else is a different thing that happens to touch it.
 *
 * Both sides are matched greedily by descending overlap, and each side is
 * consumed once. That handles the three cases that actually occur:
 *
 *   **Growth.** One proposal, one existing. Overlap is the whole of the old
 *   set. Same id, membership updated, `last_changed_at` moves.
 *
 *   **Merge.** One proposal covers two existing situations, because a new edge
 *   joined them. The larger overlap wins the id and the other is absorbed. The
 *   loser's row is removed unless the person had touched it, in which case it
 *   is kept as a tombstone (see below).
 *
 *   **Split.** Two proposals both overlap one existing situation, because an
 *   edge was withdrawn or a linker version changed. The larger overlap keeps
 *   the id; the other is genuinely new and gets a new one.
 *
 * ## What happens to a situation nobody proposed
 *
 * This is the case where it would be easy to be wrong in a way nobody notices.
 *
 * If Harbor derived it and the person never touched it, it is deleted. It was
 * an opinion, the opinion changed, and leaving stale opinions lying around is
 * how a store becomes a landfill.
 *
 * If the person *did* touch it (renamed, resolved, dismissed), the row is kept
 * with its membership, marked `state_changed_at` untouched, and it stops being
 * proposed. A dismissal has to outlive the graph that produced it, or the first
 * linker version bump quietly un-dismisses everything.
 *
 * ## Dismissed situations do not reopen on their own
 *
 * A dismissed situation that grows stays dismissed. It would be easy to argue
 * the opposite: new information arrived, surely that is worth another look. But
 * the whole failure mode this milestone exists to fix is Harbor re-raising
 * things you already dealt with, and "it grew" is true of every live situation
 * every single day. Reopening is a decision, and it belongs to the person:
 * `harbor situations reopen <id>`.
 */
import { setThreadSummary } from "../store/relationships.js";
import { createHash, randomBytes } from "node:crypto";
import { nodeKey } from "../store/nodes.js";
import {
  deleteThread,
  existingSituations,
  saveThread,
  type ExistingSituation,
  type ThreadInput,
} from "../store/relationships.js";
import type { DB } from "../kernel/db.js";
import type { NodeRef } from "../store/nodes.js";

/** Fewer shared nodes than this is a coincidence, not continuity. */
const MIN_SHARED = 2;

/**
 * How much of the smaller side has to be shared.
 *
 * A half rather than a two-thirds because situations grow in lumps: a
 * conversation gets segmented differently after a re-derive and half its
 * episode nodes are replaced while it is unmistakably the same weekend. Set
 * higher and that reads as a brand new situation, which is the failure this
 * whole file exists to prevent.
 */
const MIN_RATIO = 0.5;

export interface SituationProposal {
  readonly principalId: string;
  readonly title: string | null;
  readonly kind: string;
  readonly nodes: readonly NodeRef[];
  readonly startsAt: number | null;
  readonly endsAt: number | null;
  readonly sourceCount: number;
  readonly salience: number;
}

export interface ReconcileReport {
  readonly proposed: number;
  /** Proposals that matched an existing situation and kept its id. */
  readonly carried: number;
  /** Of those, how many actually changed membership. */
  readonly changed: number;
  readonly created: number;
  /** Existing situations absorbed into another by a merge. */
  readonly merged: number;
  /** Derived, unclaimed, and removed. */
  readonly retired: number;
  /** Unclaimed but kept because the person had made a decision about them. */
  readonly keptForState: number;
}

/** A membership fingerprint. Not an id; just a cheap change detector. */
export function digestOf(nodes: readonly NodeRef[]): string {
  return createHash("sha256").update(nodes.map(nodeKey).sort().join("|")).digest("hex").slice(0, 16);
}

/**
 * A new id.
 *
 * Random, and deliberately not derived from anything. Every previous attempt at
 * deriving it from contents produced an identity that changed when the contents
 * did, which is the one property an identity may not have.
 */
export function newSituationId(): string {
  return `sit_${randomBytes(8).toString("hex")}`;
}

interface Pairing {
  readonly proposalIndex: number;
  readonly situationId: string;
  readonly shared: number;
  readonly ratio: number;
}

/**
 * Which proposal is which existing situation.
 *
 * Exported and pure so it can be tested without a database, because this is the
 * function whose mistakes are invisible: a wrong pairing looks exactly like a
 * correct one until somebody notices a dismissal came back three weeks later.
 */
export function pairProposals(
  proposals: readonly { readonly nodes: readonly NodeRef[] }[],
  existing: readonly { readonly id: string; readonly nodeKeys: ReadonlySet<string> }[],
): readonly Pairing[] {
  const candidates: Pairing[] = [];

  proposals.forEach((proposal, proposalIndex) => {
    const keys = new Set(proposal.nodes.map(nodeKey));

    for (const situation of existing) {
      let shared = 0;

      for (const key of keys) {
        if (situation.nodeKeys.has(key)) {
          shared += 1;
        }
      }

      if (shared < MIN_SHARED) {
        continue;
      }

      const smaller = Math.min(keys.size, situation.nodeKeys.size);
      const ratio = smaller === 0 ? 0 : shared / smaller;

      if (ratio < MIN_RATIO) {
        continue;
      }

      candidates.push({ proposalIndex, situationId: situation.id, shared, ratio });
    }
  });

  // Best first, and each side consumed once. Ties break on ratio and then on id
  // so that two runs over the same data pair the same way; a matcher that is
  // not deterministic would make every bug here unreproducible.
  candidates.sort(
    (a, b) =>
      b.shared - a.shared ||
      b.ratio - a.ratio ||
      a.situationId.localeCompare(b.situationId) ||
      a.proposalIndex - b.proposalIndex,
  );

  const takenProposals = new Set<number>();
  const takenSituations = new Set<string>();
  const paired: Pairing[] = [];

  for (const candidate of candidates) {
    if (takenProposals.has(candidate.proposalIndex) || takenSituations.has(candidate.situationId)) {
      continue;
    }

    takenProposals.add(candidate.proposalIndex);
    takenSituations.add(candidate.situationId);
    paired.push(candidate);
  }

  return paired;
}

/**
 * Writes this pass's proposals, preserving identity wherever it can be shown.
 *
 * Replaces the old clear-and-rewrite. Nothing else in the relate pass changes:
 * edges, components, and every test in threads.ts are untouched.
 */
export function reconcileSituations(
  db: DB,
  principalId: string,
  proposals: readonly SituationProposal[],
  now: number = Date.now(),
): ReconcileReport {
  const existing = existingSituations(db, principalId);

  const paired = pairProposals(
    proposals,
    existing.map((situation) => ({ id: situation.id, nodeKeys: situation.nodeKeys })),
  );

  const byProposal = new Map<number, string>();
  const claimed = new Set<string>();

  for (const pairing of paired) {
    byProposal.set(pairing.proposalIndex, pairing.situationId);
    claimed.add(pairing.situationId);
  }

  const previous = new Map<string, ExistingSituation>();

  for (const situation of existing) {
    previous.set(situation.id, situation);
  }

  let carried = 0;
  let changed = 0;
  let created = 0;

  const write = db.transaction(() => {
    proposals.forEach((proposal, index) => {
      const matchedId = byProposal.get(index);
      const prior = matchedId === undefined ? undefined : previous.get(matchedId);
      const digest = digestOf(proposal.nodes);

      const id = matchedId ?? newSituationId();
      const membershipChanged = prior === undefined || prior.nodeDigest !== digest;

      if (prior === undefined) {
        created += 1;
      } else {
        carried += 1;

        if (membershipChanged) {
          changed += 1;
        }
      }

      const input: ThreadInput = {
        id,
        principalId: proposal.principalId,
        // A title the person wrote is theirs. Harbor may improve a title it
        // chose itself; it may not overwrite one it was given.
        title: prior?.titleSource === "user" ? prior.title : proposal.title,
        titleSource: prior?.titleSource ?? "derived",
        kind: proposal.kind,
        nodes: proposal.nodes,
        startsAt: proposal.startsAt,
        endsAt: proposal.endsAt,
        sourceCount: proposal.sourceCount,
        salience: proposal.salience,
        nodeDigest: digest,
        firstSeenAt: prior?.firstSeenAt ?? now,
        lastChangedAt: membershipChanged ? now : (prior?.lastChangedAt ?? now),
        // Never written by a pass. The person owns this column.
        state: prior?.state ?? "open",
        stateChangedAt: prior?.stateChangedAt ?? null,
        updatedAt: now,
      };

      saveThread(db, input);

      // A summary describes a set of members. When that set changes the
      // sentence is about something that no longer exists, so it goes, and the
      // naming pass writes a new one on its next run.
      if (membershipChanged) {
        setThreadSummary(db, id, null);
      }
    });

    return null;
  });

  write();

  // Whether an unclaimed situation's nodes live on inside some proposal. If
  // they do it was absorbed by a merge; if they do not it genuinely dissolved.
  // Only the reporting differs, but conflating the two would make a merge look
  // like data loss in the one place somebody would go to check.
  const proposedKeys = new Set<string>();

  for (const proposal of proposals) {
    for (const ref of proposal.nodes) {
      proposedKeys.add(nodeKey(ref));
    }
  }

  let merged = 0;
  let retired = 0;
  let keptForState = 0;

  const sweep = db.transaction(() => {
    for (const situation of existing) {
      if (claimed.has(situation.id)) {
        continue;
      }

      // The person made a decision about this one. The graph no longer agrees
      // it exists, and the decision still outranks the graph: deleting it here
      // is exactly how a dismissal silently becomes un-dismissed on the next
      // linker version bump.
      if (situation.state !== "open" || situation.titleSource === "user") {
        keptForState += 1;
        continue;
      }

      let survives = false;

      for (const key of situation.nodeKeys) {
        if (proposedKeys.has(key)) {
          survives = true;
          break;
        }
      }

      deleteThread(db, situation.id);

      if (survives) {
        merged += 1;
      } else {
        retired += 1;
      }
    }
  });

  sweep();

  return {
    proposed: proposals.length,
    carried,
    changed,
    created,
    merged,
    retired,
    keptForState,
  };
}
