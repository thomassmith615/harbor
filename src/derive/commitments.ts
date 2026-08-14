/**
 * Building commitments from every source that mentions one.
 *
 * Three passes, in order, and the order is deliberate.
 *
 *   1. Reminders. Deterministic and free. A reminder is already an explicit
 *      unresolved intention, so it becomes a commitment with no model involved
 *      and with the highest confidence in the system.
 *
 *   2. Conversations. A model reads only the episodes that a deterministic
 *      predicate flagged, and only produces commitments it can quote.
 *
 *   3. Transitions. Deterministic again: a reminder that got completed closes
 *      its commitment, a calendar entry that matches one schedules it, and time
 *      alone lapses one that nothing has touched.
 *
 * Reminders run first so that when a conversation and a reminder describe the
 * same thing, the reminder is already there to be matched against and the
 * conversation attaches to it as evidence. Reversing the order would produce a
 * pair of near-duplicate commitments and rely on the merge to fix it.
 */
import {
  closeCommitment,
  evidenceFor,
  listCommitments,
  normalize,
  recordCommitment,
  attachEvidence,
  setState,
  similarity,
} from "../store/commitments.js";
import { extractIntents, looksLikeIntent } from "./intents.js";
import { DEFAULT_PRINCIPAL } from "../store/schema.js";
import type { DB } from "../kernel/db.js";
import type { CommitmentOwner } from "../store/commitments.js";

/** Bump to re-extract everything. */
export const COMMITMENT_VERSION = 1;

/**
 * How long past its due date a commitment waits before Harbor calls it lapsed.
 *
 * Two weeks, and generous on purpose. Lapsing is Harbor asserting something
 * about a person's life from the absence of evidence, which is the weakest
 * claim it makes anywhere. Being slow about it costs a little staleness; being
 * quick about it means telling somebody they dropped something they did.
 */
const LAPSE_AFTER_MS = 14 * 86_400_000;

/** How close a calendar entry has to be to a commitment to be said to schedule it. */
const SCHEDULE_THRESHOLD = 0.6;

export interface CommitmentReport {
  readonly remindersRead: number;
  readonly episodesConsidered: number;
  readonly episodesRead: number;
  readonly created: number;
  readonly merged: number;
  readonly scheduled: number;
  readonly closed: number;
  readonly lapsed: number;
  readonly rejected: readonly string[];
  readonly costMicros: number;
  readonly model: string | null;
  readonly remaining: number;
  readonly durationMs: number;
}

interface TaskRow {
  readonly id: string;
  readonly title: string | null;
  readonly snippet: string | null;
  readonly state: string | null;
  readonly due_at: number | null;
  readonly occurred_at: number;
  readonly recurrence: string | null;
}

function fromReminders(db: DB, principalId: string, limit: number): { read: number; created: number; merged: number } {
  const rows = db
    .prepare(
      `SELECT id, title, snippet, state, due_at, occurred_at, recurrence FROM items
       WHERE kind = 'task' AND deleted_at IS NULL AND title IS NOT NULL
         AND (commitment_version IS NULL OR commitment_version <> @version)
       ORDER BY occurred_at DESC
       LIMIT @limit`,
    )
    .all({ version: COMMITMENT_VERSION, limit }) as TaskRow[];

  let created = 0;
  let merged = 0;

  for (const row of rows) {
    const title = (row.title ?? "").trim();

    if (title.length === 0 || normalize(title).length === 0) {
      db.prepare(`UPDATE items SET commitment_version = ? WHERE id = ?`).run(
        COMMITMENT_VERSION,
        row.id,
      );
      continue;
    }

    const done = row.state === "completed";
    const anchor = row.due_at ?? row.occurred_at;

    const outcome = recordCommitment(
      db,
      {
        principalId,
        title,
        owner: "me",
        // A reminder is the least ambiguous evidence Harbor has. The person
        // wrote it down themselves, for themselves.
        state: done ? "done" : "stated",
        confidence: 0.95,
        origin: "reminder",
        anchorAt: anchor,
        recurring: row.recurrence !== null && row.recurrence.length > 0,
        ...(row.due_at === null ? {} : { dueAt: row.due_at }),
      },
      {
        itemId: row.id,
        role: done ? "closed" : "tracked",
        note: done ? `completed in Reminders` : `a reminder in ${row.snippet ?? "Reminders"}`,
        occurredAt: anchor,
      },
      COMMITMENT_VERSION,
    );

    if (outcome.created) {
      created += 1;
    } else {
      merged += 1;
    }

    db.prepare(`UPDATE items SET commitment_version = ? WHERE id = ?`).run(
      COMMITMENT_VERSION,
      row.id,
    );
  }

  return { read: rows.length, created, merged };
}

interface EpisodeRow {
  readonly id: string;
  readonly transcript: string;
  readonly participants: string;
  readonly ends_at: number;
  readonly starts_at: number;
}

