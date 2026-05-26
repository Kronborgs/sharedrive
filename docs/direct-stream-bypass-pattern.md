# Mønster: Direkte URL til streaming (bypass Cloudflare)

> Beskrivelse baseret på implementeringen i Sharedrive.
> Brug dette som reference til at implementere samme mønster i et nyt projekt (fx Jukebox).

---

## Koncept

Al autentificering, API-kald og validering kører via den normale rute (Cloudflare-proxied).
Kun selve musik-streamingen bruger en alternativ base-URL der går direkte til serveren —
typisk via et separat subdomain der peger direkte på maskinen uden Cloudflare imellem.

```
Browser
  │
  ├─── Auth / API / metadata ──────► Cloudflare ──► Server
  │
  └─── Audio streaming ────────────────────────────► Server  (direkte, ingen Cloudflare)
```

---

## 1. Database — gem indstillingen

Én række i en `system_settings` tabel (key/value):

```sql
CREATE TABLE IF NOT EXISTS system_settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
);

-- Gem/opdater indstilling:
INSERT INTO system_settings (key, value)
VALUES ('direct_stream_url', 'https://stream.ditdomaene.dk')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
```

---

## 2. Backend — public settings endpoint (ingen auth krævet)

Lav et åbent endpoint som frontenden kan kalde uden at være logget ind.
Det er sikkert fordi det kun returnerer en URL — ingen følsomme data.

```
GET /api/v1/system/settings
→ 200 OK
  {
    "direct_stream_url": "https://stream.ditdomaene.dk"
  }
```

Eksempel (Go):

```go
func (h *Handler) GetPublicSettings(w http.ResponseWriter, r *http.Request) {
    var url string
    _ = h.db.QueryRow(r.Context(),
        `SELECT value FROM system_settings WHERE key = 'direct_stream_url'`,
    ).Scan(&url)

    json.NewEncoder(w).Encode(map[string]any{
        "direct_stream_url": url,
    })
}
```

Frontend cacher dette i 5 minutter (React Query / SWR):

```ts
const { data: settings } = useQuery({
  queryKey: ['system', 'settings'],
  queryFn: () => api.get('/api/v1/system/settings'),
  staleTime: 5 * 60 * 1000,
})
```

---

## 3. CSP — tillad den direkte URL i connect-src

Når `direct_stream_url` er sat, skal den føjes til Content-Security-Policy's
`connect-src` direktiv — ellers blokerer browseren requests til det fremmede domæne.

Hent URL'en fra databasen i en **callback** i din CSP-middleware (ikke ved opstart,
så den altid er opdateret):

```go
// I din router-opsætning:
r.Use(SecurityHeaders(func() string {
    var v string
    _ = db.QueryRow(context.Background(),
        `SELECT value FROM system_settings WHERE key = 'direct_stream_url'`,
    ).Scan(&v)
    return v  // tilføjes til connect-src
}))

// I SecurityHeaders middleware:
connectSrc := "'self' wss: ws:"
if extra := resolveCallback(); extra != "" {
    connectSrc += " " + extra
}
// Sæt header:
// Content-Security-Policy: ... connect-src 'self' wss: ws: https://stream.ditdomaene.dk ...
```

---

## 4. Cross-subdomain auth — stream token

Session-cookien er bundet til hoveddomænet og sendes **ikke** automatisk til et andet
subdomain. Løsningen er et kortlivet, single-use token via Redis:

### Flow

```
1. Frontend:  POST /api/v1/stream-token   (kræver auth via session-cookie)
              Body: { "track_id": "abc" }   (valgfrit — til audit)

2. Backend:   Genererer token (crypto/rand, 32 bytes, hex-encoded)
              Gemmer i Redis:  stream_token:<token> → user_id  (TTL: 60 sekunder)
              Svarer:          { "token": "a1b2c3..." }

3. Frontend:  Streamer via direkte URL med token i header:
              GET https://stream.ditdomaene.dk/stream/<track_id>
              Header: X-Stream-Token: a1b2c3...

4. Backend:   Middleware tjekker X-Stream-Token
              → Slår op i Redis
              → Finder user_id
              → Sletter token (single-use!)
              → Sætter bruger i request context
              → Kald videre til stream handler
```

### Backend — token-udstedelse

```go
// POST /api/v1/stream-token
func (h *Handler) HandleIssueStreamToken(w http.ResponseWriter, r *http.Request) {
    actor := middleware.UserFromContext(r.Context())
    if actor == nil {
        http.Error(w, "unauthorized", 401)
        return
    }

    b := make([]byte, 32)
    _, _ = rand.Read(b)
    token := hex.EncodeToString(b)

    key := "stream_token:" + token
    h.redis.Set(r.Context(), key, actor.ID.String(), 60*time.Second)

    json.NewEncoder(w).Encode(map[string]string{"token": token})
}
```

