package onlyoffice

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/google/uuid"

	"github.com/yourname/privatedrive/internal/httputil"
	"github.com/yourname/privatedrive/internal/middleware"
)

// ─── Blank document generators ───────────────────────────────────────────────

type zipEntry struct{ name, content string }

func buildZip(entries []zipEntry) ([]byte, error) {
	var buf bytes.Buffer
	w := zip.NewWriter(&buf)
	for _, e := range entries {
		f, err := w.Create(e.name)
		if err != nil {
			return nil, err
		}
		if _, err := f.Write([]byte(e.content)); err != nil {
			return nil, err
		}
	}
	if err := w.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func blankDocx() ([]byte, error) {
	return buildZip([]zipEntry{
		{"[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
			`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
			`<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
			`<Default Extension="xml" ContentType="application/xml"/>` +
			`<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
			`</Types>`},
		{"_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
			`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
			`<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
			`</Relationships>`},
		{"word/_rels/document.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
			`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`},
		{"word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
			`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
			`<w:body><w:p/><w:sectPr/></w:body></w:document>`},
	})
}

func blankXlsx() ([]byte, error) {
	return buildZip([]zipEntry{
		{"[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
			`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
			`<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
			`<Default Extension="xml" ContentType="application/xml"/>` +
			`<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
			`<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
			`</Types>`},
		{"_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
			`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
			`<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
			`</Relationships>`},
		{"xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
			`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
			`<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
			`</Relationships>`},
		{"xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
			`<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
			`<sheets><sheet name="Ark1" sheetId="1" r:id="rId1"/></sheets></workbook>`},
		{"xl/worksheets/sheet1.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
			`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>`},
	})
}

func blankPptx() ([]byte, error) {
	const pns = `xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"`
	const ans = `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"`
	const rns = `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`

	emptySpTree := `<p:spTree>` +
		`<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
		`<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>` +
		`<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>` +
		`</p:spTree>`

	return buildZip([]zipEntry{
		{"[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
			`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
			`<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
			`<Default Extension="xml" ContentType="application/xml"/>` +
			`<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>` +
			`<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>` +
			`<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>` +
			`<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>` +
			`</Types>`},
		{"_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
			`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
			`<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>` +
			`</Relationships>`},
		{"ppt/_rels/presentation.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
			`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
			`<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>` +
			`<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>` +
			`</Relationships>`},
		{"ppt/presentation.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
			`<p:presentation ` + pns + ` ` + ans + ` ` + rns + `>` +
			`<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>` +
			`<p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst>` +
			`<p:sldSz cx="9144000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/>` +
			`</p:presentation>`},
		{"ppt/slides/_rels/slide1.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
			`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
			`<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>` +
			`</Relationships>`},
		{"ppt/slides/slide1.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
			`<p:sld ` + pns + ` ` + ans + ` ` + rns + `>` +
			`<p:cSld>` + emptySpTree + `</p:cSld>` +
			`<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>` +
			`</p:sld>`},
		{"ppt/slideLayouts/_rels/slideLayout1.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
			`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
			`<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>` +
			`</Relationships>`},
		{"ppt/slideLayouts/slideLayout1.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
			`<p:sldLayout ` + pns + ` ` + ans + ` ` + rns + ` type="blank">` +
			`<p:cSld name="Blank">` + emptySpTree + `</p:cSld>` +
			`<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>` +
			`</p:sldLayout>`},
		{"ppt/slideMasters/_rels/slideMaster1.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
			`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
			`<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>` +
			`</Relationships>`},
		{"ppt/slideMasters/slideMaster1.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
			`<p:sldMaster ` + pns + ` ` + ans + ` ` + rns + `>` +
			`<p:cSld>` + emptySpTree + `</p:cSld>` +
			`<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>` +
			`<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>` +
			`<p:txStyles><p:titleStyle><a:lstStyle/></p:titleStyle><p:bodyStyle><a:lstStyle/></p:bodyStyle><p:otherStyle><a:lstStyle/></p:otherStyle></p:txStyles>` +
			`</p:sldMaster>`},
	})
}

// ─── POST /api/v1/onlyoffice/create ─────────────────────────────────────────

// CreateDocument creates a blank Word/Excel/PowerPoint file in the user's
// folder and returns the new file's metadata so the frontend can immediately
// open it with GetEditorConfig.
//
// Body (JSON):
//
//	{ "type": "word"|"cell"|"slide", "name": "document.docx", "parent_id": "<uuid>|null" }
func (h *Handler) CreateDocument(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	actor := middleware.UserFromContext(ctx)

	var req struct {
		DocType  string  `json:"type"`
		Name     string  `json:"name"`
		ParentID *string `json:"parent_id"`
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

	// Enforce correct extension based on type
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

	data, err := gen()
	if err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "failed to generate document")
		return
	}

	// Validate parent: user must own it or have edit access via a share
	// (including ancestor folder shares).
	var folderOwnerID string
	if req.ParentID != nil && *req.ParentID != "" {
		err := h.db.QueryRow(ctx, `
			WITH RECURSIVE anc AS (
			  SELECT id, parent_id FROM files WHERE id = $1::uuid AND deleted_at IS NULL
			  UNION ALL
			  SELECT p.id, p.parent_id FROM files p
			  JOIN anc ON p.id = anc.parent_id
			  WHERE p.deleted_at IS NULL
			)
			SELECT f.owner_id::text
			  FROM files f
			 WHERE f.id = $1::uuid AND f.is_folder = true AND f.deleted_at IS NULL
			   AND (
			     f.owner_id = $2::uuid
			     OR EXISTS(
			       SELECT 1 FROM shares sh
			       JOIN anc ON sh.resource_id = anc.id
			       WHERE sh.can_edit = true
			         AND sh.revoked_at IS NULL
			         AND (sh.expires_at IS NULL OR sh.expires_at > now())
			         AND (
			           (sh.grantee_type = 'user'  AND sh.grantee_id = $2::uuid)
			           OR (sh.grantee_type = 'group' AND sh.grantee_id IN (
			                 SELECT group_id FROM group_members WHERE user_id = $2::uuid
			           ))
			         )
			     )
			   )`,
			*req.ParentID, actor.ID.String(),
		).Scan(&folderOwnerID)
		if err != nil {
			httputil.RespondError(w, http.StatusForbidden, "invalid parent folder")
			return
		}
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

	var parentParam *string
	if req.ParentID != nil && *req.ParentID != "" {
		parentParam = req.ParentID
	}

	// When creating inside a shared folder, the file must be owned by the folder
	// owner so it stays in the correct storage tree.
	fileOwner := actor.ID.String()
	if folderOwnerID != "" {
		fileOwner = folderOwnerID
	}

	err = h.db.QueryRow(ctx,
		`INSERT INTO files (id, owner_id, parent_id, is_folder, name, mime_type, size_bytes, storage_path)
		 VALUES ($1, $2::uuid, $3::uuid, false, $4, $5, $6, $7)
		 RETURNING id::text, name`,
		newID, fileOwner, parentParam, req.Name, mime, int64(len(data)), storagePath,
	).Scan(&result.ID, &result.Name)
	if err != nil {
		_ = h.storage.Delete(newID.String())
		httputil.RespondError(w, http.StatusInternalServerError, fmt.Sprintf("db insert: %v", err))
		return
	}

	httputil.Respond(w, http.StatusCreated, result)
}

// jsonDecode is a small helper to decode a JSON request body.
func jsonDecode(r *http.Request, dst any) error {
	return json.NewDecoder(r.Body).Decode(dst)
}
