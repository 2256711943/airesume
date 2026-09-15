import { computed, ref } from "vue";
import { describe, expect, it } from "vitest";

import { useStreamingMarkdown } from "./useStreamingMarkdown";

function createClock(start = 0) {
  let current = start;

  return {
    now: () => current,
    advance: (milliseconds: number) => {
      current += milliseconds;
    },
  };
}

describe("useStreamingMarkdown", () => {
  it("derives safe and tail without writing back to the source", () => {
    const markdown = ref("intro **unfinished");
    const { rendered } = useStreamingMarkdown({
      markdown,
      streaming: true,
      minCharDelta: 0,
      minIntervalMs: 0,
    });

    expect(rendered.value.safe).toBe("intro ");
    expect(rendered.value.tail).toBe("**unfinished");
    expect(markdown.value).toBe("intro **unfinished");
  });

  it("keeps safe plus tail equal to the raw buffer while streaming", () => {
    const raw = "paragraph\n\n```ts\nconst x = 1;\n";
    const markdown = ref(raw);
    const { rendered } = useStreamingMarkdown({
      markdown,
      streaming: true,
      minCharDelta: 0,
      minIntervalMs: 0,
    });

    expect(rendered.value.safe + rendered.value.tail).toBe(raw);
    expect(rendered.value.diagnostics.fenceOpen).toBe(true);
  });

  it("reuses the last html while both thresholds are unmet, yet keeps the tail live", () => {
    const clock = createClock(1000);
    const markdown = ref("para\n");
    const { rendered } = useStreamingMarkdown({
      markdown,
      streaming: true,
      now: clock.now,
      minCharDelta: 24,
      minIntervalMs: 48,
    });

    const firstHtml = rendered.value.html;

    markdown.value = "para\nmore";
    expect(rendered.value.html).toBe(firstHtml);
    expect(rendered.value.safe).toBe("para\n");
    expect(rendered.value.tail).toBe("more");
    expect(rendered.value.safe + rendered.value.tail).toBe("para\nmore");
  });

  it("re-renders once the character delta crosses the threshold", () => {
    const clock = createClock(1000);
    const markdown = ref("para\n");
    const { rendered } = useStreamingMarkdown({
      markdown,
      streaming: true,
      now: clock.now,
      minCharDelta: 24,
      minIntervalMs: 48,
    });

    const firstHtml = rendered.value.html;

    markdown.value = "para\nmore and much more content";
    expect(rendered.value.html).not.toBe(firstHtml);
    expect(rendered.value.html).toContain("much more content");
    expect(rendered.value.tail).toBe("");
  });

  it("re-renders once the time threshold elapses", () => {
    const clock = createClock(0);
    const markdown = ref("a\n");
    const { rendered } = useStreamingMarkdown({
      markdown,
      streaming: true,
      now: clock.now,
      minCharDelta: 100,
      minIntervalMs: 50,
    });

    const firstHtml = rendered.value.html;

    markdown.value = "a\nb";
    expect(rendered.value.html).toBe(firstHtml);
    expect(rendered.value.tail).toBe("b");

    clock.advance(50);
    markdown.value = "a\nbc";
    expect(rendered.value.html).not.toBe(firstHtml);
    expect(rendered.value.tail).toBe("");
  });

  it("accumulates throttled appends until a threshold opens", () => {
    const clock = createClock(0);
    const markdown = ref("");
    const { rendered } = useStreamingMarkdown({
      markdown,
      streaming: true,
      now: clock.now,
      minCharDelta: 10,
      minIntervalMs: 1000,
    });

    const firstHtml = rendered.value.html;

    markdown.value = "abc";
    expect(rendered.value.html).toBe(firstHtml);
    expect(rendered.value.tail).toBe("abc");

    markdown.value = "abcdef";
    expect(rendered.value.html).toBe(firstHtml);
    expect(rendered.value.tail).toBe("abcdef");

    markdown.value = "abcdefghijk";
    expect(rendered.value.html).not.toBe(firstHtml);
    expect(rendered.value.safe).toBe("abcdefghijk");
    expect(rendered.value.tail).toBe("");
  });

  it("rebuilds when the new markdown is not a prefix extension", () => {
    const markdown = ref("# First\n");
    const { rendered } = useStreamingMarkdown({
      markdown,
      streaming: true,
      now: () => 0,
      minCharDelta: 1000,
      minIntervalMs: 1000,
    });

    expect(rendered.value.html).toContain("First");

    markdown.value = "# Second\n";
    expect(rendered.value.html).toContain("Second");
    expect(rendered.value.html).not.toContain("First");
  });

  it("renders the full document and drops the tail once streaming ends", () => {
    const markdown = ref("answer **unfinished");
    const streaming = ref(true);
    const { rendered } = useStreamingMarkdown({
      markdown,
      streaming,
      minCharDelta: 0,
      minIntervalMs: 0,
    });

    expect(rendered.value.tail).toBe("**unfinished");

    streaming.value = false;
    expect(rendered.value.tail).toBe("");
    expect(rendered.value.safe).toBe("answer **unfinished");
    expect(rendered.value.html).toContain("**unfinished");
  });

  it("treats a missing streaming flag as a finished message", () => {
    const markdown = ref("**done**\n");
    const { rendered } = useStreamingMarkdown({ markdown });

    expect(rendered.value.tail).toBe("");
    expect(rendered.value.html).toContain("<strong>");
  });

  it("finalizes a truncated fence when the stream ends incomplete", () => {
    const markdown = ref("结论如下\n\n```ts\nconst x = 1;\n");
    const { rendered } = useStreamingMarkdown({
      markdown,
      streaming: false,
      incomplete: true,
      minCharDelta: 0,
      minIntervalMs: 0,
    });

    expect(rendered.value.truncated).toBe(true);
    expect(rendered.value.tail).toBe("");
    expect(rendered.value.safe.endsWith("```\n")).toBe(true);
    expect(rendered.value.html).toContain("<code");
  });

  it("keeps the final render untouched when the incomplete flag finds no truncation", () => {
    const markdown = ref("恭喜完成。\n");
    const { rendered } = useStreamingMarkdown({
      markdown,
      streaming: false,
      incomplete: true,
      minCharDelta: 0,
      minIntervalMs: 0,
    });

    expect(rendered.value.truncated).toBe(false);
    expect(rendered.value.safe).toBe("恭喜完成。\n");
    expect(rendered.value.html).toContain("恭喜完成。");
  });

  it("rebuilds once the incomplete flag flips after the stream ended", () => {
    const clock = createClock(0);
    const raw = "步骤\n\n```ts\nconst x = 1;\n";
    const markdown = ref(raw);
    const incomplete = ref(false);
    const { rendered } = useStreamingMarkdown({
      markdown,
      streaming: false,
      incomplete,
      now: clock.now,
      minCharDelta: 1000,
      minIntervalMs: 1000,
    });

    expect(rendered.value.truncated).toBe(false);
    expect(rendered.value.safe).toBe(raw);

    incomplete.value = true;
    expect(rendered.value.truncated).toBe(true);
    expect(rendered.value.safe).not.toBe(raw);
    expect(rendered.value.safe.endsWith("```\n")).toBe(true);
  });

  it("accepts getter based sources", () => {
    const markdown = ref("stream `code");
    const streaming = ref(true);
    const { rendered } = useStreamingMarkdown({
      markdown: () => markdown.value,
      streaming: computed(() => streaming.value),
      minCharDelta: 0,
      minIntervalMs: 0,
    });

    expect(rendered.value.safe).toBe("stream ");
    expect(rendered.value.tail).toBe("`code");
  });
});
