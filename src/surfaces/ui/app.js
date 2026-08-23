/*
 * Harbor's interface.
 *
 * A real file rather than a string compiled into the daemon. The string was the
 * right call when the page was two hundred lines: no build step, no second
 * repository, nothing to fall behind. It stopped being right when every regex
 * needed its backslashes doubled and a backtick could end the file, which cost
 * three builds across M20. The properties that mattered are kept by shipping
 * these files inside the same package and serving them from the same origin:
 * one repo, one build, one deploy, no version skew.
 *
 * Everything here is a view over two endpoints. `/overview` answers what Harbor
 * holds, what is connected, what is running and what is wrong; `/ask` answers
 * the question. Nothing in this file knows how any of it works.
 */

const TOKEN_KEY = "harbor.token";
const VIEW_KEY = "harbor.view";

const $ = (id) => document.getElementById(id);

let token = localStorage.getItem(TOKEN_KEY);
let view = localStorage.getItem(VIEW_KEY) ?? "chat";
let overview = null;
let conversationId = null;
let asking = false;
let timer = null;
let reachable = true;
let wasBusy = false;

/* ------------------------------------------------------------------ *
 * markdown
 *
 * Models answer in markdown whether or not you ask them to, so a page that
 * sets textContent shows a person literal asterisks around every emphasis.
 * This renders the subset that actually turns up.
 *
 * Escaping runs first and unconditionally, and that ordering is the entire
 * security argument. The text being rendered is a model's output over the
 * user's own mail, so it can contain anything the mail contained: a script tag
 * from a marketing email, an img with an onerror handler. Escape everything,
 * then add back only the tags this function chose, and there is no path from
 * source text to live markup. Links are restricted to http and https for the
 * same reason, since a javascript: URL would otherwise be one tap from running.
 * ------------------------------------------------------------------ */

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function inline(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/(^|[\s(])_([^_\n]+)_/g, "$1<em>$2</em>")
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
      '<a href="$2" rel="noopener noreferrer" target="_blank">$1</a>',
    );
}

function markdown(text) {
  const out = [];
  let list = null;

  const closeList = () => {
    if (list) {
      out.push("</" + list + ">");
      list = null;
    }
  };

  const lines = String(text ?? "").split("\n");
  let skipTo = 0;

  for (let index = 0; index < lines.length; index += 1) {
    if (index < skipTo) continue;

    const raw = lines[index];
    const next = lines[index + 1];
    const line = raw.trimEnd();

    if (line.trim() === "") {
      closeList();
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);

    if (heading) {
      closeList();
      const level = Math.min(4, heading[1].length) + 2;
      out.push("<h" + level + ">" + inline(heading[2]) + "</h" + level + ">");
      continue;
    }

    // A table, which models reach for constantly when asked to compare
    // anything. Recognised by the separator row, which is the only unambiguous
    // marker: a line containing a pipe could be prose, and a line of pipes and
    // dashes could not.
    if (line.includes("|") && /^\s*\|?[\s:|-]*-[\s:|-]*$/.test(next ?? "")) {
      closeList();

      const cells = (row) =>
        row
          .replace(/^\s*\|/, "")
          .replace(/\|\s*$/, "")
          .split("|")
          .map((cell) => cell.trim());

      out.push("<table><thead><tr>");

      for (const cell of cells(line)) {
        out.push("<th>" + inline(cell) + "</th>");
      }

      out.push("</tr></thead><tbody>");

      let cursor = index + 2;

      while (cursor < lines.length && lines[cursor].includes("|")) {
        out.push("<tr>");

        for (const cell of cells(lines[cursor])) {
          out.push("<td>" + inline(cell) + "</td>");
        }

        out.push("</tr>");
        cursor += 1;
      }

      out.push("</tbody></table>");
      skipTo = cursor;
      continue;
    }

    const bullet = /^\s*[-*\u2022]\s+(.*)$/.exec(line);

    if (bullet) {
      if (list !== "ul") {
        closeList();
        out.push("<ul>");
        list = "ul";
      }

      out.push("<li>" + inline(bullet[1]) + "</li>");
      continue;
    }

    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);

    if (numbered) {
      if (list !== "ol") {
        closeList();
        out.push("<ol>");
        list = "ol";
      }

      out.push("<li>" + inline(numbered[1]) + "</li>");
      continue;
    }

    closeList();
    out.push("<p>" + inline(line) + "</p>");
  }

  closeList();

  return out.join("");
}

/* ------------------------------------------------------------------ *
 * formatting
 * ------------------------------------------------------------------ */

function ago(at) {
  if (!at) return "never";

  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));

  if (seconds < 45) return "just now";
  if (seconds < 5400) return Math.round(seconds / 60) + "m ago";
  if (seconds < 172800) return Math.round(seconds / 3600) + "h ago";

  return Math.round(seconds / 86400) + "d ago";
}

function duration(seconds) {
  if (!seconds && seconds !== 0) return "";

  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (days > 0) return days + "d " + hours + "h";
  if (hours > 0) return hours + "h " + minutes + "m";

  return minutes + "m";
}

