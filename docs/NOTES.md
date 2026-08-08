# Notes MVP

Sharedrive Notes is an integrated database-backed notes and checklist module. It uses the existing Go server, PostgreSQL connection, authenticated layout, SMTP settings, audit logger, Redis rate limiter, PWA shell, and encrypted per-user backup format.

## Features

- Plain-text notes and checklists with a fixed type
- Search across title, text content, and checklist items
- Pinning, archive, soft-delete, restore, and permanent delete
- Debounced autosave with optimistic locking through `notes.version`
- Danish and English UI
- Responsive owner and guest views
- Accountless email sharing with `view`, `check`, or `edit` permission

`view` is read-only. `check` can only toggle existing checklist items and cannot be assigned to a text note. `edit` can edit title/content and checklist structure, but cannot share, pin, archive, trash, or permanently delete a note.

## Data Model

Migration `0046_notes.sql` creates:

- `notes`: owner, immutable type, content, display state, soft delete, and version
- `note_items`: ordered checklist items
- `note_shares`: normalized recipient, permission, expiry, revocation, and SHA-256 invitation-token hash
- `note_guest_sessions`: short-lived SHA-256 session-token hashes

Deleting a note permanently cascades to its items, shares, and guest sessions. Moving a note to trash suspends guest access. Restoring it reactivates shares that have not expired or been revoked.

## API

Authenticated owner endpoints:

```text
GET    /api/v1/notes
POST   /api/v1/notes
GET    /api/v1/notes/{id}
PATCH  /api/v1/notes/{id}
DELETE /api/v1/notes/{id}
POST   /api/v1/notes/{id}/restore
DELETE /api/v1/notes/{id}/permanent
POST   /api/v1/notes/{id}/items
PATCH  /api/v1/notes/{id}/items/{itemId}
DELETE /api/v1/notes/{id}/items/{itemId}
POST   /api/v1/notes/{id}/items/reorder
GET    /api/v1/notes/{id}/shares
POST   /api/v1/notes/{id}/shares
PATCH  /api/v1/notes/{id}/shares/{shareId}
DELETE /api/v1/notes/{id}/shares/{shareId}
POST   /api/v1/notes/{id}/shares/{shareId}/resend
```

Public exchange and guest-session endpoints:

```text
GET    /notes/invite/{token}
GET    /api/v1/public/notes/invitations/{token}/accept
GET    /api/v1/guest/notes/{id}
PATCH  /api/v1/guest/notes/{id}
POST   /api/v1/guest/notes/{id}/items
PATCH  /api/v1/guest/notes/{id}/items/{itemId}
DELETE /api/v1/guest/notes/{id}/items/{itemId}
POST   /api/v1/guest/notes/{id}/items/reorder
POST   /api/v1/guest/logout
```

List filters are `search`, `type`, `archived`, `deleted`, `pinned`, `limit`, and `offset`. Mutations include the version read by the client and return HTTP 409 when it is stale.

## Invitation Security

1. The owner creates an invitation. The server generates 32 random bytes and stores only its SHA-256 hash.
2. Existing SMTP configuration sends `/notes/invite/{token}` without note content.
3. The server validates the invitation, share, owner, expiry, revocation, and note state.
4. A separate 32-byte guest-session token is created. Only its SHA-256 hash is stored.
5. The raw session token is sent in `note_guest_session`, an HttpOnly, SameSite=Lax cookie. It is Secure when `GO_ENV=production`, expires after at most 24 hours, and has path `/api/v1/guest`.
6. The server responds with HTTP 303 to `/guest/notes/{noteId}`, removing the invitation token from the address bar.
7. Every guest request re-reads the session, share permission/expiry/revocation, note state, and requested note ID.

Invitation tokens are reusable exchanges while the share is active. Resending rotates the invitation token and invalidates the previous link. Revocation also revokes all current sessions. Permission and expiry changes apply to existing sessions immediately.

Invitation paths are redacted by the global request logger. Guest and invitation responses use `Cache-Control: no-store`; note APIs are excluded from service-worker caching by the existing `/api/` rule.

State-changing guest requests require an `Origin` or `Referer` matching `APP_BASE_URL`. This supplements SameSite=Lax and prevents cross-site cookie actions. The API never accepts guest tokens from JavaScript storage or request bodies.

## Limits and Rate Limiting

- Title: 300 characters
- Text content: 100,000 characters
- Checklist item: 2,000 characters
- Checklist: 500 items
- Active invitations per note: 100
- Invitation sends: 20 per owner per hour
- Resends: 10 per share per hour
- Invitation exchanges: 20 per IP per 15 minutes
- Guest mutations: 120 per guest session per minute

Rate limiting uses the existing Redis sliding-window limiter. If Redis itself is unavailable, requests fail open consistently with other non-auth operation limits and emit a warning.

## Backup and Restore

Full per-user `.shdbak` archives use format version 3 and include `notes.json` with notes, items, and shares. Invitation-token hashes are retained so active links can continue after restore. Short-lived `note_guest_sessions` are deliberately excluded and guests must exchange their invitation again. Selective folder-only exports do not include notes.

## Known MVP Limits

- No labels, reminders, attachments, rich text, collections, or note-type conversion
- No offline editing, WebSocket collaboration, CRDT, or version history
- No guest reshare or manage permission
- Autosave detects conflicts but does not merge them
- SMTP email is plain text and follows the recipient language selected by the owner UI