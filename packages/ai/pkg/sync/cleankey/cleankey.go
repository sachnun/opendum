package cleankey

import (
	"regexp"
	"strconv"
	"strings"
)

var (
	activeParamsSuffix  = regexp.MustCompile(`(?i)^a[0-9]+(?:\.[0-9]+)?[kmbt]$`)
	expertCountSuffix   = regexp.MustCompile(`(?i)^[0-9]+e$`)
	sizeBM              = regexp.MustCompile(`(?i)^[0-9]+(?:\.[0-9]+)?[bm]$`)
	sizeT               = regexp.MustCompile(`(?i)^[0-9]+(?:\.[0-9]+)?t$`)
	quantization        = regexp.MustCompile(`(?i)^(?:fp[0-9]+|int[0-9]+|awq|gptq|gguf|q[0-9]+(?:_[a-z])?)$`)
	dateCandidate       = regexp.MustCompile(`^[0-9]{4,6}$`)
	behaviorDescriptor  = regexp.MustCompile(`(?i)^(?:instruct|it|chat|base|completion|reasoning|thinking|preview|beta|alpha|experimental|exp|deprecated)$`)
	descriptorReasoning = regexp.MustCompile(`(?i)^(?:thinking|reasoning)$`)
	descriptorType      = regexp.MustCompile(`(?i)^(?:instruct|it)$`)
	descriptorStatus    = regexp.MustCompile(`(?i)^(?:preview|beta|alpha|experimental|exp|deprecated)$`)
	descriptorCode      = regexp.MustCompile(`(?i)^(?:coder|code|x?codex|code)$`)
	descriptorVariant   = regexp.MustCompile(`(?i)^(?:vl|vision|omni|multimodal)$`)
	sizeValuePattern    = regexp.MustCompile(`(?i)[0-9]+(?:\.[0-9]+)?[bm]`)
)

func isDateToken(token string) bool {
	if !dateCandidate.MatchString(token) {
		return false
	}
	if len(token) < 2 {
		return false
	}
	month, err := strconv.Atoi(token[len(token)-2:])
	if err != nil {
		return false
	}
	return month >= 1 && month <= 12
}

func isPairableMoESuffix(token string) bool {
	return activeParamsSuffix.MatchString(token) || expertCountSuffix.MatchString(token)
}

// StripParamInfoKey derives a clean canonical key by stripping parameter info
func StripParamInfoKey(modelKey string) string {
	if modelKey == "" {
		return modelKey
	}

	tokens := strings.FieldsFunc(modelKey, func(r rune) bool {
		return r == '-' || r == '_'
	})

	end := len(tokens)
	for end > 0 {
		t := tokens[end-1]
		if isPairableMoESuffix(t) ||
			sizeBM.MatchString(t) ||
			sizeT.MatchString(t) ||
			quantization.MatchString(t) ||
			isDateToken(t) ||
			behaviorDescriptor.MatchString(t) {
			end--
			continue
		}
		break
	}

	kept := make([]string, 0, end)
	for i := 0; i < end; i++ {
		t := tokens[i]
		if t == "" {
			continue
		}

		if isPairableMoESuffix(t) {
			if len(kept) > 0 {
				prev := kept[len(kept)-1]
				if sizeBM.MatchString(prev) || sizeT.MatchString(prev) {
					kept = kept[:len(kept)-1]
				}
			}
			continue
		}

		if sizeBM.MatchString(t) ||
			sizeT.MatchString(t) ||
			quantization.MatchString(t) ||
			behaviorDescriptor.MatchString(t) {
			continue
		}

		kept = append(kept, t)
	}

	cleaned := strings.Join(kept, "-")
	if len(cleaned) > 0 {
		return cleaned
	}
	return modelKey
}

func ExtractDescriptors(modelKey string) map[string]any {
	out := map[string]any{}
	if modelKey == "" {
		return out
	}
	tokens := splitTokens(modelKey)
	for _, token := range tokens {
		switch {
		case descriptorReasoning.MatchString(token):
			out["reasoning"] = true
		case descriptorType.MatchString(token):
			out["type"] = "instruct"
		case descriptorStatus.MatchString(token):
			normalized := lower(token)
			if normalized == "exp" {
				normalized = "experimental"
			}
			out["status"] = normalized
		case descriptorCode.MatchString(token):
			out["code"] = true
		case descriptorVariant.MatchString(token):
			normalized := lower(token)
			var variant string
			switch normalized {
			case "vision":
				variant = "vision"
			case "vl":
				variant = "vl"
			case "omni":
				variant = "omni"
			default:
				variant = "multimodal"
			}
			out["variant"] = variant
		}
	}
	return out
}

func LargestSizeValue(modelKey string) float64 {
	if modelKey == "" {
		return 0
	}
	largest := 0.0
	for _, m := range sizeValuePattern.FindAllString(modelKey, -1) {
		if v, err := strconv.ParseFloat(m[:len(m)-1], 64); err == nil {
			if v > largest {
				largest = v
			}
		}
	}
	return largest
}

func splitTokens(modelKey string) []string {
	return strings.FieldsFunc(modelKey, func(r rune) bool { return r == '-' || r == '_' })
}

func lower(s string) string { return strings.ToLower(s) }

func AliasesFromUpstream(upstreamNames []string) []string {
	seen := map[string]struct{}{}
	out := []string{}
	for _, name := range upstreamNames {
		if name == "" {
			continue
		}
		if strings.Contains(name, "/") {
			kebab := strings.ReplaceAll(name, "/", "-")
			if _, ok := seen[kebab]; !ok {
				seen[kebab] = struct{}{}
				out = append(out, kebab)
			}
		}
		if _, ok := seen[name]; !ok {
			seen[name] = struct{}{}
			out = append(out, name)
		}
	}
	return out
}

func NormalizeModelKey(modelID string, preserveOpenRouterFree bool) string {
	normalized := strings.TrimPrefix(modelID, "library/")
	if preserveOpenRouterFree && normalized == "openrouter/free" {
		return "openrouter-free"
	}
	if idx := strings.Index(normalized, "/"); idx != -1 && normalized != "openrouter/free" {
		normalized = normalized[idx+1:]
	}

	var b strings.Builder
	for _, r := range normalized {
		if r == ':' || r == '/' {
			b.WriteRune('-')
		} else if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '.' || r == '_' || r == '-' {
			b.WriteRune(r)
		} else {
			b.WriteRune('-')
		}
	}
	res := b.String()
	for strings.Contains(res, "--") {
		res = strings.ReplaceAll(res, "--", "-")
	}

	cleaned := StripParamInfoKey(res)
	if res != "openrouter-free" && strings.HasSuffix(cleaned, "-free") {
		cleaned = cleaned[:len(cleaned)-len("-free")]
	}
	return cleaned
}