function count(n) {
  return Number(n ?? 0).toLocaleString();
}

function bytes(n) {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const power = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return (n / Math.pow(1024, power)).toFixed(power === 0 ? 0 : 1) + " " + units[power];
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function toast(message) {
  const node = $("toast");
  node.textContent = message;
  node.hidden = false;
  clearTimeout(node._t);
  node._t = setTimeout(() => { node.hidden = true; }, 2600);
}

/* ------------------------------------------------------------------ *
 * transport
 * ------------------------------------------------------------------ */

function gate(shown, message) {
  $("gate").hidden = !shown;
  $("shell").hidden = shown;
  if (message !== undefined) $("gateError").textContent = message;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: "Bearer " + token } : {}),
      ...(options.headers ?? {}),
    },
  });

  if (response.status === 401) {
    // Revoked, or the store was replaced. Say so once rather than failing
    // every request silently forever.
    localStorage.removeItem(TOKEN_KEY);
    token = null;
    stopPolling();
    gate(true, "This device is no longer paired.");
    throw new Error("unpaired");
  }

  return response;
}

async function json(path, options) {
  const response = await api(path, options);
  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(body.error ?? "Harbor returned " + response.status);
  }

  return body;
}

/* ------------------------------------------------------------------ *
 * pairing
 * ------------------------------------------------------------------ */

$("pairGo").addEventListener("click", async () => {
  $("gateError").textContent = "";

  const response = await fetch("/pair", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      // Typed on a phone, so accept lower case and missing dashes.
      code: $("code").value.trim().toUpperCase(),
      deviceName: navigator.userAgent.includes("iPhone")
        ? "iPhone"
        : navigator.userAgent.includes("Android")
          ? "Android"
          : "browser",
    }),
  }).catch(() => null);

  if (response === null) {
    $("gateError").textContent = "Could not reach Harbor.";
    return;
  }

  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    $("gateError").textContent = body.error ?? "That code did not work.";
    return;
  }

  token = body.token;
  localStorage.setItem(TOKEN_KEY, token);
  gate(false);
  start();
});

$("code").addEventListener("keydown", (event) => {
  if (event.key === "Enter") $("pairGo").click();
});

/* ------------------------------------------------------------------ *
 * overview and polling
 *
 * Every operation's status lives in SQLite, so a browser refresh is a reload
 * of this object and nothing about a running job is held in the page. That is
 * the whole of "persistent across refreshes": there is no client state to
 * persist.
 * ------------------------------------------------------------------ */

function busy() {
  return (overview?.running ?? []).length > 0;
}

async function refresh() {
  try {
    overview = await json("/overview");
    reachable = true;
  } catch (error) {
    if (error.message === "unpaired") return;
    reachable = false;
  }

  // A pass that redraws the graph invalidates what Noticed is showing. Cheap
  // to notice here and wrong to poll for.
  const nowBusy = busy();

  if (wasBusy && !nowBusy) {
    noticed = null;
  }

  wasBusy = nowBusy;

  renderHealth();
  renderLamps();
  renderView();
  schedule();
}

function schedule() {
  clearTimeout(timer);

  // Fast while something is moving, slow when it is not, and not at all in a
  // background tab: this runs on a phone that stays open for days.
  const delay = !reachable ? 6000 : busy() ? 1800 : 20000;

  timer = setTimeout(() => {
    if (document.visibilityState === "visible") refresh();
    else schedule();
  }, delay);
}

function stopPolling() {
  clearTimeout(timer);
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && token) refresh();
});

/* ------------------------------------------------------------------ *
 * header and lamps
 * ------------------------------------------------------------------ */

function renderHealth() {
  const node = $("health");
  const text = $("healthText");

  if (!reachable) {
    node.dataset.state = "down";
    text.textContent = "Unreachable";
    return;
  }

  const running = overview?.running ?? [];

  if (running.length > 0) {
    node.dataset.state = "busy";
    text.textContent = running[0].task;
    return;
  }

  const errors = (overview?.problems ?? []).filter((p) => p.severity === "error");

  if (errors.length > 0) {
    node.dataset.state = "warn";
    text.textContent = errors.length + " to fix";
    return;
  }

  node.dataset.state = "ok";
  text.textContent = count(overview?.items ?? 0) + " items";
}

$("health").addEventListener("click", () => { switchTo("run"); });

/** Freshness of one source, which is what its lamp colour means. */
function lampState(source, running) {
  // Set aside before anything else. A source nothing can fetch must never go
  // amber or red: those colours mean "you can fix this", and there is nothing
  // to fix.
  if (source.dormant) return "dormant";
  if (running) return "syncing";
  if (source.streams.length === 0) return "never";

  const last = source.streams.reduce(
    (best, stream) => Math.max(best, stream.lastSyncAt ?? 0),
    0,
  );

  if (last === 0) return "never";

  const age = Date.now() - last;

  if (age > 3 * 86400000) return "broken";
  if (age > 6 * 3600000) return "stale";

  return "fresh";
}

