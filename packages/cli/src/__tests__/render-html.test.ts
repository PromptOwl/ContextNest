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
    // The `| --- | --- |` delimiter row is syntax, not a data row.
    expect(html).not.toContain("<td>---</td>");
    expect(renderDocumentHtml(node("| a | b |\n|:--|--:|\n| 1 | 2 |\n"))).not.toContain(":--");
  });

  it("refuses javascript:/data: schemes in links and wikilinks (page auto-opens in a browser)", () => {
    const html = renderDocumentHtml(
      node(
        "[ok](https://a.b/c) [mail](mailto:x@y.z) [anchor](#p_1_1) [bad](javascript:alert(1)) [worse](data:text/html,x) " +
          "[[javascript:alert(2)|wiki]] [[//evil.example/x]] [[nodes/fine|fine]]\n",
      ),
    );
    expect(html).toContain('<a href="https://a.b/c">ok</a>');
    expect(html).toContain('<a href="mailto:x@y.z">mail</a>');
    expect(html).toContain('<a href="#p_1_1">anchor</a>');
    expect(html).toContain('<a class="wikilink" href="nodes/fine">fine</a>');
    expect(html).not.toContain("javascript:alert(1)\"");
    expect(html).not.toContain('href="data:');
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain('href="//evil');
    expect(html).toContain("bad (javascript:alert(1))");
    expect(html).toContain("wiki");
  });

  it("refuses a scheme hidden behind a control character (browsers strip leading C0)", () => {
    // `&#1;javascript:` in JATS decodes to U+0001, which the scheme check
    // would otherwise read as a relative path.
    const html = renderDocumentHtml(node("[x](\u0001javascript:location=name) [[\u0001javascript:location=name]]\n"));
    expect(html).not.toMatch(/href="[^"]*javascript:/);
  });

  it("keeps relative and contextnest:// links clickable (pre-existing vault content)", () => {
    const html = renderDocumentHtml(node("[appendix](appendix.md) [spec](contextnest://nodes/spec) [up](../notes/x.md)\n"));
    expect(html).toContain('<a href="appendix.md">appendix</a>');
    expect(html).toContain('<a href="contextnest://nodes/spec">spec</a>');
    expect(html).toContain('<a href="../notes/x.md">up</a>');
  });

  it("leaves inline code alone — no sup/sub/wikilink/emphasis rewriting inside backticks", () => {
    const html = renderDocumentHtml(node("mutation `rpoB^S531L^` and `[[not-a-link]]` and `*raw*` but 10^9^ outside\n"));
    expect(html).toContain("<code>rpoB^S531L^</code>");
    expect(html).toContain("<code>[[not-a-link]]</code>");
    expect(html).toContain("<code>*raw*</code>");
    expect(html).toContain("10<sup>9</sup> outside");
  });

  it("leaves LaTeX untouched for a downstream math renderer", () => {
    const html = renderDocumentHtml(node("rate $p = \\frac{k}{n}$ ^p_2_1\n\n$$\\hat{p} = 1$$\n"));
    expect(html).toContain("rate $p = \\frac{k}{n}$");
    expect(html).toContain("<p>$$\\hat{p} = 1$$</p>");
  });
});
