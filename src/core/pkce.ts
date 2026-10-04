/**
 * PKCE for the authorization-code flow. The verifier is generated in the
 * extension, kept only until the code is exchanged, and sent to the broker -- the
 * extension never holds or transmits a client secret (task 5.3).
 */

const base64url = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export const randomBase64Url = (byteLength: number): string => {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
};

export interface PkcePair {
  codeVerifier: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
}

/** RFC 7636: the verifier is 43-128 characters of the unreserved alphabet. */
export const createPkcePair = async (): Promise<PkcePair> => {
  const codeVerifier = randomBase64Url(64);
  // S256 is the only method accepted by either platform; `plain` is not offered.
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier));
  return {
    codeVerifier,
    codeChallenge: base64url(new Uint8Array(digest)),
    codeChallengeMethod: 'S256',
  };
};
