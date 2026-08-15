/**
 * The page Harbor serves to a phone.
 *
 * A string in the binary rather than a build step, and that is a deliberate
 * trade worth stating. The mandate says the current UI is a development surface
 * and warns against polishing it at the expense of the system underneath, and
 * the previous front end was a separate repository that fell six milestones
 * behind and got shelved. A page compiled into the daemon cannot fall behind:
 * there is no second install, no second deploy, no version skew, and nothing to
 * remember to rebuild.
 *
 * It is also the reason there is no framework here. This is roughly two hundred
 * lines of DOM, and the moment it wants a build step it stops being something
 * that ships with the thing it talks to.
 *
 * What it is for: asking Harbor something and reading the digest, from a phone,
 * on the sofa. Not the consumer product. When there is a real client, this stays
 * as the thing that works when the real client is broken.
 *
 * Everything about reachability is deliberately out of scope. This is served
 * from the same origin as the API, so there is no CORS, no mixed content, and
 * no second certificate. Getting to it from outside the house is a network
 * problem (Tailscale, or equivalent), not a front-end one, and solving it in
 * the front end would mean exposing the API to the internet.
 */

/** The token lives here. Same origin, so it is scoped to this Harbor. */
const STORAGE_KEY = "harbor.token";

export const APP_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#101418">
<title>Harbor</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #101418;
    --panel: #171d23;
    --line: #232c35;
    --text: #e6edf3;
    --dim: #8b98a5;
    --accent: #7aa2c4;
  }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    /* The keyboard on a phone covers the bottom of the viewport, so the
       composer is pinned to the visual viewport rather than the layout one. */
    padding: env(safe-area-inset-top) env(safe-area-inset-right) 0 env(safe-area-inset-left);
  }
  header {
    display: flex; align-items: baseline; gap: 12px;
    padding: 14px 16px; border-bottom: 1px solid var(--line);
    position: sticky; top: 0; background: var(--bg); z-index: 2;
  }
  header h1 { font-size: 17px; margin: 0; font-weight: 600; letter-spacing: 0.2px; }
  header .status { font-size: 13px; color: var(--dim); margin-left: auto; }
  nav { display: flex; gap: 4px; padding: 10px 12px 0; }
  nav button {
    flex: 1; padding: 9px 0; font: inherit; font-size: 14px;
    background: transparent; color: var(--dim);
    border: 0; border-bottom: 2px solid transparent; cursor: pointer;
  }
  nav button[aria-selected="true"] { color: var(--text); border-bottom-color: var(--accent); }
  main { padding: 12px 16px 140px; }
  .card {
    background: var(--panel); border: 1px solid var(--line);
    border-radius: 10px; padding: 12px 14px; margin-bottom: 10px;
  }
  .card h2 { font-size: 15px; margin: 0 0 4px; font-weight: 600; }
  .card p { margin: 0; color: var(--dim); font-size: 14px; }
  .msg { margin-bottom: 18px; }
  .msg.you { white-space: pre-wrap; }
  .msg p { margin: 0 0 10px; }
  .msg p:last-child, .msg ul:last-child, .msg ol:last-child { margin-bottom: 0; }
  .msg h3, .msg h4, .msg h5, .msg h6 { font-size: 15px; margin: 14px 0 6px; font-weight: 600; }
  .msg ul, .msg ol { margin: 0 0 10px; padding-left: 22px; }
  .msg li { margin-bottom: 4px; }
  .msg strong { font-weight: 600; }
  .msg code {
    font: 13px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
    background: var(--panel); border: 1px solid var(--line);
    border-radius: 5px; padding: 1px 5px;
  }
  .msg a { color: var(--accent); }
  /* Tables get their own scroller: a phone is 380px and a comparison is not. */
  .msg table {
    display: block; overflow-x: auto; border-collapse: collapse;
    margin: 0 0 12px; font-size: 14px; max-width: 100%;
  }
  .msg th, .msg td {
    border: 1px solid var(--line); padding: 6px 10px; text-align: left; white-space: nowrap;
  }
  .msg th { background: var(--panel); font-weight: 600; }
  .msg.you { color: var(--dim); }
  .msg.you::before { content: "you  "; color: var(--accent); }
  .msg .meta { display: block; margin-top: 6px; font-size: 12px; color: var(--dim); }
  .composer {
    position: fixed; left: 0; right: 0; bottom: 0;
    display: flex; gap: 8px; padding: 10px 12px calc(10px + env(safe-area-inset-bottom));
    background: var(--bg); border-top: 1px solid var(--line);
  }
  .composer input, .composer button {
    font: inherit; border-radius: 9px; border: 1px solid var(--line);
    background: var(--panel); color: var(--text); padding: 11px 12px;
  }
  .composer input { flex: 1; min-width: 0; }
  .composer button { background: var(--accent); color: #0b0f13; border-color: transparent; font-weight: 600; }
  .composer button:disabled { opacity: 0.4; }
  .empty { color: var(--dim); font-size: 14px; padding: 24px 0; text-align: center; }
  .pair { max-width: 380px; margin: 12vh auto; padding: 0 20px; }
  .pair p { color: var(--dim); font-size: 14px; }
  .pair code { color: var(--text); }
  .error { color: #e2857b; font-size: 14px; }
  [hidden] { display: none !important; }
</style>
</head>
<body>

<div class="pair" id="pair" hidden>
  <h1>Pair this device</h1>
  <p>On the machine running Harbor, run <code>harbor device code</code> and type what it prints.</p>
  <div class="composer" style="position:static;border:0;padding:12px 0">
    <input id="code" autocapitalize="characters" autocomplete="one-time-code" placeholder="XXXX-XXXX">
    <button id="pairGo">Pair</button>
  </div>
  <p class="error" id="pairError"></p>
</div>

<div id="app" hidden>
  <header>
    <h1>Harbor</h1>
    <span class="status" id="status"></span>
  </header>

  <nav>
    <button id="tabAsk" aria-selected="true">Ask</button>
    <button id="tabDigest" aria-selected="false">Noticed</button>
  </nav>

  <main>
    <div id="askView">
      <div id="thread"></div>
      <div class="empty" id="askEmpty">Ask Harbor something about your own data.</div>
    </div>

    <div id="digestView" hidden>
      <div id="digestBody"></div>
    </div>
  </main>

  <form class="composer" id="composer">
    <input id="question" placeholder="Ask Harbor" autocomplete="off" enterkeyhint="send">
    <button type="submit" id="send">Ask</button>
  </form>
</div>

<script type="module">
const KEY = ${JSON.stringify(STORAGE_KEY)};
const $ = (id) => document.getElementById(id);

/**
 * A very small markdown renderer.
 *
 * Models answer in markdown whether or not you ask them to, so a page that sets
 * textContent shows a person literal asterisks around every emphasis. This
 * converts the subset that actually turns up: emphasis, code, headings,
 * bullets, numbered lists, and links.
 *
 * Escaping happens first and unconditionally, and that ordering is the entire
 * security argument. The text being rendered is a model's output over the
 * user's own mail, so it can contain anything the mail contained: a script tag
 * in a marketing email, an img with an onerror handler. Escape first, then add
 * back only the tags this function chose, and there is no path from source text
 * to live markup.
 *
 * Links are restricted to http and https for the same reason: a javascript:
 * URL in an answer would otherwise be one tap from running.
 */
function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function inline(text) {
  return escapeHtml(text)
    .replace(/\`([^\`]+)\`/g, "<code>$1</code>")
    .replace(/\\*\\*([^*]+)\\*\\*/g, "<strong>$1</strong>")
    .replace(/(^|[\\s(])\\*([^*\\n]+)\\*/g, "$1<em>$2</em>")
    .replace(/(^|[\\s(])_([^_\\n]+)_/g, "$1<em>$2</em>")
    .replace(/\\[([^\\]]+)\\]\\((https?:\\/\\/[^)\\s]+)\\)/g, '<a href="$2" rel="noopener noreferrer" target="_blank">$1</a>');
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

  const lines = String(text ?? "").split("\\n");
  let skipTo = 0;

  for (let index = 0; index < lines.length; index += 1) {
    if (index < skipTo) {
      continue;
    }

    const raw = lines[index];
    const next = lines[index + 1];
    const line = raw.trimEnd();

    if (line.trim() === "") {
      closeList();
      continue;
    }

    const heading = /^(#{1,4})\\s+(.*)$/.exec(line);

    if (heading) {
      closeList();
      const level = Math.min(4, heading[1].length) + 2;
      out.push("<h" + level + ">" + inline(heading[2]) + "</h" + level + ">");
      continue;
    }

    // A table, which models reach for constantly when asked to compare
    // anything. Rendered as a real table rather than left as pipes, because a
    // pipe-delimited grid wraps into nonsense on a 380px screen.
    //
    // Recognised by the separator row, which is the only unambiguous marker: a
    // line containing a pipe could be prose, and a line of pipes and dashes
    // could not.
    if (line.includes("|") && /^\\s*\\|?[\\s:|-]*-[\\s:|-]*$/.test(next ?? "")) {
      closeList();

      const cells = (row) =>
        row
          .replace(/^\\s*\\|/, "")
          .replace(/\\|\\s*$/, "")
          .split("|")
          .map((cell) => cell.trim());

      out.push("<table><thead><tr>");

      for (const cell of cells(line)) {
        out.push("<th>" + inline(cell) + "</th>");
      }

      out.push("</tr></thead><tbody>");

      // Consume the separator, then every row after it that still looks like one.
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

    const bullet = /^\\s*[-*\\u2022]\\s+(.*)$/.exec(line);

    if (bullet) {
      if (list !== "ul") {
        closeList();
        out.push("<ul>");
        list = "ul";
      }

      out.push("<li>" + inline(bullet[1]) + "</li>");
      continue;
    }

    const numbered = /^\\s*\\d+[.)]\\s+(.*)$/.exec(line);

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

let token = localStorage.getItem(KEY);
let conversationId = null;

function show(paired) {
  $("pair").hidden = paired;
  $("app").hidden = !paired;
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
    // The token was revoked or the store was replaced. Say so rather than
    // failing every request silently forever.
    localStorage.removeItem(KEY);
    token = null;
    show(false);
    $("pairError").textContent = "This device is no longer paired.";
    throw new Error("unpaired");
  }

  return response;
}

$("pairGo").addEventListener("click", async () => {
  $("pairError").textContent = "";

  const response = await fetch("/pair", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      // Typed on a phone, so accept lower case and missing dashes.
      code: $("code").value.trim().toUpperCase(),
      deviceName: navigator.userAgent.includes("iPhone") ? "iPhone" : "browser",
    }),
  });

  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    $("pairError").textContent = body.error ?? "That code did not work.";
    return;
  }

  token = body.token;
  localStorage.setItem(KEY, token);
  show(true);
  load();
});

function tab(which) {
  const asking = which === "ask";
  $("tabAsk").setAttribute("aria-selected", String(asking));
  $("tabDigest").setAttribute("aria-selected", String(!asking));
  $("askView").hidden = !asking;
  $("digestView").hidden = asking;
  $("composer").hidden = !asking;
}

$("tabAsk").addEventListener("click", () => { tab("ask"); });
$("tabDigest").addEventListener("click", () => { tab("digest"); loadDigest(); });

function bubble(text, mine) {
  const node = document.createElement("div");
  node.className = "msg" + (mine ? " you" : "");
  node.textContent = text;
  $("thread").append(node);
  node.scrollIntoView({ block: "end" });
  return node;
}

$("composer").addEventListener("submit", async (event) => {
  event.preventDefault();

  const question = $("question").value.trim();
  if (!question) return;

  $("askEmpty").hidden = true;
  $("question").value = "";
  $("send").disabled = true;
  bubble(question, true);

  const answer = bubble("thinking", false);

  try {
    const response = await api("/ask", {
      method: "POST",
      body: JSON.stringify({ question, ...(conversationId ? { conversationId } : {}) }),
    });

    const body = await response.json();

    if (!response.ok) {
      answer.textContent = body.error ?? "That did not work.";
      answer.classList.add("error");
    } else {
      answer.innerHTML = markdown(body.answer);
      conversationId = body.conversationId ?? conversationId;

      // What it cost and what it read, because a person should be able to see
      // that without opening a terminal.
      const meta = document.createElement("span");
      meta.className = "meta";
      meta.textContent =
        [body.model, body.withheld ? body.withheld + " withheld by policy" : null]
          .filter(Boolean)
          .join("  ");
      answer.append(meta);
    }
  } catch {
    answer.textContent = "Could not reach Harbor.";
    answer.classList.add("error");
  } finally {
    $("send").disabled = false;
    answer.scrollIntoView({ block: "end" });
  }
});

async function loadDigest() {
  const response = await api("/digest");
  const body = await response.json();

  $("digestBody").innerHTML = "";

  if (!body.digest) {
    const empty = document.createElement("div");
    empty.className = "empty";
    // The honest empty state. Nothing to say is the correct answer most days,
    // and dressing it up would train somebody to stop reading it.
    empty.textContent = "Nothing worth interrupting you about.";
    $("digestBody").append(empty);
    return;
  }

  const card = document.createElement("div");
  card.className = "card";
  const text = document.createElement("p");
  text.style.color = "var(--text)";
  text.innerHTML = markdown(body.digest.text);
  card.append(text);
  $("digestBody").append(card);
}

async function load() {
  try {
    const response = await api("/status");
    const body = await response.json();
    $("status").textContent = body.items ? body.items.toLocaleString() + " items" : "";
  } catch {
    $("status").textContent = "";
  }
}

show(Boolean(token));
if (token) load();
</script>
</body>
</html>`;
