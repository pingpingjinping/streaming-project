export interface ProviderSubtitleSettings {
  linkaniExternalSubtitles?: boolean;
  ohli24ExternalSubtitles?: boolean;
}

export function shouldSearchExternalSubtitles(source: string | undefined, settings?: ProviderSubtitleSettings | null): boolean {
  if (source === "linkkf") return settings?.linkaniExternalSubtitles === true;
  if (source === "ohli24") return settings?.ohli24ExternalSubtitles === true;
  return true;
}
