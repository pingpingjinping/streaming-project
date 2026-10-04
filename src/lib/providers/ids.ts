export const ANISSIA_PREFIX = "ani_";

export function isAnissiaId(id: string): boolean {
  return typeof id === "string" && id.startsWith(ANISSIA_PREFIX);
}

export function toAnissiaId(rawId: string | number): string {
  const str = String(rawId);
  return str.startsWith(ANISSIA_PREFIX) ? str : `${ANISSIA_PREFIX}${str}`;
}

export function stripAnissiaId(id: string): string {
  return id.replace(new RegExp(`^${ANISSIA_PREFIX}`), "");
}

export const OHLI24_PREFIX = "ol_";

export function isOhli24Id(id: string): boolean {
  return typeof id === "string" && id.startsWith(OHLI24_PREFIX);
}

export function toOhli24Id(rawId: string | number): string {
  const str = String(rawId);
  return str.startsWith(OHLI24_PREFIX) ? str : `${OHLI24_PREFIX}${str}`;
}

export function stripOhli24Id(id: string): string {
  return id.replace(new RegExp(`^${OHLI24_PREFIX}`), "");
}

export const REANIME_PREFIX = "re_";

export function isReanimeId(id: string): boolean {
  return typeof id === "string" && id.startsWith(REANIME_PREFIX);
}

export function toReanimeId(rawId: string | number): string {
  const str = String(rawId);
  return str.startsWith(REANIME_PREFIX) ? str : `${REANIME_PREFIX}${str}`;
}

export function stripReanimeId(id: string): string {
  return id.replace(new RegExp(`^${REANIME_PREFIX}`), "");
}

export const ANIKOTO_PREFIX = "ak_";

export function isAnikotoId(id: string): boolean {
  return typeof id === "string" && id.startsWith(ANIKOTO_PREFIX);
}

export function toAnikotoId(rawId: string | number): string {
  const str = String(rawId);
  return str.startsWith(ANIKOTO_PREFIX) ? str : `${ANIKOTO_PREFIX}${str}`;
}

export function stripAnikotoId(id: string): string {
  return id.replace(new RegExp(`^${ANIKOTO_PREFIX}`), "");
}
