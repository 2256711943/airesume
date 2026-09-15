import MarkdownIt from "markdown-it";

interface MarkdownItInstance {
  render(markdown: string): string;
}

export interface StableMarkdownDiagnostics {
  fenceOpen: boolean;
  tablePending: boolean;
  inlineUnbalanced: boolean;
}

export interface StableMarkdownSlice {
  safe: string;
  tail: string;
  diagnostics: StableMarkdownDiagnostics;
}

export type BlockState =
  | { kind: "root" }
  | {
      kind: "fence";
      marker: "`" | "~";
      len: number;
      heldAtLine: number;
    }
  | { kind: "table"; heldAtLine: number; confirmed?: boolean }
  | { kind: "indentedCode"; heldAtLine: number };

interface ParsedLine {
  start: number;
  end: number;
  text: string;
  content: string;
  body: string;
}

interface BlockAnalysis {
  blockSafeOffset: number;
  state: BlockState;
  tablePending: boolean;
}

const MARKDOWN_IT_OPTIONS = {
  breaks: true,
  linkify: true,
  html: false,
} as const;

let sharedMarkdownIt: MarkdownItInstance | undefined;

/**
 * Creates the renderer used by all Markdown consumers.
 *
 * Keeping the options here makes the streaming scanner's assumptions explicit
 * and gives later UI layers one renderer factory to reuse.
 */
export function createMarkdownIt(): MarkdownItInstance {
  return new MarkdownIt(MARKDOWN_IT_OPTIONS);
}

export function getMarkdownIt(): MarkdownItInstance {
  sharedMarkdownIt ??= createMarkdownIt();
  return sharedMarkdownIt;
}

export function renderMarkdown(markdown: string): string {
  return getMarkdownIt().render(markdown || "");
}

export class LineAssembler {
  private pendingLine = "";

  private pendingCarriageReturn = false;

  push(chunk: string): string[] {
    if (!chunk) {
      return [];
    }

    const lines: string[] = [];
    let index = 0;

    if (this.pendingCarriageReturn) {
      if (chunk[0] === "\n") {
        this.pendingLine += "\r\n";
        lines.push(this.pendingLine);
        this.pendingLine = "";
        this.pendingCarriageReturn = false;
        index = 1;
      } else {
        this.pendingLine += "\r";
        this.pendingCarriageReturn = false;
        lines.push(this.pendingLine);
        this.pendingLine = "";
      }
    }

    while (index < chunk.length) {
      const newlineIndex = findNextNewline(chunk, index);
      if (newlineIndex < 0) {
        this.pendingLine += chunk.slice(index);
        break;
      }

      this.pendingLine += chunk.slice(index, newlineIndex);
      const newline = chunk[newlineIndex];

      if (newline === "\r" && newlineIndex === chunk.length - 1) {
        this.pendingCarriageReturn = true;
        break;
      }

      if (newline === "\r" && chunk[newlineIndex + 1] === "\n") {
        this.pendingLine += "\r\n";
        lines.push(this.pendingLine);
        this.pendingLine = "";
        index = newlineIndex + 2;
        continue;
      }

      this.pendingLine += newline;
      lines.push(this.pendingLine);
      this.pendingLine = "";
      index = newlineIndex + 1;
    }

    return lines;
  }

  flushPending(): string | null {
    if (this.pendingCarriageReturn) {
      this.pendingLine += "\r";
      this.pendingCarriageReturn = false;
    }

    if (!this.pendingLine) {
      return null;
    }

    const line = this.pendingLine;
    this.pendingLine = "";
    return line;
  }

  reset(): void {
    this.pendingLine = "";
    this.pendingCarriageReturn = false;
  }
}

export class BlockFsm {
  private buffer = "";

  private analysis: BlockAnalysis = {
    blockSafeOffset: 0,
    state: { kind: "root" },
    tablePending: false,
  };

  advance(completeLine: string): void {
    this.buffer += completeLine;
    this.analysis = analyzeBlocks(this.buffer);
  }

  rebuild(buffer: string): void {
    this.buffer = buffer;
    this.analysis = analyzeBlocks(buffer);
  }

  get blockSafeOffset(): number {
    return this.analysis.blockSafeOffset;
  }

  get state(): BlockState {
    return this.analysis.state;
  }

  get tablePending(): boolean {
    return this.analysis.tablePending;
  }

  get raw(): string {
    return this.buffer;
  }
}

/**
 * A small stateful adapter for consumers that receive arbitrary SSE chunks.
 * The pure helpers below remain the preferred API for unit tests and rebuilds.
 */
