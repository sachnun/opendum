package models

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func writeModelFile(t *testing.T, dir, name string, body map[string]any) {
	t.Helper()
	data, err := json.MarshalIndent(body, "", "  ")
	if err != nil {
		t.Fatalf("marshal %s: %v", name, err)
	}
	if err := os.WriteFile(filepath.Join(dir, name+".json"), data, 0o644); err != nil {
		t.Fatalf("write %s: %v", name, err)
	}
}

func TestFormatModelsForOpenAI(t *testing.T) {
	t.Parallel()
	reasoningOff := false
	registry := &Registry{effective: map[string]Info{
		"m1": {
			ID:              "m1",
			Providers:       []string{"p1"},
			Owner:           "owner1",
			ReasoningEffort: []string{"low", "high"},
			Modalities:      &Modalities{Input: []string{"text", "image"}, Output: []string{"text"}},
			Limit:           &Limit{Context: 100, Output: 50},
		},
		"m2": {ID: "m2", Providers: []string{"p2"}, Reasoning: &reasoningOff},
		"m3": {ID: "m3"},
		"m4": {ID: "m4", Providers: []string{"p4"}, Limit: &Limit{}},
	}}

	data := registry.FormatModelsForOpenAI()
	if len(data) != 3 {
		t.Fatalf("len = %d, want 3 (models without providers excluded)", len(data))
	}
	byID := map[string]map[string]any{}
	order := []string{}
	for _, item := range data {
		id, _ := item["id"].(string)
		byID[id] = item
		order = append(order, id)
	}
	for i, want := range []string{"m1", "m2", "m4"} {
		if order[i] != want {
			t.Fatalf("order = %v, want sorted [m1 m2 m4]", order)
		}
	}

	m1 := byID["m1"]
	if m1["object"] != "model" {
		t.Fatalf("m1 object = %v", m1["object"])
	}
	if m1["owner"] != "owner1" {
		t.Fatalf("m1 owner = %v", m1["owner"])
	}
	if m1["reasoning"] != true {
		t.Fatalf("m1 reasoning = %v, want true (default)", m1["reasoning"])
	}
	if m1["reasoning_effort"] == nil {
		t.Fatal("m1 reasoning_effort missing")
	}
	if m1["modalities"] == nil {
		t.Fatal("m1 modalities missing")
	}
	if m1["limit"] == nil {
		t.Fatal("m1 limit missing")
	}

	m2 := byID["m2"]
	if m2["reasoning"] != false {
		t.Fatalf("m2 reasoning = %v, want false", m2["reasoning"])
	}
	for _, key := range []string{"reasoning_effort", "modalities", "limit", "owner"} {
		if _, ok := m2[key]; ok {
			t.Fatalf("m2 should omit %q", key)
		}
	}

	if _, ok := byID["m4"]["limit"]; ok {
		t.Fatal("m4 should omit zero-valued limit")
	}
}

func TestLoadResolvesAliasesAndCanonicalWins(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	writeModelFile(t, dir, "canonical-a", map[string]any{
		"providers": []string{"mockprov"},
		"aliases":   []string{"alias-a", "alias-b"},
	})
	writeModelFile(t, dir, "canonical-b", map[string]any{
		"providers": []string{"mockprov"},
		"aliases":   []string{"shadowed"},
	})
	writeModelFile(t, dir, "shadowed", map[string]any{
		"providers": []string{"mockprov"},
	})

	registry, err := Load(dir)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if got := registry.ResolveAlias("alias-a"); got != "canonical-a" {
		t.Fatalf("ResolveAlias(alias-a) = %q, want canonical-a", got)
	}
	if got := registry.ResolveAlias("alias-b"); got != "canonical-a" {
		t.Fatalf("ResolveAlias(alias-b) = %q, want canonical-a", got)
	}
	if got := registry.ResolveAlias("shadowed"); got != "shadowed" {
		t.Fatalf("canonical id must win alias: got %q, want shadowed", got)
	}

	keys := registry.LookupKeys("alias-a")
	want := map[string]bool{"canonical-a": true, "alias-a": true, "alias-b": true}
	if len(keys) != len(want) {
		t.Fatalf("LookupKeys = %v, want %v", keys, want)
	}
	for _, key := range keys {
		if !want[key] {
			t.Fatalf("LookupKeys = %v, want %v", keys, want)
		}
	}
}
