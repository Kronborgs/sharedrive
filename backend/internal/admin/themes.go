package admin

import (
	"bytes"
	"encoding/json"
	"errors"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"net/http"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/yourname/privatedrive/internal/httputil"
	_ "golang.org/x/image/webp"
)

const maxThemeImageBytes = 8 << 20

var themeAccent = regexp.MustCompile(`^#[a-fA-F0-9]{6}$`)
var removableBuiltInThemes = map[string]bool{
	"nordic-blue-hour": true, "vesterhavet": true, "nordic-forest": true, "arctic-night": true,
	"neon-80s": true, "cyberpunk-city": true, "vice-sunset": true, "dark-3d-glass": true,
	"retro-supercar": true, "deep-space-3d": true,
}

type uploadedTheme struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Accent string `json:"accent"`
}

type themeColors struct {
	Accent     string `json:"accent"`
	Background string `json:"background"`
	Panel      string `json:"panel"`
}

type availableThemes struct {
	Uploaded []uploadedTheme        `json:"uploaded"`
	Hidden   []string               `json:"hidden"`
	Colors   map[string]themeColors `json:"colors"`
}

func (h *Handler) ListThemes(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	ctx := r.Context()
	rows, err := h.db.Query(ctx, `SELECT 'custom-' || id::text, name, accent FROM sharedrive_themes ORDER BY name, id`)
	if err != nil {
		themeServerError(w)
		return
	}
	list, err := pgx.CollectRows(rows, pgx.RowToStructByPos[uploadedTheme])
	if err != nil {
		themeServerError(w)
		return
	}
	rows, err = h.db.Query(ctx, `SELECT id FROM hidden_sharedrive_themes ORDER BY id`)
	if err != nil {
		themeServerError(w)
		return
	}
	hidden, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		themeServerError(w)
		return
	}
	rows, err = h.db.Query(ctx, `SELECT theme_id, accent, background, panel FROM sharedrive_theme_accents`)
	if err != nil {
		themeServerError(w)
		return
	}
	defer rows.Close()
	colors := make(map[string]themeColors)
	for rows.Next() {
		var id string
		var color themeColors
		if err := rows.Scan(&id, &color.Accent, &color.Background, &color.Panel); err != nil {
			themeServerError(w)
			return
		}
		colors[id] = color
	}
	if rows.Err() != nil {
		themeServerError(w)
		return
	}
	httputil.Respond(w, http.StatusOK, availableThemes{Uploaded: list, Hidden: hidden, Colors: colors})
}

func customThemeID(value string) (uuid.UUID, bool) {
	id, ok := strings.CutPrefix(value, "custom-")
	if !ok {
		return uuid.Nil, false
	}
	key, err := uuid.Parse(id)
	return key, err == nil && key.String() == id
}

func (h *Handler) ThemeImage(w http.ResponseWriter, r *http.Request) {
	id, ok := customThemeID(chi.URLParam(r, "id"))
	if !ok {
		http.NotFound(w, r)
		return
	}
	var imageType string
	var imageData []byte
	err := h.db.QueryRow(r.Context(), `SELECT image_type, image_data FROM sharedrive_themes WHERE id = $1`, id).Scan(&imageType, &imageData)
	if errors.Is(err, pgx.ErrNoRows) {
		http.NotFound(w, r)
		return
	}
	if err != nil {
		themeServerError(w)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", imageType)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	_, _ = w.Write(imageData)
}

func validateThemeImage(data []byte) (string, error) {
	config, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || config.Width < 1 || config.Height < 1 || config.Width > 6000 ||
		config.Height > 6000 || config.Width*config.Height > 16_000_000 {
		return "", errors.New("invalid image or excessive dimensions")
	}
	switch format {
	case "jpeg", "png", "webp":
		_, _, err = image.Decode(bytes.NewReader(data))
		return "image/" + format, err
	default:
		return "", errors.New("unsupported image format")
	}
}

func readThemeUpload(w http.ResponseWriter, r *http.Request) (uploadedTheme, string, []byte, bool) {
	r.Body = http.MaxBytesReader(w, r.Body, maxThemeImageBytes+(64<<10))
	if err := r.ParseMultipartForm(maxThemeImageBytes); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "Choose a JPEG, PNG or WebP image up to 8 MiB")
		return uploadedTheme{}, "", nil, false
	}
	defer r.MultipartForm.RemoveAll()
	theme := uploadedTheme{Name: strings.TrimSpace(r.FormValue("name")), Accent: strings.ToLower(r.FormValue("accent"))}
	if theme.Name == "" || utf8.RuneCountInString(theme.Name) > 60 || strings.ContainsFunc(theme.Name, unicode.IsControl) || !themeAccent.MatchString(theme.Accent) {
		httputil.RespondError(w, http.StatusBadRequest, "Enter a theme name and a valid accent colour")
		return uploadedTheme{}, "", nil, false
	}
	file, header, err := r.FormFile("image")
	if err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "A theme image is required")
		return uploadedTheme{}, "", nil, false
	}
	defer file.Close()
	if header.Size > maxThemeImageBytes {
		httputil.RespondError(w, http.StatusRequestEntityTooLarge, "The theme image exceeds 8 MiB")
		return uploadedTheme{}, "", nil, false
	}
	data, err := io.ReadAll(file)
	if err != nil {
		themeServerError(w)
		return uploadedTheme{}, "", nil, false
	}
	imageType, err := validateThemeImage(data)
	if err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "Choose a valid JPEG, PNG or WebP image up to 6000 px and 16 megapixels")
		return uploadedTheme{}, "", nil, false
	}
	return theme, imageType, data, true
}