function renderLamps() {
  const strip = $("lamps");
  strip.textContent = "";

  const sources = overview?.sources ?? [];

  if (sources.length === 0) return;

  const syncing = (overview?.running ?? []).some((job) =>
    ["pulse", "sync", "recent", "history", "backfill", "onboard"].includes(job.task),
  );

  for (const source of sources) {
    const lamp = el("button", "lamp");
    lamp.type = "button";
    lamp.setAttribute("role", "listitem");
    lamp.dataset.state = lampState(source, syncing);
    lamp.append(el("span", "lamp-dot"));
    lamp.append(el("span", null, source.label));
    lamp.addEventListener("click", () => { switchTo("sources"); });
    strip.append(lamp);
  }
}

/* ------------------------------------------------------------------ *
 * views
 * ------------------------------------------------------------------ */

function switchTo(next) {
  view = next;
  localStorage.setItem(VIEW_KEY, next);

  for (const button of $("tabs").querySelectorAll("button")) {
    button.setAttribute("aria-selected", String(button.dataset.view === next));
  }

  $("viewChat").hidden = next !== "chat";
  $("viewNoticed").hidden = next !== "noticed";
  $("viewSources").hidden = next !== "sources";
  $("viewRun").hidden = next !== "run";
  $("composer").hidden = next !== "chat";

  renderView();

  // Coming back to a conversation in progress and being thrown to the top of
  // it is the same complaint as the jumping, one tab across.
  if (next === "chat" && lastTurn() !== null) {
    requestAnimationFrame(pinLastTurn);
    return;
  }

  window.scrollTo({ top: 0 });
}

for (const button of $("tabs").querySelectorAll("button")) {
  button.addEventListener("click", () => { switchTo(button.dataset.view); });
}

function renderView() {
  if (view === "noticed") renderNoticed();
  if (view === "sources") renderSources();
  if (view === "run") renderRun();
  if (view === "chat") renderOpener();
}

/* ------------------------------------------------------------------ *
 * noticed
 *
 * The half of Harbor that does not wait to be asked. Situations are computed
 * on every pulse and the digest is written nightly, and until now the only way
 * to see either was a terminal, which makes a private secondary brain
 * something you have to remember to interrogate.
 *
 * Fetched on demand rather than folded into /overview: this is a screen you
 * open, not a thing the shell polls, and putting it in the poll would mean
 * every phone reassembles every situation every twenty seconds.
 * ------------------------------------------------------------------ */

let noticed = null;

async function loadNoticed() {
  try {
    const [situations, digest] = await Promise.all([
      json("/situations?limit=20"),
      json("/digest").catch(() => ({ digest: null })),
    ]);

    noticed = { situations: situations.situations ?? [], digest: digest.digest ?? null };
  } catch (error) {
    if (error.message !== "unpaired") noticed = { situations: [], digest: null, error: error.message };
  }

  if (view === "noticed") renderNoticed();
}

function renderNoticed() {
  const stage = $("viewNoticed");
  stage.textContent = "";

  if (noticed === null) {
    stage.append(el("div", "empty", "Looking\u2026"));
    loadNoticed();
    return;
  }

  if (noticed.digest) {
    stage.append(el("div", "section-title", "Latest digest"));

    const card = el("div", "digest");
    card.append(el("div", "digest-when", ago(noticed.digest.at)));

    const body = el("div", "digest-text");
    body.innerHTML = markdown(noticed.digest.text);
    card.append(body);
    stage.append(card);
  }

  stage.append(el("div", "section-title", "Situations"));

  if (noticed.situations.length === 0) {
    stage.append(
      el(
        "div",
        "empty",
        noticed.error ??
          "Nothing yet. A situation needs things from two different sources that " +
            "turn out to be about each other, so this fills in as Harbor syncs.",
      ),
    );
    return;
  }

  for (const situation of noticed.situations) {
    stage.append(situationCard(situation));
  }
}

function situationCard(situation) {
  const card = el("button", "card situation");
  card.type = "button";

  card.append(el("h3", "card-title", situation.title ?? "Untitled"));

  // The sentence Harbor wrote, under the title it took. The title is often a
  // calendar entry or a subject line and names one member; this says what the
  // whole thing is, which is what decides whether it is worth opening.
  if (situation.summary) {
    card.append(el("p", "card-sub", situation.summary));
  }

  const badges = el("div", "badges");

  // Which sources, named. "3 sources" is a statistic; "iMessage, calendar,
  // mail" is the claim, and the claim is what makes somebody tap.
  const sources = [...new Set(situation.items.map((item) => item.kind))];

  badges.append(
    el("span", "badge badge-count", situation.sourceCount + " sources"),
  );

  for (const kind of sources.slice(0, 4)) {
    badges.append(el("span", "badge", kind));
  }

  card.append(badges);
  card.append(
    el(
      "div",
      "when-line",
      situation.itemCount +
        " things" +
        (situation.startsAt ? ", " + ago(situation.startsAt) + " onward" : ""),
    ),
  );

  card.addEventListener("click", () => { openSituation(situation.id); });

  return card;
}

