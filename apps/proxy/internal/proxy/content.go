package proxy

func stripImageContent(payload map[string]any) {
	messages, ok := payload["messages"].([]any)
	if ok {
		for _, item := range messages {
			message, ok := item.(map[string]any)
			if !ok {
				continue
			}
			content, ok := message["content"].([]any)
			if !ok {
				continue
			}
			filtered := filterImageParts(content)
			if len(filtered) == 1 {
				if textPart, ok := filtered[0].(map[string]any); ok {
					if textPart["type"] == "text" {
						if text, ok := textPart["text"].(string); ok {
							message["content"] = text
							continue
						}
					}
				}
			}
			message["content"] = filtered
		}
	}

	responsesInput, ok := payload["_responsesInput"].([]any)
	if !ok {
		return
	}
	for _, raw := range responsesInput {
		item, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		content, ok := item["content"].([]any)
		if !ok {
			continue
		}
		item["content"] = filterImageParts(content)
	}
}

func filterImageParts(content []any) []any {
	firstImage := -1
	for i, part := range content {
		partMap, ok := part.(map[string]any)
		if !ok {
			continue
		}
		switch partMap["type"] {
		case "image_url", "image", "input_image":
			if firstImage < 0 {
				firstImage = i
			}
		}
	}
	if firstImage < 0 {
		return content
	}
	filtered := make([]any, 0, len(content))
	for _, part := range content {
		partMap, ok := part.(map[string]any)
		if !ok {
			filtered = append(filtered, part)
			continue
		}
		switch partMap["type"] {
		case "image_url", "image", "input_image":
			continue
		}
		filtered = append(filtered, part)
	}
	return filtered
}
