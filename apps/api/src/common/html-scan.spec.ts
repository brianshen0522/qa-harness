import { elements, openTags, removeElement, replaceTags } from "./html-scan";
import { htmlToText } from "../discussion/url-fetch.service";
import { extractPageStructure } from "../generation/discovery.service";

describe("html-scan", () => {
  it("removes closed blocks in any case and leaves an unclosed one", () => {
    expect(removeElement("a<SCRIPT x>1</script>b<script>2</ScRiPt>c", "script")).toBe("a b c");
    expect(removeElement("a<script>1", "script")).toBe("a<script>1");
  });

  it("replaces tags like the regex it stands in for", () => {
    for (const html of ["<p>a</p>", "a<b", "a<>b", "<<a>b>", "x > y", "<a href='1'>t</a>"]) {
      expect(replaceTags(html)).toBe(html.replace(/<[^>]+>/g, " "));
    }
  });

  it("finds elements and open tags by name, not by prefix", () => {
    const html = `<article>x</article><a href="1">one</a><A HREF="2">two</A>`;
    expect([...elements(html, "a")].map((e) => e.inner)).toEqual(["one", "two"]);
    expect([...openTags("<inputs><input name=a>", "input")].map((t) => t.attrs)).toEqual([" name=a"]);
  });
});

describe("page parsing on hostile input", () => {
  const big = 2_000_000;
  const hostile = ["<".repeat(big), "<script".repeat(big / 7), "<a ".repeat(big / 3), "<a href='x' ".repeat(big / 12), "<form ".repeat(big / 6), "<input ".repeat(big / 7), "<h1".repeat(big / 3)];

  it.each(hostile.map((html) => [html.slice(0, 12), html]))("stays linear on %s", (_name, html) => {
    const started = Date.now();
    htmlToText(html);
    extractPageStructure(html, "http://x.test/");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("still reads a normal page", () => {
    const html = `<title>T &amp; U</title><style>p{}</style><h2>Two</h2><h1>One</h1>
      <a href="/a">A</a><a>none</a>
      <form action="/l" method="post"><input name="u" required><select id="s"></select><input type="hidden" name="h"><textarea name="t"></textarea></form>`;
    expect(htmlToText(html).title).toBe("T & U");
    const page = extractPageStructure(html, "http://x.test/");
    expect(page.headings).toEqual(["Two", "One"]);
    expect(page.links).toEqual([{ href: "http://x.test/a", text: "A" }]);
    expect(page.forms).toEqual([{
      action: "/l", method: "POST",
      fields: [{ name: "u", type: "text", required: true }, { name: "s", type: "select", required: false }, { name: "t", type: "textarea", required: false }],
    }]);
  });
});
