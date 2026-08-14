/**
 * Detectors that read the commitment layer.
 *
 * The three detectors Harbor shipped with all worked on items: an unanswered
 * message, a matched interest, a loose end near a calendar entry. They are
 * useful and they share a limitation, which is that an item is a record of one
 * moment and most of what a person actually wants to be reminded of is a state
 * that has persisted.
 *
 * These read commitments instead, which is where "I said I would do this and
 * have not" now lives. Each one is deliberately narrow. The bar for saying
 * something unprompted is high, and it should be: an observation that is
 * technically correct but not worth the interruption teaches a person to stop
 * reading the digest, and once that happens nothing else Harbor does matters.
 */
import { evidenceFor, listCommitments } from "../store/commitments.js";
import { recordObservation } from "../store/signals.js";
import type { DetectorContext, DetectorResult } from "./detectors.js";
import type { DB } from "../kernel/db.js";

/** How far ahead a due date counts as "soon". */
const DUE_SOON_MS = 3 * 86_400_000;
/** How far ahead to look for events that a commitment ought to precede. */
const EVENT_HORIZON_MS = 7 * 86_400_000;
/** Below this, an extracted commitment is not certain enough to interrupt someone. */
const MIN_CONFIDENCE = 0.65;

/**
 * Commitments that are due, or just went past due.
 *
 * The plainest thing this layer can say, and the reason the layer exists. It
 * only speaks about commitments the person owns: telling somebody that another
 * person has not done something is gossip, not a reminder.
 */
export function detectDueCommitments(db: DB, context: DetectorContext): DetectorResult {
  const open = listCommitments(db, {
    principalId: context.principalId,
    states: ["stated", "scheduled"],
    limit: 200,
    dueBefore: context.now + DUE_SOON_MS,
  });

  let created = 0;

  for (const commitment of open) {
    if (commitment.owner !== "me" || commitment.confidence < MIN_CONFIDENCE) {
      continue;
    }

    const due = commitment.dueAt ?? commitment.occursAt;

    if (due === null) {
      continue;
    }

    // A repeating commitment is only worth mentioning around the occurrence
    // that is actually current. Saying "rent was due" about every month it has
    // ever been due is the fastest way to make a digest unreadable.
    if (commitment.recurring && due < context.now - DUE_SOON_MS) {
      continue;
    }

    const evidence = evidenceFor(db, commitment.id);
    const itemIds = evidence.map((record) => record.itemId).filter((id): id is string => id !== null);

    if (itemIds.length === 0) {
      // Nothing to point at means nothing gets said. The store enforces this
      // too, but failing here is clearer than an exception from a detector.
      continue;
    }

    const overdue = due < context.now;
    const days = Math.round(Math.abs(due - context.now) / 86_400_000);

    // Overdue outranks upcoming, and a commitment mentioned by more than one
    // source outranks one mentioned by a single source, because agreement
    // across sources is the only cheap confidence signal available.
    const salience = Math.min(
      0.95,
      (overdue ? 0.6 : 0.45) + (evidence.length > 1 ? 0.15 : 0) + commitment.confidence * 0.2,
    );

    const written = recordObservation(db, {
      principalId: context.principalId,
      detectorId: "commitment_due",
      // Keyed to the day so a commitment that stays overdue is said once, not
      // every time the detector runs.
      dedupKey: `commitment_due:${commitment.id}:${String(Math.floor(due / 86_400_000))}`,
      title: overdue
        ? `${commitment.title} was due ${days === 0 ? "today" : `${String(days)} days ago`}`
        : `${commitment.title} is due ${days === 0 ? "today" : `in ${String(days)} days`}`,
      detail: evidence
        .slice(0, 3)
        .map((record) => record.note)
        .join("; "),
      salience,
      evidence: itemIds,
      earliestUsefulAt: overdue ? context.now : due - DUE_SOON_MS,
      // Stops being worth saying long before it stops being true. The lapse
      // detector picks it up from there.
      expiresAt: due + 10 * 86_400_000,
    });

    if (written) {
      created += 1;
    }
  }

  return { detectorId: "commitment_due", examined: open.length, created, resolved: 0 };
}

/**
 * An upcoming calendar entry with an unresolved commitment attached to it.
 *
 * This is the cross-source observation the whole product is aimed at: the
 * calendar knows Saturday is happening and the reminder knows something has not
 * been bought, and neither can see the other. The connection is made through
 * the people involved, using the entity layer, so it holds even when the words
 * do not match at all.
 */