function renderNode(into, node) {
  into.textContent = "";

  if (node.kind === "episode") {
    for (const message of node.messages) {
      const line = el("div", "message");
      const head = el("div", "message-head");
      head.append(el("span", "message-from", message.from));
      head.append(el("span", "message-when", message.when));
      line.append(head);
      line.append(el("div", "message-text", message.text));
      into.append(line);
    }

    if (node.messages.length === 0) {
      into.append(el("p", "card-sub", "Nothing readable in this one."));
    }

    return;
  }

  if (node.from) {
    into.append(el("div", "message-from", node.from));
  }

  into.append(el("div", "message-text", node.body || "No body."));
}

async function openSituation(id) {
  sheet("Loading\u2026", (body) => {
    body.append(el("p", null, "Reading the evidence."));
  });

  let detail;

  try {
    detail = await json("/situations/" + id);
  } catch (error) {
    sheet("Could not open it", (body) => {
      body.append(el("p", null, error.message));
    });
    return;
  }

  sheet(detail.title ?? "Situation", (body) => {
    const badges = el("div", "badges");

    for (const source of detail.sources) {
      badges.append(el("span", "badge", source));
    }

    body.append(badges);

    if (detail.summary) {
      body.append(el("p", "sheet-summary", detail.summary));
    }

    // Why each thing is here, attached to the thing rather than collected in a
    // footnote. Reading "shares the confirmation code QKZT-4417" under the
    // calendar entry is what turns a list into an argument.
    const byNode = new Map();

    // Both ends. An edge is symmetric and the evidence explains the pair, so
    // indexing it only under `from` leaves whichever member happened to be the
    // other end with no reason shown at all. That is the one thing this view
    // must not do: a thing sitting in a situation with nothing said about why
    // is exactly the unexplained claim it exists to prevent.
    const attach = (key, link) => {
      if (!byNode.has(key)) byNode.set(key, []);

      const seen = byNode.get(key);

      if (!seen.some((other) => other.evidence === link.evidence)) {
        seen.push(link);
      }
    };

    for (const link of detail.links) {
      attach(link.from, link);
      attach(link.to, link);
    }

    const spine = el("div", "spine");

    for (const member of detail.members) {
      const node = el("div", "node");

      const head = el("div", "node-head");
      head.append(el("span", "node-title", member.title ?? member.kind));
      head.append(el("span", "badge", member.source));
      head.append(el("span", "node-when", member.when));
      node.append(head);

      if (member.preview) {
        node.append(el("div", "node-preview", member.preview));
      }

      const reasons = byNode.get(member.ref) ?? [];

      if (reasons.length > 0) {
        const why = el("div", "node-why");

        // One reason per neighbour, strongest first, and the rest folded into
        // a count. Four linkers agreeing is worth knowing; four near-identical
        // sentences is not worth reading.
        for (const reason of reasons.slice(0, 2)) {
          const line = el("div", "why", reason.evidence);

          if (reason.also.length > 0) {
            line.append(
              el("div", "why-also", "and " + reason.also.length + " other reason" +
                (reason.also.length === 1 ? "" : "s")),
            );
          }

          why.append(line);
        }

        node.append(why);
      }

      // Tapping reads it. The evidence says why something is here; this says
      // what it actually was, which is the question the evidence provokes.
      const open = el("button", "btn btn-quiet node-read", "Read it");
      open.type = "button";

      const content = el("div", "node-content");
      content.hidden = true;

      open.addEventListener("click", async () => {
        if (!content.hidden) {
          content.hidden = true;
          open.textContent = "Read it";
          return;
        }

        if (content.childElementCount === 0) {
          open.textContent = "Reading\u2026";

          try {
            renderNode(content, await json("/nodes/" + member.ref.replace(":", "/")));
          } catch (error) {
            content.append(el("p", "sheet-error", error.message));
          }
        }

        content.hidden = false;
        open.textContent = "Hide";
      });

      node.append(open);
      node.append(content);

      spine.append(node);
    }

    body.append(spine);

    const ask = el("button", "btn btn-primary btn-wide", "Ask about this");
    ask.type = "button";
    ask.style.marginTop = "16px";
    ask.addEventListener("click", () => {
      closeSheet();
      switchTo("chat");

      // The id goes in the question. Sending only the title asked Harbor about
      // a string like "Test rename" or "issy?", which matches nothing and got
      // the honest answer that it had never heard of it. The situations tool
      // takes an id, so give it one.
      $("question").value =
        'Tell me about the situation "' + (detail.title ?? "this one") + '" (id ' + detail.id + ").";

      $("composer").requestSubmit();
    });

    body.append(ask);
  });
}

/* ---------- sources ---------- */

const CONNECT_COPY = {
  imessage: {
    name: "iMessage",
    why: "Reads the local chat database, read only, through a snapshot.",
  },
  imap: {
    name: "Mail",
    why: "Any IMAP mailbox. Harbor works out the server from your address.",
  },
  apple: {
    name: "Apple calendar, reminders and contacts",
    why: "Needs an app-specific password from appleid.apple.com.",
  },
  google: {
    name: "Google",
    why: "Gmail and Calendar. Sign in from a browser on the Mac running Harbor.",
  },
};

