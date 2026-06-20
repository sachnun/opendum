package proxy

import "testing"

func TestCommandCodeTierFromPlanID(t *testing.T) {
	cases := []struct {
		planID string
		label  string
		allow  float64
		known  bool
	}{
		{"individual-go", "go", 10, true},
		{"individual-max-10x", "max-10x", 150, true},
		{"individual-max-20x", "max-20x", 300, true},
		{"team-pro", "team-pro", 40, true},
		{"  INDIVIDUAL-GO ", "go", 10, true},
		{"", "free", 0, true},
		{"   ", "free", 0, true},
		{"individual-future", "individual-future", 0, false},
	}
	for _, c := range cases {
		label, allowance, known := commandCodeTierFromPlanID(c.planID)
		if label != c.label || known != c.known || allowance != c.allow {
			t.Fatalf("commandCodeTierFromPlanID(%q) = (%q, %v, %v), want (%q, %v, %v)", c.planID, label, allowance, known, c.label, c.allow, c.known)
		}
	}
}
