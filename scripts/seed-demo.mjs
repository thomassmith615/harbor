#!/usr/bin/env node
/**
 * Seeds a throwaway store with fake messages so `harbor ask` can be exercised
 * without connecting Gmail.
 *
 * Writes to /tmp/harbor-demo (or DEMO_HOME), never to your real HARBOR_HOME.
 *
 * Two phases, because one of them is a test.
 *
 *   --phase 1   (default) The demo store: mail, calendar, and a booking
 *               confirmation from six weeks ago carrying a reference code.
 *
 *   --phase 2   A second wave that arrives later and refers back to phase one:
 *               a message quoting that same confirmation code, and a text from
 *               a different source minutes after an email with the same person.
 *
 * The point of the split is that phase two is the case that used to be
 * impossible. Run relate after phase one, seed phase two, run relate again, and
 * the new items must connect to the old ones. If they only connect to each
 * other, edges are still batch-local and M1 did not land.
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const home = process.env.DEMO_HOME ?? "/tmp/harbor-demo";
process.env.HARBOR_HOME = home;

const dist = join(here, "..", "dist");

const { openDatabase } = await import(join(dist, "kernel/db.js"));
const { saveAccount } = await import(join(dist, "store/accounts.js"));
const { ensureStream } = await import(join(dist, "store/streams.js"));
const { upsertItem, countItems } = await import(join(dist, "store/items.js"));

const phase = process.argv.includes("--phase") 
  ? Number.parseInt(process.argv[process.argv.indexOf("--phase") + 1] ?? "1", 10)
  : 1;

const { db } = openDatabase();

const account = saveAccount(db, {
  sourceType: "google",
  label: "demo@example.com",
  credentials: {
    accessToken: "demo",
    refreshToken: "demo",
    expiresAt: Date.now() + 3_600_000,
    scope: "demo",
  },
});

const mailStream = ensureStream(db, account.id, "gmail");
const calendarStream = ensureStream(db, account.id, "calendar");
// Two more streams, so "different sources" means something in the demo and the
// conversational path has something to segment.
const messageStream = ensureStream(db, account.id, "imessage");
const reminderStream = ensureStream(db, account.id, "apple-reminders");

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const now = Date.now();

if (phase === 2) {
  // Everything here refers back to phase one. Nothing in this wave is
  // connected to anything else in this wave, which is the whole point.
  upsertItem(db, {
    accountId: account.id,
    streamId: mailStream.id,
    externalId: "demo-p2-1",
    kind: "message",
    direction: "inbound",
    threadId: "demo-thread-p2-1",
    title: "Re: your reservation",
    body:
      "Following up on booking ABC7788XY. The room is held under your name and check in is after 3pm. " +
      "Let us know if the arrival time has changed.",
    snippet: "Following up on booking ABC7788XY.",
    author: "Harbourside Inn <stay@harboursideinn.com>",
    participants: ["demo@example.com"],
    occurredAt: now - 2 * HOUR,
    uri: "https://mail.google.com/mail/u/0/#all/demo-p2-1",
    raw: { demo: true },
  });

  upsertItem(db, {
    accountId: account.id,
    streamId: messageStream.id,
    externalId: "demo-p2-2",
    kind: "message",
    direction: "inbound",
    threadId: "demo-chat-marcus",
    title: null,
    body: "did you see the email about saturday? 8:40 still works for me",
    snippet: "did you see the email about saturday?",
    author: "Marcus Bell <marcus.bell@example.com>",
    participants: ["demo@example.com"],
    // Twenty minutes after the phase-one email from Marcus (which sits at
    // now - 35 hours), on a different source. That is the `adjacent` edge, and
    // it is the one that needs the entity layer: the email and the text look
    // like different people until resolution says otherwise.
    occurredAt: now - 35 * HOUR + 20 * 60_000,
    uri: null,
    raw: { demo: true },
  });

  const total = countItems(db);
  db.close();

  process.stdout.write(
    `Phase 2 seeded. Store now holds ${String(total)} items in ${home}\n\n` +
      `  harbor relate\n` +
      `  harbor related <the new item id>\n\n` +
      `The new items must connect back to phase one. If they do not, edges are still batch-local.\n`,
  );

  process.exit(0);
}

const inbound = [
  ["Talent Partners", "recruiting@talentpartners.com", "Senior backend role, quick chat?",
   "Hi, I came across your background in distributed systems and wanted to reach out about a Staff Backend role. Are you open to a 15 minute call this week?"],
  ["Comcast", "billing@example.net", "Your September statement is ready",
   "Your statement for account ending 4417 is now available. Amount due $184.62, autopay scheduled for the 14th."],
  ["Dana Whitfield", "dana@northlightco.com", "Re: contract redlines",
   "Thanks for turning these around so fast. Section 7 still needs work but the rest looks good to me. Can we close this out by Friday?"],
  ["REI", "news@rei.com", "Member Rewards: 20% off one full-price item",
   "Your annual dividend is here. Redeem in store or online through the end of the month."],
  ["Marcus Bell", "marcus.bell@example.com", "golf saturday?",
   "Tee time at 8:40 if you're in. Bringing Nick and maybe Sam. Let me know by Thursday."],
  ["Dr. Reyes Office", "frontdesk@reyesdental.com", "Appointment reminder",
   "This is a reminder of your cleaning on Tuesday at 10:15 AM. Please arrive ten minutes early."],
  ["GitHub", "notifications@github.com", "[harbor] CI failed on main",
   "The typecheck job failed. See the run for details."],
  ["Harbourside Inn", "stay@harboursideinn.com", "Your trip confirmation",
   "Thank you for booking with us. Confirmation ABC7788XY. Two nights, arriving Friday. Cancellation is free up to 48 hours before arrival."],
  ["Anna Kim", "anna.kim@northlightco.com", "notes from Tuesday",
   "Attaching my notes from the planning session. Main open question is whether we commit to the Q4 date."],
];

const outbound = [
  ["Re: contract redlines", ["dana@northlightco.com"],
   "Dana, agreed on section 7. I'll send a revised draft tomorrow morning with the indemnity language pulled back to where we started. Friday works."],
  ["Re: notes from Tuesday", ["anna.kim@northlightco.com"],
   "Thanks Anna. I think we hold on the Q4 date until we see where the migration lands."],
  ["Question about invoice 2291", ["ap@vendorco.com"],
   "Hi, invoice 2291 appears to bill for two seats we cancelled in June. Can you confirm and reissue?"],
];

let index = 0;

for (const [name, address, subject, body] of inbound) {
  index += 1;
  upsertItem(db, {
    accountId: account.id,
    streamId: mailStream.id,
    externalId: `demo-in-${index}`,
    kind: "message",
    direction: "inbound",
    threadId: `demo-thread-${index}`,
    title: subject,
    body,
    snippet: body.slice(0, 140),
    author: `${name} <${address}>`,
    participants: ["demo@example.com"],
    // The booking confirmation is six weeks old on purpose: phase two has to
    // reach across that gap, and under the old batch-local linkers it could not.
    occurredAt: subject === "Your trip confirmation" ? now - 42 * DAY : now - index * 7 * HOUR,
    uri: `https://mail.google.com/mail/u/0/#all/demo-in-${index}`,
    raw: { demo: true, from: address },
  });
}

let sentIndex = 0;

for (const [subject, to, body] of outbound) {
  sentIndex += 1;
  upsertItem(db, {
    accountId: account.id,
    streamId: mailStream.id,
    externalId: `demo-out-${sentIndex}`,
    kind: "message",
    direction: "outbound",
    threadId: `demo-thread-out-${sentIndex}`,
    title: subject,
    body,
    snippet: body.slice(0, 140),
    author: "demo@example.com",
    participants: to,
    occurredAt: now - (sentIndex * 11 + 2) * HOUR,
    uri: `https://mail.google.com/mail/u/0/#all/demo-out-${sentIndex}`,
    raw: { demo: true },
  });
}

// Calendar events, so cross-source questions ("am I free Thursday", "what is
// tomorrow's first meeting") can be exercised without connecting Calendar.
const MINUTE = 60_000;
// Local midnight tomorrow, in the host's timezone, matching what a real
// calendar would produce.
const startOfTomorrow = new Date(now + 24 * HOUR);
startOfTomorrow.setHours(0, 0, 0, 0);
const day = startOfTomorrow.getTime();

const events = [
  ["Standup", 9 * HOUR, 15 * MINUTE, ["anna.kim@northlightco.com"], "Daily sync"],
  ["Contract review with Dana", 11 * HOUR, 60 * MINUTE, ["dana@northlightco.com"], "Section 7 redlines"],
  ["Lunch", 12.5 * HOUR, 45 * MINUTE, [], null],
  ["Planning session", 14 * HOUR, 90 * MINUTE, ["anna.kim@northlightco.com", "marcus.bell@example.com"], "Q4 date decision"],
  ["Dentist cleaning", 26 * HOUR + 10 * MINUTE, 45 * MINUTE, [], "Arrive ten minutes early"],
  ["Golf with Marcus", 4 * 24 * HOUR + 8.67 * HOUR, 4 * HOUR, ["marcus.bell@example.com"], "Tee time 8:40"],
];

let eventIndex = 0;

for (const [title, offset, duration, attendees, description] of events) {
  eventIndex += 1;
  upsertItem(db, {
    accountId: account.id,
    streamId: calendarStream.id,
    externalId: `primary:demo-event-${eventIndex}`,
    kind: "event",
    threadId: null,
    title,
    body: description,
    snippet: description,
    author: "demo@example.com",
    participants: attendees,
    occurredAt: day + offset,
    endsAt: day + offset + duration,
    uri: `https://calendar.google.com/calendar/event?eid=demo-${eventIndex}`,
    raw: { demo: true, calendarId: "primary" },
  });
}

// A conversation, the way one actually looks: short fragments over an evening,
// none of which means anything alone. This is what episodes exist for.
const chat = [
  ["them", "Marcus Bell <marcus.bell@example.com>", "so are we doing vermont in october or not"],
  ["me", null, "i think so. depends whether the cabin near stowe is still open"],
  ["them", "Marcus Bell <marcus.bell@example.com>", "i can check. how many nights"],
  ["me", null, "two? drive up friday after work, back sunday"],
  ["them", "Marcus Bell <marcus.bell@example.com>", "works. ill look tonight"],
  ["them", "Marcus Bell <marcus.bell@example.com>", "also we need to sort out the ski rack situation"],
  ["me", null, "yeah i still need to buy one. adding a reminder"],
];

let chatIndex = 0;

for (const [who, author, body] of chat) {
  chatIndex += 1;
  upsertItem(db, {
    accountId: account.id,
    streamId: messageStream.id,
    externalId: `demo-chat-${chatIndex}`,
    kind: "message",
    direction: who === "me" ? "outbound" : "inbound",
    threadId: "demo-chat-marcus",
    title: null,
    body,
    snippet: body.slice(0, 140),
    author: author ?? "demo@example.com",
    participants: who === "me" ? ["marcus.bell@example.com"] : ["demo@example.com"],
    // A few minutes apart, six days ago: one episode, not seven items.
    occurredAt: now - 6 * DAY + chatIndex * 4 * 60_000,
    uri: null,
    raw: { demo: true },
  });
}

// Reminders, which are states rather than events. One of them is the thing he
// said he would do in the conversation above, which is the connection Harbor is
// supposed to make and no single source can.
const reminders = [
  ["Buy a ski rack", "Shopping", now + 3 * DAY, null],
  ["Send Dana the revised draft", "Work", now - 2 * DAY, null],
  ["Renew car registration", "Errands", now + 20 * DAY, null],
  ["Book dentist", "Errands", now - 10 * DAY, now - 9 * DAY],
];

let reminderIndex = 0;

for (const [title, list, due, completed] of reminders) {
  reminderIndex += 1;
  upsertItem(db, {
    accountId: account.id,
    streamId: reminderStream.id,
    externalId: `demo-todo-${reminderIndex}`,
    kind: "task",
    threadId: null,
    title,
    body: null,
    snippet: list,
    author: null,
    participants: [],
    occurredAt: due,
    dueAt: due,
    state: completed === null ? "open" : "completed",
    sourceUpdatedAt: completed,
    uri: null,
    raw: { demo: true, list },
  });
}

// A receipt, and a promotional email that quotes prices and is not one. The
// second is the important fixture: the predicate has to reject it.
upsertItem(db, {
  accountId: account.id,
  streamId: mailStream.id,
  externalId: "demo-receipt-1",
  kind: "message",
  direction: "inbound",
  threadId: "demo-thread-receipt",
  title: "Your order confirmation #A4471",
  body:
    "Thanks for your order.\n\nOrder #A4471\n\n" +
    "2 x Chicken thighs, 2 lb          8.99\n" +
    "1 x Olive oil, 500ml             12.49\n" +
    "1 x Rye bread                     5.25\n\n" +
    "Subtotal                         26.73\n" +
    "Tax                               1.87\n" +
    "Total                            28.60\n\n" +
    "Picked up at Riverside Market on Saturday.",
  snippet: "Thanks for your order. Order #A4471",
  author: "Riverside Market <orders@riversidemarket.com>",
  participants: ["demo@example.com"],
  occurredAt: now - 9 * DAY,
  uri: null,
  raw: { demo: true },
});

upsertItem(db, {
  accountId: account.id,
  streamId: mailStream.id,
  externalId: "demo-promo-1",
  kind: "message",
  direction: "inbound",
  threadId: "demo-thread-promo",
  title: "20% off everything this weekend",
  body:
    "Shop now and save. Olive oil from 12.49, bread from 5.25. Sale ends Sunday. " +
    "Unsubscribe to stop receiving these.",
  snippet: "Shop now and save.",
  author: "Riverside Market <deals@riversidemarket.com>",
  participants: ["demo@example.com"],
  occurredAt: now - 8 * DAY,
  uri: null,
  raw: { demo: true },
});

const total = countItems(db);
db.close();

process.stdout.write(
  `Seeded ${String(total)} demo items (messages and events) into ${home}\n\n` +
    `  harbor resolve && harbor derive && harbor relate\n` +
    `  harbor conversations "vermont"\n` +
    `  harbor commit --dry-run && harbor commit\n` +
    `  harbor extract --dry-run\n` +
    `  harbor commitments\n` +
    `  harbor reminders\n` +
    `  node scripts/seed-demo.mjs --phase 2   # a later wave that refers back to this one\n\n` +
    `  export HARBOR_HOME=${home}\n` +
    `  harbor ask "what does tomorrow look like, and is there mail I should deal with first?" --trace\n\n` +
    `Unset HARBOR_HOME to go back to your real store.\n`,
);
