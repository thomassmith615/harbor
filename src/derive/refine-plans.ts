/**
 * The pass where a model reads a conversation, and the only one that does.
 *
 * `plans.ts` reads a transcript by rule and finds what a rule can find:
 * somebody typing "im in", somebody tapping the message. It cannot find "she
 * can come", or "count us both", or a decline phrased as enthusiasm about next
 * week, and no pattern reaches those without also reaching every
 * acknowledgement anybody ever sends. That is not a tuning problem. It is what
 * a rule is.
 *
 * So this runs after anchoring and before frames, and it is fenced the way
 * `extract.ts` fences the purchase extractor, for the same reason: a model
 * asked to find agreement in a group chat will find agreement.
 *
 *   A deterministic predicate decides which transcripts are even shown. A
 *   conversation with no proposal in it never reaches a model, which is most
 *   of them.
 *
 *   The output parses against a schema, and a stance without a quote is
 *   dropped rather than kept at low confidence.
 *
 *   Every quote is checked against the transcript it came from. A roster that
 *   is mostly right is not a weaker version of a correct roster; it is a false
 *   statement about who is going out tonight, and the difference between the
 *   two is exactly the quote.
 *
 * What it writes is anchors, added to the ones the rules already wrote rather
 * than replacing them, with one exception: the roster. A name the model
 * declined to quote is a name it is asserting does not belong, and leaving the
 * rules' version underneath would mean refinement could only ever add somebody
 * to an evening and never take one off it.
 *
 * Idempotent by a marker anchor. A transcript that has been read once is not
 * read again until `PLAN_VERSION` moves, because this is the one pass here that
 * costs money and the answer does not change when nothing about the
 * conversation has.
 */
import { addAnchors, anchorsFor, removeAnchorsOfKind } from "../store/anchors.js";
import { anchorsOfPlan, readPlans, refinePlan, PLAN_VERSION } from "./plans.js";
import type { DB } from "../kernel/db.js";
import type { NodeRef } from "../store/nodes.js";
import type { Anchor } from "./anchors.js";

/** Written once a transcript has been read, so it is not read twice. */
const MARKER = "plan_read";

export interface RefineReport {
  readonly considered: number;
  readonly read: number;
  readonly improved: number;
  readonly failed: number;
  readonly rejected: readonly string[];
  readonly durationMs: number;
}

export interface RefineOptions {
  readonly principalId: string;
  readonly timezone: string;
  /** A ceiling on model calls for one pass. */
  readonly limit?: number | undefined;
  readonly shouldStop?: (() => boolean) | undefined;
  readonly onNote?: ((message: string) => void) | undefined;
}

/**
 * Every conversation carrying a plan that a model has not read yet.
 *
 * Ordered newest first. If a budget runs out, the evening that has not happened
 * yet is worth more than one three months ago, and the alternative ordering
 * spends the whole budget on history the first time this ever runs.
 */
function pending(db: DB, limit: number): readonly NodeRef[] {
  const rows = db
    .prepare(
      `SELECT a.node_id AS id
       FROM node_anchors a
       JOIN episodes e ON e.id = a.node_id
       WHERE a.node_kind = 'episode' AND a.kind = 'plan'
         AND NOT EXISTS (
           SELECT 1 FROM node_anchors m
           WHERE m.node_kind = 'episode' AND m.node_id = a.node_id
             AND m.kind = 'plan' AND m.value = @marker
         )
       ORDER BY e.starts_at DESC
       LIMIT @limit`,
    )
    .all({ marker: `${MARKER}:${String(PLAN_VERSION)}`, limit }) as { id: string }[];

  return rows.map((row) => ({ kind: "episode" as const, id: row.id }));
}

function marker(): Anchor {
  return {
    kind: "plan",
    value: `${MARKER}:${String(PLAN_VERSION)}`,
    display: "read by a model",
    startsAt: null,
    endsAt: null,
    confidence: 1,
  };
}

export async function refinePlans(db: DB, options: RefineOptions): Promise<RefineReport> {
  const started = Date.now();
  const refs = pending(db, options.limit ?? 25);

  const rejected: string[] = [];
  let read = 0;
  let improved = 0;
  let failed = 0;

  const nameOf = db.prepare(
    `SELECT id FROM entities WHERE LOWER(display_name) = LOWER(?) LIMIT 1`,
  );

  const self = (
    db.prepare(`SELECT id FROM entities WHERE kind = 'self' LIMIT 1`).get() as
      | { id: string }
      | undefined
  )?.id;

  for (const ref of refs) {
    if (options.shouldStop?.() === true) {
      break;
    }

    const row = db
      .prepare(`SELECT transcript, starts_at FROM episodes WHERE id = ?`)
      .get(ref.id) as { transcript: string; starts_at: number } | undefined;

    if (row === undefined) {
      continue;
    }

    const base = readPlans(row.transcript, row.starts_at, options.timezone, ref.id)[0];

    if (base === undefined) {
      // The anchor says there is a plan here and re-reading finds none, which
      // means the rules changed underneath the anchor. Marked so the pass does
      // not reconsider it every run; the next `ANCHOR_VERSION` bump rewrites
      // the anchor itself.
      addAnchors(db, ref, [marker()]);
      continue;
    }

    read += 1;

    let result;

    try {
      result = await refinePlan(db, row.transcript, base, options.timezone, options.principalId);
    } catch (error) {
      // A model server that is not running is the ordinary case on a fresh
      // machine, and it is not a failure of the store. The rules already wrote
      // a roster; this pass is what makes it better, not what makes it exist.
      failed += 1;
      options.onNote?.(
        `could not read one conversation: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }

    rejected.push(...result.rejected);

    if (result.plan === null) {
      addAnchors(db, ref, [marker()]);
      continue;
    }

    const resolved = {
      ...result.plan,
      stances: result.plan.stances.map((stance) => ({
        ...stance,
        entityId:
          stance.speaker.toLowerCase() === "me"
            ? (self ?? null)
            : ((nameOf.get(stance.speaker) as { id: string } | undefined)?.id ?? null),
      })),
    };

    const before = anchorsFor(db, ref).filter((anchor) => anchor.kind === "going").length;

    // The roster is replaced; everything else is added to. See the note at the
    // top of the file.
    removeAnchorsOfKind(db, ref, "going");

    addAnchors(db, ref, [...anchorsOfPlan(resolved), marker()]);

    const after = anchorsFor(db, ref).filter((anchor) => anchor.kind === "going").length;

    if (after !== before) {
      improved += 1;
    }
  }

  return {
    considered: refs.length,
    read,
    improved,
    failed,
    rejected: rejected.slice(0, 20),
    durationMs: Date.now() - started,
  };
}
