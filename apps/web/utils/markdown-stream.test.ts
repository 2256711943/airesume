import { describe, expect, it } from "vitest";

import {
  BlockFsm,
  LineAssembler,
  MarkdownStreamFsm,
  createMarkdownIt,
  finalizeTruncatedMarkdown,
  findInlineSafeOffset,
  getMarkdownIt,
  getStableMarkdownSlice,
} from "./markdown-stream";

describe("LineAssembler", () => {
  it("holds a CR at the chunk boundary until the next chunk confirms CRLF", () => {
    const assembler = new LineAssembler();

    expect(assembler.push("alpha\r")).toEqual([]);
    expect(assembler.push("\nbeta\n")).toEqual(["alpha\r\n", "beta\n"]);
    expect(assembler.flushPending()).toBeNull();
  });

  it("does not lose a line when a chunk starts after a newline", () => {
    const assembler = new LineAssembler();

    expect(assembler.push("alpha\n")).toEqual(["alpha\n"]);
    expect(assembler.push("\nbeta")).toEqual(["\n"]);
    expect(assembler.flushPending()).toBe("beta");
  });

  it("emits multiple lines and handles empty chunks", () => {
    const assembler = new LineAssembler();

    expect(assembler.push("")).toEqual([]);
    expect(assembler.push("\n\nalpha\rbravo")).toEqual(["\n", "\n", "alpha\r"]);
    expect(assembler.flushPending()).toBe("bravo");
  });

  it("flushes an unterminated residual line", () => {
    const assembler = new LineAssembler();

    assembler.push("残行");
    expect(assembler.flushPending()).toBe("残行");
    expect(assembler.flushPending()).toBeNull();
  });
});

describe("block FSM", () => {
  it("holds an open fenced block and releases it only on the same marker", () => {
    const raw = "before\n```ts\n**not bold**\n";
    const slice = getStableMarkdownSlice(raw);

    expect(slice.safe).toBe("before\n");
    expect(slice.tail).toBe("```ts\n**not bold**\n");
    expect(slice.diagnostics).toMatchObject({
      fenceOpen: true,
      inlineUnbalanced: false,
    });

    const closed = getStableMarkdownSlice(`${raw}\`\`\`\n`);
    expect(closed.safe).toBe(`${raw}\`\`\`\n`);
    expect(closed.tail).toBe("");
  });

  it("ignores inline markers inside fenced blocks", () => {
    const slice = getStableMarkdownSlice("```\n**not bold**\n");

    expect(slice.diagnostics.inlineUnbalanced).toBe(false);
    expect(slice.tail).toBe("```\n**not bold**\n");
  });

  it("does not close a fence with a different marker", () => {
    const slice = getStableMarkdownSlice("```\ncode\n~~~\n");

    expect(slice.diagnostics.fenceOpen).toBe(true);
    expect(slice.tail).toBe("```\ncode\n~~~\n");
  });

  it("does not treat a fence with an info string as a closing fence", () => {
    const slice = getStableMarkdownSlice("```\ncode\n``` js\n");

    expect(slice.diagnostics.fenceOpen).toBe(true);
  });

  it("holds a table candidate until the delimiter row arrives", () => {
    const pending = getStableMarkdownSlice("| A | B |\n");
    expect(pending.safe).toBe("");
    expect(pending.tail).toBe("| A | B |\n");
    expect(pending.diagnostics.tablePending).toBe(true);

    const complete = getStableMarkdownSlice(
      "| A | B |\n| --- | --- |\n| 1 | 2 |\n",
    );
    expect(complete.safe).toBe("");
    expect(complete.tail).toBe("| A | B |\n| --- | --- |\n| 1 | 2 |\n");
    expect(complete.diagnostics.tablePending).toBe(true);

    const resolved = getStableMarkdownSlice(
      "| A | B |\n| --- | --- |\n| 1 | 2 |\n\nnext",
    );
    expect(resolved.safe).toBe("| A | B |\n| --- | --- |\n| 1 | 2 |\n\nnext");
    expect(resolved.tail).toBe("");
  });

  it("falls back from a false table candidate on the next non-table line", () => {
    const slice = getStableMarkdownSlice("| ordinary text |\nnext\n");

    expect(slice.safe).toBe("| ordinary text |\nnext\n");
    expect(slice.tail).toBe("");
    expect(slice.diagnostics.tablePending).toBe(false);
  });

  it("holds indented code only when it follows a blank line", () => {
    const slice = getStableMarkdownSlice("paragraph\n\n    code\n");

    expect(slice.safe).toBe("paragraph\n\n");
    expect(slice.tail).toBe("    code\n");
  });

  it("rebuilds a setext heading instead of keeping the old paragraph boundary", () => {
    const slice = getStableMarkdownSlice("Title\n---\n");

    expect(slice.safe).toBe("Title\n---\n");
    expect(slice.tail).toBe("");
  });

  it("invalidates the safe prefix for link reference definitions", () => {
    const slice = getStableMarkdownSlice("[x]\n\n[x]: https://example.com\n");

    expect(slice.safe).toBe("");
    expect(slice.tail).toBe("[x]\n\n[x]: https://example.com\n");
  });

  it("recognizes fences inside blockquotes and lists", () => {
    const slice = getStableMarkdownSlice("> ```\n> **not bold**\n");

    expect(slice.diagnostics.fenceOpen).toBe(true);
    expect(slice.diagnostics.inlineUnbalanced).toBe(false);

    const listed = getStableMarkdownSlice("- ```\n- **not bold**\n");
    expect(listed.diagnostics.fenceOpen).toBe(true);
  });
});

