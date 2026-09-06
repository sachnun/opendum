package providers

import "testing"

func TestRegistryNamesUnique(t *testing.T) {
	seen := map[string]bool{}
	for _, name := range Names() {
		if seen[name] {
			t.Fatalf("duplicate provider name in registry: %s", name)
		}
		seen[name] = true
	}
}

func TestRegistryAllMatchesNames(t *testing.T) {
	all := All()
	if len(all) == 0 {
		t.Fatal("expected at least one registered provider")
	}
	if len(all) != len(Names()) {
		t.Fatalf("All() returned %d providers, Names() reported %d", len(all), len(Names()))
	}
	for i, p := range all {
		if p.Name() != Names()[i] {
			t.Fatalf("provider order mismatch: All()[%d] = %q, Names()[%d] = %q", i, p.Name(), i, Names()[i])
		}
	}
}
