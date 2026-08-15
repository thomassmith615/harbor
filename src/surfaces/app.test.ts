/**
 * The page, and the promises it makes.
 *
 * It is a string, so nothing about it can be typechecked. These cover the
 * handful of things that would break it silently: an endpoint that gets
 * renamed, a command name in the instructions that does not exist, and the page
 * becoming secret when it must not be.
 */
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { APP_HTML } from "./app.js";

/**
 * The markdown renderer, lifted out of the page and run for real.
 *
 * The page is a string, so this is the only way to test the one function in it
 * with a correctness question rather than a styling question. Extracting by
 * source markers is crude and it beats the alternative, which is trusting a
 * renderer that turns model output into live markup.
 */
function renderer(): (text: string) => string {
  const start = APP_HTML.indexOf("function escapeHtml");
  const end = APP_HTML.indexOf("let token = localStorage");

  assert.ok(start >= 0 && end > start, "could not find the renderer in the page");

  return new Function(`${APP_HTML.slice(start, end)}; return markdown;`)() as (
    text: string,
  ) => string;
}

describe("rendering an answer", () => {
  const markdown = renderer();

  test("emphasis and code become markup", () => {
    // Models answer in markdown whether or not you ask them to, so a page that
    // sets textContent shows a person literal asterisks around every emphasis.
    const html = markdown("You spent **$30.05** on *takeout*. Run `harbor purchases`.");

    assert.ok(html.includes("<strong>$30.05</strong>"));
    assert.ok(html.includes("<em>takeout</em>"));
    assert.ok(html.includes("<code>harbor purchases</code>"));
  });

  test("lists become lists", () => {
    const html = markdown("- **The Daisy Tavern**: $28.01\n- Philly Pretzel Factory");

    assert.ok(html.includes("<ul>"), "a bulleted answer did not become a list");
    assert.equal((html.match(/<li>/g) ?? []).length, 2);
  });

  test("numbered lists become numbered lists", () => {
    const html = markdown("1. first\n2. second");

    assert.ok(html.includes("<ol>"));
    assert.equal((html.match(/<li>/g) ?? []).length, 2);
  });

  test("markup in the source text stays text", () => {
    // The whole security argument, and the reason escaping runs first and
    // unconditionally. This text is a model's output over the user's own mail,
    // so it can contain anything the mail contained: a script tag from a
    // marketing email, an img with an onerror handler.
    const html = markdown('<img src=x onerror=alert(1)> and <script>bad()</script>');

    assert.ok(!html.includes("<img"), "an image tag survived into markup");
    assert.ok(!html.includes("<script"), "a script tag survived into markup");
    assert.ok(html.includes("&lt;script&gt;"), "the tag was dropped rather than shown as text");
  });

  test("only http links become links", () => {
    // A javascript: URL in an answer would otherwise be one tap from running.
    const html = markdown("[ok](https://example.com) [bad](javascript:alert(1))");

    assert.ok(html.includes('href="https://example.com"'));
    assert.ok(!html.includes("javascript:alert(1)\""), "a javascript URL became a link");
    assert.ok(!html.includes("<a href=\"javascript"), "a javascript URL became a link");
  });

  test("a table becomes a table", () => {
    // Models reach for a table whenever they are asked to compare anything, and
    // a pipe-delimited grid wraps into nonsense on a 380px screen.
    const html = markdown(
      "| Merchant | Total |\n| --- | --- |\n| Uber | $140.49 |\n| DSW | $119.79 |",
    );

    assert.ok(html.includes("<table>"), "a table stayed as pipes");
    assert.equal((html.match(/<th>/g) ?? []).length, 2);
    assert.equal((html.match(/<tr>/g) ?? []).length, 3);
    assert.ok(html.includes("<td>$140.49</td>"));
  });

  test("pipes in prose are not a table", () => {
    // The separator row is the only unambiguous marker. Without requiring it, a
    // sentence containing a pipe would become a one-cell table.
    const html = markdown("The command is `harbor purchases | head`.");

    assert.ok(!html.includes("<table>"), "prose containing a pipe became a table");
  });

  test("plain text is still plain text", () => {
    const html = markdown("Nothing worth interrupting you about.");

    assert.equal(html, "<p>Nothing worth interrupting you about.</p>");
  });
});

describe("the built-in page", () => {
  test("only calls endpoints the API serves", () => {
    // A renamed route would leave the page silently broken on a phone, which is
    // the one place nobody is watching a console.
    for (const path of ["/pair", "/ask", "/digest", "/status"]) {
      assert.ok(APP_HTML.includes(`"${path}"`), `the page never calls ${path}`);
    }
  });

  test("tells the truth about how to pair", () => {
    // The first draft said `harbor device pair`, which creates a token for a
    // named device rather than a code a browser can redeem. Somebody following
    // it would have got an error with no way to know which half was wrong.
    assert.ok(
      APP_HTML.includes("harbor device code"),
      "the instructions name a command that does not issue a redeemable code",
    );
    assert.ok(
      !APP_HTML.includes("harbor device pair"),
      "the instructions still name the wrong command",
    );
  });

  test("sends the token as a bearer header and keeps it out of the URL", () => {
    assert.ok(APP_HTML.includes("Bearer "), "the page does not authenticate");
    assert.ok(
      !APP_HTML.includes("?token="),
      "a token in a query string ends up in logs and history",
    );
  });

  test("forgets the token when the server stops accepting it", () => {
    // Otherwise a revoked device fails every request forever with no route back
    // to the pairing screen.
    assert.ok(APP_HTML.includes("401"), "the page does not handle being unpaired");
    assert.ok(APP_HTML.includes("removeItem"), "a dead token is never cleared");
  });

  test("is a single self-contained document", () => {
    // The point of compiling it in: no second install, no version skew, nothing
    // to rebuild. An external script or stylesheet reintroduces all three.
    assert.ok(!/<script[^>]+src=/i.test(APP_HTML), "the page loads an external script");
    assert.ok(!/<link[^>]+stylesheet/i.test(APP_HTML), "the page loads an external stylesheet");
  });
});
