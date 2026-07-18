type Boundary = {
  start: number;
  end: number;
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
  const whitespaceMatches = [...window.matchAll(/[ \t]+/g)];
  const whitespace = whitespaceMatches[whitespaceMatches.length - 1];

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

function splitRaw(content: string, limit: number, preferNewlines: boolean): string[] {
  const chunks: string[] = [];
  let remaining = content.replace(/\r\n?/g, "\n");

  while (remaining.length > limit) {
    const boundary = findBoundary(remaining, limit, preferNewlines);
    let chunk = remaining.slice(0, boundary.start);
    let next = remaining.slice(boundary.end);

    if (!chunk.length) {
      chunk = remaining.slice(0, limit);
      next = remaining.slice(limit);
    }

    // The Discord message boundary replaces the separator we split on. This
    // avoids a trailing newline plus Discord's own inter-message spacing from
    // looking like an extra blank line, while preserving all internal spacing.
    chunks.push(chunk.replace(/[ \t]+$/, ""));
    remaining = next;
  }

  if (remaining.length) chunks.push(remaining.replace(/[ \t]+$/, ""));
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

export function splitMarkdownMessage(
  content: string,
  maxLength: number,
  splitOnWords = false,
): string[] | false {
  if (!content || maxLength <= 0) return false;

  const normalized = content.replace(/\r\n?/g, "\n");
  if (normalized.length <= maxLength) return [normalized];

  // Leave enough room to close and reopen a fenced code block at a chunk
  // boundary. Most chunks remain close to Discord's actual limit.
  const reserve = Math.min(160, Math.max(48, Math.floor(maxLength * 0.08)));
  const rawLimit = maxLength - reserve;
  if (rawLimit < 1) return false;

  const rawChunks = splitRaw(normalized, rawLimit, !splitOnWords);
  const chunks: string[] = [];
  let openFence: FenceState | null = null;

  for (let i = 0; i < rawChunks.length; i++) {
    const raw = rawChunks[i];
    const prefix = openFence ? `${openFence.openLine}\n` : "";
    const nextFence = scanFenceState(raw, openFence);
    const suffix = nextFence && i < rawChunks.length - 1 ? `\n${nextFence.marker}` : "";
    const chunk = `${prefix}${raw}${suffix}`;

    if (chunk.length > maxLength) return false;
    if (chunk.trim().length > 0) chunks.push(chunk);
    openFence = nextFence;
  }

  return chunks.length ? chunks : false;
}
