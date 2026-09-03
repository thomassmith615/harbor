/**
 * Plans: the thing being decided, as opposed to the thing that happened.
 *
 * Every frame kind before this one is detected from a record somebody else
 * already made. A trip needs an airline's calendar entry. An occasion needs a
 * calendar entry of any sort. That is a reasonable place to start and it has
 * one structural consequence, which is that an evening arranged entirely in a
 * group chat does not exist. There is no calendar entry, so there is no frame,
 * so nothing is gathered, so the four pieces that describe it stay four pieces.
 *
 * The other half of the problem is what those pieces are made of. Every anchor
 * kind in `anchors.ts` is a fully specified claim: a resolved place, a fixed
 * span, an exact identifier. A plan being made is composed almost entirely of
 * underspecified ones. "later". "the bar". "8ish". "im in". None of them is a
 * value the store could previously hold, and no amount of tuning a similarity
 * score reaches a word that cannot be represented.
 *
 * So this file adds the frame kind, and `timing.ts` adds the value kind, and
 * together they let membership ask a different question.
 *
 * **Before.** Does this candidate resemble the frame? On vague text the answer
 * is always no, because there is nothing to resemble. A conversation saying
 * "the bar" and a confirmation saying "Great American Pub" share no word, no
 * place, no person and no identifier.
 *
 * **Now.** Does this candidate *resolve* something the frame is holding open? A
 * plan that said "later" is holding a five hour window and a question. A
 * confirmation stating 8:00 PM answers it, exactly, while sharing nothing at
 * all. The evidence line is a sentence about the world rather than about an
 * index: *you said "later" at 5:45, and this says 8:00 PM.*
 *
 * That asymmetry is also the quality control. A narrow interval inside a wide
 * one is an answer; two wide intervals overlapping is a coincidence, and every
 * plan on a Thursday evening overlaps every other plan on that Thursday
 * evening. See `resolves` in `timing.ts`.
 *
 * ## What is deterministic and what is not
 *
 * The reading here is deterministic and it is deliberately the floor rather
 * than the ceiling. It finds a proposal, the people who plainly said yes, a
 * venue phrase and a time hint, and it will miss an acceptance phrased as "she
 * can come" or "sounds good" because no pattern reaches those without also
 * reaching half of ordinary conversation.
 *
 * `refinePlans` is where a model reads the same transcript and does better, and
 * it is fenced the way `purchase.ts` is fenced: a deterministic predicate
 * decides which transcripts are worth reading at all, the output parses against
 * a schema, and every stance has to quote the words it came from with the quote
 * checked against the transcript. A model asked to find agreement in a group
 * chat will find agreement; the quote is what turns that into something a
 * person can check.
 *
 * Nothing here decides anything. The model may say who agreed. What that is
 * worth, and whether a reservation belongs to the evening, stays in `gather.ts`
 * under rules a person can read.
 */
import { createHash } from "node:crypto";
import { narrowest, timeHintsIn, type TimeHint } from "./timing.js";
import { route } from "../reasoning/router.js";
import { schemaFor } from "../reasoning/schemas.js";
import type { DB } from "../kernel/db.js";
import type { Anchor } from "./anchors.js";

const HOUR = 3_600_000;

/**
 * Bump to re-read every plan from transcripts already on disk.
 *
 * Separate from ANCHOR_VERSION for the usual reason: improving how a stance is
 * recognised should not cost a re-scan of every mailbox.
 */
export const PLAN_VERSION = 1;

/**
 * A proposal, before anybody has agreed to it.
 *
 * Deliberately narrow, and matched before any model is called. An invitation
 * has a recognisable shape in every register: it asks, or it suggests, and it
 * names something people do together. Widening this is cheap; what stops a
 * false positive becoming a false plan is that a plan with nobody agreeing to
 * it is not a plan, which is checked below rather than here.
 */
