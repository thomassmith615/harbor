/**
 * The page, and the promises it makes.
 *
 * The interface is plain HTML, CSS and JavaScript served from disk, so nothing
 * in it is typechecked and a rename on the API side breaks it silently. These
 * cover the handful of failures that would otherwise reach a phone: an endpoint
 * the page calls that no longer exists, a command in the pairing instructions
 * that Harbor does not have, the files not reaching `dist` at all, and the
 * markdown renderer turning model output into live markup.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { builtinUiRoot } from "./app.js";
import { API_PREFIXES } from "./api.js";

const root = builtinUiRoot();

function file(name: string): string {
  return readFileSync(join(root, name), "utf8");
}

describe("the interface reaches dist", () => {
  test("all three files are where the daemon serves them from", () => {
    // The build copies these; if that step is ever dropped, the daemon answers
    // the root with a 404 and the only symptom is a blank page on a phone.
    for (const name of ["index.html", "app.css", "app.js"]) {
      assert.ok(file(name).length > 0, `${name} is missing from ${root}`);
    }
  });

  test("the document loads the other two", () => {
    const html = file("index.html");

    assert.ok(html.includes('href="/app.css"'));
    assert.ok(html.includes('src="/app.js"'));
  });
});

describe("what the page asks Harbor for", () => {
  const script = file("app.js");

  test("every endpoint it calls is one the API routes", () => {
    // Extracted from the source rather than listed here, so a call to a route
    // that does not exist fails the build rather than the phone.
    //
    // The lookbehind drops the tail of a concatenated path: in
    // `"/jobs/" + id + "/cancel"` only `/jobs` is a route, and `/cancel` is a
    // segment underneath it. Without this the test reads it as a call to a
    // route named cancel and fails on correct code.
    const called = new Set<string>();

    for (const match of script.matchAll(/(?<!\+\s*)["'`]\/([a-z]+)[/"'`?]/g)) {
      const head = match[1];

      if (head !== undefined && head !== "app") {
        called.add(head);
      }
    }

    assert.ok(called.has("overview"), "the page no longer reads /overview");
    assert.ok(called.has("ask"), "the page no longer asks anything");

    for (const head of called) {
      assert.ok(
        API_PREFIXES.includes(head),
        `the page calls /${head}, which the API does not route`,
      );
    }
  });

  test("the pairing instructions name a command that exists", () => {
    // This was a real bug: the page said `harbor device pair`, which mints a
    // token for a named device rather than a code a browser can redeem.
    assert.ok(file("index.html").includes("harbor device code"));
  });
});

/**
 * The markdown renderer, lifted out of the page and run for real.
 *
 * Extracting by source markers is crude and it beats the alternative, which is
 * trusting a function that turns model output into live markup on the basis of
 * having read it.
 */
function renderer(): (text: string) => string {
  const script = file("app.js");
  const start = script.indexOf("function escapeHtml");
  const end = script.indexOf("function ago(");

  assert.ok(start >= 0 && end > start, "could not find the renderer in the page");

  return new Function(`${script.slice(start, end)}; return markdown;`)() as (
    text: string,
  ) => string;
}

describe("rendering an answer", () => {
  const markdown = renderer();

  test("emphasis and code become markup", () => {
    const html = markdown("You spent **$30.05** on *takeout*. Run `harbor purchases`.");

    assert.ok(html.includes("<strong>$30.05</strong>"));
    assert.ok(html.includes("<em>takeout</em>"));
    assert.ok(html.includes("<code>harbor purchases</code>"));
  });

  test("lists become lists", () => {
    const html = markdown("- **The Bellhouse Tavern**: $28.01\n- Philly Pretzel Factory");

    assert.ok(html.includes("<ul>"), "a bulleted answer did not become a list");
    assert.equal((html.match(/<li>/g) ?? []).length, 2);
  });

  test("numbered lists become numbered lists", () => {
    const html = markdown("1. first\n2. second");

    assert.ok(html.includes("<ol>"));
    assert.equal((html.match(/<li>/g) ?? []).length, 2);
  });

  test("markup in the source text stays text", () => {
    // The whole security argument. The text is a model's output over the
    // user's own mail, so it can contain anything the mail contained.
    const html = markdown("A receipt said <script>alert(1)</script> and <img onerror=x>.");

    assert.ok(!html.includes("<script"), "a script tag survived into the markup");
    assert.ok(!html.includes("<img"), "an img tag survived into the markup");
    assert.ok(html.includes("&lt;script&gt;"));
  });

  test("a javascript url does not become a link", () => {
    const html = markdown("[tap me](javascript:alert(1))");

    assert.ok(!html.includes("<a "), "a javascript: url became a link");
  });

  test("links are http only, and open safely", () => {
    const html = markdown("See [the receipt](https://example.com/r/1).");

    assert.ok(html.includes('href="https://example.com/r/1"'));
    assert.ok(html.includes('rel="noopener noreferrer"'));
  });

  test("a table becomes a table", () => {
    const html = markdown("| Place | Spent |\n| --- | --- |\n| Wegmans | $41.02 |");

    assert.ok(html.includes("<table>"));
    assert.ok(html.includes("<th>Place</th>"));
    assert.ok(html.includes("<td>$41.02</td>"));
  });

  test("prose containing a pipe stays prose", () => {
    // The false positive that matters: `harbor purchases | head` inside
    // backticks must not be read as a table.
    const html = markdown("Run `harbor purchases | head` to see them.");

    assert.ok(!html.includes("<table>"), "a pipe in prose became a table");
  });
});
