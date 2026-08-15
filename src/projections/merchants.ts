/**
 * Who a receipt is from, and who it says it is from.
 *
 * Two problems that look unrelated and are the same problem: a total is only as
 * good as the identity attached to it.
 *
 * **Merchant identity.** `GEEKSQUAD` and `GEEK SQUAD` were separate merchants.
 * So were `The Tomato Shack - Conshohocken`, `Tomato Shack - Conshohocken`, and
 * `The Tomato Shack - Conshohocke`, the last one truncated by a column width.
 * Spending by merchant is the whole point of the projection and it was split
 * three ways for one pizza place.
 *
 * **Sender trust.** `GEEKSQUAD $514.98` and `PayPal $675.99` were the second
 * and third largest lines in a real spending report, and neither was a purchase
 * anybody made. They are invoice-scam emails: a PDF attached to a message from
 * a consumer mail account, claiming to be a brand, hoping the recipient calls
 * the number to dispute a charge that does not exist. The extraction did its
 * job perfectly and read exactly what the document said.
 *
 * The defence is deterministic and narrow. Real merchants do not send receipts
 * from Gmail, and a message whose display name claims a brand its domain does
 * not is either a scam or a forward. Both tests are about the envelope rather
 * than the content, which matters: the content is the part an attacker controls
 * and writes convincingly.
 */

/**
 * Consumer mail providers.
 *
 * A business large enough to send an automated receipt has a domain. This is
 * the single highest-value signal available and it costs one string compare.
 */
const CONSUMER_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "ymail.com",
  "aol.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "proton.me",
  "protonmail.com",
  "gmx.com",
  "mail.com",
  "zoho.com",
  "yandex.com",
]);

/**
 * Brands worth impersonating, which is most of the ones that get impersonated.
 *
 * Only used for the mismatch test: if the display name claims one of these and
 * the sending domain does not contain it, the message is claiming to be
 * somebody it is not. Deliberately short and about impersonation rather than
 * commerce; an unknown brand simply fails no test.
 */
const IMPERSONATED = [
  "paypal",
  "geeksquad",
  "geek squad",
  "bestbuy",
  "best buy",
  "norton",
  "mcafee",
  "amazon",
  "apple",
  "microsoft",
  "coinbase",
  "venmo",
  "docusign",
  "fedex",
  "ups",
  "dhl",
  "netflix",
  "paypa1",
];

export interface SenderVerdict {
  readonly trusted: boolean;
  /** Why not, in words a person can check. Null when trusted. */
  readonly reason: string | null;
}

function addressOf(author: string): string {
  return (/<([^<>]+)>/.exec(author)?.[1] ?? author).trim().toLowerCase();
}

function domainOf(address: string): string {
  return address.split("@")[1] ?? "";
}