export interface CandidateSummary {
  readonly id: string;
  readonly participants: readonly string[];
  readonly endsAt: number;
  readonly preview: string;
}

/**
 * Conversations that appear to contain a commitment.
 *
 * Free to compute, which is what makes `--dry-run` worth having: the number
 * this returns is the number of model calls a real run would make, and it can
 * be looked at before spending anything.
 */
export function intentCandidates(db: DB, limit: number): readonly CandidateSummary[] {
  const rows = db
    .prepare(
      `SELECT id, transcript, participants, starts_at, ends_at FROM episodes
       WHERE commitment_version IS NULL OR commitment_version <> @version
       ORDER BY ends_at DESC
       LIMIT @limit`,
    )
    .all({ version: COMMITMENT_VERSION, limit: limit * 8 }) as EpisodeRow[];

  const candidates: CandidateSummary[] = [];

  for (const row of rows) {
    if (!looksLikeIntent(row.transcript)) {
      continue;
    }

    candidates.push({
      id: row.id,
      participants: JSON.parse(row.participants) as string[],
      endsAt: row.ends_at,
      preview: row.transcript.split("\n")[0]?.slice(0, 90) ?? "",
    });

    if (candidates.length >= limit) {
      break;
    }
  }

  return candidates;
}

/**
 * Marks conversations the predicate rejected, so they are not reconsidered.
 *
 * Separate from the extraction loop because a conversation with no intent
 * language is a complete answer, not a skipped one, and leaving it unmarked
 * would make every run re-scan the entire message history.
 */
function markUninteresting(db: DB, limit: number): number {
  const rows = db
    .prepare(
      `SELECT id, transcript FROM episodes
       WHERE commitment_version IS NULL OR commitment_version <> @version
       ORDER BY ends_at DESC
       LIMIT @limit`,
    )
    .all({ version: COMMITMENT_VERSION, limit }) as { id: string; transcript: string }[];

  const mark = db.prepare(`UPDATE episodes SET commitment_version = ? WHERE id = ?`);
  let marked = 0;

  const work = db.transaction(() => {
    for (const row of rows) {
      if (!looksLikeIntent(row.transcript)) {
        mark.run(COMMITMENT_VERSION, row.id);
        marked += 1;
      }
    }
  });

  work();

  return marked;
}

function ownerFor(owner: string): CommitmentOwner {
  return owner === "them" ? "them" : owner === "shared" ? "shared" : "me";
}

/**
 * Calendar entries that formalize a commitment somebody stated.
 *
 * The connection this layer exists to make. An event does not create a
 * commitment; it schedules one that a conversation or a reminder already put
 * on the books.
 */
function applySchedules(db: DB, principalId: string): number {
  const open = listCommitments(db, { principalId, states: ["stated"], limit: 500 });

  if (open.length === 0) {
    return 0;
  }

  let scheduled = 0;

  for (const commitment of open) {
    const anchor = commitment.dueAt ?? commitment.firstSeenAt;

    const events = db
      .prepare(
        `SELECT id, title, occurred_at FROM items
         WHERE kind = 'event' AND deleted_at IS NULL AND title IS NOT NULL
           AND occurred_at BETWEEN @from AND @to`,
      )
      .all({ from: anchor - 30 * 86_400_000, to: anchor + 90 * 86_400_000 }) as {
      id: string;
      title: string;
      occurred_at: number;
    }[];

    for (const event of events) {
      if (similarity(commitment.normalized, normalize(event.title)) < SCHEDULE_THRESHOLD) {
        continue;
      }

      db.prepare(
        `UPDATE commitments SET occurs_at = @at, state = 'scheduled', updated_at = @now
         WHERE id = @id AND state = 'stated'`,
      ).run({ id: commitment.id, at: event.occurred_at, now: Date.now() });

      attachEvidence(db, commitment.id, {
        itemId: event.id,
        role: "scheduled",
        note: `on the calendar as "${event.title}"`,
        occurredAt: event.occurred_at,
      });

      scheduled += 1;
      break;
    }
  }

  return scheduled;
}

/**
 * Commitments nothing has touched since well past their due date.
 *
 * The only state Harbor assigns without evidence, and it says "nothing since
 * suggests this happened", not "you failed to do this". The distinction matters
 * because this is what a digest will eventually surface, and a system that
 * scolds a person about things they already did stops being read.
 */
function applyLapses(db: DB, principalId: string): number {
  const now = Date.now();

  const open = listCommitments(db, {
    principalId,
    states: ["stated"],
    limit: 1000,
    dueBefore: now - LAPSE_AFTER_MS,
  });

  let lapsed = 0;

  for (const commitment of open) {
    // A repeating commitment is never lapsed. A monthly bill that went unpaid
    // in November is not an abandoned intention, and treating it as one is how
    // a digest ends up reciting last year's rent.
    if (commitment.recurring) {
      continue;
    }

    const evidence = evidenceFor(db, commitment.id);
    const latest = evidence.reduce((max, entry) => Math.max(max, entry.occurredAt), 0);

    // Anything said about it recently means it is still live, whatever the due
    // date says.
    if (latest > now - LAPSE_AFTER_MS) {
      continue;
    }

    setState(db, commitment.id, "lapsed");
    lapsed += 1;
  }

  return lapsed;
}

