import { AnimeProvider } from "./types";
import { linkkfProvider } from "./linkkf";
import { ohli24Provider } from "./ohli24";
import { reanimeProvider } from "./reanime";
import { anissiaProvider } from "./anissia";
import { isAnissiaId, isOhli24Id, isReanimeId } from "./ids";

export * from "./types";
export * from "./linkkf";
export { ohli24Provider } from "./ohli24";
export { reanimeProvider, REANIME_GENRES } from "./reanime";
export { anissiaProvider, ANISSIA_PRIMARY_GENRES, ANISSIA_ALL_GENRES } from "./anissia";
export * from "./ids";

export function getProvider(sourceName?: string | null): AnimeProvider {
  if (sourceName === "linkkf") {
    return linkkfProvider;
  }
  if (sourceName === "ohli24") {
    return ohli24Provider;
  }
  if (sourceName === "reanime") {
    return reanimeProvider;
  }
  return anissiaProvider;
}

export function getProviderByAnimeId(animeId: string): AnimeProvider {
  if (isAnissiaId(animeId)) {
    return anissiaProvider;
  }
  if (isReanimeId(animeId)) {
    return reanimeProvider;
  }
  if (isOhli24Id(animeId)) {
    return ohli24Provider;
  }
  return linkkfProvider;
}
