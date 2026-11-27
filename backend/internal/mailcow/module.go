package mailcow

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/yourname/privatedrive/internal/httputil"
)

const moduleSetting = "mailcow_enabled"

type Module struct {
	db *pgxpool.Pool
}

func NewModule(db *pgxpool.Pool) Module {
	return Module{db: db}
}

func (m Module) Enabled(ctx context.Context) (bool, error) {
	var value string
	err := m.db.QueryRow(ctx, "SELECT value FROM system_settings WHERE key = $1", moduleSetting).Scan(&value)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return value == "true", err
}

func (m Module) Update(w http.ResponseWriter, r *http.Request) {
	w.Header().Set(cacheControlHeader, noStore)
	if !isJSON(r) {
		httputil.RespondError(w, http.StatusUnsupportedMediaType, "Mailcow requests must use application/json")
		return
	}
	var body struct {
		Enabled *bool `json:"enabled"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&body) != nil || decoder.Decode(new(json.RawMessage)) != io.EOF || body.Enabled == nil {
		httputil.RespondError(w, http.StatusBadRequest, "Invalid Mailcow setting")
		return
	}
	_, err := m.db.Exec(r.Context(), `INSERT INTO system_settings (key, value) VALUES ($1, $2)
		ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
		moduleSetting, strconv.FormatBool(*body.Enabled))
	if err != nil {
		accountError(w)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Accounts) Feature(w http.ResponseWriter, r *http.Request) {
	h.featureStatus(w, r, false)
}

func (h *Accounts) AdminFeature(w http.ResponseWriter, r *http.Request) {
	h.featureStatus(w, r, true)
}

func (h *Accounts) featureStatus(w http.ResponseWriter, r *http.Request, checkService bool) {
	if _, ok := accountOwner(w, r); !ok {
		return
	}
	enabled, err := h.moduleEnabled(r.Context())
	if err != nil {
		accountError(w)
		return
	}
	ready := h.ready() && (!checkService || h.probe.healthy(r.Context()))
	httputil.Respond(w, http.StatusOK, map[string]bool{"enabled": enabled, "ready": ready})
}

func (p *Probe) healthy(ctx context.Context) bool {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	target := strings.TrimSuffix(p.target, "/internal/v1/probe") + "/healthz"
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return false
	}
	response, err := p.client.Do(request)
	if err != nil {
		return false
	}
	defer response.Body.Close()
	return response.StatusCode == http.StatusOK
}

func (h *Accounts) requireModule(w http.ResponseWriter, r *http.Request) bool {
	enabled, err := h.moduleEnabled(r.Context())
	if err != nil {
		accountError(w)
		return false
	}
	if !enabled || !h.ready() {
		httputil.RespondError(w, http.StatusServiceUnavailable, "Mailcow account linking is unavailable")
		return false
	}
	return true
}
