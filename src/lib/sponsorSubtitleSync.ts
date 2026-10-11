/** User-chosen timeline breakpoint, not an automatic S/NS content classification. */
export interface SponsorSubtitleSync {
  startSeconds: number | null;
  delaySeconds: number;
}

export function effectiveSubtitleOffset(
  baseOffset: number,
  sponsor: SponsorSubtitleSync,
  videoSeconds: number,
): number {
  if (sponsor.startSeconds === null || !Number.isFinite(sponsor.startSeconds) ||
      sponsor.startSeconds < 0 || !Number.isFinite(sponsor.delaySeconds) ||
      sponsor.delaySeconds <= 0 || !Number.isFinite(videoSeconds)) {
    return baseOffset;
  }
  return baseOffset + (videoSeconds >= sponsor.startSeconds ? sponsor.delaySeconds : 0);
}

export function formatSyncTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  return Math.floor(total / 60) + ":" + String(total % 60).padStart(2, "0");
}
