/**
 * Who a receipt is from, and who it says it is from.
 *
 * Every case here comes from one real spending report in which $2,600 of a
 * $4,885 total was wrong: money that never moved, a merchant that was never
 * used, and one pizza place counted three times.
 */
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { displayMerchant, isTransfer, merchantKey, sameMerchant, trustSender } from "./merchants.js";

describe("sender trust", () => {
  test("a consumer mail account is not a merchant", () => {
    // Invoice scams: a PDF from a personal account claiming a charge that does
    // not exist, hoping you call the number to dispute it.
    for (const author of [
      "Maara Morgan <hpk917456@gmail.com>",
      "Cheryl Engel <cherylengelpc5t@outlook.com>",
      "Sharon Williams <sharonwilliams_jimmybarnett@outlook.com>",
    ]) {
      const verdict = trustSender(author);

      assert.equal(verdict.trusted, false, `${author} was trusted`);
      assert.ok((verdict.reason ?? "").length > 0);
    }
  });

  test("a display name claiming a brand its domain does not", () => {
    const verdict = trustSender("GEEK SQUAD <billing@invoice-services-247.biz>");

    assert.equal(verdict.trusted, false);
    assert.ok((verdict.reason ?? "").includes("geek squad"));
  });

  test("the real brand from its own domain is fine", () => {
    assert.equal(trustSender("PayPal <service@paypal.com>").trusted, true);
    assert.equal(trustSender("Geek Squad <no-reply@geeksquad.com>").trusted, true);
    // A subdomain is still the brand.
    assert.equal(trustSender("PayPal <s@mail.paypal.com>").trusted, true);
  });

  test("ordinary merchants pass", () => {
    for (const author of [
      "Uber Receipts <noreply@uber.com>",
      "DSW <orders@dsw.com>",
      "DoorDash Order <no-reply@doordash.com>",
    ]) {
      assert.equal(trustSender(author).trusted, true, `${author} was refused`);
    }
  });
});

describe("merchant identity", () => {
  test("spacing and case are not different merchants", () => {
    assert.ok(sameMerchant("GEEKSQUAD", "GEEK SQUAD"));
    assert.equal(merchantKey("GEEKSQUAD"), merchantKey("Geek Squad"));
  });

  test("a leading article is not a different merchant", () => {
    assert.ok(sameMerchant("The Tomato Shack - Conshohocken", "Tomato Shack - Conshohocken"));
  });

  test("a name truncated by a column width still matches", () => {
    assert.ok(sameMerchant("The Tomato Shack - Conshohocke", "The Tomato Shack - Conshohocken"));
  });

  test("a shared stem is not the same merchant", () => {
    // The reason the prefix rule has a length floor: these are genuinely
    // different businesses and merging them would be worse than splitting one.
    assert.equal(sameMerchant("Uber", "Uber Eats"), false);
  });

  test("the display name is the one that was not cut off", () => {
    assert.equal(
      displayMerchant(["The Tomato Shack - Conshohocke", "The Tomato Shack - Conshohocken"]),
      "The Tomato Shack - Conshohocken",
    );
    assert.equal(displayMerchant(["GEEKSQUAD", "Geek Squad"]), "Geek Squad");
  });
});

describe("transfers", () => {
  test("money moving is not money spent", () => {
    for (const name of ["Robinhood", "Venmo", "American Express", "PayPal", "Coinbase"]) {
      assert.equal(isTransfer(name), true, `${name} counted as spending`);
    }
  });

  test("shops are not transfers", () => {
    for (const name of ["DSW", "Wegmans", "PGA TOUR Superstore", "Uber Eats"]) {
      assert.equal(isTransfer(name), false, `${name} counted as a transfer`);
    }
  });
});