const PROPOSAL_PATTERNS: readonly RegExp[] = [
  /\bwho(?:'s| is|s)\s+(?:going|coming|down|in|up)\b/i,
  /\banyone\s+(?:going|coming|down|in|up|want|free)\b/i,
  /\bwho\s+wants?\s+to\b/i,
  /\b(?:you|u|yall|y'all|everyone)\s+(?:going|coming|down|free)\b/i,
  /\b(?:let'?s|lets|we should|wanna|want to|down to|up for)\s+(?:go|grab|get|hit|meet|do|try)\b/i,
  /\b(?:drinks|dinner|lunch|brunch|coffee|beers?)\s+(?:at|tonight|later|tomorrow|after)\b/i,
  /\b(?:meet|meeting|meetup|grabbing|heading)\s+(?:at|up at|over to|to)\b/i,
];

/**
 * Somebody saying yes, including without typing.
 *
 * `[liked "..."]` is how `episodes.ts` renders a tapback, and it counts. It is
 * weaker than saying so and it is the thing the user actually asked for: on a
 * real group chat a good share of the roster never types a word, and treating
 * silence and a heart as the same thing is what made the roster half a roster.
 *
 * Only on the proposal itself, which is checked at the call site. Liking an
 * unrelated line five messages later is not agreement to anything.
 */
const REACTED = /^\[(?:love|like)d\s/i;

/** Somebody saying yes. Bare acknowledgements are excluded; see below. */
const ACCEPT_PATTERNS: readonly RegExp[] = [
  /^(?:i'?m in|im in|in)\b/i,
  /^(?:same|deal|done)\b/i,
  /^(?:yes|yeah|yep|yup|ya|sure|absolutely|definitely)\b/i,
  /\bi'?m (?:in|down|going|coming|there)\b/i,
  /\bim (?:in|down|going|coming|there)\b/i,
  /\bcount me in\b/i,
  /\bsee (?:you|u|yall|y'all) there\b/i,
  /\bi'?ll (?:be there|come|swing by|head over)\b/i,
  /\b(?:on my way|omw)\b/i,
];

/**
 * Somebody saying no.
 *
 * Read before the acceptances, because "yeah I can't tonight" opens with a yes
 * and is a decline, and getting that backwards puts a person on a roster they
 * explicitly removed themselves from. A wrong name on a plan is worse than a
 * missing one: the missing name is a thin answer, the wrong one is a false
 * statement about somebody's evening.
 */
const DECLINE_PATTERNS: readonly RegExp[] = [
  /\b(?:can'?t|cannot|won'?t)\b/i,
  /\bnot (?:tonight|tomorrow|this time|gonna|going)\b/i,
  /\b(?:next time|rain ?check|i'?m out|im out|sit this one out)\b/i,
  /\bhave to (?:work|pass|skip)\b/i,
];

/**
 * Words that name a thing people do together, for a title when nothing else is
 * known and for deciding that a proposal is about an occasion at all.
 */
const ACTIVITY =
  /\b(bar|pub|tavern|brewery|drinks|beers?|dinner|lunch|brunch|breakfast|coffee|game|match|movie|show|concert|gig|party|round|golf|gym|hike|ride)\b/i;

/**
 * A venue named in running text.
 *
 * Two shapes, and they fail in opposite directions on purpose. A capitalised
 * run after "at" catches "Great American Pub" and misses "the bar". The common
 * noun list catches "the bar" and can never reach a proper name. Both are
 * needed because the two halves of this problem are written in different
 * registers: the person says "the bar" and the restaurant says its own name,
 * and the entire job of the resolution step is to learn that those are the
 * same evening without either of them ever saying so.
 */
const VENUE_NAMED =
  /\b(?:at|to|from)\s+((?:[A-Z][\w'&.-]*)(?:\s+(?:[A-Z][\w'&.-]*|of|and|the|de|la))*)/g;

const VENUE_COMMON =
  /\b(?:the|a)\s+(bar|pub|tavern|brewery|restaurant|diner|cafe|coffee shop|club|gym|course|range|office|house|place|game)\b/gi;

/** Not a venue, however capitalised. */
const NOT_A_VENUE = new Set([
  "i", "im", "the", "and", "confirmation", "reservation", "party", "table",
  "thursday", "friday", "saturday", "sunday", "monday", "tuesday", "wednesday",
  "january", "february", "march", "april", "may", "june", "july", "august",
  "september", "october", "november", "december", "pm", "am", "your", "our",
]);

export interface Stance {
  /** As written in the transcript. */
  readonly speaker: string;
  readonly entityId: string | null;
  readonly verdict: "accept" | "decline";
  /** Verbatim, and checked against the transcript before it is stored. */
  readonly quote: string;
  readonly confidence: number;
}

export interface PlanReading {
  /** Stable within the episode, so a re-read keeps the same anchor value. */
  readonly key: string;
  /** The words that proposed it. */
  readonly proposal: string;
  readonly proposer: string | null;
  readonly activity: string | null;
  readonly venuePhrases: readonly string[];
  readonly time: TimeHint | null;
  readonly stances: readonly Stance[];
  readonly saidAt: number;
  readonly source: "rules" | "model";
}

interface Line {
  readonly speaker: string;
  readonly text: string;
  readonly index: number;
}

/** A transcript is "Speaker: what they said", one per line. */
export function linesOf(transcript: string): readonly Line[] {
  const lines: Line[] = [];

  for (const raw of transcript.split("\n")) {
    const split = raw.indexOf(": ");

    if (split <= 0) {
      continue;
    }

    const speaker = raw.slice(0, split).trim();
    const text = raw.slice(split + 2).trim();

    if (speaker.length === 0 || speaker.length > 60 || text.length === 0) {
      continue;
    }

    lines.push({ speaker, text, index: lines.length });
  }

  return lines;
}

export function looksLikeProposal(text: string): boolean {
  // A reaction quotes what it was a reaction to, so the line rendering Nina's
  // tap on "who's going to the bar later" contains the proposal verbatim and
  // matched every pattern the proposal did. The transcript then held two
  // proposals, the second one four lines below the first, and the roster the
  // first had collected was cut off at exactly the point somebody agreed.
  if (REACTED.test(text)) {
    return false;
  }

  return PROPOSAL_PATTERNS.some((pattern) => pattern.test(text));
}

function verdictOf(text: string): "accept" | "decline" | null {
  if (REACTED.test(text)) {
    return "accept";
  }

  if (DECLINE_PATTERNS.some((pattern) => pattern.test(text))) {
    return "decline";
  }

  if (ACCEPT_PATTERNS.some((pattern) => pattern.test(text))) {
    return "accept";
  }

  return null;
}

export function venuesIn(text: string): readonly string[] {
  const found = new Map<string, string>();

  const put = (phrase: string): void => {
    const trimmed = phrase.trim().replace(/[.,;:!?]+$/, "");
    const key = normalizeVenue(trimmed);

    if (key.length < 3 || NOT_A_VENUE.has(key)) {
      return;
    }

    if (!found.has(key)) {
      found.set(key, trimmed);
    }
  };

  for (const match of text.matchAll(VENUE_NAMED)) {
    const phrase = (match[1] ?? "").split(/\s+/).slice(0, 4).join(" ");

    // A single capitalised word after "at" is a time, a day, or somebody's
    // name far more often than a venue. Two or more is a name.
    if (phrase.split(/\s+/).length >= 2) {
      put(phrase);
    }
  }

  for (const match of text.matchAll(VENUE_COMMON)) {
    put(match[0]);
  }

  return [...found.values()];
}

/** Comparable form. Case, articles and punctuation carry no information here. */
export function normalizeVenue(phrase: string): string {
  return phrase
    .toLowerCase()
    .replace(/^(?:the|a)\s+/, "")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Content tokens of a venue phrase, for overlap rather than equality. */
export function venueTokens(phrase: string): ReadonlySet<string> {
  return new Set(
    normalizeVenue(phrase)
      .split(" ")
      .filter((token) => token.length >= 3),
  );
}

/**
 * How sure a follow-up has to be before it narrows the plan.
 *
 * A meridiem or an "ish" clears it. A bare "at 9" does not, and the difference
 * is not pedantry: "the game is on at 9" and "8ish?" sit four lines apart in
 * the fixture, and the first one winning puts the whole evening an hour late
 * and then refuses the reservation that would have corrected it.
 */
const SETTLES_CONFIDENCE = 0.7;

function overlaps(a: TimeHint, b: TimeHint): boolean {
  return a.startsAt <= b.endsAt && b.startsAt <= a.endsAt;
}

function pickTime(proposed: TimeHint | null, settled: TimeHint | undefined): TimeHint | null {
  if (settled === undefined) {
    return proposed;
  }

  if (proposed === null || overlaps(proposed, settled)) {
    return settled;
  }

  // They disagree. The proposal is what was asked and the follow-up is about
  // something else, so the plan keeps its own question open rather than
  // adopting an answer to a different one.
  return proposed;
}

function keyFor(episodeId: string, proposal: string): string {
  return createHash("sha256").update(`${episodeId}:${proposal}`).digest("hex").slice(0, 12);
}

/**
 * Every plan a transcript contains, read by rule.
 *
 * One proposal per episode in practice, and the code allows more only because
 * a long group chat genuinely does arrange two things in one sitting, and
 * taking the first would silently drop the second.
 *
 * A proposal with nobody agreeing to it is not returned. That is the check that
 * makes the loose proposal patterns safe: "let's grab dinner sometime" is a
 * pleasantry until somebody answers it, and a plan nobody joined is exactly the
 * shape of a false positive that would otherwise sit on the upcoming surface
 * asserting an evening that was never arranged.
 */
export function readPlans(
  transcript: string,
  startsAt: number,
  tz: string,
  episodeId: string,
): readonly PlanReading[] {
  const lines = linesOf(transcript);
  const plans: PlanReading[] = [];

  for (const line of lines) {
    if (!looksLikeProposal(line.text)) {
      continue;
    }

    // Roughly when this line was said. An episode carries its own start and
    // end and not a timestamp per line, so the position in the transcript is
    // the best available reading, and it only has to be good enough to resolve
    // "later" against, which is an interval hours wide.
    const saidAt = startsAt + line.index * 60_000;

    const stances: Stance[] = [];
    const seen = new Set<string>();

    for (const later of lines) {
      if (later.index <= line.index) {
        continue;
      }

      // A second proposal ends the first one's roster. Two plans in one
      // transcript are two rosters, and letting the first collect the second's
      // acceptances is how one evening acquires people who agreed to another.
      if (looksLikeProposal(later.text) && later.index > line.index + 1) {
        break;
      }

      const verdict = verdictOf(later.text);

      if (verdict === null || seen.has(later.speaker)) {
        continue;
      }

      const reaction = REACTED.test(later.text);

      // A tapback only counts on the thing being proposed. `episodes.ts`
      // renders the target inside the line, so this is a check against what
      // was actually reacted to rather than against where the line happens to
      // sit: liking "anyone seen my charger" is not agreeing to go out.
      if (reaction && !later.text.includes(line.text.slice(0, 60))) {
        continue;
      }

      seen.add(later.speaker);

      stances.push({
        speaker: later.speaker,
        entityId: null,
        verdict,
        quote: later.text,
        // Lower, and deliberately. Saying "im in" is a commitment; tapping a
        // heart is agreement with something, and which something is an
        // inference from what it was attached to.
        confidence: reaction ? 0.6 : 0.75,
      });
    }

    if (!stances.some((stance) => stance.verdict === "accept")) {
      continue;
    }

    // What the plan says about when.
    //
    // Two statements, and they are not the same kind of statement. The
    // proposal says "later", which is the question. Somebody answering "8ish?"
    // four messages down is the conversation settling it, and taking only the
    // proposal's own hint throws away the better of the two.
    //
    // Taking the narrowest of everything, though, is how the plan ends up
    // asserting nine o'clock, because the same transcript also contains "the
    // game is on at 9" and a bare hour with no meridiem and no "ish" is the
    // weakest reading there is. So a follow-up narrows the plan only when it is
    // a confident clock time and it falls inside what was already said. An
    // aside about something else is neither.
    const proposed = narrowest(timeHintsIn(line.text, saidAt, tz));

    const followUps = lines
      .filter((other) => other.index > line.index && other.index <= line.index + 12)
      .flatMap((other) => timeHintsIn(other.text, startsAt + other.index * 60_000, tz));

    const settled = followUps
      .filter((hint) => hint.kind === "clock" && hint.confidence >= SETTLES_CONFIDENCE)
      .sort((a, b) => b.confidence - a.confidence)[0];

    const time = pickTime(proposed, settled);

    const activity = ACTIVITY.exec(line.text)?.[1]?.toLowerCase() ?? null;

    plans.push({
      key: keyFor(episodeId, line.text),
      proposal: line.text,
      proposer: line.speaker,
      activity,
      venuePhrases: venuesIn(line.text),
      time,
      stances,
      saidAt,
      source: "rules",
    });
  }

  return plans;
}

/**
 * A plan reading, written as anchors.
 *
 * No new table. An anchor is already a typed, versioned, rebuildable claim
 * about a node with a value, a display form, a span and a confidence, which is
 * exactly the shape of everything here. Adding a table would have meant a
 * migration, a second thing to keep in step with `ANCHOR_VERSION`, and a second
 * place for the frame layer to look.
 *
 * `going` is separate from `person` on purpose, and the distinction is the one
 * the product turns on: everybody in the group chat is a `person` on that
 * episode, and only the ones who said yes are `going`. Collapsing them would
 * put the whole thread on the roster, which is the specific wrong answer the
 * `ask` prompt already warns the model about in prose.
 */
export function anchorsOfPlan(plan: PlanReading): readonly Anchor[] {
  const anchors: Anchor[] = [
    {
      kind: "plan",
      value: plan.key,
      display: plan.proposal.slice(0, 120),
      startsAt: plan.time?.startsAt ?? null,
      endsAt: plan.time?.endsAt ?? null,
      confidence: plan.source === "model" ? 0.8 : 0.65,
    },
  ];

  if (plan.time !== null) {
    anchors.push({
      kind: "time_hint",
      value: plan.time.value,
      display: plan.time.display,
      startsAt: plan.time.startsAt,
      endsAt: plan.time.endsAt,
      confidence: plan.time.confidence,
    });
  }

  for (const phrase of plan.venuePhrases) {
    anchors.push({
      kind: "venue",
      value: normalizeVenue(phrase),
      display: phrase,
      startsAt: null,
      endsAt: null,
      confidence: 0.6,
    });
  }

  for (const stance of plan.stances) {
    if (stance.verdict !== "accept") {
      continue;
    }

    anchors.push({
      kind: "going",
      value: stance.entityId ?? `name:${stance.speaker.toLowerCase()}`,
      display: stance.speaker,
      startsAt: null,
      endsAt: null,
      confidence: stance.confidence,
    });
  }

  return anchors;
}

/* -------------------------------------------------------------------------
 * The model half.
 * ---------------------------------------------------------------------- */

const SYSTEM = `You read a group conversation and report what was arranged.

The transcript labels every line with who said it. "Me" is the person whose Harbor
this is.

Report at most one plan: a specific occasion two or more people agreed to attend.

Rules:
- Only report what is actually stated. Never infer a plan from tone or topic.
- going is everyone who agreed to attend, by their name exactly as it is labelled in
  the transcript. Include "Me" when they agreed. Do not include somebody who only
  acknowledged the message, asked a question, or was talked about.
- Every name in going must have a quote: the verbatim line where that person agreed.
  If you cannot quote it, leave them out.
- venue is the place, exactly as written. "the bar" is a valid answer. Null if nowhere
  was named.
- time is the words that state when, exactly as written: "later", "8ish", "after work".
  Never convert it, never guess one, null if nobody said when.
- Most conversations contain no plan. Returning null is the correct answer far more
  often than not.

Respond with JSON only, no prose and no code fences:
{"plan":null}
or
{"plan":{"proposal":"...","venue":null,"time":null,"going":[{"name":"...","quote":"..."}]}}`;

interface ModelPlan {
  readonly proposal?: unknown;
  readonly venue?: unknown;
  readonly time?: unknown;
  readonly going?: unknown;
}

function loose(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export interface RefineResult {
  readonly plan: PlanReading | null;
  readonly rejected: readonly string[];
}

/**
 * One transcript, read by a model, with every claim checked.
 *
 * The verification is the same one `purchase.ts` uses on a total: a number a
 * model produced that does not appear in the source text is a number the model
 * invented, and a quote that is not a substring of the transcript is a person
 * the model invented. Both are dropped rather than kept at low confidence,
 * because a roster that is mostly right is not a weaker version of a correct
 * roster. It is a false statement about who is going out tonight.
 */
export async function refinePlan(
  db: DB,
  transcript: string,
  base: PlanReading,
  tz: string,
  principalId: string,
): Promise<RefineResult> {
  const routed = await route(
    db,
    "extract.structured",
    {
      system: SYSTEM,
      messages: [{ role: "user", content: transcript }],
      // The roster shape, not the generic envelope. Every entry in `going` is
      // required to carry the words it came from, so a local server with
      // constrained decoding cannot emit a name without a quote to check it
      // against, and the verification below stops being the only thing
      // standing between a model's guess and somebody's evening.
      schema: schemaFor("extract.plan"),
    },
    { principalId, pipelineVersion: PLAN_VERSION },
  );

  const text = routed.result.content
    .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();

  let parsed: { plan?: ModelPlan | null };

  try {
    parsed = JSON.parse(text.replace(/^```(?:json)?|```$/g, "").trim()) as { plan?: ModelPlan | null };
  } catch {
    return { plan: null, rejected: ["the model did not return JSON"] };
  }

  const plan = parsed.plan;

  if (plan === null || plan === undefined || typeof plan !== "object") {
    return { plan: null, rejected: [] };
  }

  const haystack = loose(transcript);
  const rejected: string[] = [];
  const stances: Stance[] = [];

  for (const entry of Array.isArray(plan.going) ? plan.going : []) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }

    const name = (entry as { name?: unknown }).name;
    const quote = (entry as { quote?: unknown }).quote;

    if (typeof name !== "string" || typeof quote !== "string" || quote.trim().length === 0) {
      continue;
    }

    if (!haystack.includes(loose(quote))) {
      rejected.push(`${name}: the quote is not in the transcript`);
      continue;
    }

    stances.push({
      speaker: name.trim(),
      entityId: null,
      verdict: "accept",
      quote: quote.trim(),
      confidence: 0.85,
    });
  }

  if (stances.length === 0) {
    return { plan: null, rejected };
  }

  // A time the model reports has to be words somebody wrote, and it is parsed
  // here rather than trusted. Asking a model for an ISO timestamp is asking it
  // to do arithmetic about timezones and about which Thursday was meant, and
  // it will produce one confidently.
  const stated = typeof plan.time === "string" && haystack.includes(loose(plan.time))
    ? narrowest(timeHintsIn(plan.time, base.saidAt, tz))
    : null;

  const venue =
    typeof plan.venue === "string" && plan.venue.trim().length > 0 && haystack.includes(loose(plan.venue))
      ? [plan.venue.trim()]
      : base.venuePhrases;

  const proposal =
    typeof plan.proposal === "string" && haystack.includes(loose(plan.proposal))
      ? plan.proposal
      : base.proposal;

  return {
    plan: {
      ...base,
      proposal,
      venuePhrases: venue,
      time: stated ?? base.time,
      // The union, not the replacement. The rules found "im in" and the model
      // found "she can come"; each is evidence and neither supersedes the
      // other. Deduplicated by speaker, model first, because its stance
      // carries the quote that explains itself better.
      stances: dedupeStances([...stances, ...base.stances]),
      source: "model",
    },
    rejected,
  };
}

function dedupeStances(stances: readonly Stance[]): readonly Stance[] {
  const held = new Map<string, Stance>();

  for (const stance of stances) {
    const key = stance.speaker.toLowerCase();

    if (!held.has(key)) {
      held.set(key, stance);
    }
  }

  return [...held.values()];
}

export { HOUR as PLAN_HOUR };
