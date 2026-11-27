import {
  assertSameServerOrigin,
  buildForwardedIpHeaders,
  ensureTrailingSlash,
  normalizeMailcowUrl,
  type CalDavCredentials
} from './davClient.js';

const maxPreferencesBytes = 1024 * 1024;
const maxSignatureLength = 16_384;

export class SogoSignatureError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

interface SogoIdentity {
  email?: string;
  signature?: string;
}

export async function fetchSogoSignature(creds: CalDavCredentials, email: string) {
  const base = ensureTrailingSlash(normalizeMailcowUrl(creds.serverUrl));
  const endpoint = new URL(encodeURIComponent(creds.username) + '/jsonDefaults', base).toString();
  assertSameServerOrigin(endpoint, creds);

  const authorization = Buffer.from(`${creds.username}:${creds.password}`, 'utf8').toString('base64');
  const response = await fetch(endpoint, {
    headers: {
      Authorization: `Basic ${authorization}`,
      Accept: 'application/json',
      ...buildForwardedIpHeaders(creds.clientIp)
    },
    redirect: 'manual',
    signal: AbortSignal.timeout(8_000)
  });

  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new SogoSignatureError('SOGo gav ikke mailkontoen adgang til signaturer via DAV.', 502);
  }

  return readIdentitySignature(await readPreferences(response), email);
}

async function readPreferences(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return null;

  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxPreferencesBytes) {
        await reader.cancel().catch(() => {});
        throw new SogoSignatureError('SOGos svar med indstillinger er for stort.', 502);
      }
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } catch (error) {
    if (error instanceof SogoSignatureError) throw error;
    throw new SogoSignatureError('SOGo returnerede ikke indstillinger via DAV.', 502);
  } finally {
    reader.releaseLock();
  }
}

function readIdentitySignature(value: unknown, email: string) {
  const preferences = value as {
    AuxiliaryMailAccounts?: Array<{ identities?: SogoIdentity[] }>;
    SOGoMailComposeMessageType?: string;
  } | null;
  const accounts = preferences?.AuxiliaryMailAccounts;
  if (!Array.isArray(accounts) || !Array.isArray(accounts[0]?.identities)) {
    throw new SogoSignatureError('SOGo returnerede ingen afsenderidentiteter.', 502);
  }
  // SOGo inserts the system account first. Its auxiliary accounts can point to other servers.
  const identity = accounts[0].identities.find(item =>
    typeof item?.email === 'string' && item.email.trim().toLowerCase() === email.toLowerCase());
  if (!identity) throw new SogoSignatureError('Afsenderadressen blev ikke fundet i SOGo.', 404);
  if (typeof identity.signature !== 'string' || !identity.signature.trim()) {
    throw new SogoSignatureError('Afsenderen har ingen signatur i SOGo.', 404);
  }
  if (identity.signature.length > maxSignatureLength) {
    throw new SogoSignatureError('Signaturen i SOGo er for lang til at blive hentet.', 422);
  }
  return { signature: identity.signature, html: preferences?.SOGoMailComposeMessageType === 'html' };
}
