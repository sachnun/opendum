package providers

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	appdb "github.com/opendum/opendum/apps/proxy/internal/db"
)

func makeTestJWT(exp time.Time) string {
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"HS256"}`))
	payloadJSON, _ := json.Marshal(map[string]any{"exp": exp.Unix()})
	payload := base64.RawURLEncoding.EncodeToString(payloadJSON)
	return header + "." + payload + ".signature"
}

func TestMimoCodeAuthless(t *testing.T) {
	if !(mimoCodeProvider{}).Authless() {
		t.Fatal("mimoCodeProvider.Authless() = false, want true")
	}
}

func TestMimoCodeBuildsRequestAndInjectsMarker(t *testing.T) {
	resetMimoCodeJWT()
	mimoCodeCachedJWT = makeTestJWT(time.Now().Add(time.Hour))
	mimoCodeJWTExpires = time.Now().Add(time.Hour)

	var bootstrapHits int
	var chatReq *http.Request
	var chatBody map[string]any
	client := &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		switch req.URL.Path {
		case "/api/free-ai/bootstrap":
			bootstrapHits++
			return jsonTestResponse(http.StatusOK, `{"jwt":"`+mimoCodeCachedJWT+`"}`), nil
		case "/api/free-ai/openai/chat":
			chatReq = req
			if err := json.NewDecoder(req.Body).Decode(&chatBody); err != nil {
				t.Fatalf("decode chat body: %v", err)
			}
			return jsonTestResponse(http.StatusOK, `{"id":"resp","choices":[{"message":{"content":"ok"}}]}`), nil
		}
		t.Fatalf("unexpected request: %s %s", req.Method, req.URL.Path)
		return nil, nil
	})}

	resp, err := mimoCodeProvider{}.MakeRequest(t.Context(), client, "", appdb.ProviderAccount{}, map[string]any{
		"model":    "mimo_code/mimo-auto",
		"messages": []any{map[string]any{"role": "user", "content": "hi"}},
	}, false)
	if err != nil {
		t.Fatalf("MakeRequest err: %v", err)
	}
	defer resp.Body.Close()

	if bootstrapHits != 0 {
		t.Fatalf("bootstrap called %d times despite cached jwt", bootstrapHits)
	}
	if chatReq == nil {
		t.Fatal("chat request was not captured")
	}
	if auth := chatReq.Header.Get("Authorization"); auth != "Bearer "+mimoCodeCachedJWT {
		t.Fatalf("Authorization = %q, want Bearer <jwt>", auth)
	}
	if got := chatReq.Header.Get("X-Mimo-Source"); got != mimoCodeSource {
		t.Fatalf("X-Mimo-Source = %q, want %q", got, mimoCodeSource)
	}
	if aff := chatReq.Header.Get("x-session-affinity"); !strings.HasPrefix(aff, mimoCodeSessionPrefix) || len(aff) != len(mimoCodeSessionPrefix)+mimoCodeSessionLen {
		t.Fatalf("x-session-affinity = %q, want prefix %q and length %d", aff, mimoCodeSessionPrefix, len(mimoCodeSessionPrefix)+mimoCodeSessionLen)
	}
	msgs, _ := chatBody["messages"].([]any)
	if len(msgs) != 2 {
		t.Fatalf("messages len = %d, want 2 (system marker + user)", len(msgs))
	}
	first, ok := msgs[0].(map[string]any)
	if !ok {
		t.Fatalf("first message not a map: %#v", msgs[0])
	}
	if role, _ := first["role"].(string); role != "system" {
		t.Fatalf("first role = %q, want system", role)
	}
	if content, _ := first["content"].(string); !strings.Contains(content, mimoCodeSystemMarker) {
		t.Fatalf("system content missing marker: %q", content)
	}
}

func TestMimoCodeIdempotentMarkerInjection(t *testing.T) {
	body := map[string]any{
		"messages": []any{
			map[string]any{"role": "system", "content": mimoCodeSystemMarker},
			map[string]any{"role": "user", "content": "hi"},
		},
	}
	injectMimoCodeSystemMarker(body)
	msgs := body["messages"].([]any)
	if len(msgs) != 2 {
		t.Fatalf("messages len = %d, want 2 (no duplicate)", len(msgs))
	}
}

func TestMimoCodeRetriesOnAuthFailureWithFreshJWT(t *testing.T) {
	resetMimoCodeJWT()
	staleJWT := makeTestJWT(time.Now().Add(10 * time.Minute))
	mimoCodeCachedJWT = staleJWT
	mimoCodeJWTExpires = time.Now().Add(10 * time.Minute)

	var bootstrapHits, chatHits int
	var lastAuth string
	freshJWT := makeTestJWT(time.Now().Add(time.Hour))
	client := &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		switch req.URL.Path {
		case "/api/free-ai/bootstrap":
			bootstrapHits++
			return jsonTestResponse(http.StatusOK, `{"jwt":"`+freshJWT+`"}`), nil
		case "/api/free-ai/openai/chat":
			chatHits++
			lastAuth = req.Header.Get("Authorization")
			if chatHits == 1 {
				return &http.Response{StatusCode: http.StatusUnauthorized, Status: "401 Unauthorized", Body: http.NoBody, Header: http.Header{}}, nil
			}
			return jsonTestResponse(http.StatusOK, `{"choices":[{"message":{"content":"ok"}}]}`), nil
		}
		t.Fatalf("unexpected request: %s %s", req.Method, req.URL.Path)
		return nil, nil
	})}

	resp, err := mimoCodeProvider{}.MakeRequest(t.Context(), client, "", appdb.ProviderAccount{}, map[string]any{
		"model":    "mimo_code/mimo-auto",
		"messages": []any{map[string]any{"role": "user", "content": "hi"}},
	}, false)
	if err != nil {
		t.Fatalf("MakeRequest err: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("final status = %d, want 200", resp.StatusCode)
	}
	if chatHits != 2 {
		t.Fatalf("chat hits = %d, want 2 (initial + retry)", chatHits)
	}
	if bootstrapHits != 1 {
		t.Fatalf("bootstrap hits = %d, want 1 (retry only)", bootstrapHits)
	}
	if lastAuth != "Bearer "+freshJWT {
		t.Fatalf("retry auth = %q, want Bearer <freshJWT>", lastAuth)
	}
}

func TestMimoCodeBootstrapRefreshesStaleCache(t *testing.T) {
	resetMimoCodeJWT()
	mimoCodeCachedJWT = makeTestJWT(time.Now().Add(time.Minute))
	mimoCodeJWTExpires = time.Now().Add(time.Minute)

	var bootstrapHits int
	freshJWT := makeTestJWT(time.Now().Add(time.Hour))
	client := &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		bootstrapHits++
		return jsonTestResponse(http.StatusOK, `{"jwt":"`+freshJWT+`"}`), nil
	})}

	if _, err := bootstrapMimoCodeJWT(t.Context(), client); err != nil {
		t.Fatalf("bootstrap err: %v", err)
	}
	if bootstrapHits != 1 {
		t.Fatalf("bootstrap hits = %d, want 1 (stale cache must refresh)", bootstrapHits)
	}
	if mimoCodeCachedJWT != freshJWT {
		t.Fatalf("cached jwt not replaced")
	}
}
