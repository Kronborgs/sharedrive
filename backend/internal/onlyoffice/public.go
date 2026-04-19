package onlyoffice

import (
	"bytes"
	"fmt"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/yourname/privatedrive/internal/httputil"
)

// PublicGetEditorConfig returns OO editor config for link-share (guest) access.
// The file may be the share's root resource, or any descendant when the share
// resource is a folder.
//
//	GET /api/v1/public/onlyoffice/config/{fileId}?share_token=<token>
func (h *Handler) PublicGetEditorConfig(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	fileID := chi.URLParam(r, "fileId")
	shareToken := r.URL.Query().Get("share_token")
	if shareToken == "" {
		httputil.RespondError(w, http.StatusUnauthorized, "missing share_token")
		return
	}

	ooURL, jwtSecret, err := h.getSettings(ctx)
	if err != nil || ooURL == "" {
		httputil.RespondError(w, http.StatusServiceUnavailable, "OnlyOffice not configured")
		return
	}

	// Verify the share token and confirm the requested file is accessible via this share.
	// We walk the file's ancestor chain and check whether the share's resource_id
	// appears anywhere in it — this covers both direct-file shares and folder shares.
	var ownerID string
	var canEdit bool
	var fileName string
	err = h.db.QueryRow(ctx, `
		SELECT s.owner_id::text, s.can_edit, target.name
		  FROM shares s
		  JOIN files target ON target.id = $1::uuid
		 WHERE s.token = $2
		   AND s.revoked_at IS NULL
		   AND (s.expires_at IS NULL OR s.expires_at > now())
		   AND target.deleted_at IS NULL
		   AND EXISTS (
		     WITH RECURSIVE anc AS (
		       SELECT id, parent_id FROM files
		        WHERE id = $1::uuid AND deleted_at IS NULL
		       UNION ALL
		       SELECT f.id, f.parent_id FROM files f
		       JOIN anc ON f.id = anc.parent_id
		        WHERE f.deleted_at IS NULL
		     )
		     SELECT 1 FROM anc WHERE id = s.resource_id
		   )`,
		fileID, shareToken,
	).Scan(&ownerID, &canEdit, &fileName)
	if err != nil {
		httputil.RespondError(w, http.StatusNotFound, "file not accessible via this share")
		return
	}

	ext := strings.ToLower(strings.TrimPrefix(filepath.Ext(fileName), "."))
	docKey := h.getOrCreateDocKey(ctx, fileID)

	downloadURL := fmt.Sprintf("%s/api/v1/onlyoffice/download/%s", h.appBase, fileID)
	if jwtSecret != "" {
		dlTokenPayload := map[string]any{
			"file_id": fileID,
			"sub":     "guest:" + shareToken,
			"exp":     time.Now().Add(6 * time.Hour).Unix(),
		}
		if dlTok, signErr := signJWT(dlTokenPayload, jwtSecret); signErr == nil {
			downloadURL += "?token=" + dlTok
		}
	}

	mode := "edit"
	if !canEdit {
		mode = "view"
	}
	guestID := "guest"
	if len(shareToken) >= 8 {
		guestID = "guest:" + shareToken[:8]
	}

	cfg := editorConfig{
		Document: docSection{
			FileType:    ext,
			Key:         docKey,
			Title:       fileName,
			URL:         downloadURL,
			Permissions: docPerms{Edit: canEdit, Download: true},
		},
		DocumentType: documentType(fileName),
		EditorConfig: editorSection{
			CallbackURL: fmt.Sprintf("%s/api/v1/onlyoffice/callback/%s", h.appBase, fileID),
			Lang:        "da",
			Mode:        mode,
			User:        edUser{ID: guestID, Name: "Gæst"},
			Plugins:     edPlugins{PluginsData: []string{}},
		},
	}

	if jwtSecret != "" {
		tok, signErr := signJWT(cfg, jwtSecret)
		if signErr != nil {
			httputil.RespondError(w, http.StatusInternalServerError, "jwt error")
			return
		}
		cfg.Token = tok
	}

	httputil.Respond(w, http.StatusOK, cfg)
}

// PublicCreateDocument creates a blank document inside a shared folder.
// The share token must grant edit access to the specified parent folder (or an
// ancestor of it).
//
//	POST /api/v1/public/onlyoffice/create?share_token=<token>
//	Body: {"type":"word"|"cell"|"slide","name":"filename.docx","parent_id":"<uuid>"}
func (h *Handler) PublicCreateDocument(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	shareToken := r.URL.Query().Get("share_token")
	if shareToken == "" {
		httputil.RespondError(w, http.StatusUnauthorized, "missing share_token")
		return
	}

	var req struct {
		DocType  string `json:"type"`
		Name     string `json:"name"`
		ParentID string `json:"parent_id"`
	}
	if err := jsonDecode(r, &req); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "invalid body")
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" {
		httputil.RespondError(w, http.StatusBadRequest, "name is required")
		return
	}

	// Resolve document type → extension, MIME, generator.
	var ext, mime string
	var gen func() ([]byte, error)
	switch req.DocType {
	case "word":
		ext, mime, gen = "docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", blankDocx
	case "cell":
		ext, mime, gen = "xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", blankXlsx
	case "slide":
		ext, mime, gen = "pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation", blankPptx
	default:
		httputil.RespondError(w, http.StatusBadRequest, "type must be word, cell, or slide")
		return
	}
	if !strings.HasSuffix(strings.ToLower(req.Name), "."+ext) {
		req.Name += "." + ext
	}

	// Verify the share grants edit access and the target parent is within the shared subtree.
	var ownerID string
	var canEdit bool
	err := h.db.QueryRow(ctx, `
		SELECT s.owner_id::text, s.can_edit
		  FROM shares s
		  JOIN files f ON f.id = s.resource_id
		 WHERE s.token = $1
		   AND s.revoked_at IS NULL
		   AND (s.expires_at IS NULL OR s.expires_at > now())
		   AND f.deleted_at IS NULL
		   AND f.is_folder = true
		   AND EXISTS (
		     WITH RECURSIVE anc AS (
		       SELECT id, parent_id FROM files
		        WHERE id = $2::uuid AND deleted_at IS NULL
		       UNION ALL
		       SELECT fi.id, fi.parent_id FROM files fi
		       JOIN anc ON fi.id = anc.parent_id
		        WHERE fi.deleted_at IS NULL
		     )
		     SELECT 1 FROM anc WHERE id = s.resource_id
		   )`,
		shareToken, req.ParentID,
	).Scan(&ownerID, &canEdit)
	if err != nil || !canEdit {
		httputil.RespondError(w, http.StatusForbidden, "no edit access via this share")
		return
	}

	data, err := gen()
	if err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "failed to generate document")
		return
	}

	newID := uuid.New()
	storagePath := h.storage.Path(newID.String())

	if _, err := h.storage.Write(newID.String(), bytes.NewReader(data)); err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "storage write failed")
		return
	}

	type newFileRow struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	var result newFileRow
	err = h.db.QueryRow(ctx,
		`INSERT INTO files (id, owner_id, parent_id, is_folder, name, mime_type, size_bytes, storage_path)
		 VALUES ($1, $2::uuid, $3::uuid, false, $4, $5, $6, $7)
		 RETURNING id::text, name`,
		newID, ownerID, req.ParentID, req.Name, mime, int64(len(data)), storagePath,
	).Scan(&result.ID, &result.Name)
	if err != nil {
		_ = h.storage.Delete(newID.String())
		httputil.RespondError(w, http.StatusInternalServerError, "db insert failed")
		return
	}

	httputil.Respond(w, http.StatusCreated, result)
}
