import { extractUrls, htmlToText } from "./url-fetch.service";

describe("extractUrls", () => {
  it("finds http(s) URLs, dedupes, strips trailing punctuation and caps at 5", () => {
    expect(extractUrls("see https://a.test/x and http://b.test/y.")).toEqual(["https://a.test/x", "http://b.test/y"]);
    expect(extractUrls("https://a.test https://a.test")).toEqual(["https://a.test"]);
    expect(extractUrls([1, 2, 3, 4, 5, 6].map((n) => `https://s${n}.test`).join(" "))).toHaveLength(5);
  });

  it("ignores text without URLs and non-http schemes", () => {
    expect(extractUrls("沒有連結")).toEqual([]);
    expect(extractUrls("ftp://x.test/f")).toEqual([]);
  });

  it("stops at full-width CJK punctuation (the common case in Chinese prose)", () => {
    expect(extractUrls("API 在 http://localhost:8080，文件在 http://localhost:8080/openapi.json。")).toEqual([
      "http://localhost:8080",
      "http://localhost:8080/openapi.json",
    ]);
    expect(extractUrls("前端是 https://app.test/路徑（測試用）")).toEqual(["https://app.test/路徑"]);
    expect(extractUrls("見「https://a.test/x」與 https://b.test/y、https://c.test/z；謝謝")).toEqual([
      "https://a.test/x", "https://b.test/y", "https://c.test/z",
    ]);
  });

  it("drops fragments that are not valid URLs", () => {
    expect(extractUrls("http:// 沒有主機")).toEqual([]);
  });

  it("does not swallow a trailing bracket or quote", () => {
    expect(extractUrls('(https://a.test/x) "https://b.test"')).toEqual(["https://a.test/x", "https://b.test"]);
  });
});

describe("htmlToText", () => {
  it("extracts the title, drops script/style, and decodes entities", () => {
    const { title, text } = htmlToText(
      "<html><head><title>My &amp; Page</title><style>a{color:red}</style></head>" +
        "<body><script>var x=1</script><h1>Hello</h1><p>World &lt;3</p></body></html>",
    );
    expect(title).toBe("My & Page");
    expect(text).toContain("Hello");
    expect(text).toContain("World <3");
    expect(text).not.toContain("color:red");
    expect(text).not.toContain("var x");
  });

  it("turns block ends into newlines and collapses runs of blank lines", () => {
    const { text } = htmlToText("<p>a</p><p>b</p><br><div>c</div>");
    expect(text.split("\n").filter(Boolean).map((s) => s.trim())).toEqual(["a", "b", "c"]);
  });

  it("survives a document with no title", () => {
    expect(htmlToText("<p>x</p>").title).toBeNull();
  });
});
