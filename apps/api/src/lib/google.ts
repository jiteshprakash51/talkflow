// Google OAuth 2.0 helpers — free, uses fetch only (no paid SDK).
// Scopes: gmail.readonly + sheets (append). Tokens stored in localStore/D1, never logged.

export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/spreadsheets",
].join(" ");

export function googleEnv(env: Record<string, string | undefined>) {
  return {
    clientId: env.GOOGLE_CLIENT_ID ?? process.env.GOOGLE_CLIENT_ID ?? "",
    clientSecret: env.GOOGLE_CLIENT_SECRET ?? process.env.GOOGLE_CLIENT_SECRET ?? "",
    redirectUri:
      env.GOOGLE_REDIRECT_URI ?? process.env.GOOGLE_REDIRECT_URI ?? "http://localhost:8787/api/auth/google/callback",
  };
}

export function googleAuthUrl(env: Record<string, string | undefined>, state = "local"): string {
  const { clientId, redirectUri } = googleEnv(env);
  const p = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GOOGLE_SCOPES,
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p.toString()}`;
}

export async function exchangeCode(
  env: Record<string, string | undefined>,
  code: string
): Promise<{ access_token: string; refresh_token?: string; expires_in: number }> {
  const { clientId, clientSecret, redirectUri } = googleEnv(env);
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }).toString(),
  });
  if (!res.ok) throw new Error(`Google token HTTP ${res.status}`);
  return (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number };
}

export async function refreshAccessToken(
  env: Record<string, string | undefined>,
  refreshToken: string
): Promise<{ access_token: string; expires_in: number }> {
  const { clientId, clientSecret } = googleEnv(env);
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
    }).toString(),
  });
  if (!res.ok) throw new Error(`Google refresh HTTP ${res.status}`);
  return (await res.json()) as { access_token: string; expires_in: number };
}
