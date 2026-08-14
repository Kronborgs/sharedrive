# Sharedrive Rooms

Rooms are permanent, PostgreSQL-backed collaboration workspaces. Phase 1 provides Room metadata and membership only; it does not add chat, files, Notes, guests, or media.

## Phase 1 authorization

- A Room has one owner and may have moderators and members.
- Members may view the Room and its membership.
- Owners and moderators may rename a Room and manage members.
- Only owners may archive a Room.
- Moderators can add or remove members, but cannot add or remove moderators or owners.
- Archived Rooms are read-only.
- Platform administrators do not gain implicit Room membership or access. Any future administrative access must be an explicit, tested Room policy.

## Managed groups

Each Room has an internal, system-managed group. `room_members` is the source of truth; the group is a derived authorization adapter and is updated in the same transaction when Room membership changes. The normal group-admin API must not expose or mutate managed groups.

## Ownership and user deletion

Room ownership stays with an existing Sharedrive user in Phase 1. Deleting an owner is blocked until ownership transfer exists. Ownership transfer, workspace-owned files, quota semantics, WebDAV, OnlyOffice, previews, trash, and backup are separate designs and are deliberately not changed in this phase.

## Backup

Rooms are not exported or restored in Phase 1. Complete Room backup/restore support is Phase 7 work and must include Rooms, membership, chat, resources, reactions, read state, and safe handling of invite configuration without raw tokens or guest sessions.

## Next phases
