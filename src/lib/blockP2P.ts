function blockedPeerConnection(): never {
  throw new DOMException("P2P peer connections are disabled.", "NotAllowedError");
}

/** Install before loading the direct player's scripts. The guard lasts for this
 * document, including client-side navigation, so scripts cannot re-enable P2P.
 * Cross-origin embeds have their own window; Linkani uses direct HLS only.
 */
export function blockPeerConnections(target: object): void {
  for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection", "mozRTCPeerConnection"]) {
    const descriptor = Object.getOwnPropertyDescriptor(target, name);
    if (descriptor?.value === blockedPeerConnection && !descriptor.configurable && !descriptor.writable) continue;
    // Fail closed if an existing locked API cannot be replaced.
    Object.defineProperty(target, name, {
      value: blockedPeerConnection,
      configurable: false,
      writable: false,
    });
  }
}
