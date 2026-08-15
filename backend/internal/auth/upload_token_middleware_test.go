package auth

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestUploadTokenMiddlewareRejectsExplicitInvalidToken(t *testing.T) {
	called := false
	handler := (&Handler{}).UploadTokenMiddleware(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		called = true
	}))
	request := httptest.NewRequest(http.MethodPost, "/upload/", nil)
	request.Header.Set("X-Upload-Token", "invalid")
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if called {
		t.Fatal("invalid explicit upload token must not fall through to session authentication")
	}
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusUnauthorized)
	}
}

func TestUploadTokenMiddlewareAllowsRequestWithoutExplicitToken(t *testing.T) {
	called := false
	handler := (&Handler{}).UploadTokenMiddleware(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		called = true
	}))
	request := httptest.NewRequest(http.MethodPost, "/upload/", nil)

	handler.ServeHTTP(httptest.NewRecorder(), request)

	if !called {
		t.Fatal("request without explicit upload token must continue to normal session middleware")
	}
}