function displayNameOf(author: string): string {
  const match = /^([^<]+)</.exec(author);

  return (match?.[1] ?? "").trim().toLowerCase().replace(/^["']|["']$/g, "");
}

/**
 * Whether a receipt's sender is who it claims to be.
 *
 * Not spam detection in general. The question is narrower and answerable: is
 * this envelope consistent with a business sending its own receipt.
 */
export function trustSender(author: string | null): SenderVerdict {
  if (author === null || author.trim().length === 0) {
    return { trusted: false, reason: "no sender" };
  }

  const address = addressOf(author);
  const domain = domainOf(address);

  if (domain.length === 0) {
    return { trusted: false, reason: "no sending domain" };
  }

  if (CONSUMER_DOMAINS.has(domain)) {
    return {
      trusted: false,
      reason: `receipts do not come from ${domain}`,
    };
  }

  const display = displayNameOf(author);

  for (const brand of IMPERSONATED) {
    if (!display.includes(brand)) {
      continue;
    }

    // The brand without spaces, because "Geek Squad" sends from geeksquad.com,
    // and a subdomain counts: mail.paypal.com is PayPal.
    const compact = brand.replace(/\s+/g, "");

    if (domain.includes(compact)) {
      return { trusted: true, reason: null };
    }

    return {
      trusted: false,
      reason: `claims to be ${display} but was sent from ${domain}`,
    };
  }

  return { trusted: true, reason: null };
}

/**
 * A merchant name reduced to what makes it that merchant.
 *
 * Used for grouping only; the display name is chosen separately, because
 * `geek squad` is the right key and the wrong label.
 */
export function merchantKey(name: string): string {
  let key = name.toLowerCase().trim();

  // Truncation. A name cut off by a column width should still group with the
  // whole one, and this is the cheapest way to notice: strip a trailing partial
  // word only when the name is long enough that truncation is plausible.
  key = key.replace(/\s*[.,-]\s*$/, "");

  key = key
    .replace(/^(the|a)\s+/, "")
    .replace(/\b(inc|llc|ltd|co|corp|company|store|stores|shop)\b\.?/g, "")
    .replace(/[^a-z0-9]+/g, "");

  return key;
}

/**
 * Whether two merchant names are the same merchant.
 *
 * Exact after normalisation, or one is a prefix of the other and the shorter is
 * long enough to be distinctive. The prefix rule is what joins
 * `thetomatoshackconshohocke` to `thetomatoshackconshohocken`; the length floor
 * is what stops `uber` joining `ubereats`, which are genuinely different
 * merchants that happen to share a stem.
 */
export function sameMerchant(a: string, b: string): boolean {
  const left = merchantKey(a);
  const right = merchantKey(b);

  if (left === right) {
    return true;
  }

  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];

  // At least twelve characters and within three of the longer: a truncation,
  // not a different business. Uber and Uber Eats differ by four on a stem of
  // four and are correctly kept apart.
  return (
    shorter.length >= 12 && longer.startsWith(shorter) && longer.length - shorter.length <= 3
  );
}

/**
 * The name to show for a group of variants.
 *
 * The longest, because truncation is the common cause of variance and the
 * longest is the one that was not cut off. Ties go to whichever has more
 * lowercase, since `Geek Squad` reads better than `GEEKSQUAD` and shouting is
 * usually the artifact.
 */
export function displayMerchant(names: readonly string[]): string {
  return [...names].sort((a, b) => {
    if (a.length !== b.length) {
      return b.length - a.length;
    }

    const lower = (value: string): number => value.replace(/[^a-z]/g, "").length;

    return lower(b) - lower(a);
  })[0] ?? "";
}

/**
 * Merchants that move money rather than sell things.
 *
 * A brokerage transfer, a card payment, and a peer-to-peer send are all real
 * and none of them are spending. On a real report they were $2,600 of a $4,885
 * total, which makes every other number in it meaningless.
 *
 * Recorded rather than discarded: "$1,522 to Robinhood on June 15" is a fact
 * worth keeping, it just does not belong in what you spent.
 */
const TRANSFER_MERCHANTS = [
  "robinhood",
  "venmo",
  "cashapp",
  "zelle",
  "paypal",
  "coinbase",
  "wise",
  "schwab",
  "fidelity",
  "vanguard",
  "etrade",
  "sofi",
  "chime",
  "americanexpress",
  "amex",
  "chase",
  "citi",
  "capitalone",
  "discover",
  "wellsfargo",
  "bankofamerica",
];

export function isTransfer(merchant: string | null): boolean {
  if (merchant === null) {
    return false;
  }

  const key = merchantKey(merchant);

  return TRANSFER_MERCHANTS.some((name) => key === name || key.startsWith(name));
}

/**
 * Sending platforms, where the domain identifies the platform and not the
 * merchant.
 *
 * `store+75632214210@t.shopifyemail.com` looked like a solid envelope and is
 * nothing of the kind: every Shopify store on earth sends from that domain, a
 * real boutique and a dropship front alike. The same is true of every bulk
 * email service, which is most of the ones a small merchant uses.
 *
 * So for these, the display name is unverifiable by construction. A brand-name
 * check against the domain cannot fail and cannot pass; it simply does not
 * apply, and treating "the domain is real" as "the merchant is real" is the
 * mistake that let a $749 iPhone into a spending report.
 */
const SHARED_SENDERS = [
  "shopifyemail.com",
  "sendgrid.net",
  "mailgun.org",
  "mailgun.net",
  "klaviyomail.com",
  "mcsv.net",
  "rsgsv.net",
  "mailchimpapp.net",
  "sparkpostmail.com",
  "amazonses.com",
  "postmarkapp.com",
  "mandrillapp.com",
  "sendinblue.com",
  "brevo.com",
  "cmail19.com",
  "createsend.com",
  "hubspotemail.net",
  "salesforce.com",
  "exacttarget.com",
  "mktomail.com",
  "incentivio.com",
  "chowlyinc.com",
  "toasttab.com",
  "squareup.com",
];

/**
 * Whether the sending domain says anything about who the merchant is.
 *
 * Not a judgement about the merchant. A great many real purchases arrive this
 * way, and the point is only that the envelope carries no evidence, so the
 * evidence has to come from somewhere else.
 */
export function isSharedSender(author: string | null): boolean {
  if (author === null) {
    return false;
  }

  const domain = domainOf(addressOf(author));

  return SHARED_SENDERS.some((shared) => domain === shared || domain.endsWith(`.${shared}`));
}
