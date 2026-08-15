# Sharedrive Rooms

Rooms are permanent, PostgreSQL-backed collaboration workspaces. Phase 1 provides Room metadata and membership only; it does not add chat, files, Notes, guests, or media.

## Phase 1 authorization

- A Room has one owner and may have moderators and members.
- Members may view the Room and its membership.
- Owners and moderators may rename a Room and manage members.
- Only owners may archive a Room.
- Moderators can add or remove members, but cannot add or remove moderators or owners.
- Archived Rooms are read-only.
- Platform administrators do not gain implicit Room membership or general Room access. They do have the explicit moderation right to delete any Room chat message when they can access that Room.

## Chat moderation

- Message authors may edit and delete their own messages.
- Room owners and Room moderators may delete every message in their Room, including guest messages, but may not edit other authors' messages.
- Sharedrive platform administrators may delete every Room message. This is a platform-wide moderation right; the Room moderator role remains scoped to the individual Room.
- Deletion is a soft delete: the message body is replaced by the deleted-message state in the UI.
- Room reaction graphics use the pinned OpenMoji release from the frontend dependency lock. OpenMoji graphics are credited in the Room chat and licensed under CC BY-SA 4.0.

## Managed groups

Each Room has an internal, system-managed group. `room_members` is the source of truth; the group is a derived authorization adapter and is updated in the same transaction when Room membership changes. The normal group-admin API must not expose or mutate managed groups.

## Ownership and user deletion

Room ownership stays with an existing Sharedrive user in Phase 1. Deleting an owner is blocked until ownership transfer exists. Ownership transfer, workspace-owned files, quota semantics, WebDAV, OnlyOffice, previews, trash, and backup are separate designs and are deliberately not changed in this phase.

## Backup

Rooms are not exported or restored in Phase 1. Complete Room backup/restore support is Phase 7 work and must include Rooms, membership, chat, resources, reactions, read state, and safe handling of invite configuration without raw tokens or guest sessions.

## Next phases