function renderSources() {
  const stage = $("viewSources");
  stage.textContent = "";

  const sources = overview?.sources ?? [];
  const connectable = overview?.connectable ?? [];

  if (sources.length === 0) {
    const welcome = el("div", "welcome");
    welcome.append(el("h2", null, "Nothing is connected yet"));
    welcome.append(
      el(
        "p",
        null,
        "Harbor reasons across sources, so it gets useful at two and interesting at three. Connect the first one.",
      ),
    );
    stage.append(welcome);
  } else {
    stage.append(el("div", "section-title", "Connected"));

    for (const source of sources) {
      stage.append(sourceCard(source));
    }

    const store = el("div", "card");
    const head = el("div", "card-head");
    head.append(el("h3", "card-title", "Store"));
    head.append(el("span", "card-note", bytes(overview?.databaseBytes ?? 0)));
    store.append(head);
    store.append(
      el(
        "p",
        "card-sub",
        count(overview?.items ?? 0) +
          " items, " +
          count(overview?.people ?? 0) +
          " people, " +
          count(overview?.situations ?? 0) +
          " situations spanning more than one source",
      ),
    );
    stage.append(store);
  }

  const addable = connectable.filter((option) => !option.connected || option.multiple);

  if (addable.length > 0) {
    stage.append(el("div", "section-title", sources.length === 0 ? "Available" : "Add another"));

    for (const option of addable) {
      const copy = CONNECT_COPY[option.sourceType] ?? { name: option.sourceType, why: "" };
      const button = el("button", "source-option");
      button.type = "button";
      button.disabled = !option.available;

      const body = el("div", "so-body");
      body.append(el("div", "so-name", copy.name));
      body.append(el("div", "so-why", option.available ? copy.why : option.reason));
      button.append(body);
      button.append(el("span", "so-go", "\u203A"));

      button.addEventListener("click", () => { openConnect(option.sourceType); });
      stage.append(button);
    }
  }
}

function sourceCard(source) {
  const card = el("div", "card");
  const head = el("div", "card-head");

  head.append(el("h3", "card-title", source.label));
  head.append(el("span", "card-note", count(source.items) + " items"));
  card.append(head);

  if (source.dormant) {
    card.append(
      el(
        "p",
        "card-sub",
        "Set aside. No connector in this build can fetch it, so these items are " +
          "kept as they are and never update. They are still searchable and " +
          "Harbor still reasons over them.",
      ),
    );
  }

  const rows = el("div", "rows");

  for (const stream of source.streams) {
    const row = el("div", "row");
    row.append(el("span", "row-name", stream.connector));

    const meta = el("span", "row-meta");

    if (!stream.syncable) {
      // Not "synced 9 days ago". That reads as a problem, and the number would
      // grow forever.
      meta.textContent = "frozen";
      meta.style.color = "var(--faint)";
    } else if (stream.lastSyncAt) {
      meta.textContent =
        "synced " + ago(stream.lastSyncAt) + (stream.historicalDone ? "" : ", filling in");
    } else {
      meta.textContent = "not synced yet";
    }

    row.append(meta);
    rows.append(row);
  }

  if (source.streams.length === 0) {
    const row = el("div", "row");
    row.append(el("span", "row-name", "No sync has run yet"));
    const meta = el("span", "row-meta", "run Sync");
    row.append(meta);
    rows.append(row);
  }

  card.append(rows);

  return card;
}

/* ---------- run ---------- */

const OPERATIONS = [
  {
    task: "pulse",
    name: "Sync",
    why: "Fetch what is new from every source and work it through the pipeline.",
  },
  {
    task: "history",
    name: "Fill in history",
    why: "Reach further back on any source that still owes older items.",
  },
  {
    task: "relate",
    name: "Rebuild links",
    why: "Recompute the connections between sources and the situations they form.",
  },
  {
    task: "backup",
    name: "Back up",
    why: "Write an encrypted copy of the store.",
  },
];

