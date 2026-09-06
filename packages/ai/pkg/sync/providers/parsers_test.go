package providers

import (
	"reflect"
	"testing"
)

func TestWorkersAINormalizeKey(t *testing.T) {
	cases := map[string]string{
		"@cf/openai/gpt-4o":      "openai-gpt-4o",
		"@cf/qwen/qwen3-32b":     "qwen-qwen3",
		"@hf/meta/llama-3.3-70b": "meta-llama-3.3",
	}
	for input, want := range cases {
		if got := workersAINormalizeKey(input); got != want {
			t.Errorf("workersAINormalizeKey(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestWorkersAIDeriveFamily(t *testing.T) {
	cases := map[string]string{
		"kimi-k2":       "Moonshot",
		"glm-4.5":       "Z.AI",
		"gpt-4o":        "OpenAI",
		"o3":            "OpenAI",
		"gemma-3":       "Gemini",
		"llama-3.3":     "Meta",
		"qwen3-32b":     "Qwen",
		"deepseek-r1":   "DeepSeek",
		"nemotron-3":    "NVIDIA",
		"granite-3":     "IBM",
		"phi-4":         "Microsoft",
		"totally-other": "",
	}
	for input, want := range cases {
		if got := workersAIDeriveFamily(input); got != want {
			t.Errorf("workersAIDeriveFamily(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestWorkersAIIsTrue(t *testing.T) {
	if !workersAIIsTrue(true) || !workersAIIsTrue("true") {
		t.Error("expected true and \"true\" to be truthy")
	}
	if workersAIIsTrue(false) || workersAIIsTrue("false") || workersAIIsTrue(1) {
		t.Error("expected false, \"false\", and 1 to be falsy")
	}
}

func TestWorkersAISupportsMessages(t *testing.T) {
	if !workersAISupportsMessages(map[string]any{"properties": map[string]any{"messages": map[string]any{}}}, 0) {
		t.Error("expected messages property to be detected")
	}
	if workersAISupportsMessages(map[string]any{"properties": map[string]any{"inputs": map[string]any{}}}, 0) {
		t.Error("expected non-messages property to be rejected")
	}
	if workersAISupportsMessages(nil, 0) {
		t.Error("expected nil to be rejected")
	}
	if workersAISupportsMessages(map[string]any{"properties": map[string]any{"messages": map[string]any{}}}, 65) {
		t.Error("expected depth limit to stop recursion")
	}
}

func TestSortedCopy(t *testing.T) {
	in := []string{"b", "a", "c"}
	out := sortedCopy(in)
	if !reflect.DeepEqual(out, []string{"a", "b", "c"}) {
		t.Errorf("sortedCopy = %v, want [a b c]", out)
	}
	if !reflect.DeepEqual(in, []string{"b", "a", "c"}) {
		t.Errorf("sortedCopy mutated input: %v", in)
	}
}

func TestNvidiaToModelKey(t *testing.T) {
	if got := nvidiaToModelKey("library/nvidia/nemotron-4"); got != "nemotron-4" {
		t.Errorf("nvidiaToModelKey = %q, want nemotron-4", got)
	}
	if got := nvidiaToModelKey("nvidia/nemotron-3-nano-9b"); got != "nemotron-3-nano" {
		t.Errorf("nvidiaToModelKey = %q, want nemotron-3-nano", got)
	}
}

func TestNvidiaNormalizeForMatch(t *testing.T) {
	got := nvidiaNormalizeForMatch("library/NVIDIA/Nemotron-4 340B")
	want := "nvidia-nemotron-4-340b"
	if got != want {
		t.Errorf("nvidiaNormalizeForMatch = %q, want %q", got, want)
	}
}

func TestNvidiaIsExcluded(t *testing.T) {
	if !nvidiaIsExcluded("library/nvidia/nemotron-4-340b-embedding") {
		t.Error("expected embedding model to be excluded")
	}
	if !nvidiaIsExcluded("library/nvidia/llama-guard") {
		t.Error("expected guard model to be excluded")
	}
	if nvidiaIsExcluded("library/nvidia/nemotron-4-340b-chat") {
		t.Error("expected chat model not to be excluded")
	}
}

func TestNvidiaStripHTML(t *testing.T) {
	got := nvidiaStripHTML("<p>Hello &amp; &lt;World&gt;</p>")
	want := "Hello & <World>"
	if got != want {
		t.Errorf("nvidiaStripHTML = %q, want %q", got, want)
	}
}

func TestNvidiaIsChatEndpoint(t *testing.T) {
	if !nvidiaIsChatEndpoint("Chat conversation endpoint") {
		t.Error("expected chat conversation to be chat")
	}
	if !nvidiaIsChatEndpoint("Create completion") {
		t.Error("expected create completion to be chat")
	}
	if nvidiaIsChatEndpoint("Text embedding endpoint") {
		t.Error("expected embedding not to be chat")
	}
	if nvidiaIsChatEndpoint("Rerank API") {
		t.Error("expected rerank not to be chat")
	}
}

func TestOpenCodeToModelKey(t *testing.T) {
	if got := openCodeToModelKey("gpt-4o-free"); got != "gpt-4o" {
		t.Errorf("openCodeToModelKey = %q, want gpt-4o", got)
	}
	if got := openCodeToModelKey("claude-sonnet-4"); got != "claude-sonnet-4" {
		t.Errorf("openCodeToModelKey = %q, want claude-sonnet-4", got)
	}
}

func TestOpenCodeSplitRow(t *testing.T) {
	got := openCodeSplitRow("| `Model ID` | Endpoint |")
	want := []string{"Model ID", "Endpoint"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("openCodeSplitRow = %v, want %v", got, want)
	}
}

func TestOpenCodeNameKey(t *testing.T) {
	if got := openCodeNameKey("  GPT   4o  "); got != "gpt 4o" {
		t.Errorf("openCodeNameKey = %q, want %q", got, "gpt 4o")
	}
}

func TestOpenCodeHeaderIndex(t *testing.T) {
	headers := []string{"Model", "Input", "Output", "Cached Read"}
	if got := openCodeHeaderIndex(headers, "model"); got != 0 {
		t.Errorf("openCodeHeaderIndex(model) = %d, want 0", got)
	}
	if got := openCodeHeaderIndex(headers, "Cached Read"); got != 3 {
		t.Errorf("openCodeHeaderIndex(Cached Read) = %d, want 3", got)
	}
	if got := openCodeHeaderIndex(headers, "Missing"); got != -1 {
		t.Errorf("openCodeHeaderIndex(Missing) = %d, want -1", got)
	}
}

func TestKiroStripHTML(t *testing.T) {
	got := kiroStripHTML("<b>Kimi&nbsp;K2</b> &amp; <i>friends</i>")
	want := "Kimi K2 & friends"
	if got != want {
		t.Errorf("kiroStripHTML = %q, want %q", got, want)
	}
}

func TestKiroDisplayToID(t *testing.T) {
	cases := map[string]string{
		"MiniMax M2":        "minimax-m2",
		"Claude 3.5 Sonnet": "claude-3.5-sonnet",
	}
	for input, want := range cases {
		if got := kiroDisplayToID(input); got != want {
			t.Errorf("kiroDisplayToID(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestKiroExpandVariants(t *testing.T) {
	if got := kiroExpandVariants("claude-sonnet-4.6"); !reflect.DeepEqual(got, []string{"claude-sonnet-4.6", "claude-sonnet-4.6-1m"}) {
		t.Errorf("kiroExpandVariants(4.6) = %v", got)
	}
	if got := kiroExpandVariants("kimi-k2"); !reflect.DeepEqual(got, []string{"kimi-k2"}) {
		t.Errorf("kiroExpandVariants(kimi-k2) = %v", got)
	}
}

func TestKiroToCanonical(t *testing.T) {
	key, upstream := kiroToCanonical("claude-3.5-sonnet")
	if key != "claude-3-5-sonnet" || upstream != "claude-3.5-sonnet" {
		t.Errorf("kiroToCanonical(claude-3.5-sonnet) = (%q, %q)", key, upstream)
	}
	key, upstream = kiroToCanonical("deepseek-r1")
	if key != "deepseek-r1" || upstream != "deepseek-r1" {
		t.Errorf("kiroToCanonical(deepseek-r1) = (%q, %q)", key, upstream)
	}
}

func TestKiroParseTableRows(t *testing.T) {
	table := `<table>
<tr><th>Model</th><th>Context</th></tr>
<tr><td>Kimi K2</td><td>256K</td></tr>
</table>`
	rows := kiroParseTableRows(table)
	if len(rows) != 2 {
		t.Fatalf("expected 2 rows, got %v", rows)
	}
	if !reflect.DeepEqual(rows[1], []string{"Kimi K2", "256K"}) {
		t.Errorf("row = %v", rows[1])
	}
}

func TestKiroParseOfficial(t *testing.T) {
	html := `<h1>Models</h1>
<table>
<tr><th>Model</th><th>Context</th><th>Free</th><th>Pro</th></tr>
<tr><td>Kimi K2</td><td>256K</td><td>yes</td><td>yes</td></tr>
<tr><td>Claude Sonnet</td><td>200K</td><td></td><td>yes</td></tr>
</table>`
	models, err := kiroParseOfficial(html)
	if err != nil {
		t.Fatalf("kiroParseOfficial: %v", err)
	}
	if len(models) != 2 {
		t.Fatalf("expected 2 models, got %v", models)
	}
	if models[0].name != "Kimi K2" || !models[0].freeAvailable || !models[0].paidAvailable {
		t.Errorf("model[0] = %+v", models[0])
	}
	if models[1].name != "Claude Sonnet" || models[1].freeAvailable || !models[1].paidAvailable {
		t.Errorf("model[1] = %+v", models[1])
	}
}

func TestKiroParseOfficialErrors(t *testing.T) {
	if _, err := kiroParseOfficial("<p>no tables</p>"); err == nil {
		t.Error("expected error for missing tables")
	}
	if _, err := kiroParseOfficial("<table><tr><td>x</td></tr></table>"); err == nil {
		t.Error("expected error for missing Model column")
	}
}

func TestCommandCodeToModelKey(t *testing.T) {
	if got := commandCodeToModelKey("anthropic/claude-opus-4"); got != "claude-opus-4" {
		t.Errorf("commandCodeToModelKey = %q, want claude-opus-4", got)
	}
}

func TestRegexpTrimTrailing(t *testing.T) {
	if got := regexpTrimTrailing("abc}extra"); got != "abc}" {
		t.Errorf("regexpTrimTrailing = %q, want abc}", got)
	}
	if got := regexpTrimTrailing(`[1,2]junk`); got != `[1,2]` {
		t.Errorf("regexpTrimTrailing = %q, want [1,2]", got)
	}
}

func TestSiliconFlowToModelKey(t *testing.T) {
	if got := siliconFlowToModelKey("Qwen/Qwen3-32B"); got != "qwen3" {
		t.Errorf("siliconFlowToModelKey = %q, want qwen3", got)
	}
}

func TestSiliconFlowIsChat(t *testing.T) {
	if !siliconFlowIsChat("Qwen/Qwen3-32B") {
		t.Error("expected chat model to be included")
	}
	if siliconFlowIsChat("BAAI/bge-m3-embedding") {
		t.Error("expected embedding model to be excluded")
	}
	if siliconFlowIsChat("stabilityai/stable-diffusion") {
		t.Error("expected image model to be excluded")
	}
}

func TestOpenRouterToModelKey(t *testing.T) {
	cases := map[string]string{
		"openrouter/free": "openrouter-free",
		"library/meta-llama/llama-3.3-70b-instruct": "llama-3.3",
		"openai/gpt-4o": "gpt-4o",
	}
	for input, want := range cases {
		if got := openRouterToModelKey(input); got != want {
			t.Errorf("openRouterToModelKey(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestIsOpenRouterFreeChat(t *testing.T) {
	free := openRouterModel{ID: "openrouter/free", Architecture: &struct {
		InputModalities  []string `json:"input_modalities"`
		OutputModalities []string `json:"output_modalities"`
	}{InputModalities: []string{"text"}, OutputModalities: []string{"text"}}}
	if !isOpenRouterFreeChat(free) {
		t.Error("expected openrouter/free to be a free chat model")
	}
	suffixed := openRouterModel{ID: "anthropic/claude-3.5:free"}
	if !isOpenRouterFreeChat(suffixed) {
		t.Error("expected :free suffix to be a free chat model")
	}
	paid := openRouterModel{ID: "openai/gpt-4o"}
	if isOpenRouterFreeChat(paid) {
		t.Error("expected paid model not to be free chat")
	}
}

func TestZenMuxToModelKey(t *testing.T) {
	if got := zenMuxToModelKey("openai/gpt-4o-free"); got != "gpt-4o" {
		t.Errorf("zenMuxToModelKey = %q, want gpt-4o", got)
	}
	if got := zenMuxToModelKey("deepseek/deepseek-r1"); got != "deepseek-r1" {
		t.Errorf("zenMuxToModelKey = %q, want deepseek-r1", got)
	}
}

func TestKiloCodeToModelKey(t *testing.T) {
	if got := kiloCodeToModelKey("anthropic/claude-sonnet-4:free"); got != "claude-sonnet-4" {
		t.Errorf("kiloCodeToModelKey = %q, want claude-sonnet-4", got)
	}
	if got := kiloCodeToModelKey("kilo-auto/small"); got != "kilo-auto-small" {
		t.Errorf("kiloCodeToModelKey = %q, want kilo-auto-small", got)
	}
}