export function detectCommitmentsBeforeEvents(
  db: DB,
  context: DetectorContext,
): DetectorResult {
  const events = db
    .prepare(
      `SELECT id, title, occurred_at FROM items
       WHERE kind = 'event' AND deleted_at IS NULL AND title IS NOT NULL
         AND occurred_at BETWEEN @from AND @to
       ORDER BY occurred_at ASC
       LIMIT 80`,
    )
    .all({ from: context.now, to: context.now + EVENT_HORIZON_MS }) as {
    id: string;
    title: string;
    occurred_at: number;
  }[];

  if (events.length === 0) {
    return { detectorId: "commitment_before_event", examined: 0, created: 0, resolved: 0 };
  }

  const open = listCommitments(db, {
    principalId: context.principalId,
    states: ["stated"],
    limit: 200,
  });

  let created = 0;

  for (const event of events) {
    const eventPeople = new Set(
      (
        db
          .prepare(`SELECT entity_id AS id FROM item_entities WHERE item_id = ?`)
          .all(event.id) as { id: string }[]
      ).map((row) => row.id),
    );

    if (eventPeople.size === 0) {
      continue;
    }

    for (const commitment of open) {
      if (commitment.confidence < MIN_CONFIDENCE) {
        continue;
      }

      // A commitment already due after the event is not something to do before
      // it, and one due long before is its own problem rather than this one.
      const due = commitment.dueAt;

      if (due !== null && due > event.occurred_at) {
        continue;
      }

      const evidence = evidenceFor(db, commitment.id);
      const itemIds = evidence
        .map((record) => record.itemId)
        .filter((id): id is string => id !== null);

      if (itemIds.length === 0) {
        continue;
      }

      // Shared people, through whichever items the commitment was built from.
      const shared = db
        .prepare(
          `SELECT DISTINCT COALESCE(ie.entity_id, ie2.entity_id) AS id FROM commitment_evidence ce
           LEFT JOIN item_entities ie ON ie.item_id = ce.item_id
           LEFT JOIN episode_items ei ON ei.episode_id = ce.episode_id
           LEFT JOIN item_entities ie2 ON ie2.item_id = ei.item_id
           WHERE ce.commitment_id = ?
             AND COALESCE(ie.entity_id, ie2.entity_id) IS NOT NULL`,
        )
        .all(commitment.id) as { id: string | null }[];

      const overlap = shared.some((row) => row.id !== null && eventPeople.has(row.id));

      if (!overlap) {
        continue;
      }

      const days = Math.max(0, Math.round((event.occurred_at - context.now) / 86_400_000));

      const written = recordObservation(db, {
        principalId: context.principalId,
        detectorId: "commitment_before_event",
        dedupKey: `before_event:${commitment.id}:${event.id}`,
        title: `${commitment.title} is still open, and ${event.title} is ${days === 0 ? "today" : `in ${String(days)} days`}`,
        detail: evidence
          .slice(0, 2)
          .map((record) => record.note)
          .join("; "),
        // The most useful thing Harbor can say, so it outranks a plain due
        // date, but capped: it is an inference from shared people rather than
        // from anything either source stated.
        salience: Math.min(0.9, 0.6 + commitment.confidence * 0.25),
        evidence: [...new Set([...itemIds, event.id])],
        // Two days before the event, or now if that has passed. Saying this a
        // week out is noise; saying it the morning of is too late to act.
        earliestUsefulAt: Math.max(context.now, event.occurred_at - 2 * 86_400_000),
        expiresAt: event.occurred_at,
      });

      if (written) {
        created += 1;
      }
    }
  }

  return {
    detectorId: "commitment_before_event",
    examined: events.length,
    created,
    resolved: 0,
  };
}

/**
 * Commitments that quietly lapsed.
 *
 * Said once, late, and gently. The commitment layer has already waited two
 * weeks past the due date before calling something lapsed, so this is not a
 * nudge about something recent; it is a periodic "these fell off the edge, do
 * you still care". Salience is deliberately low: nothing here is urgent by
 * definition, and it should never crowd out something that is.
 */
export function detectLapsedCommitments(db: DB, context: DetectorContext): DetectorResult {
  const lapsed = listCommitments(db, {
    principalId: context.principalId,
    states: ["lapsed"],
    limit: 40,
  });

  let created = 0;

  for (const commitment of lapsed) {
    if (commitment.recurring) {
      continue;
    }

    if (commitment.owner !== "me" || commitment.confidence < 0.8) {
      // Only the ones Harbor is sure about. A weakly extracted intention that
      // lapsed is exactly the kind of thing that should be forgotten rather
      // than raised.
      continue;
    }

    const evidence = evidenceFor(db, commitment.id);
    const itemIds = evidence.map((record) => record.itemId).filter((id): id is string => id !== null);

    if (itemIds.length === 0) {
      continue;
    }

    const written = recordObservation(db, {
      principalId: context.principalId,
      detectorId: "commitment_lapsed",
      dedupKey: `lapsed:${commitment.id}`,
      title: `${commitment.title} has been sitting since ${new Date(commitment.dueAt ?? commitment.firstSeenAt).toISOString().slice(0, 10)}`,
      detail: "Nothing since suggests it happened. It may simply not matter any more.",
      salience: 0.35,
      evidence: itemIds,
      earliestUsefulAt: context.now,
      expiresAt: context.now + 30 * 86_400_000,
    });

    if (written) {
      created += 1;
    }
  }

  return { detectorId: "commitment_lapsed", examined: lapsed.length, created, resolved: 0 };
}