function renderRun() {
  const stage = $("viewRun");
  stage.textContent = "";

  const running = overview?.running ?? [];
  const jobs = overview?.jobs ?? [];
  const availability = overview?.availability ?? [];
  const problems = overview?.problems ?? [];

  // "Is Harbor running" is not the same question as "did that request
  // succeed". A daemon crash-looping under launchd answers every request it
  // is up for, and the only tell is that it has been up for forty seconds.
  const card = el("div", "card");
  const head = el("div", "card-head");
  head.append(el("h3", "card-title", reachable ? "Running" : "Not answering"));
  head.append(el("span", "card-note", overview?.version ? "v" + overview.version : ""));
  card.append(head);
  card.append(
    el(
      "p",
      "card-sub",
      reachable
        ? "up " +
          duration(overview?.uptimeSeconds) +
          ", holding " +
          count(overview?.items ?? 0) +
          " items"
        : "The daemon is not answering. On the Mac: tail -f ~/.harbor/logs/harbor.log",
    ),
  );
  stage.append(card);

  stage.append(el("div", "section-title", "Operations"));

  const grid = el("div", "ops");

  for (const operation of OPERATIONS) {
    const live = running.find((job) => job.task === operation.task);
    const blocked = availability.find((entry) => entry.task === operation.task)?.blockedBy ?? null;

    const button = el("button", "op");
    button.type = "button";
    button.disabled = blocked !== null && live === undefined;
    button.dataset.running = String(live !== undefined);

    button.append(el("div", "op-name", live ? operation.name + "\u2026" : operation.name));
    button.append(
      el("div", "op-why", blocked ? "Waiting on " + blocked.task : operation.why),
    );

    if (live) {
      const bar = el("div", "progress");
      const fill = el("span");
      const total = live.progressTotal ?? 0;
      const done = live.progressDone ?? 0;

      if (total > 0) {
        fill.style.width = Math.min(100, Math.round((done / total) * 100)) + "%";
      } else {
        bar.dataset.indeterminate = "true";
      }

      bar.append(fill);
      button.append(bar);
    }

    button.addEventListener("click", () => {
      if (live) stopJob(live.id);
      else startJob(operation.task, operation.name);
    });

    grid.append(button);
  }

  stage.append(grid);

  if (running.length > 0) {
    const note = running[0].note ?? running[0].phase;

    if (note) {
      stage.append(el("p", "card-sub", note));
    }
  }

  if (problems.length > 0) {
    stage.append(el("div", "section-title", "Needs attention"));

    for (const problem of problems) {
      const node = el("div", "problem");
      node.dataset.severity = problem.severity;
      node.append(el("p", null, problem.message));
      node.append(el("p", "fix", problem.fix));
      stage.append(node);
    }
  }

  stage.append(el("div", "section-title", "Recent activity"));

  if (jobs.length === 0) {
    stage.append(el("div", "empty", "Nothing has run yet."));
  }

  for (const job of jobs.slice(0, 12)) {
    const card = el("div", "card");
    const line = el("div", "job-line");

    line.append(el("span", "job-task", job.task));

    const state = el("span", "job-state", job.state);
    if (job.state === "failed") state.style.color = "var(--bad)";
    if (job.state === "done") state.style.color = "var(--good)";
    line.append(state);

    line.append(el("span", "job-when", ago(job.finishedAt ?? job.startedAt ?? job.createdAt)));
    card.append(line);

    const detail = job.error ?? job.note ?? job.phase;

    if (detail) {
      const note = el("p", "job-note", detail);
      if (job.error) note.style.color = "var(--bad)";
      card.append(note);
    }

    stage.append(card);
  }
}

async function startJob(task, name) {
  try {
    const body = await json("/jobs", {
      method: "POST",
      body: JSON.stringify({ task }),
    });

    if (body.blocked) {
      toast(name + " is waiting on " + body.blocked.task);
    } else if (body.alreadyRunning) {
      // Tapping twice returns the job already in flight rather than an error,
      // so say what happened rather than pretending a second one started.
      toast(name + " is already running");
    } else {
      toast(name + " started");
    }
  } catch (error) {
    toast(error.message);
  }

  refresh();
}

async function stopJob(id) {
  try {
    await json("/jobs/" + id + "/cancel", { method: "POST", body: "{}" });
    toast("Stopping. It finishes the batch it is on.");
  } catch (error) {
    toast(error.message);
  }

  refresh();
}

/* ---------- connecting a source ---------- */

function sheet(title, build) {
  $("sheetTitle").textContent = title;
  const body = $("sheetBody");
  body.textContent = "";
  build(body);
  $("sheet").hidden = false;
}

function closeSheet() {
  $("sheet").hidden = true;
}

$("sheetClose").addEventListener("click", closeSheet);
$("sheetScrim").addEventListener("click", closeSheet);

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeSheet();
});

function field(body, label, id, type, placeholder) {
  const caption = el("label", null, label);
  caption.htmlFor = id;
  body.append(caption);

  const input = el("input");
  input.id = id;
  input.type = type;
  if (placeholder) input.placeholder = placeholder;
  if (type === "email") input.autocapitalize = "none";
  input.autocomplete = type === "password" ? "current-password" : "off";
  body.append(input);
  return input;
}

function actions(body, label, run) {
  const wrap = el("div", "sheet-actions");
  const cancel = el("button", "btn btn-quiet", "Cancel");
  cancel.type = "button";
  cancel.addEventListener("click", closeSheet);

  const go = el("button", "btn btn-primary", label);
  go.type = "button";

  const error = el("p", "sheet-error");
  error.hidden = true;

  go.addEventListener("click", async () => {
    error.hidden = true;
    go.disabled = true;
    const was = go.textContent;
    go.textContent = "Working\u2026";

    try {
      await run();
      closeSheet();
      refresh();
    } catch (failure) {
      error.textContent = failure.message;
      error.hidden = false;
    } finally {
      go.disabled = false;
      go.textContent = was;
    }
  });

  wrap.append(cancel, go);
  body.append(wrap);
  body.append(error);
}

