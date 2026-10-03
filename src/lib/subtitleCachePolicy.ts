export function canCacheSubtitle(subtitle: {
  isCached?: boolean; localArchive?: boolean; sourceProvider?: string;
  sourceCreatorWebsite?: string; url?: string; content?: string;
} | null | undefined): boolean {
  return Boolean(subtitle && !subtitle.isCached && !subtitle.localArchive
    && ['aniall', 'anissia'].includes(subtitle.sourceProvider || '')
    && /^https?:\/\//i.test(subtitle.sourceCreatorWebsite || subtitle.url || '') && subtitle.content);
}