export class MarkdownStreamFsm {
  private readonly assembler = new LineAssembler();

  private readonly blockFsm = new BlockFsm();

  private buffer = "";

  push(chunk: string): string[] {
    this.buffer += chunk;
    const completeLines = this.assembler.push(chunk);
    for (const line of completeLines) {
      this.blockFsm.advance(line);
    }
    return completeLines;
  }

  advance(completeLine: string): void {
    this.buffer += completeLine;
    this.blockFsm.advance(completeLine);
  }

  flushPending(): string | null {
    const line = this.assembler.flushPending();
    if (line) {
      this.blockFsm.advance(line);
    }
    return line;
  }

  rebuild(buffer: string): void {
    this.buffer = buffer;
    this.assembler.reset();
    const completeLines = this.assembler.push(buffer);
    this.blockFsm.rebuild(completeLines.join(""));
  }

  get raw(): string {
    return this.buffer;
  }

  get slice(): StableMarkdownSlice {
    return getStableMarkdownSlice(this.buffer);
  }
}

export function findInlineSafeOffset(text: string): number {
  const unmatchedStarts: number[] = [];
  const pairedMarkers = new Map<string, number>();
  const bracketStack: number[] = [];
  let activeLink:
    | {
        start: number;
        depth: number;
      }
    | undefined;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (character === "\\") {
      index += 1;
      continue;
    }

    if (activeLink) {
      if (character === "(") {
        activeLink.depth += 1;
      } else if (character === ")") {
        activeLink.depth -= 1;
        if (activeLink.depth === 0) {
          activeLink = undefined;
        }
      }
      continue;
    }

    if (character === "[") {
      bracketStack.push(index);
      continue;
    }

    if (character === "]") {
      const bracketStart = bracketStack.pop();
      if (
        bracketStart !== undefined &&
        text[index + 1] === "(" &&
        !isEscaped(text, index + 1)
      ) {
        activeLink = {
          start: bracketStart,
          depth: 1,
        };
        index += 1;
      }
      continue;
    }

    if (character === "`") {
      const runLength = readRunLength(text, index, "`");
      const closeIndex = findClosingRun(
        text,
        index + runLength,
        "`",
        runLength,
      );
      if (closeIndex < 0) {
        unmatchedStarts.push(index);
        break;
      }
      index = closeIndex + runLength - 1;
      continue;
    }

    if (character === "~" && text[index + 1] === "~") {
      const marker = "~~";
      if (pairedMarkers.has(marker)) {
        pairedMarkers.delete(marker);
      } else {
        pairedMarkers.set(marker, index);
      }
      index += 1;
      continue;
    }

    if (
      (character === "*" || character === "_") &&
      text[index + 1] === character
    ) {
      const marker = character + character;
      if (pairedMarkers.has(marker)) {
        pairedMarkers.delete(marker);
      } else {
        pairedMarkers.set(marker, index);
      }
      index += 1;
    }
  }

  for (const start of pairedMarkers.values()) {
    unmatchedStarts.push(start);
  }
  for (const start of bracketStack) {
    unmatchedStarts.push(start);
  }
  if (activeLink) {
    unmatchedStarts.push(activeLink.start);
  }

  if (unmatchedStarts.length === 0) {
    return text.length;
  }

  return Math.min(...unmatchedStarts);
}

export function getStableMarkdownSlice(raw: string): StableMarkdownSlice {
  const blockFsm = new BlockFsm();
  blockFsm.rebuild(raw);

  const blockSafeOffset = blockFsm.blockSafeOffset;
  const blockTail = raw.slice(blockSafeOffset);
  const linkReferenceBacktrack = hasLinkReferenceDefinition(
    parseCompleteLines(raw),
  );
  const inlineSafeOffset =
    blockFsm.state.kind === "root" && !linkReferenceBacktrack
      ? findInlineSafeOffset(blockTail)
      : 0;
  const safeEnd = blockSafeOffset + inlineSafeOffset;

  return {
    safe: raw.slice(0, safeEnd),
    tail: raw.slice(safeEnd),
    diagnostics: {
      fenceOpen: blockFsm.state.kind === "fence",
      tablePending: blockFsm.tablePending,
      inlineUnbalanced:
        blockFsm.state.kind === "root" &&
        !linkReferenceBacktrack &&
        inlineSafeOffset < blockTail.length,
    },
  };
}

export const createStableMarkdownSlice = getStableMarkdownSlice;
export const splitStableMarkdown = getStableMarkdownSlice;

export interface TruncatedMarkdownResult {
  text: string;
  truncated: boolean;
  reasons: string[];
}

