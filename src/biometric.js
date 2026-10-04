// Fingerprint / Face ID unlock with a passkey on this phone. The passkey's PRF secret
// (created and kept inside the phone's secure hardware, released only after the fingerprint
// or face check) encrypts a copy of the passcode. Nothing goes over the network.

const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function available() {
  try {
    return Boolean(window.PublicKeyCredential && window.isSecureContext &&
      await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable());
  } catch {
    return false;
  }
}

async function keyFrom(prfOutput) {
  const base = await crypto.subtle.importKey('raw', prfOutput, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('finance-app'), info: enc.encode('passcode') },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

async function prfSecret(credId, salt) {
  const cred = await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: [{ type: 'public-key', id: unb64(credId) }],
      userVerification: 'required',
      timeout: 60000,
      extensions: { prf: { eval: { first: unb64(salt) } } },
    },
  });
  const out = cred?.getClientExtensionResults?.().prf?.results?.first;
  if (!out) throw new Error('unsupported');
  return out;
}

// Returns what to keep on the phone, or throws 'unsupported' / the browser's error.
export async function enroll(passcode) {
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const cred = await navigator.credentials.create({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { name: 'Finance' },
      user: { id: crypto.getRandomValues(new Uint8Array(16)), name: 'Finance app', displayName: 'Finance app' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'preferred', userVerification: 'required' },
      timeout: 60000,
      extensions: { prf: { eval: { first: salt } } },
    },
  });
  const ext = cred.getClientExtensionResults?.().prf;
  if (!ext || ext.enabled === false) throw new Error('unsupported');
  const credId = b64(cred.rawId);
  // Some phones hand out the secret right away; others need one more fingerprint check.
  const out = ext.results?.first || await prfSecret(credId, b64(salt));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await keyFrom(out), enc.encode(passcode));
  return { credId, salt: b64(salt), iv: b64(iv), data: b64(data), createdAt: new Date().toISOString() };
}

// Asks for the fingerprint and returns the passcode.
export async function passcode(bio) {
  const out = await prfSecret(bio.credId, bio.salt);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(bio.iv) }, await keyFrom(out), unb64(bio.data));
  return dec.decode(plain);
}
