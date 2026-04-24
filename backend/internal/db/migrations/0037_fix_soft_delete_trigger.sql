-- +goose Up

-- Fix: the parent-owner trigger fired when SoftDelete cascaded owner_id changes
-- to descendants whose parent folder had already been soft-deleted in the same
-- transaction (deleted_at IS NOT NULL on the parent).  The trigger then failed
-- to find the parent (because of the AND deleted_at IS NULL guard), causing the
-- entire folder deletion to be rolled back with a 400 error.
--
-- Solution: skip the invariant check when the row itself is being soft-deleted.
-- There is no parent-ownership invariant to enforce when a file is being removed.

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION check_parent_owner_match()
RETURNS trigger AS $$
BEGIN
  -- If the file is being soft-deleted, the parent-ownership invariant no longer
  -- applies — the file is leaving the folder tree, not joining one.
  IF NEW.deleted_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.parent_id IS NOT NULL THEN
    -- Allow if parent is owned by same user
    IF EXISTS (
      SELECT 1 FROM files
      WHERE id = NEW.parent_id AND owner_id = NEW.owner_id AND deleted_at IS NULL
    ) THEN
      RETURN NEW;
    END IF;

    -- Allow if parent owner has a can_edit share for this user
    IF EXISTS (
      WITH RECURSIVE anc AS (
        SELECT id, parent_id FROM files WHERE id = NEW.parent_id AND deleted_at IS NULL
        UNION ALL
        SELECT f.id, f.parent_id FROM files f JOIN anc a ON f.id = a.parent_id WHERE f.deleted_at IS NULL
      )
      SELECT 1 FROM shares s
      JOIN anc a ON a.id = s.resource_id
      WHERE s.revoked_at IS NULL
        AND (s.expires_at IS NULL OR s.expires_at > now())
        AND s.can_edit = true
        AND (
          (s.grantee_type = 'user' AND s.grantee_id = NEW.owner_id)
          OR (s.grantee_type = 'group' AND s.grantee_id IN (
            SELECT group_id FROM group_members WHERE user_id = NEW.owner_id
          ))
        )
    ) THEN
      RETURN NEW;
    END IF;

    RAISE EXCEPTION 'parent folder % is not owned by user % and no edit share exists',
      NEW.parent_id, NEW.owner_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
-- +goose StatementEnd

-- +goose Down

-- Restore the previous (broken) version of the trigger function.
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION check_parent_owner_match()
RETURNS trigger AS $$
BEGIN
  IF NEW.parent_id IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM files
      WHERE id = NEW.parent_id AND owner_id = NEW.owner_id AND deleted_at IS NULL
    ) THEN
      RETURN NEW;
    END IF;

    IF EXISTS (
      WITH RECURSIVE anc AS (
        SELECT id, parent_id FROM files WHERE id = NEW.parent_id AND deleted_at IS NULL
        UNION ALL
        SELECT f.id, f.parent_id FROM files f JOIN anc a ON f.id = a.parent_id WHERE f.deleted_at IS NULL
      )
      SELECT 1 FROM shares s
      JOIN anc a ON a.id = s.resource_id
      WHERE s.revoked_at IS NULL
        AND (s.expires_at IS NULL OR s.expires_at > now())
        AND s.can_edit = true
        AND (
          (s.grantee_type = 'user' AND s.grantee_id = NEW.owner_id)
          OR (s.grantee_type = 'group' AND s.grantee_id IN (
            SELECT group_id FROM group_members WHERE user_id = NEW.owner_id
          ))
        )
    ) THEN
      RETURN NEW;
    END IF;

    RAISE EXCEPTION 'parent folder % is not owned by user % and no edit share exists',
      NEW.parent_id, NEW.owner_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
-- +goose StatementEnd
