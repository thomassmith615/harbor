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
  $("viewSources").hidden = next !== "sources";
  $("viewRun").hidden = next !== "run";
  $("composer").hidden = next !== "chat";

  renderView();
  window.scrollTo({ top: 0 });
}

for (const button of $("tabs").querySelectorAll("button")) {
  button.addEventListener("click", () => { switchTo(button.dataset.view); });
}

function renderView() {
  if (view === "sources") renderSources();
  if (view === "run") renderRun();
  if (view === "chat") renderOpener();
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

  const rows = el("div", "rows");

  for (const stream of source.streams) {
    const row = el("div", "row");
    row.append(el("span", "row-name", stream.connector));

    const meta = el("span", "row-meta");
    meta.textContent = stream.lastSyncAt
      ? "synced " + ago(stream.lastSyncAt) + (stream.historicalDone ? "" : ", filling in")
      : "not synced yet";
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

const OPENERS = [
  "What is going on this week across everything?",
  "What have I said I would do and not done?",
  "Who have I been talking to most recently?",
];

function renderOpener() {
  const opener = $("opener");
  opener.hidden = $("thread").childElementCount > 0;

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
  answer.scrollIntoView({ block: "end" });

  try {
    await streamAsk(question, answer);
  } catch {
    answer.textContent = "Could not reach Harbor.";
    answer.className = "msg msg-harbor msg-error";
  } finally {
    asking = false;
    $("send").disabled = false;
    $("composerStatus").hidden = true;
    answer.scrollIntoView({ block: "end" });
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
        node.scrollIntoView({ block: "end" });
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
