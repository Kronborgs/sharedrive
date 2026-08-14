package rooms

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDecodeRequestRejectsUnknownFields(t *testing.T) {
	t.Parallel()

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/v1/rooms", strings.NewReader(`{"name":"Alpha","unexpected":true}`))
	var input createRoomRequest

	if decodeRequest(recorder, request, &input) {
		t.Fatal("decodeRequest() accepted an unknown field")
	}
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusBadRequest)
	}
}

func TestHandlerRespondErrorUsesPublicStatuses(t *testing.T) {
	t.Parallel()

	tests := []struct {
		err  error
		want int
	}{
		{ErrInvalidName, http.StatusBadRequest},
		{ErrNotFound, http.StatusNotFound},
		{ErrForbidden, http.StatusForbidden},
		{ErrArchived, http.StatusConflict},
	}

	for _, test := range tests {
		recorder := httptest.NewRecorder()
		(&Handler{}).respondError(recorder, test.err)
		if recorder.Code != test.want {
			t.Fatalf("respondError(%v) status = %d, want %d", test.err, recorder.Code, test.want)
		}
	}
}