function openConnect(sourceType) {
  if (sourceType === "imessage") {
    sheet("Connect iMessage", (body) => {
      body.append(
        el(
          "p",
          null,
          "Harbor reads a snapshot of the local chat database and never writes to it. If macOS refuses, give your terminal Full Disk Access in System Settings and try again.",
        ),
      );

      actions(body, "Connect", async () => {
        const result = await json("/sources/imessage", { method: "POST", body: "{}" });
        toast("iMessage connected, " + count(result.messages) + " messages");
      });
    });

    return;
  }

  if (sourceType === "google") {
    sheet("Connect Google", (body) => {
      body.append(
        el(
          "p",
          null,
          "Google only redirects to this machine, so finish this in a browser on the Mac running Harbor. A sign-in window opens there.",
        ),
      );

      actions(body, "Sign in", async () => {
        const result = await json("/sources/google/local", { method: "POST", body: "{}" });
        toast(result.account.label + " connected");
      });
    });

    return;
  }

  if (sourceType === "apple") {
    sheet("Connect Apple", (body) => {
      body.append(
        el(
          "p",
          null,
          "Calendar, reminders and contacts over CalDAV. Create an app-specific password at appleid.apple.com; your normal password will not work.",
        ),
      );

      const id = field(body, "Apple ID", "appleId", "email", "you@icloud.com");
      const password = field(body, "App-specific password", "applePassword", "password", "xxxx-xxxx-xxxx-xxxx");

      actions(body, "Connect", async () => {
        const result = await json("/sources/apple", {
          method: "POST",
          body: JSON.stringify({
            appleId: id.value.trim(),
            appPassword: password.value.trim(),
          }),
        });

        toast(result.calendars.length + " calendars connected");
      });
    });

    return;
  }

  if (sourceType === "imap") {
    sheet("Connect mail", (body) => {
      body.append(
        el(
          "p",
          null,
          "Harbor finds the server from your address, shows you where it is about to send a password, and only then asks for one.",
        ),
      );

      const address = field(body, "Address", "imapAddress", "email", "you@example.com");
      const found = el("p", "sheet-ok");
      found.hidden = true;
      body.append(found);

      const discover = el("button", "btn btn-wide", "Find the server");
      discover.type = "button";
      discover.style.marginTop = "14px";
      body.append(discover);

      const rest = el("div");
      rest.hidden = true;
      body.append(rest);

      discover.addEventListener("click", async () => {
        discover.disabled = true;
        discover.textContent = "Looking\u2026";

        try {
          const settings = await json(
            "/sources/imap?address=" + encodeURIComponent(address.value.trim()),
          );

          found.textContent = settings.host + ":" + settings.port + " (" + settings.source + ")";
          found.hidden = false;
          discover.hidden = true;
          rest.hidden = false;

          const password = field(rest, "Password", "imapPassword", "password", "");
          password.focus();

          actions(rest, "Connect", async () => {
            const result = await json("/sources/imap", {
              method: "POST",
              body: JSON.stringify({
                address: address.value.trim(),
                password: password.value,
                host: settings.host,
                port: settings.port,
              }),
            });

            toast(count(result.messages) + " messages found");
          });
        } catch (error) {
          found.className = "sheet-error";
          found.textContent = error.message;
          found.hidden = false;
          discover.disabled = false;
          discover.textContent = "Find the server";
        }
      });
    });
  }
}

/* ---------- chat ---------- */

/**
 * Scrolling, which is a thing to get right rather than a thing to call
 * scrollIntoView about.
 *
 * The old page scrolled the answer bubble into view on every streamed event.
 * That reads as jumping, and it has three separate causes: the bubble changes
 * height as "Thinking" becomes "Reading conversation" becomes the answer, the
 * page is shorter than the viewport early in a turn so the browser clamps the
 * scroll somewhere arbitrary, and on iOS `scrollIntoView` measures the layout
 * viewport while the keyboard has moved the visual one.
 *
 * The model here scrolls exactly once per turn: when you send a question, it
 * goes to the top of the screen and stays there while the answer fills in
 * underneath. Nothing moves after that, because #tail shrinks by however much
 * the answer grows and the page height never changes.
 */
function chatMetrics() {
  const top = $("topbar").offsetHeight;
  // The composer's own padding already reserves the tab bar underneath it, so
  // its height is the whole obstructed strip at the bottom.
  const composer = $("composer").offsetHeight;

  return { top, composer, available: window.innerHeight - top - composer };
}

/** The question and answer of the turn in progress, or null. */
function lastTurn() {
  const answer = $("thread").lastElementChild;
  const question = answer === null ? null : answer.previousElementSibling;

  if (question === null || !question.classList.contains("msg-you")) {
    return null;
  }

  return { question, answer };
}

