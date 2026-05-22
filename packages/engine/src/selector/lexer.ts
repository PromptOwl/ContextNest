/**
 * Selector grammar lexer (§2).
 * Tokenizes selector strings into atoms and operators.
 */

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
        throw new Error(`Invalid tag at position ${start}: expected tag name after #`);
      }
      tokens.push({ type: "TAG", value: tagValue, position: start });
      continue;
    }

    // URI: contextnest://...
    if (input.slice(pos).startsWith("contextnest://")) {
      const uriStart = pos;
      pos += "contextnest://".length;
      // Read until whitespace or operator or paren
      while (pos < input.length && !/[\s+|\-()]/.test(input[pos])) pos++;
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
        // Treat as URI by default
        tokens.push({ type: "URI", value, position: start });
      }
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
              throw new Error(`Invalid tag filter at position ${start}: expected tag name after "tag:"`);
            }
            tokens.push({
              type: "TAG",
              value: input.slice(tagValueStart, pos),
              position: start,
            });
            break;
          default:
            throw new Error(`Unknown filter type "${word}" at position ${start}`);
        }
        continue;
      }

      // Just a word — error
      throw new Error(`Unexpected token "${word}" at position ${start}`);
    }

    throw new Error(`Unexpected character "${ch}" at position ${pos}`);
  }

  tokens.push({ type: "EOF", value: "", position: pos });
  return tokens;
}