export function finalizeTruncatedMarkdown(
  raw: string,
): TruncatedMarkdownResult {
  const terminalRaw = ensureTerminalLine(raw);
  const slice = getStableMarkdownSlice(terminalRaw);
  const reasons: string[] = [];
  let text = raw;

  if (slice.diagnostics.fenceOpen) {
    const blockFsm = new BlockFsm();
    blockFsm.rebuild(terminalRaw);
    const state = blockFsm.state;
    if (state.kind === "fence") {
      const newline = text.endsWith("\n") || text.endsWith("\r") ? "" : "\n";
      text += `${newline}${state.marker.repeat(state.len)}\n`;
      reasons.push("unclosed-fence");
    }
  }

  if (slice.diagnostics.tablePending) {
    const blockFsm = new BlockFsm();
    blockFsm.rebuild(terminalRaw);
    text = raw.slice(0, blockFsm.blockSafeOffset);
    reasons.push("incomplete-table");
  } else if (slice.diagnostics.inlineUnbalanced) {
    text = slice.safe;
    reasons.push("unbalanced-inline");
  }

  if (
    getStableMarkdownSlice(ensureTerminalLine(text)).diagnostics.fenceOpen &&
    !reasons.includes("unclosed-fence")
  ) {
    reasons.push("unclosed-fence");
  }

  if (reasons.length === 0) {
    return {
      text,
      truncated: false,
      reasons,
    };
  }

  return {
    text,
    truncated: true,
    reasons,
  };
}

function analyzeBlocks(buffer: string): BlockAnalysis {
  const lines = parseCompleteLines(buffer);
  let blockSafeOffset = 0;
  let state: BlockState = { kind: "root" };
  let tablePending = false;
  let previousLine: ParsedLine | undefined;
  let previousBody = "";
  let lastLineStable = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) {
      continue;
    }
    const body = line.body;
    const isBlank = isBlankLine(body);

    if (state.kind === "fence") {
      if (isFenceClose(body, state.marker, state.len)) {
        state = { kind: "root" };
        blockSafeOffset = line.end;
        lastLineStable = true;
      } else {
        lastLineStable = false;
      }
      previousLine = line;
      previousBody = body;
      continue;
    }

    if (state.kind === "indentedCode") {
      if (isBlank || isIndentedCode(body)) {
        lastLineStable = false;
        previousLine = line;
        previousBody = body;
        continue;
      }

      blockSafeOffset = previousLine?.end ?? state.heldAtLine;
      state = { kind: "root" };
    }

    if (state.kind === "table") {
      if (!state.confirmed) {
        if (isTableDelimiter(body)) {
          state = {
            kind: "table",
            heldAtLine: state.heldAtLine,
            confirmed: true,
          };
          tablePending = true;
          lastLineStable = false;
          previousLine = line;
          previousBody = body;
          continue;
        }

        blockSafeOffset = previousLine?.end ?? state.heldAtLine;
        state = { kind: "root" };
        tablePending = false;
      } else if (isTableRow(body)) {
        lastLineStable = false;
        previousLine = line;
        previousBody = body;
        continue;
      } else {
        blockSafeOffset = previousLine?.end ?? state.heldAtLine;
        state = { kind: "root" };
        tablePending = false;
      }
    }

    const openingFence = readFenceOpening(body);
    if (openingFence) {
      state = {
        kind: "fence",
        marker: openingFence.marker,
        len: openingFence.len,
        heldAtLine: line.start,
      };
      lastLineStable = false;
      previousLine = line;
      previousBody = body;
      continue;
    }

    if (
      isIndentedCode(body) &&
      (previousLine === undefined || isBlankLine(previousBody))
    ) {
      state = {
        kind: "indentedCode",
        heldAtLine: line.start,
      };
      lastLineStable = false;
      previousLine = line;
      previousBody = body;
      continue;
    }

    if (isSetextUnderline(body) && previousLine && !isBlankLine(previousBody)) {
      blockSafeOffset = line.end;
      lastLineStable = true;
      previousLine = line;
      previousBody = body;
      continue;
    }

    if (isTableRow(body) && !isBlank) {
      state = {
        kind: "table",
        heldAtLine: line.start,
        confirmed: false,
      };
      tablePending = true;
      lastLineStable = false;
      previousLine = line;
      previousBody = body;
      continue;
    }

    blockSafeOffset = line.end;
    lastLineStable = isBlank;

    previousLine = line;
    previousBody = body;
  }

  if (state.kind === "table") {
    tablePending = true;
    blockSafeOffset = state.heldAtLine;
  } else if (state.kind === "fence" || state.kind === "indentedCode") {
    blockSafeOffset = state.heldAtLine;
  } else if (lines.length > 0) {
    const lastLine = lines.at(-1);
    if (lastLineStable && lastLine) {
      blockSafeOffset = lastLine.end;
    } else if (lastLine) {
      blockSafeOffset = Math.min(blockSafeOffset, lastLine.start);
    }
  }

  if (hasLinkReferenceDefinition(lines)) {
    blockSafeOffset = 0;
  }

  return {
    blockSafeOffset,
    state,
    tablePending,
  };
}

