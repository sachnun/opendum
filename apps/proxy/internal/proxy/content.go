package proxy

func stripImageContent(payload map[string]any) {
	messages, ok := payload["messages"].([]any)
	if !ok {
		return
	}
	for _, item := range messages {
		message, ok := item.(map[string]any)
		if !ok {
			continue
		}
		content, ok := message["content"].([]any)
		if !ok {
			continue
		}
		filtered := make([]any, 0, len(content))
		for _, part := range content {
			partMap, ok := part.(map[string]any)
			if !ok {
				filtered = append(filtered, part)
				continue
			}
			typeValue, _ := partMap["type"].(string)
			if typeValue == "image_url" || typeValue == "image" || typeValue == "input_image" {
				continue
			}
			filtered = append(filtered, part)
		}
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