### Backend — token-validerings middleware

```go
func StreamTokenMiddleware(redisClient *redis.Client, next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        // Allerede autentificeret via session-cookie → skip
        if middleware.UserFromContext(r.Context()) != nil {
            next.ServeHTTP(w, r)
            return
        }

        token := r.Header.Get("X-Stream-Token")
        if token == "" {
            next.ServeHTTP(w, r)
            return
        }

        key := "stream_token:" + token
        userID, err := redisClient.GetDel(r.Context(), key).Result() // atomic get+delete = single-use
        if err != nil {
            http.Error(w, "invalid or expired token", 401)
            return
        }

        // Sæt bruger i context og kald videre
        ctx := middleware.WithUserID(r.Context(), userID)
        next.ServeHTTP(w, r.WithContext(ctx))
    })
}
```

---

## 5. Frontend — vælg URL dynamisk

```ts
async function playTrack(trackId: string) {
  const directBase = settings?.direct_stream_url?.trim().replace(/\/+$/, '')

  let extraHeaders: Record<string, string> = {}

  if (directBase) {
    // Hent single-use token fra vores egen server (kræver auth)
    try {
      const res = await api.post<{ token: string }>('/api/v1/stream-token', { track_id: trackId })
      extraHeaders['X-Stream-Token'] = res.token
    } catch {
      // Fallback til normal rute hvis token-hentning fejler
      console.warn('Stream token fetch failed, falling back to normal route')
    }
  }

  const streamUrl = directBase
    ? `${directBase}/stream/${trackId}`
    : `/api/v1/stream/${trackId}`

  // Brug streamUrl og extraHeaders med din audio-afspiller
  audioElement.src = streamUrl
  // Bemærk: <audio src="..."> sender ikke custom headers.
  // Brug i stedet fetch() + createObjectURL() hvis du skal sende headers,
  // ELLER sæt token som query-param hvis headers ikke er muligt.
}
```

> **Tip — query-param alternativ:** `<audio>` elementet kan ikke sende custom headers.
> Enten brug `fetch()` + `URL.createObjectURL(blob)`, eller send tokenet som
> `?token=abc123` i URL'en og læs det fra `r.URL.Query()` i backend-middlewaret.

---

## 6. Admin UI — indstillingsfelt

Et simpelt felt i admin-panelet:

```tsx
<Field label="Direkte stream-URL" error={errors.direct_stream_url?.message}>
  <input
    type="url"
    {...register('direct_stream_url')}
    placeholder="https://stream.ditdomaene.dk"
  />
  <p className="hint">
    Valgfri URL der bypasser Cloudflare til musikstreaming.
    Lad feltet stå tomt for normal rute.
  </p>
</Field>
```

Zod-validering:

```ts
const schema = z.object({
  direct_stream_url: z.string().url().or(z.literal('')),
})
```

Gem via:

```
PATCH /api/v1/admin/settings
Body: { "direct_stream_url": "https://stream.ditdomaene.dk" }
```

---

## 7. Hvornår bruges direkte vs. normal rute?

| Handling                          | Rute                        |
|-----------------------------------|-----------------------------|
| Login, session, brugerhåndtering  | Altid via Cloudflare        |
| API-kald (søg, playlist, metadata)| Altid via Cloudflare        |
| Hent `system/settings`            | Via Cloudflare (caches 5min)|
| Hent stream-token                 | Via Cloudflare (kræver auth)|
| **Selve audio-streaming**         | **Direkte, hvis URL er sat**|

---

## 8. UI-indikator (valgfrit)

Vis en lille badge så brugeren kan se hvilken rute der bruges:

```tsx
{directBase ? (
  <span className="badge green">⚡ Direkte</span>
) : (
  <span className="badge gray">☁ Via Cloudflare</span>
)}
```

---

## Nøglepunkter til implementering

- Tokenet er **single-use** — brug Redis `GETDEL` (atomisk get + delete)
- Tokenet lever i **Redis**, ikke databasen — kort TTL (60s), ingen oprydning nødvendig
- `direct_stream_url` returneres fra et **public endpoint** — sikkert fordi det kun er en URL
- CSP opdateres **dynamisk** fra DB i middleware-callback, ikke ved appstart
- `<audio src="...">` sender ikke custom headers — brug enten `fetch()+createObjectURL()` eller query-param token