func (h *Handler) UploadTheme(w http.ResponseWriter, r *http.Request) {
	theme, imageType, data, ok := readThemeUpload(w, r)
	if !ok {
		return
	}
	id := uuid.New()
	_, err := h.db.Exec(r.Context(), `INSERT INTO sharedrive_themes (id, name, accent, image_type, image_data)
		VALUES ($1, $2, $3, $4, $5)`, id, theme.Name, theme.Accent, imageType, data)
	if err != nil {
		themeServerError(w)
		return
	}
	theme.ID = "custom-" + id.String()
	httputil.Respond(w, http.StatusCreated, theme)
}

func (h *Handler) UpdateThemeAccent(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var req themeColors
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || (!themeAccent.MatchString(req.Accent) || !themeAccent.MatchString(req.Background) || !themeAccent.MatchString(req.Panel)) {
		httputil.RespondError(w, http.StatusBadRequest, "Enter valid theme colours")
		return
	}
	if customID, ok := customThemeID(id); ok {
		var exists bool
		if err := h.db.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM sharedrive_themes WHERE id = $1)`, customID).Scan(&exists); err != nil {
			themeServerError(w)
			return
		} else if !exists {
			http.NotFound(w, r)
			return
		}
	} else if id != "classic-dark" && !removableBuiltInThemes[id] {
		http.NotFound(w, r)
		return
	}
	if _, err := h.db.Exec(r.Context(), `INSERT INTO sharedrive_theme_accents (theme_id, accent, background, panel) VALUES ($1, $2, $3, $4) ON CONFLICT (theme_id) DO UPDATE SET accent = EXCLUDED.accent, background = EXCLUDED.background, panel = EXCLUDED.panel`, id, strings.ToLower(req.Accent), strings.ToLower(req.Background), strings.ToLower(req.Panel)); err != nil {
		themeServerError(w)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) DeleteTheme(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "id")
	var err error
	if id, ok := customThemeID(name); ok {
		_, err = h.db.Exec(r.Context(), `WITH deleted AS (DELETE FROM sharedrive_themes WHERE id = $1 RETURNING id) DELETE FROM sharedrive_theme_accents WHERE theme_id = $2 AND EXISTS (SELECT 1 FROM deleted)`, id, name)
	} else if removableBuiltInThemes[name] {
		_, err = h.db.Exec(r.Context(), `INSERT INTO hidden_sharedrive_themes (id) VALUES ($1) ON CONFLICT DO NOTHING`, name)
	} else {
		http.NotFound(w, r)
		return
	}
	if err != nil {
		themeServerError(w)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) RestoreTheme(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "id")
	if !removableBuiltInThemes[name] {
		http.NotFound(w, r)
		return
	}
	if _, err := h.db.Exec(r.Context(), `DELETE FROM hidden_sharedrive_themes WHERE id = $1`, name); err != nil {
		themeServerError(w)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func themeServerError(w http.ResponseWriter) {
	httputil.RespondError(w, http.StatusInternalServerError, "Theme catalogue is unavailable")
}
