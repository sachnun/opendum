package cleankey

import (
	"regexp"
	"strconv"
	"strings"
)

var (
	activeParamsSuffix = regexp.MustCompile(`(?i)^a[0-9]+(?:\.[0-9]+)?[kmbt]$`)
	expertCountSuffix  = regexp.MustCompile(`(?i)^[0-9]+e$`)
	sizeBM             = regexp.MustCompile(`(?i)^[0-9]+(?:\.[0-9]+)?[bm]$`)
	sizeT              = regexp.MustCompile(`(?i)^[0-9]+(?:\.[0-9]+)?t$`)
	quantization       = regexp.MustCompile(`(?i)^(?:fp[0-9]+|int[0-9]+|awq|gptq|gguf|q[0-9]+(?:_[a-z])?)$`)
	dateCandidate      = regexp.MustCompile(`^[0-9]{4,6}$`)
	behaviorDescriptor = regexp.MustCompile(`(?i)^(?:instruct|it|chat|base|completion|reasoning|thinking|preview|beta|alpha|experimental|exp|deprecated)$`)
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

// StripParamInfoKey strips size, quantization, date, and pure behavior tokens
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
