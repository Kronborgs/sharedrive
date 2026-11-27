import type { MailFolder, SenderAlias } from '../types/mail';
import type { CalendarSource } from '../types/calendar';
import type { SuiteConfig, SuiteModule } from '../types/suite';

export interface SuiteSessionResponse {
  ok: boolean;
  authenticated: boolean;
  username?: string;
  aliases?: SenderAlias[];
  authBlocked?: boolean;
}

export interface SuiteLoginResponse {
  ok: boolean;
  username: string;
  folders: MailFolder[];
  aliases: SenderAlias[];
  calendars: Omit<CalendarSource, 'visible'>[];
  nameOverrides?: Record<string, string>;
  dismissedSharedCount?: number;
  caldavReady: boolean;
  error?: string;
}

export async function apiGetSuiteConfig(): Promise<SuiteConfig> {
  try {
    const res = await fetch('/api/v1/me/mailcow/suite/auth/config', { credentials: 'include' });
    const data = await res.json();
    const modules = Array.isArray(data?.enabledModules)
      ? (data.enabledModules as SuiteModule[])
      : (['mail', 'calendar', 'contacts'] as SuiteModule[]);
    return {
      hasDefaultServer: Boolean(data?.hasDefaultServer),
      enabledModules: modules.length > 0 ? modules : ['mail', 'calendar', 'contacts'],
      sogoUrl: typeof data?.sogoUrl === 'string' && data.sogoUrl ? data.sogoUrl : null
    };
  } catch {
    return {
      hasDefaultServer: false,
      enabledModules: ['mail', 'calendar', 'contacts'],
      sogoUrl: null
    };
  }
}

export async function apiGetSuiteSession(): Promise<SuiteSessionResponse> {
  try {
    const res = await fetch('/api/v1/me/mailcow/suite/auth/session', { credentials: 'include' });
    const data = await res.json();
    return {
      ok: Boolean(data?.ok),
      authenticated: Boolean(data?.authenticated),
      username: data?.username || '',
      authBlocked: data?.authBlocked === true,
      aliases: Array.isArray(data?.aliases) ? data.aliases : []
    };
  } catch {
    return { ok: false, authenticated: false };
  }
}

export const mailcowAuthPausedEvent = 'sharedrive-mailcow-auth-paused';

export function reportPausedMailcow(response: Response): void {
  if (response.status === 424) window.dispatchEvent(new Event(mailcowAuthPausedEvent));
}

export async function apiLoginSuite(params: {
  username: string;
  password: string;
  serverHost?: string;
  imapHost?: string;
  imapPort?: number;
  imapSecure?: boolean;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  caldavUrl?: string;
}): Promise<SuiteLoginResponse> {
  const res = await fetch('/api/v1/me/mailcow/suite/auth/login', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(params)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || 'Login mod Mailcow mislykkedes. Kontrollér e-mail og adgangskode.');
  }
  return data as SuiteLoginResponse;
}

export async function apiLogoutSuite(): Promise<void> {
  await fetch('/api/v1/me/mailcow/suite/auth/logout', {
    method: 'POST',
    credentials: 'include'
  }).catch(() => {});
}