/** Reminders completed since the commitment was made close it. */
function applyClosures(db: DB, principalId: string): number {
  const open = listCommitments(db, { principalId, states: ["stated", "scheduled"], limit: 1000 });
  let closed = 0;

  for (const commitment of open) {
    const done = db
      .prepare(
        `SELECT i.id AS id FROM commitment_evidence ce
         JOIN items i ON i.id = ce.item_id
         WHERE ce.commitment_id = ? AND i.kind = 'task' AND i.state = 'completed'
         LIMIT 1`,
      )
      .get(commitment.id) as { id: string } | undefined;

    if (done === undefined) {
      continue;
    }

    closeCommitment(db, commitment.id, "done", "the reminder was completed");
    closed += 1;
  }

  return closed;
}

export interface CommitmentOptions {
  readonly principalId?: string;
  /** Conversations to send to a model. Reminders and transitions are free and unbounded. */
  readonly limit?: number | undefined;
  readonly shouldStop?: (() => boolean) | undefined;
  readonly onNote?: ((message: string) => void) | undefined;
  readonly onProgress?: ((done: number, total: number) => void) | undefined;
}

export async function buildCommitments(
  db: DB,
  options: CommitmentOptions = {},
): Promise<CommitmentReport> {
  const started = Date.now();
  const principalId = options.principalId ?? DEFAULT_PRINCIPAL;

  const reminders = fromReminders(db, principalId, 5_000);

  if (reminders.read > 0) {
    options.onNote?.(`${String(reminders.read)} reminders read`);
  }

  const skipped = markUninteresting(db, 2_000);

  if (skipped > 0) {
    options.onNote?.(`${String(skipped)} conversations had no intent language, skipped for free`);
  }

  const budget = options.limit ?? 25;
  const candidates = intentCandidates(db, budget);

  let created = reminders.created;
  let merged = reminders.merged;
  let cost = 0;
  let model: string | null = null;
  let read = 0;
  const rejected: string[] = [];

  for (const candidate of candidates) {
    if (options.shouldStop?.() === true) {
      break;
    }

    const row = db.prepare(`SELECT transcript, starts_at FROM episodes WHERE id = ?`).get(
      candidate.id,
    ) as { transcript: string; starts_at: number } | undefined;

    if (row === undefined) {
      continue;
    }

    let result;

    try {
      result = await extractIntents(db, row.transcript, principalId, COMMITMENT_VERSION);
    } catch (error) {
      // One conversation failing is not the pass failing. The episode stays
      // unmarked and is retried next run.
      options.onNote?.(`extraction failed for ${candidate.id}: ${String(error)}`);
      continue;
    }

    cost += result.costMicros;
    model = result.model;
    read += 1;
    rejected.push(...result.rejected);

    for (const intent of result.intents) {
      const due = intent.due === null ? null : Date.parse(intent.due);

      const outcome = recordCommitment(
        db,
        {
          principalId,
          title: intent.title,
          owner: ownerFor(intent.owner),
          state: "stated",
          // Below a reminder's confidence, always. Something said in passing is
          // weaker evidence than something a person wrote down deliberately.
          confidence: Math.min(0.8, intent.confidence),
          origin: "conversation",
          anchorAt: due === null || Number.isNaN(due) ? row.starts_at : due,
          ...(due === null || Number.isNaN(due) ? {} : { dueAt: due }),
        },
        {
          episodeId: candidate.id,
          role: "stated",
          note: `said in conversation: "${intent.quote.slice(0, 140)}"`,
          occurredAt: row.starts_at,
        },
        COMMITMENT_VERSION,
      );

      if (outcome.created) {
        created += 1;
      } else {
        merged += 1;
      }
    }

    db.prepare(`UPDATE episodes SET commitment_version = ? WHERE id = ?`).run(
      COMMITMENT_VERSION,
      candidate.id,
    );

    options.onProgress?.(read, candidates.length);
  }

  const scheduled = applySchedules(db, principalId);
  const closed = applyClosures(db, principalId);
  const lapsed = applyLapses(db, principalId);

  const remaining = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM episodes
         WHERE commitment_version IS NULL OR commitment_version <> ?`,
      )
      .get(COMMITMENT_VERSION) as { n: number }
  ).n;

  return {
    remindersRead: reminders.read,
    episodesConsidered: candidates.length,
    episodesRead: read,
    created,
    merged,
    scheduled,
    closed,
    lapsed,
    rejected,
    costMicros: cost,
    model,
    remaining,
    durationMs: Date.now() - started,
  };
}