describe("inline balancer", () => {
  it("holds an unclosed code span at its opening backtick", () => {
    const text = "before `code";
    expect(findInlineSafeOffset(text)).toBe("before ".length);
  });

  it("matches code spans by equal backtick run length", () => {
    expect(findInlineSafeOffset("`code` tail")).toBe("`code` tail".length);
    expect(findInlineSafeOffset("`code`` tail")).toBe(0);
    expect(findInlineSafeOffset("``code`")).toBe(0);
  });

  it("holds unmatched strong and strike markers", () => {
    expect(findInlineSafeOffset("before **bold")).toBe("before ".length);
    expect(findInlineSafeOffset("before ~~deleted")).toBe("before ".length);
  });

  it("skips escaped markers", () => {
    expect(findInlineSafeOffset(String.raw`before \** text`)).toBe(
      String.raw`before \** text`.length,
    );
  });

  it("does not infer single-character emphasis", () => {
    expect(findInlineSafeOffset("* ordinary text")).toBe(
      "* ordinary text".length,
    );
    expect(findInlineSafeOffset("_ ordinary text")).toBe(
      "_ ordinary text".length,
    );
  });

  it("holds an incomplete link at its opening bracket", () => {
    expect(findInlineSafeOffset("[文字](http")).toBe(0);
    expect(findInlineSafeOffset("[文字](https://example.com)")).toBe(
      "[文字](https://example.com)".length,
    );
  });

  it("scans the final complete line before committing it to safe", () => {
    const slice = getStableMarkdownSlice("answer **unfinished\n");

    expect(slice.safe).toBe("answer ");
    expect(slice.tail).toBe("**unfinished\n");
    expect(slice.diagnostics.inlineUnbalanced).toBe(true);
  });
});

describe("truncated markdown finalization", () => {
  it("closes an unclosed top-level fence and reports truncation", () => {
    const result = finalizeTruncatedMarkdown("answer\n```\ncode");

    expect(result.truncated).toBe(true);
    expect(result.text).toBe("answer\n```\ncode\n```\n");
    expect(result.reasons).toContain("unclosed-fence");
  });

  it("drops a pending table tail", () => {
    const result = finalizeTruncatedMarkdown("answer\n\n| A | B |\n");

    expect(result).toMatchObject({
      text: "answer\n\n",
      truncated: true,
    });
    expect(result.reasons).toContain("incomplete-table");
  });

  it("treats an unterminated fence or table row as a terminal line", () => {
    const fence = finalizeTruncatedMarkdown("answer\n```code");
    expect(fence.reasons).toContain("unclosed-fence");
    expect(fence.text).toBe("answer\n```code\n```\n");

    const table = finalizeTruncatedMarkdown("| A | B |");
    expect(table).toMatchObject({
      text: "",
      truncated: true,
    });
    expect(table.reasons).toContain("incomplete-table");
  });

  it("drops an incomplete inline tail", () => {
    const result = finalizeTruncatedMarkdown("answer **unfinished");

    expect(result).toEqual({
      text: "answer ",
      truncated: true,
      reasons: ["unbalanced-inline"],
    });
  });

  it("does not modify a complete markdown document", () => {
    expect(finalizeTruncatedMarkdown("# Done\n\n**ok**\n")).toEqual({
      text: "# Done\n\n**ok**\n",
      truncated: false,
      reasons: [],
    });
  });
});

describe("streaming markdown invariants", () => {
  it("keeps safe plus tail equal to the original buffer", () => {
    const samples = [
      "plain text",
      "before\n```ts\nconst x = 1;\n",
      "| A | B |\n| --- | --- |\n| 1 | 2 |\n",
      "A **bold** and [link](https://example.com)",
    ];

    for (const sample of samples) {
      const slice = getStableMarkdownSlice(sample);
      expect(slice.safe + slice.tail).toBe(sample);
    }
  });

  it("is idempotent across arbitrary chunk splits", () => {
    const samples = [
      "before\n```ts\nconst value = `x`;\n```\nafter **done**",
      "| A | B |\n| --- | --- |\n| 1 | 2 |\n\nnext",
      "paragraph\n\n    code\n\nfinal",
      "[x]\n\n[x]: https://example.com\n",
    ];

    for (const sample of samples) {
      const expected = getStableMarkdownSlice(sample);

      for (let split = 0; split <= sample.length; split += 1) {
        const stream = new MarkdownStreamFsm();
        stream.push(sample.slice(0, split));
        stream.push(sample.slice(split));

        expect(stream.slice).toEqual(expected);
      }
    }
  });

  it("is idempotent across deterministic multi-chunk splits", () => {
    const sample =
      "intro\n```ts\nconst value = `stream`;\n```\n| A | B |\n| --- | --- |\n| 1 | 2 |\n";
    const expected = getStableMarkdownSlice(sample);
    const stream = new MarkdownStreamFsm();
    let seed = 17;
    let offset = 0;

    while (offset < sample.length) {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      const size = 1 + (seed % 7);
      stream.push(sample.slice(offset, offset + size));
      offset += size;
    }

    expect(stream.slice).toEqual(expected);
    expect(stream.raw).toBe(sample);
  });

  it("keeps block safe offsets monotonic without known backtracking constructs", () => {
    const fsm = new BlockFsm();
    let previous = 0;

    for (const line of ["one\n", "two\n", "three\n", "\n", "four\n"]) {
      fsm.advance(line);
      expect(fsm.blockSafeOffset).toBeGreaterThanOrEqual(previous);
      previous = fsm.blockSafeOffset;
    }
  });

  it("shares one configured MarkdownIt renderer", () => {
    expect(getMarkdownIt()).toBe(getMarkdownIt());
    expect(createMarkdownIt().render("a\nb")).toContain("<br>");
    expect(createMarkdownIt().render("<em>unsafe</em>")).not.toContain("<em>");
  });
});
