/**
 * Subjects that keep coming up, and the mail that touches them.
 *
 * This is the example from the original brief, more or less verbatim: notice
 * that a subject has been recurring in conversation, find a piece of mail
 * related to it, and surface the connection. It is the last detector owed and
 * the only one that reasons about a pattern across time rather than a single
 * state.
 *
 * It is deterministic, which was not obvious. The instinct for "what have I
 * been talking about" is embeddings and clustering, and that produces
 * groupings nobody can check and a threshold nobody can reason about. Counting
 * distinct conversations a term appears in is cruder and has two properties
 * that matter more: the evidence is a list of conversations a person can read,
 * and the reason a thing was surfaced is one sentence rather than a similarity
 * score.
 *
 * The failure mode to design against is not missing a topic. It is surfacing
 * "you keep mentioning tomorrow", which is why the term has to be uncommon in
 * the corpus as a whole rather than merely frequent lately.
 */
import { NoiseIndex } from "./noise.js";
import { TermIndex } from "./terms.js";
import { recordObservation } from "../store/signals.js";
import type { DetectorContext, DetectorResult } from "./detectors.js";
import type { DB } from "../kernel/db.js";

/** How far back a subject counts as current. */
const WINDOW_MS = 21 * 86_400_000;

/** Distinct conversations a term must appear in before it is a subject. */
const MIN_EPISODES = 3;

/** A term in more than this share of all conversations is vocabulary, not a subject. */
const MAX_CORPUS_SHARE = 0.08;

/**
 * Below this many conversations, the share test is meaningless and is skipped.
 *
 * With five conversations in the store, a term in four of them is 80% of the
 * corpus and gets excluded as vocabulary, when in fact it is the only subject
 * there is. The ratio only says something once there is enough history for
 * "unusual" to mean anything, and until then the count test carries it alone.
 */
const MIN_CORPUS_FOR_SHARE = 50;

/** How recent a piece of mail must be to be worth connecting. */
const MAIL_WINDOW_MS = 10 * 86_400_000;

/**
 * Words that are frequent everywhere and mean nothing anywhere.
 *
 * Short, because the corpus-share test above does most of this work
 * automatically and does it per person: somebody who talks about golf every
 * week has "golf" excluded without anybody listing it.
 */
const COMMON = new Set([
  "the", "and", "you", "that", "have", "for", "with", "this", "just", "like",
  "was", "are", "not", "but", "your", "what", "when", "will", "can", "get",
  "got", "there", "here", "they", "them", "then", "than", "some", "would",
  "about", "know", "think", "really", "going", "want", "need", "good", "yeah",
  "okay", "sure", "thanks", "today", "tomorrow", "tonight", "morning", "night",
  "time", "back", "still", "well", "much", "make", "take", "come", "see",
]);

interface EpisodeRow {
  readonly id: string;
  readonly transcript: string;
  readonly ends_at: number;
}

function termsOf(transcript: string): ReadonlySet<string> {
  const words = transcript
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 4 && word.length < 20 && !COMMON.has(word));

  return new Set(words);
}

export interface Topic {
  readonly term: string;
  readonly episodeIds: readonly string[];
  readonly firstAt: number;
  readonly lastAt: number;
}

/**
 * Terms appearing in several distinct recent conversations and not many old ones.
 *
 * Distinct conversations rather than total mentions, deliberately. Saying a word
 * forty times in one argument is not a recurring subject; saying it once in each
 * of four conversations over three weeks is.
 */
export function recurringTopics(db: DB, principalId: string, now: number): readonly Topic[] {
  const recent = db
    .prepare(
      `SELECT id, transcript, ends_at FROM episodes
       WHERE principal_id = @principal AND ends_at >= @since
       ORDER BY ends_at DESC LIMIT 400`,
    )
    .all({ principal: principalId, since: now - WINDOW_MS }) as EpisodeRow[];

  if (recent.length < MIN_EPISODES) {
    return [];
  }

  const totalEpisodes = (
    db.prepare(`SELECT COUNT(*) AS n FROM episodes WHERE principal_id = ?`).get(principalId) as {
      n: number;
    }
  ).n;

  const seen = new Map<string, { episodes: string[]; first: number; last: number }>();

  for (const episode of recent) {
    for (const term of termsOf(episode.transcript)) {
      const entry = seen.get(term) ?? { episodes: [], first: episode.ends_at, last: episode.ends_at };

      entry.episodes.push(episode.id);
      entry.first = Math.min(entry.first, episode.ends_at);
      entry.last = Math.max(entry.last, episode.ends_at);
      seen.set(term, entry);
    }
  }

  const topics: Topic[] = [];

  // The same test the relationship graph uses, rather than a second opinion.
  //
  // This file had its own stopword list and its own corpus-share ceiling, and
  // they disagreed with `derive/terms.ts` in the way that matters: "before" and
  // "pretty" cleared them both, so a real digest said "before has come up in 20
  // conversations recently" about a marketing email. Two places deciding what a
  // distinctive word is means one of them is wrong and nobody finds out until
  // it says something ridiculous out loud.
  const distinctive = new TermIndex(db);

  // How common a term is across the whole corpus, not just lately. This is what
  // separates a subject from a person's ordinary vocabulary, and it adapts per
  // person without anybody maintaining a list.
  const corpusCount = db.prepare(
    `SELECT COUNT(*) AS n FROM episodes_fts WHERE episodes_fts MATCH ?`,
  );

  for (const [term, entry] of seen) {
    if (entry.episodes.length < MIN_EPISODES) {
      continue;
    }

    let overall = 0;

    try {
      overall = (corpusCount.get(`"${term}"`) as { n: number }).n;
    } catch {
      continue;
    }

    if (totalEpisodes >= MIN_CORPUS_FOR_SHARE && overall / totalEpisodes > MAX_CORPUS_SHARE) {
      continue;
    }

    if (!distinctive.isDistinctive(term)) {
      continue;
    }

    topics.push({
      term,
      episodeIds: [...new Set(entry.episodes)],
      firstAt: entry.first,
      lastAt: entry.last,
    });
  }

  // Most conversations first: a term in six conversations is a stronger subject
  // than one in three, and the budget below is small.
  return topics.sort((left, right) => right.episodeIds.length - left.episodeIds.length).slice(0, 12);
}

