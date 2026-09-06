package providers

import (
	"reflect"
	"testing"
)

const antigravityHTMLFixture = `<h1>Models</h1>
<h2 id="reasoning-model">Reasoning Model</h2>
<table>
<tr><th>Model</th><th>Context</th></tr>
<tr><td><strong>Gemini 3.5 Flash</strong></td><td>1M</td></tr>
<tr><td><code>Claude Sonnet 4.6</code></td><td>200K</td></tr>
</table>
<h2>Other section</h2>
<p>unrelated</p>`

func TestAntigravityMarkdown(t *testing.T) {
	got := antigravityMarkdown(antigravityHTMLFixture)
	want := "## Reasoning Model\n\n| Model | Context |\n| Gemini 3.5 Flash | 1M |\n| Claude Sonnet 4.6 | 200K |\n"
	if got != want {
		t.Errorf("antigravityMarkdown:\n got: %q\nwant: %q", got, want)
	}
}

func TestAntigravityParseNames(t *testing.T) {
	markdown := "## Reasoning Model\n\n| Model | Context |\n|-------|---------|\n| Gemini 3.5 Flash | 1M |\n| Claude Sonnet 4.6 | 200K |\n"
	got, err := antigravityParseNames(markdown)
	if err != nil {
		t.Fatalf("antigravityParseNames: %v", err)
	}
	want := []string{"Gemini 3.5 Flash", "Claude Sonnet 4.6"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %v, want %v", got, want)
	}
}

func TestAntigravityParseNamesRoundTrip(t *testing.T) {
	markdown := antigravityMarkdown(antigravityHTMLFixture)
	names, err := antigravityParseNames(markdown)
	if err != nil {
		t.Fatalf("round trip: %v", err)
	}
	if len(names) != 2 {
		t.Fatalf("expected 2 names, got %v", names)
	}
}

func TestAntigravityParseNamesMissingSection(t *testing.T) {
	if _, err := antigravityParseNames("## Something else\n\n| A | B |"); err == nil {
		t.Fatal("expected error for missing Reasoning Model section")
	}
}

func TestAntigravityIDFromDisplay(t *testing.T) {
	cases := map[string]string{
		"Gemini 3.5 Flash":  "gemini-3.5-flash",
		"Claude Sonnet 4.6": "claude-sonnet-4-6",
		"GPT-OSS-120b":      "gpt-oss-120b",
		"Claude Opus 4.6":   "claude-opus-4-6",
	}
	for input, want := range cases {
		if got := antigravityIDFromDisplay(input); got != want {
			t.Errorf("antigravityIDFromDisplay(%q) = %q, want %q", input, got, want)
		}
	}
}
