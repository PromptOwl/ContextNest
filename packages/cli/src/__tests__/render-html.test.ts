import { describe, it, expect } from "vitest";
import { renderDocumentHtml } from "../render-html.js";
import type { ContextNode } from "@promptowl/contextnest-engine";

// CU-wdqcq02c6w: the JATS importer writes wikilinks, trailing block anchors,
// pandoc sup/sub and escaped table pipes — none of which the hand-rolled
// renderer understood, so `ctx read --html` showed them as literal text.

function node(body: string): ContextNode {
  return {
    id: "nodes/papers/x",
    filePath: "/v/nodes/papers/x.md",
    frontmatter: { title: "X", type: "reference", status: "published" },
    body,
    rawContent: body,
  };
}

describe("render-html — importer constructs", () => {
  it("turns a trailing block id into a paragraph anchor", () => {
    const html = renderDocumentHtml(node("Cure rates are high. ^p_1_1\n"));
    expect(html).toContain('<p id="p_1_1">Cure rates are high. <a class="anchor" href="#p_1_1">¶</a></p>');
  });

  it("renders wikilinks as links, with and without a label", () => {
    const html = renderDocumentHtml(node("See [[nodes/papers/pmid-1]] and [[nodes/papers/pmid-2|Smith 2020]].\n"));
    expect(html).toContain('<a class="wikilink" href="nodes/papers/pmid-1">nodes/papers/pmid-1</a>');
    expect(html).toContain('<a class="wikilink" href="nodes/papers/pmid-2">Smith 2020</a>');
  });

  it("renders pandoc superscript and subscript", () => {
    const html = renderDocumentHtml(node("10^9^ CFU/g of H~2~O\n"));
    expect(html).toContain("10<sup>9</sup> CFU/g of H<sub>2</sub>O");
  });

  it("keeps an escaped pipe inside a table cell and formats inline markdown in cells", () => {
    const html = renderDocumentHtml(
      node("| Test | Threshold |\n| --- | --- |\n| Serum HIV \\| HBV | **Negative** |\n"),
    );
    expect(html).toContain("<td>Serum HIV | HBV</td>");
    const bs = renderDocumentHtml(node("| a | b |\n| --- | --- |\n| C:\\\\path \\| x | y |\n"));
    expect(bs).toContain("<td>C:\\path | x</td>");
    expect(html).toContain("<td><strong>Negative</strong></td>");
    expect(html).toContain("<th>Threshold</th>");
  });

  it("leaves LaTeX untouched for a downstream math renderer", () => {
    const html = renderDocumentHtml(node("rate $p = \\frac{k}{n}$ ^p_2_1\n\n$$\\hat{p} = 1$$\n"));
    expect(html).toContain("rate $p = \\frac{k}{n}$");
    expect(html).toContain("<p>$$\\hat{p} = 1$$</p>");
  });
});
