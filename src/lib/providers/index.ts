import { AnimeProvider } from "./types";
import { linkkfProvider } from "./linkkf";
import { ohli24Provider } from "./ohli24";
import { reanimeProvider } from "./reanime";
import { anissiaProvider } from "./anissia";
import { anikotoProvider } from "./anikoto"; // 1. anikoto 가져오기
import { isAnissiaId, isOhli24Id, isReanimeId, isAnikotoId } from "./ids"; // 2. isAnikotoId 추가

export * from "./types";
export * from "./linkkf";
export { ohli24Provider } from "./ohli24";
export { reanimeProvider, REANIME_GENRES } from "./reanime";
export { anissiaProvider, ANISSIA_PRIMARY_GENRES, ANISSIA_ALL_GENRES } from "./anissia";
export { anikotoProvider } from "./anikoto"; // 3. export 추가
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
  if (sourceName === "anikoto") { // 4. sourceName 분기 추가
    return anikotoProvider;
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
  if (isAnikotoId(animeId)) { // 5. anikoto 접두사('ak_') 감지 분기 추가
    return anikotoProvider;
  }
  return linkkfProvider;
}