/**
 * A recurring subject, and a recent piece of mail that mentions it.
 *
 * The connection the product exists to make, and the strictest version of it:
 * the mail has to come from a different source than the conversations, be
 * recent, and actually contain the term. No inference, no similarity, nothing a
 * person cannot check by opening both.
 */
export function detectRecurringSubjects(db: DB, context: DetectorContext): DetectorResult {
  const topics = recurringTopics(db, context.principalId, context.now);

  // Mail nobody corresponds with is not news about a topic.
  //
  // A real digest led with "What would you do with 100,000 points?" from a
  // flight-deals list and "Check Out Mike's Picks" from a clothing brand. Both
  // genuinely contained a recurring word, and neither was anything happening.
  // The graph learned to ignore one-way mail two milestones ago and this layer
  // never heard about it.
  const broadcastIds = JSON.stringify(new NoiseIndex(db).broadcastIds);

  if (topics.length === 0) {
    return { detectorId: "recurring_subject", examined: 0, created: 0, resolved: 0 };
  }

  // Recomputed each run and replaced wholesale, because a subject that has
  // stopped recurring should stop existing rather than linger.
  const write = db.transaction(() => {
    db.prepare(`DELETE FROM topics WHERE principal_id = ?`).run(context.principalId);

    const insert = db.prepare(
      `INSERT INTO topics (id, principal_id, term, episode_count, first_at, last_at, computed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    for (const topic of topics) {
      insert.run(
        `tp_${context.principalId}:${topic.term}`,
        context.principalId,
        topic.term,
        topic.episodeIds.length,
        topic.firstAt,
        topic.lastAt,
        context.now,
      );
    }
  });

  write();

  let created = 0;

  // One observation per piece of mail, not per term. A single email about a
  // trip matches "vermont", "stowe", and "cabin", and three near-identical
  // lines about the same email is exactly the kind of noise that makes a digest
  // stop being read. Topics are already ordered by strength, so the first match
  // wins and the rest are silently the same finding.
  const spokenFor = new Set<string>();

  for (const topic of topics) {
    const mail = db
      .prepare(
        `SELECT i.id AS id, i.title AS title, i.occurred_at AS at, i.author AS author
         FROM items i
         JOIN streams s ON s.id = i.stream_id
         WHERE i.kind = 'message' AND i.deleted_at IS NULL
           AND s.connector_id NOT IN ('imessage')
           AND i.occurred_at >= @since
           AND i.id NOT IN (SELECT value FROM json_each(@broadcast))
           AND (LOWER(COALESCE(i.title, '')) LIKE @term OR LOWER(COALESCE(i.body, '')) LIKE @term)
         ORDER BY i.occurred_at DESC
         LIMIT 1`,
      )
      .get({
        since: context.now - MAIL_WINDOW_MS,
        term: `%${topic.term}%`,
        broadcast: broadcastIds,
      }) as
      | { id: string; title: string | null; at: number; author: string | null }
      | undefined;

    if (mail === undefined || spokenFor.has(mail.id)) {
      continue;
    }

    spokenFor.add(mail.id);

    const written = recordObservation(db, {
      principalId: context.principalId,
      detectorId: "recurring_subject",
      // Keyed to the mail, not the topic, so a subject that keeps recurring is
      // only mentioned again when something new actually arrives about it.
      dedupKey: `recurring:${topic.term}:${mail.id}`,
      title: `"${mail.title ?? "an email"}" arrived, and ${topic.term} has come up in ${String(topic.episodeIds.length)} conversations recently`,
      detail: `From ${mail.author ?? "unknown"}. The subject has been recurring since ${new Date(topic.firstAt).toISOString().slice(0, 10)}.`,
      // Below an overdue commitment and above a lapsed one. It is a genuine
      // connection and it is not urgent: nothing breaks if it is read tomorrow.
      salience: Math.min(0.75, 0.45 + topic.episodeIds.length * 0.05),
      evidence: [mail.id],
      earliestUsefulAt: context.now,
      expiresAt: context.now + 7 * 86_400_000,
    });

    if (written) {
      created += 1;
    }
  }

  return { detectorId: "recurring_subject", examined: topics.length, created, resolved: 0 };
}
