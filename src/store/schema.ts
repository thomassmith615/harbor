/**
 * The schema, as ordered migrations.
 *
 * Migration index is stored in SQLite's `user_version`. Migrations are append
 * only: to change something, add a new one. A migration is never edited after
 * it has run anywhere, including on your own machine.
 *
 * Three things here look like over-engineering for a single-user MVP and are
 * not:
 *
 *   households / people   The identity model exists before the UI does, because
 *                         retrieval is scoped by principal from the first line
 *                         of code. Adding that later means auditing every query.
 *
 *   raw                   The verbatim source payload, never modified. Every
 *                         derived value must be rebuildable from it without
 *                         re-fetching, because extraction logic will be wrong
 *                         repeatedly.
 *
 *   deleted_at            Tombstones, not deletes. A source that stops
 *                         mentioning something has not necessarily lost it.
 */

export const MIGRATIONS: readonly string[] = [
  // 001: identity, accounts, items, full text index.
  `
  CREATE TABLE households (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE people (
    id            TEXT PRIMARY KEY,
    household_id  TEXT NOT NULL REFERENCES households (id),
    kind          TEXT NOT NULL CHECK (kind IN ('adult', 'child', 'service')),
    name          TEXT NOT NULL,
    created_at    INTEGER NOT NULL
  );

  -- One authenticated connector instance. Custodian is whose account it is,
  -- which is a property of the account and inherited by everything it ingests.
  CREATE TABLE accounts (
    id                   TEXT PRIMARY KEY,
    source_type          TEXT NOT NULL,
    label                TEXT NOT NULL,
    custodian_person_id  TEXT NOT NULL REFERENCES people (id),
    credentials          TEXT NOT NULL,
    cursor               TEXT,
    last_sync_at         INTEGER,
    created_at           INTEGER NOT NULL,
    UNIQUE (source_type, label)
  );

  CREATE TABLE items (
    id                 TEXT PRIMARY KEY,
    account_id         TEXT NOT NULL REFERENCES accounts (id),
    external_id        TEXT NOT NULL,
    kind               TEXT NOT NULL,
    direction          TEXT CHECK (direction IN ('inbound', 'outbound', 'internal')),
    thread_id          TEXT,
    title              TEXT,
    body               TEXT,
    snippet            TEXT,
    author             TEXT,
    participants       TEXT,
    occurred_at        INTEGER NOT NULL,
    source_updated_at  INTEGER,
    ingested_at        INTEGER NOT NULL,
    content_hash       TEXT NOT NULL,
    uri                TEXT,
    raw                TEXT NOT NULL,
    visibility         TEXT NOT NULL DEFAULT 'private'
                       CHECK (visibility IN ('private', 'household')),
    deleted_at         INTEGER,
    UNIQUE (account_id, external_id)
  );

  CREATE INDEX items_occurred        ON items (occurred_at DESC);
  CREATE INDEX items_direction_time  ON items (direction, occurred_at DESC);
  CREATE INDEX items_account         ON items (account_id);
  CREATE INDEX items_thread          ON items (thread_id);

  -- Standalone rather than an external-content table: one fewer set of
  -- triggers to keep correct, and the duplication is not material at this size.
  CREATE VIRTUAL TABLE items_fts USING fts5 (
    item_id UNINDEXED,
    title,
    body,
    author,
    tokenize = 'porter unicode61'
  );

  INSERT INTO households (id, name, created_at)
  VALUES ('household:default', 'Default', CAST(strftime('%s', 'now') AS INTEGER) * 1000);

  INSERT INTO people (id, household_id, kind, name, created_at)
  VALUES ('person:me', 'household:default', 'adult', 'Me',
          CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  `,

  // 002: compressed raw payloads, and resumable sync runs.
  //
  // `raw_encoding` rather than a blanket rewrite: rows written before this
  // migration stay readable as plain JSON, new rows are gzipped, and the read
  // path handles both. Gmail's format=full response is mostly base64url HTML,
  // which compresses roughly tenfold. A full mailbox backfill is the difference
  // between a few hundred megabytes and several gigabytes. Raw stays sacred;
  // it just stops being stored naively.
  //
  // `sync_runs` exists because a backfill of tens of thousands of messages will
  // be interrupted. Resumability is the requirement. A general job queue is
  // not, yet: this work is I/O bound, and the thing that actually forces worker
  // processes is CPU-bound derivation (chunking, embedding), which does not
  // exist yet. Building the queue now would be guessing at its shape.
  `
  ALTER TABLE items ADD COLUMN raw_encoding TEXT NOT NULL DEFAULT 'json';

  CREATE TABLE sync_runs (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id        TEXT NOT NULL REFERENCES accounts (id),
    mode              TEXT NOT NULL CHECK (mode IN ('recent', 'backfill', 'incremental')),
    state             TEXT NOT NULL CHECK (state IN ('running', 'complete', 'failed')),
    page_cursor       TEXT,
    start_history_id  TEXT,
    fetched           INTEGER NOT NULL DEFAULT 0,
    changed           INTEGER NOT NULL DEFAULT 0,
    started_at        INTEGER NOT NULL,
    finished_at       INTEGER,
    error             TEXT
  );

  CREATE INDEX sync_runs_account ON sync_runs (account_id, mode, state);
  `,

  // 003: streams, and events.
  //
  // Adding the second source moved the schema in one way that only a second
  // source could have revealed: the sync cursor is not a property of the
  // account. One Google OAuth grant covers Gmail and Calendar, but Gmail
  // tracks a `historyId` and Calendar tracks a `syncToken`, and Calendar needs
  // one per calendar. So a cursor belongs to a *stream* (account + connector),
  // and it is an opaque string the framework never parses.
  //
  // `ends_at` is the other addition. Duration is a property of "when did this
  // happen", which is already a core concern, and events, calls, trips, and
  // tasks all have it. Everything genuinely calendar-specific (location,
  // recurrence, attendee response status, conferencing links) stays in `raw`
  // and will surface through a projection, not through more columns.
  `
  ALTER TABLE items ADD COLUMN ends_at INTEGER;
  ALTER TABLE items ADD COLUMN stream_id TEXT;

  CREATE TABLE streams (
    id            TEXT PRIMARY KEY,
    account_id    TEXT NOT NULL REFERENCES accounts (id),
    connector_id  TEXT NOT NULL,
    cursor        TEXT,
    last_sync_at  INTEGER,
    created_at    INTEGER NOT NULL,
    UNIQUE (account_id, connector_id)
  );

  INSERT INTO streams (id, account_id, connector_id, cursor, last_sync_at, created_at)
  SELECT id || '/gmail', id, 'gmail', cursor, last_sync_at, created_at FROM accounts;

  UPDATE items SET stream_id = account_id || '/gmail' WHERE stream_id IS NULL;

  ALTER TABLE sync_runs ADD COLUMN stream_id TEXT;
  UPDATE sync_runs SET stream_id = account_id || '/gmail' WHERE stream_id IS NULL;

  CREATE INDEX items_ends       ON items (ends_at);
  CREATE INDEX items_stream     ON items (stream_id);
  CREATE INDEX items_kind_time  ON items (kind, occurred_at DESC);

  -- Two places holding a cursor is how sync silently diverges. Drop the old one.
  ALTER TABLE accounts DROP COLUMN cursor;
  ALTER TABLE accounts DROP COLUMN last_sync_at;
  `,

  // 004: derivation. Chunks, embeddings, and settings.
  //
  // Everything in these tables is disposable. Chunks and vectors are stamped
  // with a `pipeline_version` and rebuildable from `raw` and `body` without
  // touching the network, which is the property the whole design rests on:
  // chunking will be naive, the embedding model will change, and neither can
  // be allowed to require a re-sync of a mailbox.
  //
  // `items.derived_version` is the incremental hook. It is set when an item is
  // derived and cleared whenever its content changes, so `harbor dev derive` only
  // ever works on what is actually stale.
  //
  // The vector index itself is NOT created here. It lives in a sqlite-vec
  // virtual table whose column width depends on the embedding model, and the
  // extension may not load on every machine. Retrieval creates it on demand
  // and falls back to a scan if it cannot.
  `
  CREATE TABLE settings (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    updated_at  INTEGER NOT NULL
  );

  CREATE TABLE chunks (
    id                TEXT PRIMARY KEY,
    item_id           TEXT NOT NULL REFERENCES items (id),
    ordinal           INTEGER NOT NULL,
    text              TEXT NOT NULL,
    chars             INTEGER NOT NULL,
    pipeline_version  INTEGER NOT NULL,
    created_at        INTEGER NOT NULL,
    UNIQUE (item_id, ordinal)
  );

  CREATE INDEX chunks_item     ON chunks (item_id);
  CREATE INDEX chunks_pipeline ON chunks (pipeline_version);

  CREATE TABLE embeddings (
    chunk_id          TEXT PRIMARY KEY REFERENCES chunks (id) ON DELETE CASCADE,
    model             TEXT NOT NULL,
    dims              INTEGER NOT NULL,
    vector            BLOB NOT NULL,
    pipeline_version  INTEGER NOT NULL,
    created_at        INTEGER NOT NULL
  );

  CREATE INDEX embeddings_model ON embeddings (model, pipeline_version);

  ALTER TABLE items ADD COLUMN derived_version INTEGER;
  ALTER TABLE items ADD COLUMN derived_at INTEGER;

  CREATE INDEX items_derived ON items (derived_version);
  `,

  // 005: entities.
  //
  // The table that makes "find the document I discussed with John" possible,
  // and the one most likely to do damage if it gets clever. The whole design
  // is built around one rule: an email address is an identity anchor, a name
  // is not. Names attach to entities; they never merge them. Two people called
  // John Smith stay two entities until a shared address or an explicit
  // `harbor merge` says otherwise.
  //
  // That rule costs recall. The alternative costs correctness, and a personal
  // data system that silently welds two people together produces confident
  // wrong answers with no visible symptom.
  //
  // Everything here is derived and disposable, with one exception: `pinned`
  // marks an entity a human has corrected, and resolution never overwrites a
  // pinned display name. That is the escape hatch for the cases the rule above
  // gets wrong.
  `
  CREATE TABLE entities (
    id            TEXT PRIMARY KEY,
    kind          TEXT NOT NULL CHECK (kind IN ('person', 'org', 'self')),
    display_name  TEXT NOT NULL,
    pinned        INTEGER NOT NULL DEFAULT 0,
    merged_into   TEXT REFERENCES entities (id),
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
  );

  CREATE INDEX entities_merged ON entities (merged_into);

  CREATE TABLE identifiers (
    id           TEXT PRIMARY KEY,
    entity_id    TEXT NOT NULL REFERENCES entities (id),
    kind         TEXT NOT NULL CHECK (kind IN ('email', 'name', 'handle')),
    value        TEXT NOT NULL,
    normalized   TEXT NOT NULL,
    confidence   REAL NOT NULL,
    occurrences  INTEGER NOT NULL DEFAULT 0,
    first_seen   INTEGER,
    last_seen    INTEGER,
    UNIQUE (kind, normalized)
  );

  CREATE INDEX identifiers_entity ON identifiers (entity_id);
  CREATE INDEX identifiers_norm   ON identifiers (normalized);

  CREATE TABLE item_entities (
    item_id    TEXT NOT NULL REFERENCES items (id),
    entity_id  TEXT NOT NULL REFERENCES entities (id),
    role       TEXT NOT NULL CHECK (role IN ('author', 'participant', 'mentioned')),
    PRIMARY KEY (item_id, entity_id, role)
  );

  CREATE INDEX item_entities_entity ON item_entities (entity_id, item_id);

  ALTER TABLE items ADD COLUMN entities_version INTEGER;
  CREATE INDEX items_entities_version ON items (entities_version);
  `,

  // 006: signals.
  //
  // The tables that turn Harbor from a search box into something that speaks
  // first. Four ideas, each of which is the difference between a product and a
  // nuisance:
  //
  //   interests    What the user is trying to do, as durable statements. This
  //                is closer to being the digital twin than `items` is: items
  //                are what happened to you, interests are what makes a given
  //                fact worth mentioning rather than merely true.
  //
  //   observations Candidates worth saying. `evidence` is NOT NULL and is
  //                enforced non-empty in code: nothing proactive may be
  //                asserted that cannot be clicked back to the items that
  //                produced it.
  //
  //   dedup_key    Said once, never again. Most proactive assistants fail here.
  //
  //   detector_feedback  Dismissals are the only quality signal available. A
  //                detector the user keeps waving away gets muted and reported
  //                rather than left running, because every added detector
  //                otherwise makes the product slightly worse.
  //
  // `earliest_useful_at` is why a recruiter email arriving Friday at 4:47pm is
  // mentioned on Monday morning. Detection time and delivery time are
  // different things and the schema has to know it.
  `
  CREATE TABLE interests (
    id                 TEXT PRIMARY KEY,
    principal_id       TEXT NOT NULL REFERENCES people (id),
    statement          TEXT NOT NULL,
    origin             TEXT NOT NULL CHECK (origin IN ('user', 'conversation')),
    origin_note        TEXT,
    state              TEXT NOT NULL
                       CHECK (state IN ('active', 'dormant', 'fulfilled', 'dismissed')),
    embedding          BLOB,
    embedding_model    TEXT,
    created_at         INTEGER NOT NULL,
    last_confirmed_at  INTEGER,
    expires_at         INTEGER
  );

  CREATE INDEX interests_principal ON interests (principal_id, state);

  CREATE TABLE observations (
    id                  TEXT PRIMARY KEY,
    principal_id        TEXT NOT NULL REFERENCES people (id),
    detector_id         TEXT NOT NULL,
    dedup_key           TEXT NOT NULL,
    title               TEXT NOT NULL,
    detail              TEXT,
    salience            REAL NOT NULL,
    evidence            TEXT NOT NULL,
    interest_id         TEXT REFERENCES interests (id),
    earliest_useful_at  INTEGER NOT NULL,
    expires_at          INTEGER,
    state               TEXT NOT NULL
                        CHECK (state IN ('pending', 'surfaced', 'dismissed', 'acted', 'stale')),
    created_at          INTEGER NOT NULL,
    surfaced_at         INTEGER,
    resolved_at         INTEGER,
    UNIQUE (principal_id, dedup_key)
  );

  CREATE INDEX observations_queue    ON observations (principal_id, state, salience DESC);
  CREATE INDEX observations_detector ON observations (detector_id, state);

  CREATE TABLE briefs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    principal_id    TEXT NOT NULL REFERENCES people (id),
    observation_ids TEXT NOT NULL,
    budget          INTEGER NOT NULL,
    created_at      INTEGER NOT NULL
  );

  CREATE TABLE detector_feedback (
    detector_id  TEXT PRIMARY KEY,
    surfaced     INTEGER NOT NULL DEFAULT 0,
    dismissed    INTEGER NOT NULL DEFAULT 0,
    acted        INTEGER NOT NULL DEFAULT 0,
    suppressed   INTEGER NOT NULL DEFAULT 0,
    updated_at   INTEGER NOT NULL
  );
  `,

  // 007: policy, audit, routing.
  //
  // Everything that reaches a model now goes through one chokepoint. Policy
  // decides what may leave, the router decides what handles it, the audit log
  // records both. Building those apart would have meant building the chokepoint
  // twice, and a second one is how the first gets bypassed.
  //
  //   items.sensitivity  Derived, versioned, and rebuildable like every other
  //                      derivation. Deterministic rules first; a model is a
  //                      fallback, never the default, because classifying an
  //                      entire mailbox with a model is exactly the cost the
  //                      routing ladder exists to avoid.
  //
  //   policy_rules       Ordered by priority, first match wins. Built-in rules
  //                      are seeded here and can be overridden but not deleted,
  //                      so a bad edit degrades to the defaults rather than to
  //                      no policy at all.
  //
  //   audit_log          What was seen, by whom, under which rule, at what
  //                      cost. This is the table that makes "your data stays
  //                      yours" a queryable claim rather than a sentence in a
  //                      README.
  //
  //   model_cache        Cheapest model is no model. Keyed on task class plus
  //                      input plus pipeline version, so a re-derive after a
  //                      logic change recomputes only what actually changed.
  //
  //   router_quality     An escalation ladder with no quality signal degrades
  //                      silently. Shadow samples land here and demote a tier
  //                      that has stopped being good enough.
  `
  ALTER TABLE items ADD COLUMN sensitivity TEXT;
  ALTER TABLE items ADD COLUMN classified_version INTEGER;

  CREATE INDEX items_sensitivity ON items (sensitivity);
  CREATE INDEX items_classified  ON items (classified_version);

  CREATE TABLE policy_rules (
    id                 TEXT PRIMARY KEY,
    priority           INTEGER NOT NULL,
    match_kind         TEXT,
    match_sensitivity  TEXT,
    match_entity       TEXT,
    match_pattern      TEXT,
    egress             TEXT NOT NULL CHECK (egress IN ('local_only', 'redacted', 'allowed')),
    confirm            TEXT NOT NULL CHECK (confirm IN ('never', 'first_time', 'always')),
    note               TEXT,
    builtin            INTEGER NOT NULL DEFAULT 0,
    enabled            INTEGER NOT NULL DEFAULT 1,
    created_at         INTEGER NOT NULL
  );

  CREATE INDEX policy_rules_order ON policy_rules (enabled, priority);

  CREATE TABLE audit_log (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    at             INTEGER NOT NULL,
    principal_id   TEXT NOT NULL,
    kind           TEXT NOT NULL,
    task_class     TEXT,
    provider       TEXT,
    model          TEXT,
    tier           TEXT,
    item_ids       TEXT,
    items_included INTEGER NOT NULL DEFAULT 0,
    items_withheld INTEGER NOT NULL DEFAULT 0,
    redactions     INTEGER NOT NULL DEFAULT 0,
    bytes_out      INTEGER NOT NULL DEFAULT 0,
    input_tokens   INTEGER,
    output_tokens  INTEGER,
    cost_micros    INTEGER,
    rule_ids       TEXT,
    outcome        TEXT NOT NULL,
    note           TEXT
  );

  CREATE INDEX audit_at    ON audit_log (at DESC);
  CREATE INDEX audit_task  ON audit_log (task_class, at DESC);

  CREATE TABLE model_cache (
    key         TEXT PRIMARY KEY,
    task_class  TEXT NOT NULL,
    value       TEXT NOT NULL,
    model       TEXT NOT NULL,
    tier        TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    hits        INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX model_cache_task ON model_cache (task_class);

  CREATE TABLE router_quality (
    task_class     TEXT NOT NULL,
    tier           TEXT NOT NULL,
    samples        INTEGER NOT NULL DEFAULT 0,
    disagreements  INTEGER NOT NULL DEFAULT 0,
    demoted        INTEGER NOT NULL DEFAULT 0,
    updated_at     INTEGER NOT NULL,
    PRIMARY KEY (task_class, tier)
  );
  `,

  // 008: the daemon, devices, and write actions.
  //
  // Harbor stops being something you invoke and becomes something that runs.
  //
  //   schedules        Interval and daily triggers, with the next run computed
  //                    and stored rather than held in memory, so a restart does
  //                    not lose the schedule or double-fire it.
  //
  //   devices          Once other machines in the house can reach Harbor, a
  //                    process listening on a socket is not a trusted caller.
  //                    Tokens are stored hashed; the plaintext is shown once at
  //                    pairing and never again.
  //
  //   pending_actions  Every write is proposed, then approved, then executed,
  //                    then verified. Nothing a model asks for happens without a
  //                    human saying yes, because writes are the only
  //                    irreversible thing Harbor does, and "the model booked it"
  //                    is not a recoverable failure.
  `
  CREATE TABLE schedules (
    id                TEXT PRIMARY KEY,
    principal_id      TEXT NOT NULL REFERENCES people (id),
    task              TEXT NOT NULL,
    interval_minutes  INTEGER,
    at_hour           INTEGER,
    at_minute         INTEGER,
    enabled           INTEGER NOT NULL DEFAULT 1,
    last_run_at       INTEGER,
    last_status       TEXT,
    last_note         TEXT,
    next_run_at       INTEGER,
    created_at        INTEGER NOT NULL
  );

  CREATE INDEX schedules_due ON schedules (enabled, next_run_at);

  CREATE TABLE devices (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    token_hash    TEXT NOT NULL UNIQUE,
    principal_id  TEXT NOT NULL REFERENCES people (id),
    scopes        TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    last_seen_at  INTEGER,
    revoked_at    INTEGER
  );

  CREATE TABLE pending_actions (
    id            TEXT PRIMARY KEY,
    principal_id  TEXT NOT NULL REFERENCES people (id),
    connector_id  TEXT NOT NULL,
    action        TEXT NOT NULL,
    args          TEXT NOT NULL,
    summary       TEXT NOT NULL,
    state         TEXT NOT NULL
                  CHECK (state IN ('pending', 'approved', 'rejected', 'executed', 'failed')),
    requested_by  TEXT,
    verification  TEXT,
    external_id   TEXT,
    result        TEXT,
    created_at    INTEGER NOT NULL,
    decided_at    INTEGER,
    executed_at   INTEGER,
    expires_at    INTEGER
  );

  CREATE INDEX pending_actions_state ON pending_actions (state, created_at DESC);
  `,

  // 009: jobs, pairing, and remote auth flows.
  //
  // The three things that stop Harbor being a CLI with an API bolted on.
  //
  //   jobs        Long passes stop being synchronous functions that print to a
  //               logger. A client starts one, polls it, shows progress, and
  //               survives being backgrounded. `sync_runs` already had the hard
  //               part (resumable, checkpointed); this generalizes it to every
  //               pass and makes progress readable rather than printed.
  //
  //   pairing_codes  A device joins by scanning a short-lived code, not by
  //               someone reading a token out of a terminal. Codes are single
  //               use and expire in minutes, because a pairing secret that
  //               lives forever is a password nobody rotates.
  //
  //   auth_flows  OAuth currently assumes the browser and the daemon are the
  //               same machine: it opens a loopback listener and points a local
  //               browser at it. With the daemon in a closet and the browser on
  //               a phone, that cannot work. Splitting start from complete lets
  //               whoever has a browser do the browsing.
  `
  CREATE TABLE jobs (
    id              TEXT PRIMARY KEY,
    principal_id    TEXT NOT NULL REFERENCES people (id),
    task            TEXT NOT NULL,
    state           TEXT NOT NULL
                    CHECK (state IN ('queued', 'running', 'complete', 'failed', 'cancelled')),
    phase           TEXT,
    progress_done   INTEGER NOT NULL DEFAULT 0,
    progress_total  INTEGER,
    note            TEXT,
    error           TEXT,
    requested_by    TEXT,
    created_at      INTEGER NOT NULL,
    started_at      INTEGER,
    finished_at     INTEGER
  );

  CREATE INDEX jobs_state ON jobs (state, created_at DESC);
  CREATE INDEX jobs_task  ON jobs (task, created_at DESC);

  CREATE TABLE pairing_codes (
    code          TEXT PRIMARY KEY,
    principal_id  TEXT NOT NULL REFERENCES people (id),
    scopes        TEXT NOT NULL,
    label         TEXT,
    expires_at    INTEGER NOT NULL,
    used_at       INTEGER,
    created_at    INTEGER NOT NULL
  );

  CREATE TABLE auth_flows (
    id            TEXT PRIMARY KEY,
    source_type   TEXT NOT NULL,
    oauth_state   TEXT NOT NULL,
    verifier      TEXT NOT NULL,
    redirect_uri  TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    expires_at    INTEGER NOT NULL,
    completed_at  INTEGER
  );

  CREATE INDEX auth_flows_state ON auth_flows (oauth_state);
  `,

  // 010: conversations.
  //
  // Every `ask` was previously a cold start. "Yes, do that" got answered with
  // "this appears to be the start of our conversation", which is both true and
  // useless, and worse, the model would invent a plausible continuity it did
  // not have.
  //
  // Turns are stored verbatim and recent ones replayed. Older ones roll into a
  // summary rather than being dropped or replayed forever: dropping loses the
  // thread, replaying makes every question in a long conversation cost more
  // than the last until it stops working.
  //
  // `summarized_through` is the watermark. Turns at or below it are represented
  // by the summary; turns above it are replayed as themselves.
  `
  CREATE TABLE conversations (
    id                  TEXT PRIMARY KEY,
    principal_id        TEXT NOT NULL REFERENCES people (id),
    title               TEXT,
    summary             TEXT,
    summarized_through  INTEGER NOT NULL DEFAULT 0,
    created_at          INTEGER NOT NULL,
    updated_at          INTEGER NOT NULL
  );

  CREATE INDEX conversations_recent ON conversations (principal_id, updated_at DESC);

  CREATE TABLE turns (
    id               TEXT PRIMARY KEY,
    conversation_id  TEXT NOT NULL REFERENCES conversations (id),
    seq              INTEGER NOT NULL,
    role             TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content          TEXT NOT NULL,
    evidence         TEXT,
    tools_used       TEXT,
    model            TEXT,
    cost_micros      INTEGER,
    created_at       INTEGER NOT NULL,
    UNIQUE (conversation_id, seq)
  );

  CREATE INDEX turns_conversation ON turns (conversation_id, seq);
  `,

  // 011: cancellable jobs.
  //
  // A backfill can run for half an hour and there was no way to stop it short
  // of killing the daemon, which loses nothing (the passes resume) but is a
  // blunt instrument for "actually, not now".
  //
  // Cooperative rather than forced: the flag is set here and the passes check
  // it between batches. Interrupting mid-batch would leave a half-written
  // transaction, and every pass already knows how to stop cleanly at a
  // checkpoint because that is how resume works.
  `
  ALTER TABLE jobs ADD COLUMN cancel_requested INTEGER NOT NULL DEFAULT 0;
  `,

  // 012: phased ingestion.
  //
  // A first run used to mean reading everything before Harbor was useful for
  // anything, which on a real mailbox is an hour of waiting at a progress bar.
  // Now ingestion happens in two passes and the useful one goes first:
  //
  //   recent      The last few months, across every source. Minutes, not an
  //               hour, and enough that search, people, and the brief all work.
  //   historical  Everything older, oldest-ward, in the background. Coverage
  //               already tells the model what it cannot see, so answers stay
  //               honest while this fills in behind them.
  //
  // Contacts are exempt and always ingested whole: an address book is small,
  // and it is what turns addresses and phone numbers into people, so every
  // other source is worth more once it has landed.
  //
  // `target` on a schedule is the other half. One cadence for every source is
  // wrong in both directions: a local SQLite read can happen every minute,
  // while a CalDAV round trip every minute is rude for no benefit.
  `
  ALTER TABLE streams ADD COLUMN recent_done INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE streams ADD COLUMN historical_done INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE streams ADD COLUMN oldest_reached INTEGER;

  ALTER TABLE schedules ADD COLUMN target TEXT;
  `,

  // 013: phone numbers as identity, and nicknames for search.
  //
  // Two separate problems that both looked like "matching people".
  //
  // **Phone numbers were not anchors.** iMessage stores a handle as
  // +15551234567 and the resolver only treated strings containing @ as identity.
  // So every text conversation built its own entity, disconnected from the
  // contact card that had the same number under TEL, and "everything involving
  // Marcus" saw his email and not his messages. The CHECK constraint has to be
  // rebuilt to admit a phone kind, which is why this migration copies the table.
  //
  // **Nicknames are search, not identity, and the distinction is load-bearing.**
  // A card says Isabella Forté; the user types "issy". Deriving that is useful
  // and it is also guesswork, so derived names live in their own table with no
  // uniqueness: two people may both plausibly be "issy", and an identifier row
  // could not represent that without one of them silently swallowing the other.
  // Aliases widen lookup and never merge anything.
  `
  CREATE TABLE identifiers_next (
    id           TEXT PRIMARY KEY,
    entity_id    TEXT NOT NULL REFERENCES entities (id),
    kind         TEXT NOT NULL CHECK (kind IN ('email', 'phone', 'name', 'handle')),
    value        TEXT NOT NULL,
    normalized   TEXT NOT NULL,
    confidence   REAL NOT NULL,
    occurrences  INTEGER NOT NULL DEFAULT 0,
    first_seen   INTEGER,
    last_seen    INTEGER,
    UNIQUE (kind, normalized)
  );

  INSERT INTO identifiers_next
    SELECT id, entity_id, kind, value, normalized, confidence, occurrences, first_seen, last_seen
    FROM identifiers;

  DROP TABLE identifiers;
  ALTER TABLE identifiers_next RENAME TO identifiers;

  CREATE INDEX identifiers_entity ON identifiers (entity_id);
  CREATE INDEX identifiers_norm   ON identifiers (normalized);

  CREATE TABLE entity_aliases (
    entity_id   TEXT NOT NULL REFERENCES entities (id),
    alias       TEXT NOT NULL,
    normalized  TEXT NOT NULL,
    origin      TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (entity_id, normalized)
  );

  CREATE INDEX entity_aliases_norm ON entity_aliases (normalized);
  `,

  // 014: jobs remember which process owns them.
  //
  // Orphan reaping ran on every database open and failed anything still marked
  // running. The intent was to clean up after a crash. The effect was that
  // `harbor jobs`, run to check on a backfill, opened the database and killed
  // the backfill it was reporting on. Twice, deterministically, with an error
  // message blaming a restart that never happened.
  //
  // Recording the pid makes the check precise: a job is orphaned when the
  // process that owns it is gone, which is a fact rather than an assumption.
  `
  ALTER TABLE jobs ADD COLUMN owner_pid INTEGER;
  `,

  // 015: relationships between items.
  //
  // The gap the whole product rests on. Harbor could link an item to a person
  // and could not link an item to another item, which means "this email, this
  // calendar entry, and this text describe one situation" was not merely
  // uncomputed, it was unrepresentable. Every cross-source example anyone gives
  // for why Harbor should exist bottoms out here.
  //
  // Two tables, and the split matters.
  //
  //   relationships   One edge between two items, with a kind, a confidence,
  //                   and the reason it was drawn. Cheap, deterministic, and
  //                   individually meaningless: a reply is a reply.
  //
  //   threads         A set of items that appear to be about one real-world
  //                   situation, assembled from those edges. This is the thing
  //                   a person would name. "The Boston trip" is not an edge; it
  //                   is a connected component of them.
  //
  // Both are derivations. Nothing here is authored by the user and nothing is
  // irreplaceable, so `relationships_version` behaves like every other version
  // column: bump it and the whole graph rebuilds from items that never had to
  // be re-fetched.
  `
  CREATE TABLE relationships (
    id           TEXT PRIMARY KEY,
    from_item    TEXT NOT NULL REFERENCES items (id),
    to_item      TEXT NOT NULL REFERENCES items (id),
    kind         TEXT NOT NULL,
    confidence   REAL NOT NULL,
    evidence     TEXT NOT NULL,
    detector     TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    UNIQUE (from_item, to_item, kind)
  );

  CREATE INDEX relationships_from ON relationships (from_item);
  CREATE INDEX relationships_to   ON relationships (to_item);
  CREATE INDEX relationships_kind ON relationships (kind, confidence DESC);

  CREATE TABLE threads (
    id            TEXT PRIMARY KEY,
    principal_id  TEXT NOT NULL REFERENCES people (id),
    title         TEXT,
    summary       TEXT,
    kind          TEXT NOT NULL,
    starts_at     INTEGER,
    ends_at       INTEGER,
    item_count    INTEGER NOT NULL DEFAULT 0,
    source_count  INTEGER NOT NULL DEFAULT 0,
    salience      REAL NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
  );

  CREATE INDEX threads_recent ON threads (principal_id, ends_at DESC);

  CREATE TABLE thread_items (
    thread_id  TEXT NOT NULL REFERENCES threads (id),
    item_id    TEXT NOT NULL REFERENCES items (id),
    role       TEXT,
    PRIMARY KEY (thread_id, item_id)
  );

  CREATE INDEX thread_items_item ON thread_items (item_id);

  ALTER TABLE items ADD COLUMN relationships_version INTEGER;

  CREATE INDEX items_relationships_pending
    ON items (relationships_version) WHERE deleted_at IS NULL;
  `,

  // 016: the reference index, and the end of batch-local edges.
  //
  // The relationship pass shipped with a defect that only showed up on the
  // second run. Linkers received a batch of pending items and looked for pairs
  // inside it, so the first full pass looked correct (the batch was the whole
  // store) and every run afterwards could only connect items that arrived
  // together. A message that lands this morning could not be linked to the
  // booking it refers to, which is the only kind of connection Harbor exists
  // to make.
  //
  // Fixing it needs one thing the schema did not have: a way to ask "what else
  // mentions this identifier" without scanning text. Hence `item_references`.
  // Extraction happens once per item and is versioned separately from the
  // linkers, because improving a pattern should cost a re-scan of stored text
  // and improving a linker should not.
  //
  // No data is thrown away here. RELATIONSHIP_VERSION moves to 2, so every
  // item becomes pending once and the graph is redrawn from items that were
  // never re-fetched, exactly as every other derivation behaves.
  `
  CREATE TABLE item_references (
    item_id  TEXT NOT NULL REFERENCES items (id),
    kind     TEXT NOT NULL,
    value    TEXT NOT NULL,
    PRIMARY KEY (item_id, kind, value)
  );

  -- The index the whole fix rests on: candidate generation is a lookup by
  -- value, and without this it is a table scan on every item in every pass.
  CREATE INDEX item_references_value ON item_references (kind, value);

  ALTER TABLE items ADD COLUMN references_version INTEGER;

  CREATE INDEX items_references_pending
    ON items (references_version) WHERE deleted_at IS NULL;

  -- Candidate generation asks for items involving one person inside a time
  -- window. The existing index is on (entity_id, item_id), which finds the
  -- items but leaves the time filter to a scan of them.
  CREATE INDEX items_occurred_kind ON items (occurred_at, kind);
  `,

  // 017: episodes, and reminders that know whether they are done.
  //
  // Two gaps that only became visible once the source mix stopped being
  // mail-shaped.
  //
  // **An item is not always a unit of meaning.** An email is: subject, body,
  // sender, one moment. A text message is not. "yeah saturday works" is one
  // item, one chunk, one vector, and it means nothing on its own. A store whose
  // most important source is conversational was holding tens of thousands of
  // individually meaningless fragments and embedding each one, so semantic
  // retrieval could not find the conversation where something was planned
  // because no single message in it carried enough words to rank.
  //
  // An episode is a contiguous burst of messages in one conversation: the unit
  // a person would call "when we talked about the trip". It is derived,
  // versioned, and rebuildable from items, like every other derivation here.
  // Episode text is embedded; the messages inside it are not.
  //
  // **A reminder is a state, not an event.** Open, due, completed. Harbor kept
  // all three in `raw`, which meant "what have I still not done" was
  // unanswerable, and completing a reminder in the Reminders app did not even
  // change the content hash, so the row was never rewritten. Both are columns
  // now, and `state` joins the hash.
  //
  // `embeddings` is rebuilt here to drop its foreign key to `chunks`. Vectors
  // now belong to a chunk of either an item or an episode, and the two live in
  // separate tables. Chunk deletion already removes the matching embeddings
  // explicitly, so nothing depended on the cascade.
  `
  ALTER TABLE items ADD COLUMN state TEXT;
  ALTER TABLE items ADD COLUMN due_at INTEGER;

  CREATE INDEX items_open_state ON items (kind, state, due_at) WHERE deleted_at IS NULL;

  CREATE TABLE episodes (
    id             TEXT PRIMARY KEY,
    stream_id      TEXT NOT NULL,
    thread_id      TEXT NOT NULL,
    principal_id   TEXT NOT NULL REFERENCES people (id),
    title          TEXT,
    transcript     TEXT NOT NULL,
    participants   TEXT NOT NULL,
    message_count  INTEGER NOT NULL,
    starts_at      INTEGER NOT NULL,
    ends_at        INTEGER NOT NULL,
    segment_version INTEGER NOT NULL,
    derived_version INTEGER,
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL
  );

  CREATE INDEX episodes_thread  ON episodes (thread_id, starts_at);
  CREATE INDEX episodes_recent  ON episodes (ends_at DESC);
  CREATE INDEX episodes_pending ON episodes (derived_version);

  CREATE TABLE episode_items (
    episode_id  TEXT NOT NULL REFERENCES episodes (id),
    item_id     TEXT NOT NULL REFERENCES items (id),
    PRIMARY KEY (episode_id, item_id)
  );

  CREATE INDEX episode_items_item ON episode_items (item_id);

  CREATE VIRTUAL TABLE episodes_fts USING fts5 (
    episode_id UNINDEXED,
    title,
    transcript,
    tokenize = 'porter unicode61'
  );

  ALTER TABLE items ADD COLUMN episode_version INTEGER;

  CREATE INDEX items_episode_pending
    ON items (episode_version) WHERE deleted_at IS NULL;

  CREATE TABLE episode_chunks (
    id                TEXT PRIMARY KEY,
    episode_id        TEXT NOT NULL REFERENCES episodes (id),
    ordinal           INTEGER NOT NULL,
    text              TEXT NOT NULL,
    chars             INTEGER NOT NULL,
    pipeline_version  INTEGER NOT NULL,
    created_at        INTEGER NOT NULL,
    UNIQUE (episode_id, ordinal)
  );

  CREATE INDEX episode_chunks_episode ON episode_chunks (episode_id);

  CREATE TABLE embeddings_next (
    chunk_id          TEXT PRIMARY KEY,
    model             TEXT NOT NULL,
    dims              INTEGER NOT NULL,
    vector            BLOB NOT NULL,
    pipeline_version  INTEGER NOT NULL,
    created_at        INTEGER NOT NULL
  );

  INSERT INTO embeddings_next (chunk_id, model, dims, vector, pipeline_version, created_at)
    SELECT chunk_id, model, dims, vector, pipeline_version, created_at FROM embeddings;

  DROP TABLE embeddings;
  ALTER TABLE embeddings_next RENAME TO embeddings;

  CREATE INDEX embeddings_model ON embeddings (model, pipeline_version);
  `,

  // 018: commitments.
  //
  // The first projection, and the one that makes the product thesis
  // representable rather than merely searchable.
  //
  // Everything Harbor holds so far is a record of something that was *said*: a
  // message, an event, a reminder, an email. Four sources each hold a different
  // form of the same underlying thing, and no source can see the others. An
  // intention stated in a conversation, a reminder written to not forget it, a
  // calendar entry that formalizes it, and an email that confirms or changes it
  // are one commitment with four pieces of evidence.
  //
  // A commitment is deliberately *not* an item. Items are what a source told
  // us and are never edited. A commitment has a state that changes over time,
  // is assembled from several items, and is Harbor's own claim rather than any
  // source's. Keeping it in its own table is what allows "what have I said I
  // would do and not done" to be a query.
  //
  // Calendar events do not become commitments on their own, which is a
  // deliberate limit. An event already sits in a calendar, already answers
  // "what is happening Friday", and turning every recurring standup into a
  // commitment would bury the handful that matter. Events instead *schedule*
  // commitments that already exist.
  //
  // Evidence rows carry their own id rather than a composite key because a
  // piece of evidence may be an item or an episode, and SQLite treats NULLs in
  // a unique index as distinct, which would let the same evidence attach twice.
  `
  CREATE TABLE commitments (
    id             TEXT PRIMARY KEY,
    principal_id   TEXT NOT NULL REFERENCES people (id),
    title          TEXT NOT NULL,
    normalized     TEXT NOT NULL,
    owner          TEXT NOT NULL,
    counterparty   TEXT,
    state          TEXT NOT NULL,
    due_at         INTEGER,
    occurs_at      INTEGER,
    confidence     REAL NOT NULL,
    origin         TEXT NOT NULL,
    extract_version INTEGER NOT NULL,
    first_seen_at  INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL,
    closed_at      INTEGER,
    closed_reason  TEXT
  );

  CREATE INDEX commitments_open  ON commitments (principal_id, state, due_at);
  CREATE INDEX commitments_match ON commitments (normalized);
  CREATE INDEX commitments_time  ON commitments (COALESCE(due_at, occurs_at, first_seen_at));

  CREATE TABLE commitment_evidence (
    id            TEXT PRIMARY KEY,
    commitment_id TEXT NOT NULL REFERENCES commitments (id),
    item_id       TEXT REFERENCES items (id),
    episode_id    TEXT REFERENCES episodes (id),
    role          TEXT NOT NULL,
    note          TEXT NOT NULL,
    occurred_at   INTEGER NOT NULL,
    CHECK ((item_id IS NULL) <> (episode_id IS NULL))
  );

  CREATE INDEX commitment_evidence_commitment ON commitment_evidence (commitment_id);
  CREATE INDEX commitment_evidence_item       ON commitment_evidence (item_id);
  CREATE INDEX commitment_evidence_episode    ON commitment_evidence (episode_id);

  ALTER TABLE items ADD COLUMN commitment_version INTEGER;
  ALTER TABLE episodes ADD COLUMN commitment_version INTEGER;

  CREATE INDEX items_commitment_pending
    ON items (commitment_version) WHERE deleted_at IS NULL;
  CREATE INDEX episodes_commitment_pending ON episodes (commitment_version);
  `,

  // 019: weight, and the digest.
  //
  // **Not every account is equally about the person.** A signup address that
  // exists to get past popups produces a large volume of mail that is real,
  // correctly ingested, and worth nothing. Harbor had no way to know that, so
  // every detector treated a marketing blast the same as a message from a
  // friend. Weight is a per-account multiplier applied to salience only. It
  // never filters retrieval: asking about something in a low-weight account
  // still finds it. It only decides what is worth interrupting someone about.
  //
  // **A digest is a thing that was said, so it is stored.** Not for history's
  // sake: without a record of what was surfaced and when, there is no way to
  // avoid saying the same thing again tomorrow in slightly different words,
  // and no way to answer "you already told me this".
  `
  ALTER TABLE accounts ADD COLUMN weight REAL NOT NULL DEFAULT 1.0;

  CREATE TABLE digests (
    id            TEXT PRIMARY KEY,
    principal_id  TEXT NOT NULL REFERENCES people (id),
    created_at    INTEGER NOT NULL,
    covers_from   INTEGER NOT NULL,
    text          TEXT NOT NULL,
    entry_count   INTEGER NOT NULL,
    observation_ids TEXT NOT NULL,
    delivered_at  INTEGER,
    channel       TEXT
  );

  CREATE INDEX digests_recent ON digests (principal_id, created_at DESC);
  `,

  // 020: recurrence.
  //
  // The commitment layer met a real reminder list and the result was a digest
  // that would have spent its entire budget telling somebody rent was due in
  // November, December, January, and February.
  //
  // A recurring reminder is one intention with a schedule, not four
  // obligations. Harbor was treating every instance as its own commitment, so
  // each lapsed separately and each became its own thing worth saying. The
  // RRULE was in the CalDAV data the whole time and was being discarded.
  //
  // `recurrence` on items keeps the rule as stated. `recurring` on commitments
  // is what the detectors read: a recurring commitment merges every instance
  // into one row that tracks the next occurrence, and never lapses, because a
  // monthly bill that was not paid in November is not an abandoned intention.
  `
  ALTER TABLE items ADD COLUMN recurrence TEXT;
  ALTER TABLE commitments ADD COLUMN recurring INTEGER NOT NULL DEFAULT 0;

  CREATE INDEX commitments_recurring ON commitments (principal_id, recurring, state);
  `,

  // 021: projections, and the text inside attachments.
  //
  // "What did I spend on groceries in July" is a sum over structured records.
  // Nothing in the store could hold one. Items, chunks, entities, edges, and
  // episodes can all represent that an email happened and that two things are
  // related; none of them can represent two pounds of chicken thighs at $8.99
  // on the third. No amount of retrieval over chunks answers a question that
  // needs an aggregate rather than a ranking.
  //
  // A projection is a structured fact extracted from an item, with a declared
  // type, a schema version, and a pointer back to what it came from. Purchases
  // are the first type; the table is deliberately generic because the second
  // and third types (deliveries, bills) should not need a migration.
  //
  // Attachments store extracted text, not bytes. A mailbox of PDF receipts
  // would double the database for content nobody reads directly, and the text
  // is what makes a receipt findable and extractable. The digest of the bytes
  // is kept so a re-extraction can tell whether the file actually changed.
  `
  CREATE TABLE attachments (
    id             TEXT PRIMARY KEY,
    item_id        TEXT NOT NULL REFERENCES items (id),
    filename       TEXT,
    mime           TEXT,
    size_bytes     INTEGER NOT NULL,
    sha256         TEXT,
    text           TEXT,
    text_version   INTEGER,
    extract_error  TEXT,
    created_at     INTEGER NOT NULL
  );

  CREATE INDEX attachments_item ON attachments (item_id);
  CREATE INDEX attachments_pending ON attachments (text_version);

  CREATE TABLE projections (
    id             TEXT PRIMARY KEY,
    principal_id   TEXT NOT NULL REFERENCES people (id),
    item_id        TEXT NOT NULL REFERENCES items (id),
    type           TEXT NOT NULL,
    schema_version INTEGER NOT NULL,
    occurred_at    INTEGER NOT NULL,
    merchant       TEXT,
    currency       TEXT,
    total_cents    INTEGER,
    reference      TEXT,
    payload        TEXT NOT NULL,
    confidence     REAL NOT NULL,
    model          TEXT,
    created_at     INTEGER NOT NULL
  );

  -- Aggregation is the point, so the indexes are the aggregation keys.
  CREATE INDEX projections_type_time ON projections (principal_id, type, occurred_at DESC);
  CREATE INDEX projections_merchant  ON projections (principal_id, type, merchant);
  CREATE INDEX projections_item      ON projections (item_id);

  CREATE TABLE projection_lines (
    id             TEXT PRIMARY KEY,
    projection_id  TEXT NOT NULL REFERENCES projections (id),
    ordinal        INTEGER NOT NULL,
    description    TEXT NOT NULL,
    quantity       REAL,
    unit           TEXT,
    amount_cents   INTEGER
  );

  CREATE INDEX projection_lines_projection ON projection_lines (projection_id);

  ALTER TABLE items ADD COLUMN projection_version INTEGER;

  CREATE INDEX items_projection_pending
    ON items (projection_version) WHERE deleted_at IS NULL;
  `,

  // 022: what Harbor knows about the person.
  //
  // Everything so far is a record of events, or something derived from a
  // specific one. None of it holds the standing facts that make an answer good
  // rather than merely correct: that somebody does not eat pork, that Dana is a
  // counterparty and not a colleague, which airport they fly from. Those change
  // rarely, apply everywhere, and are exactly the thing that compounds as
  // Harbor is used.
  //
  // The design constraint is trust rather than storage. A system that quietly
  // accumulates conclusions about a person and then acts on them is a system
  // whose mistakes are invisible until they are embarrassing. So a fact has a
  // state: `proposed` until a person says otherwise, `confirmed` once they do,
  // and `rejected` forever after if they say no. Only confirmed facts reach a
  // model. Harbor may notice; it may not decide.
  //
  // Every fact keeps the item or conversation it came from, so "why does Harbor
  // think this about me" is always answerable, and a wrong one can be traced to
  // the thing that misled it rather than argued with.
  `
  CREATE TABLE facts (
    id            TEXT PRIMARY KEY,
    principal_id  TEXT NOT NULL REFERENCES people (id),
    kind          TEXT NOT NULL,
    statement     TEXT NOT NULL,
    normalized    TEXT NOT NULL,
    state         TEXT NOT NULL,
    confidence    REAL NOT NULL,
    origin        TEXT NOT NULL,
    source_item   TEXT REFERENCES items (id),
    source_episode TEXT REFERENCES episodes (id),
    quote         TEXT,
    first_seen_at INTEGER NOT NULL,
    decided_at    INTEGER,
    updated_at    INTEGER NOT NULL
  );

  CREATE INDEX facts_state ON facts (principal_id, state, kind);
  CREATE UNIQUE INDEX facts_normalized ON facts (principal_id, normalized);

  -- Subjects that keep coming up across conversations. Derived, disposable, and
  -- rebuilt on every pass, which is why it carries no state of its own beyond
  -- what the detector needs to explain itself.
  CREATE TABLE topics (
    id            TEXT PRIMARY KEY,
    principal_id  TEXT NOT NULL REFERENCES people (id),
    term          TEXT NOT NULL,
    episode_count INTEGER NOT NULL,
    first_at      INTEGER NOT NULL,
    last_at       INTEGER NOT NULL,
    computed_at   INTEGER NOT NULL
  );

  CREATE INDEX topics_recent ON topics (principal_id, last_at DESC);

  ALTER TABLE episodes ADD COLUMN fact_version INTEGER;
  CREATE INDEX episodes_fact_pending ON episodes (fact_version);
  `,

  // 023: the graph learns that a conversation is a thing.
  //
  // The relationship layer shipped able to connect items and nothing else,
  // which sounded general and was not. The most important source in the store
  // is iMessage, whose unit of meaning is an episode rather than a message, and
  // an episode was structurally invisible to the only layer whose job is
  // connecting things. So Harbor spent a full pass over a quarter of a million
  // individually meaningless fragments, drew an edge between each one and its
  // neighbour, and called the result a graph. 99.7% of the edges on the first
  // real run restated what the source had already told us.
  //
  // An edge now joins two *nodes*, and a node is an item or an episode. That is
  // the whole change, and everything else follows from it: a conversation can
  // be connected to a calendar entry, a situation can contain "the exchange
  // about Saturday" instead of forty texts, and the messages inside an episode
  // stop being graph subjects at all, which is also why the pass got roughly
  // twenty times cheaper.
  //
  // Both tables are rebuilt rather than extended. A polymorphic reference
  // cannot carry a foreign key to `items`, and leaving the old constraint in
  // place while writing episode ids into the column is exactly the sort of
  // thing that works until it does not.
  //
  // No data is lost. Existing edges migrate as item-to-item, and
  // RELATIONSHIP_VERSION moves to 3 so the whole graph is redrawn from items
  // that were never re-fetched, as every derivation here is supposed to behave.
  `
  CREATE TABLE relationships_next (
    id          TEXT PRIMARY KEY,
    from_kind   TEXT NOT NULL,
    from_id     TEXT NOT NULL,
    to_kind     TEXT NOT NULL,
    to_id       TEXT NOT NULL,
    kind        TEXT NOT NULL,
    confidence  REAL NOT NULL,
    evidence    TEXT NOT NULL,
    detector    TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    UNIQUE (from_kind, from_id, to_kind, to_id, kind)
  );

  INSERT INTO relationships_next
    (id, from_kind, from_id, to_kind, to_id, kind, confidence, evidence, detector, created_at)
  SELECT id, 'item', from_item, 'item', to_item, kind, confidence, evidence, detector, created_at
    FROM relationships;

  DROP TABLE relationships;
  ALTER TABLE relationships_next RENAME TO relationships;

  CREATE INDEX relationships_from ON relationships (from_kind, from_id);
  CREATE INDEX relationships_to   ON relationships (to_kind, to_id);
  CREATE INDEX relationships_kind ON relationships (kind, confidence DESC);

  CREATE TABLE thread_nodes (
    thread_id  TEXT NOT NULL REFERENCES threads (id),
    node_kind  TEXT NOT NULL,
    node_id    TEXT NOT NULL,
    role       TEXT,
    PRIMARY KEY (thread_id, node_kind, node_id)
  );

  CREATE INDEX thread_nodes_node ON thread_nodes (node_kind, node_id);

  DROP TABLE thread_items;

  -- Episodes become pending work for the relate pass, like items already were.
  ALTER TABLE episodes ADD COLUMN relationships_version INTEGER;
  CREATE INDEX episodes_relationships_pending ON episodes (relationships_version);

  -- Handles a connector has told us belong to the user. iMessage knows the
  -- account's own address and phone number and had no way to say so, which is
  -- why the self entity was built entirely from mail and every text looked like
  -- it came from a stranger.
  CREATE TABLE self_handles (
    value       TEXT PRIMARY KEY,
    kind        TEXT NOT NULL,
    source      TEXT NOT NULL,
    created_at  INTEGER NOT NULL
  );
  `,
];

/** The only principal that exists until household support lands. */
export const DEFAULT_PRINCIPAL = "person:me";
export const DEFAULT_HOUSEHOLD = "household:default";