function fitTail() {
  const tail = $("tail");
  const { composer, available } = chatMetrics();

  // Never less than the strip the composer covers, or the last line of a long
  // answer sits underneath it.
  const floor = composer + 16;
  const turn = lastTurn();

  if (turn === null) {
    tail.style.height = $("thread").childElementCount > 0 ? floor + "px" : "0px";
    return;
  }

  const used =
    turn.question.getBoundingClientRect().height +
    turn.answer.getBoundingClientRect().height +
    24;

  tail.style.height = Math.max(floor, available - used) + "px";
}

function pinLastTurn() {
  const turn = lastTurn();

  if (turn === null) {
    return;
  }

  const { top } = chatMetrics();
  const y = turn.question.getBoundingClientRect().top + window.scrollY - top - 10;

  // Instant, not smooth. A smooth scroll still running when the first tool
  // event resizes the page is the jump this whole function exists to remove.
  window.scrollTo({ top: Math.max(0, y), behavior: "auto" });
}

window.addEventListener("resize", () => {
  if (view === "chat") fitTail();
});

const OPENERS = [
  "What is going on this week across everything?",
  "What have I said I would do and not done?",
  "Who have I been talking to most recently?",
];

function renderOpener() {
  const opener = $("opener");
  opener.hidden = $("thread").childElementCount > 0;

  fitTail();

  const chips = $("openerChips");

  if (chips.childElementCount > 0) return;

  for (const question of OPENERS) {
    const chip = el("button", "chip", question);
    chip.type = "button";
    chip.addEventListener("click", () => {
      $("question").value = question;
      $("composer").requestSubmit();
    });
    chips.append(chip);
  }
}

function bubble(className) {
  const node = el("div", "msg " + className);
  $("thread").append(node);
  return node;
}

function working(node, what) {
  node.textContent = "";
  const line = el("div", "working");
  line.append(el("span", "working-dot"));
  line.append(el("span", null, what ? "Reading" : "Thinking"));
  if (what) line.append(el("span", "working-what", what));
  node.append(line);
}

$("composer").addEventListener("submit", async (event) => {
  event.preventDefault();

  const question = $("question").value.trim();

  if (!question || asking) return;

  asking = true;
  $("question").value = "";
  $("send").disabled = true;
  $("opener").hidden = true;

  const mine = bubble("msg-you");
  mine.textContent = question;

  const answer = bubble("msg-harbor");
  working(answer, null);

  // After layout, not during it: the bubbles were appended this tick and their
  // heights are not measurable until the browser has laid them out.
  requestAnimationFrame(() => {
    fitTail();
    pinLastTurn();
  });

  try {
    await streamAsk(question, answer);
  } catch {
    answer.textContent = "Could not reach Harbor.";
    answer.className = "msg msg-harbor msg-error";
  } finally {
    asking = false;
    $("send").disabled = false;
    $("composerStatus").hidden = true;
    requestAnimationFrame(fitTail);
  }
});

/**
 * Server-sent events over fetch rather than EventSource, because EventSource
 * cannot set an Authorization header and the token is not going in a query
 * string where it would land in a log.
 */
async function streamAsk(question, node) {
  const response = await api("/ask", {
    method: "POST",
    headers: { accept: "text/event-stream" },
    body: JSON.stringify({
      question,
      ...(conversationId ? { conversationId } : {}),
    }),
  });

  if (!response.ok || !response.body) {
    const body = await response.json().catch(() => ({}));
    node.textContent = body.error ?? "That did not work.";
    node.className = "msg msg-harbor msg-error";
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();

    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";

    for (const frame of frames) {
      let name = "message";
      let data = "";

      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) name = line.slice(6).trim();
        if (line.startsWith("data:")) data += line.slice(5).trim();
      }

      if (data === "") continue;

      let payload;

      try {
        payload = JSON.parse(data);
      } catch {
        continue;
      }

      if (name === "tool") {
        // What it is doing while it does it. A spinner for eleven seconds
        // reads as broken; "searching your calendar" reads as working.
        working(node, payload.name);
        $("composerStatus").textContent = payload.name;
        $("composerStatus").hidden = false;
        fitTail();
      }

      if (name === "answer") {
        node.innerHTML = markdown(payload.answer);
        conversationId = payload.conversationId ?? conversationId;

        const meta = el("div", "msg-meta");

        if (payload.model) meta.append(el("span", null, payload.model));

        if (payload.costMicros) {
          meta.append(el("span", null, "$" + (payload.costMicros / 1e6).toFixed(4)));
        }

        if (payload.withheld) {
          meta.append(
            el("span", "withheld", payload.withheld + " withheld by policy"),
          );
        }

        if (meta.childElementCount > 0) node.append(meta);

        // The spacer gives back exactly what the answer took, so the page is
        // the same height it was a moment ago and nothing moves under you.
        requestAnimationFrame(fitTail);
      }

      if (name === "error") {
        node.textContent = payload.message ?? "That did not work.";
        node.className = "msg msg-harbor msg-error";
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * start
 * ------------------------------------------------------------------ */

function start() {
  switchTo(view);
  refresh();
}

if (token) {
  gate(false);
  start();
} else {
  gate(true);
}
