-- +goose Up

-- Prevent mixed-owner parent/child insertion at the DB level.
-- A file's parent (if non-null) must either:
--   1. Be owned by the same user, OR
--   2. The parent's owner has shared the folder with can_edit to the child's owner.
-- This trigger enforces invariant #1 (same-owner) for all inserts/updates.
-- Shared-folder writes are handled by the application AuthorizeParentWrite check.
CREATE OR REPLACE FUNCTION check_parent_owner_match()
RETURNS trigger AS $$
BEGIN
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

DROP TRIGGER IF EXISTS trg_check_parent_owner ON files;
CREATE TRIGGER trg_check_parent_owner
  BEFORE INSERT OR UPDATE OF parent_id, owner_id ON files
  FOR EACH ROW
  EXECUTE FUNCTION check_parent_owner_match();

-- +goose Down
DROP TRIGGER IF EXISTS trg_check_parent_owner ON files;
DROP FUNCTION IF EXISTS check_parent_owner_match;
