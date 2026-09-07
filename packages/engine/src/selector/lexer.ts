/**
 * Selector grammar lexer (§2).
 * Tokenizes selector strings into atoms and operators.
 */

import { InvalidSelectorError } from "../errors.js";
import { SELECTOR_FILTERS } from "./grammar.js";

export type TokenType =
  | "TAG"
  | "URI"
  | "PACK"
  | "TYPE_FILTER"
  | "STATUS_FILTER"
  | "TRANSPORT_FILTER"
  | "SERVER_FILTER"
  | "AND"
  | "OR"
  | "NOT"
  | "LPAREN"
  | "RPAREN"
  | "EOF";

export interface Token {
  type: TokenType;
  value: string;
  position: number;
}

/** Bare node id prefixes that lex as a URI atom without the scheme. */
const BARE_ID_PREFIX = /^(nodes|sources)\//;

/**
 * `nodes/<id>` / `sources/<id>` → `contextnest://nodes/<id>`; anything else →
 * null. Shared by the bare-id branch and the quoted-string branch so the two
 * spellings (`nodes/x` and `"nodes/x"`) can never diverge.
 */
function bareIdToUri(value: string): string | null {
  return BARE_ID_PREFIX.test(value) ? `contextnest://${value}` : null;
}

export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let pos = 0;

  function skipWhitespace() {
    while (pos < input.length && /\s/.test(input[pos])) pos++;
  }

  while (pos < input.length) {
    skipWhitespace();
    if (pos >= input.length) break;

    const start = pos;
    const ch = input[pos];

    // Operators
    if (ch === "+") {
      tokens.push({ type: "AND", value: "+", position: start });
      pos++;
      continue;
    }
    if (ch === "|") {
      tokens.push({ type: "OR", value: "|", position: start });
      pos++;
      continue;
    }
    if (ch === "-") {
      tokens.push({ type: "NOT", value: "-", position: start });
      pos++;
      continue;
    }
    if (ch === "(") {
      tokens.push({ type: "LPAREN", value: "(", position: start });
      pos++;
      continue;
    }
    if (ch === ")") {
      tokens.push({ type: "RPAREN", value: ")", position: start });
      pos++;
      continue;
    }

    // Tag: #word
    if (ch === "#") {
      pos++;
      const tagStart = pos;
      while (pos < input.length && /[a-zA-Z0-9_-]/.test(input[pos])) pos++;
      const tagValue = input.slice(tagStart, pos);
      if (!tagValue) {
        throw new InvalidSelectorError(
          `Invalid tag at position ${start}: expected tag name after #`,
        );
      }
      tokens.push({ type: "TAG", value: tagValue, position: start });
      continue;
    }

    // URI: contextnest://...
    if (input.slice(pos).startsWith("contextnest://")) {
      const uriStart = pos;
      pos += "contextnest://".length;
      // Read until whitespace, a binary/group operator, or paren. Note `-` is
      // NOT a delimiter here: hyphens are valid URI path characters (e.g.
      // `contextnest://nodes/api-design`), mirroring tag tokenization which
      // also consumes `-`. The NOT operator is whitespace-delimited in practice
      // (`uri - #tag`), so it still tokenizes correctly after the URI ends.
      while (pos < input.length && !/[\s+|()]/.test(input[pos])) pos++;
      tokens.push({ type: "URI", value: input.slice(uriStart, pos), position: uriStart });
      continue;
    }

    // Quoted string (for URIs or complex values)
    if (ch === '"') {
      pos++;
      const strStart = pos;
      while (pos < input.length && input[pos] !== '"') pos++;
      const value = input.slice(strStart, pos);
      pos++; // skip closing quote
      // Determine type based on content
      if (value.startsWith("contextnest://")) {
        tokens.push({ type: "URI", value, position: start });
      } else if (value.startsWith("#")) {
        tokens.push({ type: "TAG", value: value.slice(1), position: start });
      } else if (value.startsWith("pack:")) {
        tokens.push({ type: "PACK", value: value.slice(5), position: start });
      } else {
        // A quoted bare id gets the scheme like the unquoted form; anything
        // else is treated as a URI by default (and fails in parseUri later).
        tokens.push({ type: "URI", value: bareIdToUri(value) ?? value, position: start });
      }
      continue;
    }

    // Bare node id: nodes/<id> or sources/<id> — the same URI atom as if the
    // user had typed `contextnest://nodes/<id>`, so `ctx query "nodes/gtm/foo"`
    // selects one node without the scheme. Terminates exactly like the URI
    // branch above (whitespace, `+`, `|`, parens; `-` stays inside the id).
    if (BARE_ID_PREFIX.test(input.slice(pos))) {
      const idStart = pos;
      while (pos < input.length && !/[\s+|()]/.test(input[pos])) pos++;
      tokens.push({
        type: "URI",
        value: bareIdToUri(input.slice(idStart, pos))!,
        position: idStart,
      });
      continue;
    }

    // Keyword atoms: type:X, status:X, transport:X, server:X, pack:X
    const wordMatch = input.slice(pos).match(/^([a-zA-Z_][a-zA-Z0-9_]*)/);
    if (wordMatch) {
      const word = wordMatch[1];
      const afterWord = pos + word.length;

      if (afterWord < input.length && input[afterWord] === ":") {
        // It's a filter: type:X, status:X, etc.
        pos = afterWord + 1;
        const valueStart = pos;
        while (pos < input.length && /[a-zA-Z0-9_-]/.test(input[pos])) pos++;
        const filterValue = input.slice(valueStart, pos);

        switch (word) {
          case "type":
            tokens.push({ type: "TYPE_FILTER", value: filterValue, position: start });
            break;
          case "status":
            tokens.push({ type: "STATUS_FILTER", value: filterValue, position: start });
            break;
          case "transport":
            tokens.push({ type: "TRANSPORT_FILTER", value: filterValue, position: start });
            break;
          case "server":
            tokens.push({ type: "SERVER_FILTER", value: filterValue, position: start });
            break;
          case "pack":
            // Pack values can include dots
            const packStart = pos - filterValue.length;
            pos = packStart;
            while (pos < input.length && /[a-zA-Z0-9_.-]/.test(input[pos])) pos++;
            tokens.push({
              type: "PACK",
              value: input.slice(packStart, pos),
              position: start,
            });
            break;
          case "tag":
            // `tag:#X` is the spec-documented alias for the bare `#X` form.
            // The standard filterValue read stops at `#`, so rewind and re-read,
            // consuming an optional leading `#`.
            const tagRewindStart = pos - filterValue.length;
            pos = tagRewindStart;
            if (input[pos] === "#") pos++;
            const tagValueStart = pos;
            while (pos < input.length && /[a-zA-Z0-9_-]/.test(input[pos])) pos++;
            if (pos === tagValueStart) {
              throw new InvalidSelectorError(
                `Invalid tag filter at position ${start}: expected tag name after "tag:"`,
              );
            }
            tokens.push({
              type: "TAG",
              value: input.slice(tagValueStart, pos),
              position: start,
            });
            break;
          default:
            throw new InvalidSelectorError(
              `Unknown filter "${word}" at position ${start} — valid filters: ${SELECTOR_FILTERS.join(", ")}`,
            );
        }
        continue;
      }

      // Just a word — error. Report the whole run up to the next delimiter
      // (`gtm/foo`, `api-design`), not only the leading identifier, so the
      // hint below is something the user can paste back.
      let wordEnd = pos;
      while (wordEnd < input.length && !/[\s+|()]/.test(input[wordEnd])) wordEnd++;
      const bare = input.slice(pos, wordEnd);
      // `Nodes/foo` is a mis-cased prefix, not a tag: suggest `nodes/foo`,
      // never `nodes/Nodes/foo`.
      const miscased = /^(nodes|sources)\//i.test(bare) && !BARE_ID_PREFIX.test(bare);
      const hint = miscased
        ? `"${bare.replace(/^(nodes|sources)\//i, (m) => m.toLowerCase())}" (a node id)`
        : `"nodes/${bare}" (a node id) or "#${bare}" (a tag)`;
      throw new InvalidSelectorError(
        `Unexpected token "${bare}" at position ${start} — did you mean ${hint}?`,
      );
    }

    throw new InvalidSelectorError(`Unexpected character "${ch}" at position ${pos}`);
  }

  tokens.push({ type: "EOF", value: "", position: pos });
  return tokens;
}
