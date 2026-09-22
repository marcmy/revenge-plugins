type Boundary = {
  start: number;
  end: number;
};

type RawChunk = {
  text: string;
  sourceStart: number;
};

export type MarkdownSplitResult = {
  chunks: string[];
  sourceStarts: number[];
  normalized: string;
};

type FenceState = {
  marker: string;
  openLine: string;
};

function findBoundary(text: string, limit: number, preferNewlines: boolean): Boundary {
  const minUseful = Math.floor(limit * 0.45);
  const window = text.slice(0, limit + 1);
  const paragraph = window.lastIndexOf("\n\n");
  const newline = window.lastIndexOf("\n");
  const whitespace = window.match(/[ \t]+(?=[^ \t]*$)/);

  if (preferNewlines) {
    if (paragraph >= minUseful) return { start: paragraph, end: paragraph + 2 };
    if (newline >= minUseful) return { start: newline, end: newline + 1 };
    if (whitespace?.index != null && whitespace.index >= minUseful) {
      return { start: whitespace.index, end: whitespace.index + whitespace[0].length };
    }
  } else {
    if (whitespace?.index != null && whitespace.index >= minUseful) {
      return { start: whitespace.index, end: whitespace.index + whitespace[0].length };
    }
    if (newline >= minUseful) return { start: newline, end: newline + 1 };
  }

  return { start: limit, end: limit };
}

function splitRaw(content: string, limit: number, preferNewlines: boolean): RawChunk[] {
  const chunks: RawChunk[] = [];
  const normalized = content.replace(/\r\n?/g, "\n");
  let remaining = normalized;
  let sourceStart = 0;

  while (remaining.length > limit) {
    const boundary = findBoundary(remaining, limit, preferNewlines);
    let chunk = remaining.slice(0, boundary.start);
    let consumed = boundary.end;

    if (!chunk.length) {
      chunk = remaining.slice(0, limit);
      consumed = limit;
    }

    // The Discord message boundary replaces the separator we split on. This
    // avoids a trailing newline plus Discord's own inter-message spacing from
    // looking like an extra blank line, while preserving all internal spacing.
    chunks.push({ text: chunk.replace(/[ \t]+$/, ""), sourceStart });
    sourceStart += consumed;
    remaining = normalized.slice(sourceStart);
  }

  if (remaining.length) {
    chunks.push({ text: remaining.replace(/[ \t]+$/, ""), sourceStart });
  }

  return chunks;
}

function scanFenceState(content: string, initial: FenceState | null): FenceState | null {
  let open = initial;

  for (const line of content.split("\n")) {
    const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (!match) continue;

    const marker = match[1];
    const rest = match[2] ?? "";

    if (!open) {
      open = { marker, openLine: line };
      continue;
    }

    const closesCurrentFence =
      marker[0] === open.marker[0] && marker.length >= open.marker.length && rest.trim().length === 0;

    if (closesCurrentFence) open = null;
  }

  return open;
}

export function splitMarkdownMessageDetailed(
  content: string,
  maxLength: number,
  splitOnWords = false,
): MarkdownSplitResult | false {
  if (!content || maxLength <= 0) return false;

  const normalized = content.replace(/\r\n?/g, "\n");
  if (normalized.length <= maxLength) {
    return { chunks: [normalized], sourceStarts: [0], normalized };
  }

  // Leave enough room to close and reopen a fenced code block at a chunk
  // boundary. Most chunks remain close to Discord's actual limit.
  const reserve = Math.min(160, Math.max(48, Math.floor(maxLength * 0.08)));
  const rawLimit = maxLength - reserve;
  if (rawLimit < 1) return false;

  const rawChunks = splitRaw(normalized, rawLimit, !splitOnWords);
  const chunks: string[] = [];
  const sourceStarts: number[] = [];
  let openFence: FenceState | null = null;

  for (let i = 0; i < rawChunks.length; i++) {
    const raw = rawChunks[i];
    const prefix = openFence ? `${openFence.openLine}\n` : "";
    const nextFence = scanFenceState(raw.text, openFence);
    const suffix = nextFence && i < rawChunks.length - 1 ? `\n${nextFence.marker}` : "";
    const chunk = `${prefix}${raw.text}${suffix}`;

    if (chunk.length > maxLength) return false;
    if (chunk.trim().length > 0) {
      chunks.push(chunk);
      sourceStarts.push(raw.sourceStart);
    }
    openFence = nextFence;
  }

  return chunks.length ? { chunks, sourceStarts, normalized } : false;
}

export function splitMarkdownMessage(
  content: string,
  maxLength: number,
  splitOnWords = false,
): string[] | false {
  const result = splitMarkdownMessageDetailed(content, maxLength, splitOnWords);
  return result === false ? false : result.chunks;
}