function parseCompleteLines(buffer: string): ParsedLine[] {
  const lines: ParsedLine[] = [];
  let start = 0;

  for (let index = 0; index < buffer.length; index += 1) {
    const character = buffer[index];
    if (character !== "\r" && character !== "\n") {
      continue;
    }

    const newlineLength =
      character === "\r" && buffer[index + 1] === "\n" ? 2 : 1;
    const end = index + newlineLength;
    const text = buffer.slice(start, end);
    const content = buffer.slice(start, index);
    lines.push({
      start,
      end,
      text,
      content,
      body: stripContainerPrefix(content),
    });
    start = end;
    index += newlineLength - 1;
  }

  return lines;
}

function stripContainerPrefix(line: string): string {
  let body = line;

  for (let count = 0; count < 8; count += 1) {
    const blockquote = body.match(/^ {0,3}>[ \t]?/);
    if (blockquote) {
      body = body.slice(blockquote[0].length);
      continue;
    }

    const listMarker = body.match(/^ {0,3}(?:[*+-]|\d+[.)])[ \t]+/);
    if (listMarker) {
      body = body.slice(listMarker[0].length);
      continue;
    }

    break;
  }

  return body;
}

function readFenceOpening(
  body: string,
): { marker: "`" | "~"; len: number } | null {
  const match = body.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
  if (!match) {
    return null;
  }

  const markerRun = match[1];
  if (!markerRun) {
    return null;
  }

  return {
    marker: markerRun[0] as "`" | "~",
    len: markerRun.length,
  };
}

function isFenceClose(
  body: string,
  marker: "`" | "~",
  length: number,
): boolean {
  const escapedMarker = marker === "`" ? "`" : "~";
  const match = body.match(
    new RegExp(`^ {0,3}(${escapedMarker}{${length},})[ \\t]*$`),
  );
  return Boolean(match);
}

function isIndentedCode(body: string): boolean {
  return /^ {4}(?!\s*$)/.test(body);
}

function isTableRow(body: string): boolean {
  return body.includes("|");
}

function isTableDelimiter(body: string): boolean {
  if (!isTableRow(body)) {
    return false;
  }

  const cells = body.trim().replace(/^\|/, "").replace(/\|$/, "").split("|");

  return (
    cells.length > 0 &&
    cells.every((cell) => /^ {0,3}:?-{1,}:? {0,3}$/.test(cell))
  );
}

function isSetextUnderline(body: string): boolean {
  return /^ {0,3}(?:-+|=+)[ \t]*$/.test(body);
}

function isBlankLine(body: string): boolean {
  return body.trim() === "";
}

function ensureTerminalLine(raw: string): string {
  if (raw.endsWith("\n") || raw.endsWith("\r")) {
    return raw;
  }
  return `${raw}\n`;
}

function hasLinkReferenceDefinition(lines: ParsedLine[]): boolean {
  return lines.some((line) => /^\s*\[[^\]]+\]:\s*\S+/.test(line.body));
}

function findNextNewline(text: string, start: number): number {
  const carriageReturn = text.indexOf("\r", start);
  const lineFeed = text.indexOf("\n", start);

  if (carriageReturn < 0) {
    return lineFeed;
  }
  if (lineFeed < 0) {
    return carriageReturn;
  }
  return Math.min(carriageReturn, lineFeed);
}

function readRunLength(text: string, start: number, character: string): number {
  let length = 0;
  while (text[start + length] === character) {
    length += 1;
  }
  return length;
}

function findClosingRun(
  text: string,
  start: number,
  character: string,
  length: number,
): number {
  for (let index = start; index < text.length; index += 1) {
    if (isEscaped(text, index)) {
      continue;
    }
    if (text[index] === character) {
      const runLength = readRunLength(text, index, character);
      if (runLength === length) {
        return index;
      }
      index += runLength - 1;
    }
  }
  return -1;
}

function isEscaped(text: string, index: number): boolean {
  let slashCount = 0;
  for (
    let cursor = index - 1;
    cursor >= 0 && text[cursor] === "\\";
    cursor -= 1
  ) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}
