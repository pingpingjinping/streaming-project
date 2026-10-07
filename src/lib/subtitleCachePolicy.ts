export function canCacheSubtitle(subtitle: {
  isCached?: boolean; localArchive?: boolean; temporary?: boolean; sourceProvider?: string;
  sourceCreatorWebsite?: string; url?: string; content?: string;
} | null | undefined): boolean {
  return Boolean(subtitle && !subtitle.isCached && !subtitle.localArchive && !subtitle.temporary
    && ['aniall', 'anissia'].includes(subtitle.sourceProvider || '')
    && /^https?:\/\//i.test(subtitle.sourceCreatorWebsite || subtitle.url || '') && subtitle.content);
}
