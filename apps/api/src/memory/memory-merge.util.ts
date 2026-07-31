/**
 * Shared merge helpers used by both the memory store facade and the memory
 * summarizer to keep their merge behaviour consistent.
 */

export function mergeContent(
  previousContent: string,
  nextContent: string,
): string {
  if (!previousContent.trim()) {
    return nextContent;
  }

  if (!nextContent.trim()) {
    return previousContent;
  }

  return `${previousContent}\n${nextContent}`;
}

export function mergeMetadata(
  previous: Record<string, unknown> | null,
  next: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!previous && !next) {
    return null;
  }

  return {
    ...(previous ?? {}),
    ...(next ?? {}),
  };
}
