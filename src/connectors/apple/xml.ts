/**
 * A very small XML reader, for DAV multistatus responses only.
 *
 * Written rather than depended on because the shape of what WebDAV returns is
 * narrow and completely predictable: elements, attributes, text, entities. No
 * DTDs, no processing instructions worth honouring, no mixed content that
 * matters. A general XML library would be a large dependency doing a fraction
 * of its job.
 *
 * The one part that needs care is `calendar-data` and `address-data`, whose
 * text content is an entire iCalendar or vCard document with its own escaping
 * on top of XML's. Entity decoding happens here; the format-specific unescaping
 * happens in the parsers that consume it.
 */

export interface XmlNode {
  /** Local name, lowercased. Namespaces are stripped: DAV uses one vocabulary. */
  readonly name: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: readonly XmlNode[];
  readonly text: string;
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
    }

    if (body.startsWith("#")) {
      return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
    }

    return ENTITIES[body.toLowerCase()] ?? match;
  });
}

function localName(raw: string): string {
  const colon = raw.indexOf(":");
  return (colon === -1 ? raw : raw.slice(colon + 1)).toLowerCase();
}

function parseAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};

  for (const match of source.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"|([\w:.-]+)\s*=\s*'([^']*)'/g)) {
    const key = match[1] ?? match[3];
    const value = match[2] ?? match[4];

    if (key !== undefined && value !== undefined) {
      attributes[localName(key)] = decodeEntities(value);
    }
  }

  return attributes;
}

interface Frame {
  name: string;
  attributes: Record<string, string>;
  children: XmlNode[];
  text: string;
}

export function parseXml(source: string): XmlNode {
  const root: Frame = { name: "#document", attributes: {}, children: [], text: "" };
  const stack: Frame[] = [root];

  const tagPattern = /<(\/)?([\w:.-]+)((?:\s+[^>]*?)?)(\/)?>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>/g;

  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = tagPattern.exec(source)) !== null) {
    const frame = stack[stack.length - 1];

    if (frame !== undefined && match.index > cursor) {
      frame.text += source.slice(cursor, match.index);
    }

    cursor = match.index + match[0].length;

    // Comments and declarations: skipped, and they carry no text.
    if (match[2] === undefined) {
      continue;
    }

    const closing = match[1] === "/";
    const selfClosing = match[4] === "/";
    const name = localName(match[2]);

    if (closing) {
      const finished = stack.pop();

      if (finished === undefined || stack.length === 0) {
        // Unbalanced. Stop rather than corrupting the tree further.
        break;
      }

      const parent = stack[stack.length - 1];
      parent?.children.push({
        name: finished.name,
        attributes: finished.attributes,
        children: finished.children,
        text: decodeEntities(finished.text),
      });

      continue;
    }

    const attributes = parseAttributes(match[3] ?? "");

    if (selfClosing) {
      frame?.children.push({ name, attributes, children: [], text: "" });
      continue;
    }

    stack.push({ name, attributes, children: [], text: "" });
  }

  return {
    name: root.name,
    attributes: {},
    children: root.children,
    text: decodeEntities(root.text),
  };
}

/** Every descendant with this local name, depth first. */
export function findAll(node: XmlNode, name: string): readonly XmlNode[] {
  const found: XmlNode[] = [];

  const walk = (current: XmlNode): void => {
    for (const child of current.children) {
      if (child.name === name) {
        found.push(child);
      }
      walk(child);
    }
  };

  walk(node);
  return found;
}

export function findFirst(node: XmlNode, name: string): XmlNode | null {
  return findAll(node, name)[0] ?? null;
}

export function textOf(node: XmlNode | null): string {
  if (node === null) {
    return "";
  }

  if (node.children.length === 0) {
    return node.text.trim();
  }

  // Text can be split around child elements; DAV does this with hrefs.
  return `${node.text}${node.children.map((child) => textOf(child)).join("")}`.trim();
}

export function escapeXml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
