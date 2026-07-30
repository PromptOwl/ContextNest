/**
 * Recursive descent parser for the selector grammar (§2).
 * Precedence (highest to lowest): () > AND (+) > NOT (-) > OR (|)
 *
 * Grammar:
 *   expr     → or_expr
 *   or_expr  → not_expr ("|" not_expr)*
 *   not_expr → and_expr ("-" and_expr)*
 *   and_expr → atom (("+" | implicit) atom)*
 *   atom     → TAG | URI | PACK | TYPE_FILTER | STATUS_FILTER |
 *              TRANSPORT_FILTER | SERVER_FILTER | "(" expr ")"
 */

import type { Token, TokenType } from "./lexer.js";
import { tokenize } from "./lexer.js";
import { InvalidSelectorError } from "../errors.js";

export type SelectorNode =
  | { type: "tag"; value: string }
  | { type: "uri"; value: string }
  | { type: "pack"; value: string }
  | { type: "typeFilter"; value: string }
  | { type: "statusFilter"; value: string }
  | { type: "transportFilter"; value: string }
  | { type: "serverFilter"; value: string }
  | { type: "and"; left: SelectorNode; right: SelectorNode }
  | { type: "or"; left: SelectorNode; right: SelectorNode }
  | { type: "not"; left: SelectorNode; right: SelectorNode };

const ATOM_TYPES: TokenType[] = [
  "TAG",
  "URI",
  "PACK",
  "TYPE_FILTER",
  "STATUS_FILTER",
  "TRANSPORT_FILTER",
  "SERVER_FILTER",
];

class SelectorParser {
  private tokens: Token[];
  private pos: number = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private advance(): Token {
    const token = this.tokens[this.pos];
    this.pos++;
    return token;
  }

  private expect(type: TokenType): Token {
    const token = this.peek();
    if (token.type !== type) {
      throw new InvalidSelectorError(
        `Expected ${type} but got ${token.type} ("${token.value}") at position ${token.position}`,
      );
    }
    return this.advance();
  }

  private isAtom(): boolean {
    return (
      ATOM_TYPES.includes(this.peek().type) || this.peek().type === "LPAREN"
    );
  }

  parse(): SelectorNode {
    const result = this.parseOrExpr();
    if (this.peek().type !== "EOF") {
      throw new InvalidSelectorError(
        `Unexpected token "${this.peek().value}" at position ${this.peek().position}`,
      );
    }
    return result;
  }

  // or_expr → not_expr ("|" not_expr)*
  private parseOrExpr(): SelectorNode {
    let left = this.parseNotExpr();
    while (this.peek().type === "OR") {
      this.advance();
      const right = this.parseNotExpr();
      left = { type: "or", left, right };
    }
    return left;
  }

  // not_expr → and_expr ("-" and_expr)*
  private parseNotExpr(): SelectorNode {
    let left = this.parseAndExpr();
    while (this.peek().type === "NOT") {
      this.advance();
      const right = this.parseAndExpr();
      left = { type: "not", left, right };
    }
    return left;
  }

  // and_expr → atom (("+" | implicit) atom)*
  private parseAndExpr(): SelectorNode {
    let left = this.parseAtom();
    while (true) {
      if (this.peek().type === "AND") {
        this.advance();
        const right = this.parseAtom();
        left = { type: "and", left, right };
      } else if (this.isAtom()) {
        // Implicit AND between adjacent atoms
        const right = this.parseAtom();
        left = { type: "and", left, right };
      } else {
        break;
      }
    }
    return left;
  }

  // atom → TAG | URI | PACK | TYPE_FILTER | STATUS_FILTER |
  //        TRANSPORT_FILTER | SERVER_FILTER | "(" expr ")"
  private parseAtom(): SelectorNode {
    const token = this.peek();

    switch (token.type) {
      case "TAG":
        this.advance();
        return { type: "tag", value: token.value };
      case "URI":
        this.advance();
        return { type: "uri", value: token.value };
      case "PACK":
        this.advance();
        return { type: "pack", value: token.value };
      case "TYPE_FILTER":
        this.advance();
        return { type: "typeFilter", value: token.value };
      case "STATUS_FILTER":
        this.advance();
        return { type: "statusFilter", value: token.value };
      case "TRANSPORT_FILTER":
        this.advance();
        return { type: "transportFilter", value: token.value };
      case "SERVER_FILTER":
        this.advance();
        return { type: "serverFilter", value: token.value };
      case "LPAREN": {
        this.advance();
        const expr = this.parseOrExpr();
        this.expect("RPAREN");
        return expr;
      }
      default:
        throw new InvalidSelectorError(
          `Unexpected token "${token.value}" at position ${token.position}`,
        );
    }
  }
}

/**
 * Parse a selector string into an AST.
 */
export function parseSelector(input: string): SelectorNode {
  const tokens = tokenize(input);
  const parser = new SelectorParser(tokens);
  return parser.parse();
}
