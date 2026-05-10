import type { ModelInfo } from "./loader";

export const GENERATED_MODEL_REGISTRY = {
  "claude-3-7-sonnet": {
    "providers": [],
    "aliases": [
      "claude-3.7-sonnet",
      "claude-3-7-sonnet-latest",
      "claude-3.7-sonnet-latest"
    ],
    "family": "Claude",
    "meta": {
      "contextLength": 200000,
      "outputLimit": 64000,
      "knowledgeCutoff": "2024-10-31",
      "releaseDate": "2025-02-19",
      "reasoning": true,
      "toolCall": true,
      "vision": true,
      "modalities": {
        "input": [
          "text",
          "image",
          "pdf"
        ],
        "output": [
          "text"
        ]
      }
    }
  },
  "claude-3-haiku": {
    "providers": [],
    "family": "Claude",
    "meta": {
      "contextLength": 200000,
      "outputLimit": 4096,
      "knowledgeCutoff": "2023-08-31",
      "releaseDate": "2024-03-13",
      "reasoning": false,
      "toolCall": true,
      "vision": true,
      "modalities": {
        "input": [
          "text",
          "image",
          "pdf"
        ],
        "output": [
          "text"
        ]
      }
    }
  },
  "claude-haiku-4-5": {
    "providers": [
      "copilot",
      "kiro"
    ],
    "aliases": [
      "claude-haiku-4.5",
      "claude-haiku4.5"
    ],
    "family": "Claude",
    "meta": {
      "contextLength": 200000,
      "outputLimit": 64000,
      "knowledgeCutoff": "2025-02-28",
      "releaseDate": "2025-10-15",
      "reasoning": true,
      "toolCall": true,
      "vision": true,
      "modalities": {
        "input": [
          "text",
          "image",
          "pdf"
        ],
        "output": [
          "text"
        ]
      }
    },
    "upstream": {
      "copilot": "claude-haiku-4.5",
      "kiro": "claude-haiku-4.5"
    },
    "providerConfig": {
      "copilot": {
        "upstream": "claude-haiku-4.5"
      },
      "kiro": {
        "upstream": "claude-haiku-4.5"
      }
    }
  },
  "claude-opus-4-5": {
    "providers": [
      "copilot",
      "kiro"
    ],
    "aliases": [
      "claude-opus-4.5",
      "claude-opus4.5"
    ],
    "family": "Claude",
    "meta": {
      "contextLength": 200000,
      "outputLimit": 64000,
      "knowledgeCutoff": "2025-03-31",
      "releaseDate": "2025-11-24",
      "reasoning": true,
      "toolCall": true,
      "vision": true,
      "modalities": {
        "input": [
          "text",
          "image",
          "pdf"
        ],
        "output": [
          "text"
        ]
      }
    },
    "upstream": {
      "copilot": "claude-opus-4.5",
      "kiro": "claude-opus-4.5"
    },
    "providerConfig": {
      "copilot": {
        "upstream": "claude-opus-4.5"
      },
      "kiro": {
        "upstream": "claude-opus-4.5"
      }
    }
  },
  "claude-opus-4-6-1m": {
    "providers": [
      "kiro"
    ],
    "aliases": [
      "claude-opus-4.6-1m",
      "claude-opus-4-6-1m"
    ],
    "family": "Claude",
    "meta": {
      "contextLength": 1000000,
      "outputLimit": 128000,
      "knowledgeCutoff": "2025-05",
      "releaseDate": "2026-02-05",
      "reasoning": true,
      "toolCall": true,
      "vision": true,
      "modalities": {
        "input": [
          "text",
          "image",
          "pdf"
        ],
        "output": [
          "text"
        ]
      }
    },
    "upstream": {
      "kiro": "claude-opus-4.6-1m"
    },
    "providerConfig": {
      "kiro": {
        "upstream": "claude-opus-4.6-1m"
      }
    }
  },
  "claude-opus-4-6": {
    "providers": [
      "antigravity",
      "copilot",
      "kiro"
    ],
    "aliases": [
      "claude-opus-4.6",
      "claude-opus4.6"
    ],
    "family": "Claude",
    "meta": {
      "contextLength": 1000000,
      "outputLimit": 128000,
      "knowledgeCutoff": "2025-05",
      "releaseDate": "2026-02-05",
      "reasoning": true,
      "toolCall": true,
      "vision": true,
      "modalities": {
        "input": [
          "text",
          "image",
          "pdf"
        ],
        "output": [
          "text"
        ]
      }
    },
    "upstream": {
      "copilot": "claude-opus-4.6",
      "antigravity": "claude-opus-4-6-thinking",
      "kiro": "claude-opus-4.6"
    },
    "providerConfig": {
      "copilot": {
        "upstream": "claude-opus-4.6"
      },
      "antigravity": {
        "upstream": "claude-opus-4-6-thinking",
        "signature_family": "claude",
        "system_instruction": true,
        "force_stream_non_stream": true,
        "convert_external_images": true,
        "strict_tool_schema": true,
        "strict_thought_signatures": true,
        "sanitize_tool_blocks": true,
        "thinking_model": true,
        "top_p_min_095": true,
        "anthropic_beta_thinking": true
      },
      "kiro": {
        "upstream": "claude-opus-4.6"
      }
    }
  },
  "claude-opus-4-7": {
    "providers": [
      "copilot",
      "kiro"
    ],
    "family": "Claude",
    "upstream": {
      "copilot": "claude-opus-4.7",
      "kiro": "claude-opus-4.7"
    },
    "providerConfig": {
      "copilot": {
        "upstream": "claude-opus-4.7"
      },
      "kiro": {
        "upstream": "claude-opus-4.7"
      }
    }
  },
  "claude-sonnet-4-5-1m": {
    "providers": [
      "kiro"
    ],
    "aliases": [
      "claude-sonnet-4.5-1m",
      "claude-sonnet-4-5-1m"
    ],
    "family": "Claude",
    "meta": {
      "contextLength": 200000,
      "outputLimit": 64000,
      "knowledgeCutoff": "2025-07-31",
      "releaseDate": "2025-09-29",
      "reasoning": true,
      "toolCall": true,
      "vision": true,
      "modalities": {
        "input": [
          "text",
          "image",
          "pdf"
        ],
        "output": [
          "text"
        ]
      }
    },
    "upstream": {
      "kiro": "claude-sonnet-4.5-1m"
    },
    "providerConfig": {
      "kiro": {
        "upstream": "claude-sonnet-4.5-1m"
      }
    }
  },
  "claude-sonnet-4-5": {
    "providers": [
      "copilot",
      "kiro"
    ],
    "aliases": [
      "claude-sonnet-4.5",
      "claude-sonnet4.5"
    ],
    "family": "Claude",
    "meta": {
      "contextLength": 200000,
      "outputLimit": 64000,
      "knowledgeCutoff": "2025-07-31",
      "releaseDate": "2025-09-29",
      "reasoning": true,
      "toolCall": true,
      "vision": true,
      "modalities": {
        "input": [
          "text",
          "image",
          "pdf"
        ],
        "output": [
          "text"
        ]
      }
    },
    "upstream": {
      "copilot": "claude-sonnet-4.5",
      "kiro": "claude-sonnet-4.5"
    },
    "providerConfig": {
      "copilot": {
        "upstream": "claude-sonnet-4.5"
      },
      "kiro": {
        "upstream": "claude-sonnet-4.5"
      }
    }
  },
  "claude-sonnet-4-6-1m": {
    "providers": [
      "kiro"
    ],
    "aliases": [
      "claude-sonnet-4.6-1m",
      "claude-sonnet-4-6-1m"
    ],
    "family": "Claude",
    "meta": {
      "contextLength": 1000000,
      "outputLimit": 64000,
      "knowledgeCutoff": "2025-08",
      "releaseDate": "2026-02-17",
      "reasoning": true,
      "toolCall": true,
      "vision": true,
      "modalities": {
        "input": [
          "text",
          "image",
          "pdf"
        ],
        "output": [
          "text"
        ]
      }
    },
    "upstream": {
      "kiro": "claude-sonnet-4.6-1m"
    },
    "providerConfig": {
      "kiro": {
        "upstream": "claude-sonnet-4.6-1m"
      }
    }
  },
  "claude-sonnet-4-6": {
    "providers": [
      "antigravity",
      "copilot",
      "kiro"
    ],
    "aliases": [
      "claude-sonnet-4.6",
      "claude-sonnet4.6"
    ],
    "family": "Claude",
    "meta": {
      "contextLength": 1000000,
      "outputLimit": 64000,
      "knowledgeCutoff": "2025-08",
      "releaseDate": "2026-02-17",
      "reasoning": true,
      "toolCall": true,
      "vision": true,
      "modalities": {
        "input": [
          "text",
          "image",
          "pdf"
        ],
        "output": [
          "text"
        ]
      }
    },
    "upstream": {
      "copilot": "claude-sonnet-4.6",
      "kiro": "claude-sonnet-4.6"
    },
    "providerConfig": {
      "antigravity": {
        "signature_family": "claude",
        "system_instruction": true,
        "force_stream_non_stream": true,
        "convert_external_images": true,
        "strict_tool_schema": true,
        "strict_thought_signatures": true,
        "sanitize_tool_blocks": true
      },
      "copilot": {
        "upstream": "claude-sonnet-4.6"
      },
      "kiro": {
        "upstream": "claude-sonnet-4.6"
      }
    }
  },
  "claude-sonnet-4": {
    "providers": [
      "kiro"
    ],
    "aliases": [
      "claude-sonnet-4-0",
      "claude-sonnet-4.0",
      "claude-sonnet4.0"
    ],
    "family": "Claude",
    "meta": {
      "contextLength": 1000000,
      "outputLimit": 64000,
      "knowledgeCutoff": "2025-03-31",
      "releaseDate": "2025-05-22",
      "reasoning": true,
      "toolCall": true,
      "vision": true,
      "modalities": {
        "input": [
          "text",
          "image",
          "pdf"
        ],
        "output": [
          "text"
        ]
      }
    }
  },
  "deepseek-coder-6.7b-instruct": {
    "providers": [
      "nvidia_nim"
    ],
    "aliases": [
      "deepseek-ai-deepseek-coder-6.7b-instruct",
      "deepseek-ai/deepseek-coder-6.7b-instruct"
    ],
    "family": "DeepSeek",
    "meta": {
      "contextLength": 128000,
      "outputLimit": 4096,
      "releaseDate": "2023-10-29",
      "reasoning": false,
      "toolCall": true,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    },
    "upstream": {
      "nvidia_nim": "deepseek-ai/deepseek-coder-6.7b-instruct"
    },
    "providerConfig": {
      "nvidia_nim": {
        "upstream": "deepseek-ai/deepseek-coder-6.7b-instruct"
      }
    }
  },
  "deepseek-v3.1-671b": {
    "providers": [
      "ollama_cloud"
    ],
    "family": "DeepSeek",
    "meta": {
      "contextLength": 163840,
      "outputLimit": 163840,
      "releaseDate": "2025-08-21",
      "reasoning": true,
      "toolCall": true,
      "vision": false
    },
    "upstream": {
      "ollama_cloud": "deepseek-v3.1:671b"
    },
    "providerConfig": {
      "ollama_cloud": {
        "upstream": "deepseek-v3.1:671b"
      }
    }
  },
  "deepseek-v3.1-terminus": {
    "providers": [],
    "aliases": [
      "deepseek-ai-deepseek-v3.1-terminus",
      "deepseek-ai/deepseek-v3.1-terminus"
    ],
    "family": "DeepSeek",
    "meta": {
      "contextLength": 128000,
      "outputLimit": 16384,
      "knowledgeCutoff": "2025-09",
      "releaseDate": "2025-09-22",
      "reasoning": true,
      "toolCall": true,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    }
  },
  "deepseek-v3.1": {
    "providers": [],
    "family": "DeepSeek",
    "meta": {
      "contextLength": 128000,
      "outputLimit": 32000,
      "knowledgeCutoff": "2024-07",
      "releaseDate": "2025-08-19",
      "reasoning": true,
      "toolCall": true,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    }
  },
  "deepseek-v3.2": {
    "providers": [
      "kiro",
      "ollama_cloud"
    ],
    "family": "DeepSeek",
    "meta": {
      "contextLength": 128000,
      "outputLimit": 64000,
      "knowledgeCutoff": "2024-12",
      "releaseDate": "2025-01-01",
      "reasoning": false,
      "toolCall": true,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    },
    "upstream": {
      "kiro": "deepseek-3.2"
    },
    "providerConfig": {
      "kiro": {
        "upstream": "deepseek-3.2"
      }
    }
  },
  "deepseek-v4-flash": {
    "providers": [
      "nvidia_nim",
      "ollama_cloud"
    ],
    "upstream": {
      "nvidia_nim": "deepseek-ai/deepseek-v4-flash"
    },
    "providerConfig": {
      "nvidia_nim": {
        "upstream": "deepseek-ai/deepseek-v4-flash"
      }
    }
  },
  "deepseek-v4-pro": {
    "providers": [
      "nvidia_nim",
      "ollama_cloud"
    ],
    "upstream": {
      "nvidia_nim": "deepseek-ai/deepseek-v4-pro"
    },
    "providerConfig": {
      "nvidia_nim": {
        "upstream": "deepseek-ai/deepseek-v4-pro"
      }
    }
  },
  "gemini-2.5-flash-lite": {
    "providers": [
      "antigravity",
      "gemini_cli"
    ],
    "family": "Gemini",
    "meta": {
      "contextLength": 1048576,
      "outputLimit": 65536,
      "knowledgeCutoff": "2025-01",
      "releaseDate": "2025-06-17",
      "reasoning": true,
      "toolCall": true,
      "vision": true,
      "modalities": {
        "input": [
          "text",
          "image",
          "audio",
          "video",
          "pdf"
        ],
        "output": [
          "text"
        ]
      }
    },
    "providerConfig": {
      "antigravity": {
        "thinking_format": "budget",
        "signature_family": "gemini-flash",
        "scrub_model_artifacts": true,
        "inject_thought_signature": true,
        "thinking_budgets": {
          "low": 6144,
          "medium": 12288,
          "high": 24576,
          "xhigh": 24576
        }
      },
      "gemini_cli": {
        "thinking_format": "budget",
        "thinking_budgets": {
          "low": 6144,
          "medium": 12288,
          "high": 24576,
          "xhigh": 24576
        }
      }
    }
  },
  "gemini-2.5-flash": {
    "providers": [
      "antigravity",
      "gemini_cli"
    ],
    "aliases": [
      "gemini-2.5-flash-thinking"
    ],
    "family": "Gemini",
    "meta": {
      "contextLength": 1048576,
      "outputLimit": 65536,
      "knowledgeCutoff": "2025-01",
      "releaseDate": "2025-03-20",
      "reasoning": true,
      "toolCall": true,
      "vision": true,
      "modalities": {
        "input": [
          "text",
          "image",
          "audio",
          "video",
          "pdf"
        ],
        "output": [
          "text"
        ]
      }
    },
    "providerConfig": {
      "antigravity": {
        "thinking_format": "budget",
        "signature_family": "gemini-flash",
        "scrub_model_artifacts": true,
        "inject_thought_signature": true,
        "thinking_budgets": {
          "low": 6144,
          "medium": 12288,
          "high": 24576,
          "xhigh": 24576
        }
      },
      "gemini_cli": {
        "thinking_format": "budget",
        "thinking_budgets": {
          "low": 6144,
          "medium": 12288,
          "high": 24576,
          "xhigh": 24576
        }
      }
    }
  },
  "gemini-2.5-pro": {
    "providers": [
      "gemini_cli",
      "copilot"
    ],
    "family": "Gemini",
    "meta": {
      "contextLength": 1048576,
      "outputLimit": 65536,
      "knowledgeCutoff": "2025-01",
      "releaseDate": "2025-03-20",
      "reasoning": true,
      "toolCall": true,
      "vision": true,
      "modalities": {
        "input": [
          "text",
          "image",
          "audio",
          "video",
          "pdf"
        ],
        "output": [
          "text"
        ]
      }
    },
    "providerConfig": {
      "gemini_cli": {
        "thinking_format": "budget",
        "thinking_budgets": {
          "low": 8192,
          "medium": 16384,
          "high": 32768,
          "xhigh": 32768
        }
      }
    }
  },
  "gemini-3-flash-preview": {
    "providers": [
      "antigravity",
      "copilot",
      "gemini_cli",
      "ollama_cloud"
    ],
    "aliases": [
      "gemini-3-flash",
      "gemini-3-flash-preview-latest"
    ],
    "family": "Gemini",
    "meta": {
      "contextLength": 1048576,
      "outputLimit": 65536,
      "knowledgeCutoff": "2025-01",
      "releaseDate": "2025-12-17",
      "reasoning": true,
      "toolCall": true,
      "vision": true,
      "modalities": {
        "input": [
          "text",
          "image",
          "video",
          "audio",
          "pdf"
        ],
        "output": [
          "text"
        ]
      }
    },
    "upstream": {
      "antigravity": "gemini-3-flash"
    },
    "providerConfig": {
      "antigravity": {
        "upstream": "gemini-3-flash",
        "system_instruction": true,
        "thinking_format": "level",
        "signature_family": "gemini-flash",
        "scrub_model_artifacts": true,
        "inject_thought_signature": true,
        "thinking_levels": {
          "none": "minimal",
          "low": "low",
          "medium": "medium",
          "high": "high",
          "xhigh": "high"
        }
      },
      "gemini_cli": {
        "thinking_format": "level",
        "thinking_levels": {
          "none": "minimal",
          "low": "low",
          "medium": "medium",
          "high": "high",
          "xhigh": "high"
        }
      }
    }
  },
  "gemini-3-pro-image-preview": {
    "providers": [
      "antigravity"
    ],
    "aliases": [
      "gemini-3-pro-image"
    ],
    "family": "Gemini",
    "meta": {
      "contextLength": 32768,
      "outputLimit": 64000,
      "knowledgeCutoff": "2025-06",
      "releaseDate": "2025-11-20",
      "reasoning": false,
      "toolCall": false,
      "vision": true,
      "modalities": {
        "input": [
          "text",
          "image"
        ],
        "output": [
          "text"
        ]
      }
    },
    "upstream": {
      "antigravity": "gemini-3-pro-image"
    },
    "providerConfig": {
      "antigravity": {
        "upstream": "gemini-3-pro-image",
        "signature_family": "gemini-pro"
      }
    }
  },
  "gemini-3-pro-preview": {
    "providers": [
      "antigravity",
      "gemini_cli"
    ],
    "aliases": [
      "gemini-3-pro",
      "gemini-3-pro-high",
      "gemini-3-pro-low"
    ],
    "family": "Gemini",
    "meta": {
      "contextLength": 1000000,
      "outputLimit": 64000,
      "knowledgeCutoff": "2025-01",
      "releaseDate": "2025-11-18",
      "reasoning": true,
      "toolCall": true,
      "vision": true,
      "modalities": {
        "input": [
          "text",
          "image",
          "video",
          "audio",
          "pdf"
        ],
        "output": [
          "text"
        ]
      }
    },
    "upstream": {
      "antigravity": "gemini-3-pro-high"
    },
    "providerConfig": {
      "antigravity": {
        "upstream": "gemini-3-pro-high",
        "system_instruction": true,
        "thinking_format": "level",
        "signature_family": "gemini-pro",
        "scrub_model_artifacts": true,
        "inject_thought_signature": true,
        "thinking_levels": {
          "none": "low",
          "low": "low",
          "medium": "high",
          "high": "high",
          "xhigh": "high"
        }
      },
      "gemini_cli": {
        "thinking_format": "level",
        "thinking_levels": {
          "none": "low",
          "low": "low",
          "medium": "high",
          "high": "high",
          "xhigh": "high"
        }
      }
    }
  },
  "gemini-3.1-flash-image-preview": {
    "providers": [
      "antigravity"
    ],
    "aliases": [
      "gemini-3.1-flash-image",
      "gemini-3-flash-image"
    ],
    "family": "Gemini",
    "meta": {
      "contextLength": 131072,
      "outputLimit": 32768,
      "knowledgeCutoff": "2025-01",
      "releaseDate": "2026-02-26",
      "reasoning": true,
      "toolCall": false,
      "vision": true,
      "modalities": {
        "input": [
          "text",
          "image",
          "pdf"
        ],
        "output": [
          "text",
          "image"
        ]
      }
    },
    "upstream": {
      "antigravity": "gemini-3.1-flash-image"
    },
    "providerConfig": {
      "antigravity": {
        "upstream": "gemini-3.1-flash-image",
        "signature_family": "gemini-flash"
      }
    }
  },
  "gemini-3.1-flash-lite-preview": {
    "providers": [
      "gemini_cli"
    ],
    "family": "Gemini",
    "meta": {
      "contextLength": 1048576,
      "outputLimit": 65536,
      "knowledgeCutoff": "2025-01",
      "releaseDate": "2026-03-03",
      "reasoning": true,
      "toolCall": true,
      "vision": true,
      "modalities": {
        "input": [
          "text",
          "image",
          "video",
          "audio",
          "pdf"
        ],
        "output": [
          "text"
        ]
      }
    },
    "providerConfig": {
      "gemini_cli": {
        "thinking_format": "budget",
        "thinking_budgets": {
          "low": 6144,
          "medium": 12288,
          "high": 24576,
          "xhigh": 24576
        }
      }
    }
  },
  "gemini-3.1-pro-preview": {
    "providers": [
      "antigravity",
      "copilot",
      "gemini_cli"
    ],
    "aliases": [
      "gemini-3.1-pro",
      "gemini-3.1-pro-high",
      "gemini-3.1-pro-low"
    ],
    "family": "Gemini",
    "meta": {
      "contextLength": 1048576,
      "outputLimit": 65536,
      "knowledgeCutoff": "2025-01",
      "releaseDate": "2026-02-19",
      "reasoning": true,
      "toolCall": true,
      "vision": true,
      "modalities": {
        "input": [
          "text",
          "image",
          "video",
          "audio",
          "pdf"
        ],
        "output": [
          "text"
        ]
      }
    },
    "upstream": {
      "antigravity": "gemini-3.1-pro-high"
    },
    "providerConfig": {
      "antigravity": {
        "upstream": "gemini-3.1-pro-high",
        "system_instruction": true,
        "thinking_format": "budget",
        "signature_family": "gemini-pro",
        "scrub_model_artifacts": true,
        "inject_thought_signature": true,
        "thinking_budgets": {
          "low": 8192,
          "medium": 16384,
          "high": 32768,
          "xhigh": 32768
        }
      },
      "gemini_cli": {
        "thinking_format": "budget",
        "thinking_budgets": {
          "low": 8192,
          "medium": 16384,
          "high": 32768,
          "xhigh": 32768
        }
      }
    }
  },
  "codegemma-1.1-7b": {
    "providers": [],
    "aliases": [
      "google-codegemma-1.1-7b",
      "google/codegemma-1.1-7b"
    ],
    "family": "Google",
    "meta": {
      "contextLength": 128000,
      "outputLimit": 4096,
      "releaseDate": "2024-04-30",
      "reasoning": false,
      "toolCall": false,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    }
  },
  "codegemma-7b": {
    "providers": [
      "nvidia_nim"
    ],
    "aliases": [
      "google-codegemma-7b",
      "google/codegemma-7b"
    ],
    "family": "Google",
    "meta": {
      "contextLength": 128000,
      "outputLimit": 4096,
      "releaseDate": "2024-03-21",
      "reasoning": false,
      "toolCall": false,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    },
    "upstream": {
      "nvidia_nim": "google/codegemma-7b"
    },
    "providerConfig": {
      "nvidia_nim": {
        "upstream": "google/codegemma-7b"
      }
    }
  },
  "gemma-2-27b-it": {
    "providers": [],
    "aliases": [
      "google-gemma-2-27b-it",
      "google/gemma-2-27b-it"
    ],
    "family": "Google",
    "meta": {
      "contextLength": 128000,
      "outputLimit": 4096,
      "releaseDate": "2024-06-24",
      "reasoning": false,
      "toolCall": true,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    }
  },
  "gemma-2-2b-it": {
    "providers": [
      "nvidia_nim"
    ],
    "aliases": [
      "google-gemma-2-2b-it",
      "google/gemma-2-2b-it"
    ],
    "family": "Google",
    "meta": {
      "contextLength": 128000,
      "outputLimit": 4096,
      "releaseDate": "2024-07-16",
      "reasoning": false,
      "toolCall": true,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    },
    "upstream": {
      "nvidia_nim": "google/gemma-2-2b-it"
    },
    "providerConfig": {
      "nvidia_nim": {
        "upstream": "google/gemma-2-2b-it"
      }
    }
  },
  "gemma-2-9b-cpt-sahabatai-instruct": {
    "providers": [],
    "family": "Google"
  },
  "gemma-2-9b-it": {
    "providers": [],
    "family": "Google",
    "meta": {
      "contextLength": 8192,
      "outputLimit": 8192,
      "knowledgeCutoff": "2024-06",
      "releaseDate": "2024-06-27",
      "reasoning": false,
      "toolCall": true,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    }
  },
  "gemma-3-12b-it": {
    "providers": [
      "nvidia_nim"
    ],
    "family": "Google",
    "meta": {
      "contextLength": 131072,
      "outputLimit": 8192,
      "knowledgeCutoff": "2024-12",
      "releaseDate": "2024-12-01",
      "reasoning": false,
      "toolCall": false,
      "vision": false,
      "modalities": {
        "input": [
          "text",
          "image"
        ],
        "output": [
          "text"
        ]
      }
    },
    "upstream": {
      "nvidia_nim": "google/gemma-3-12b-it"
    },
    "providerConfig": {
      "nvidia_nim": {
        "upstream": "google/gemma-3-12b-it"
      }
    }
  },
  "gemma-3-1b-it": {
    "providers": [],
    "aliases": [
      "google-gemma-3-1b-it",
      "google/gemma-3-1b-it"
    ],
    "family": "Google",
    "meta": {
      "contextLength": 128000,
      "outputLimit": 4096,
      "releaseDate": "2025-03-10",
      "reasoning": false,
      "toolCall": true,
      "vision": true,
      "modalities": {
        "input": [
          "text",
          "image"
        ],
        "output": [
          "text"
        ]
      }
    }
  },
  "gemma-3-27b-it": {
    "providers": [
      "nvidia_nim"
    ],
    "family": "Google",
    "meta": {
      "contextLength": 40000,
      "outputLimit": 8192,
      "knowledgeCutoff": "2024-12",
      "releaseDate": "2024-12-01",
      "reasoning": true,
      "toolCall": true,
      "vision": true,
      "modalities": {
        "input": [
          "text",
          "image"
        ],
        "output": [
          "text"
        ]
      }
    },
    "upstream": {
      "nvidia_nim": "google/gemma-3-27b-it"
    },
    "providerConfig": {
      "nvidia_nim": {
        "upstream": "google/gemma-3-27b-it"
      }
    }
  },
  "gemma-3-4b-it": {
    "providers": [
      "nvidia_nim"
    ],
    "family": "Google",
    "upstream": {
      "nvidia_nim": "google/gemma-3-4b-it"
    },
    "providerConfig": {
      "nvidia_nim": {
        "upstream": "google/gemma-3-4b-it"
      }
    }
  },
  "gemma-3n-e2b-it": {
    "providers": [
      "nvidia_nim"
    ],
    "aliases": [
      "google-gemma-3n-e2b-it",
      "google/gemma-3n-e2b-it"
    ],
    "family": "Google",
    "meta": {
      "contextLength": 128000,
      "outputLimit": 4096,
      "knowledgeCutoff": "2024-06",
      "releaseDate": "2025-06-12",
      "reasoning": false,
      "toolCall": true,
      "vision": true,
      "modalities": {
        "input": [
          "text",
          "image"
        ],
        "output": [
          "text"
        ]
      }
    },
    "upstream": {
      "nvidia_nim": "google/gemma-3n-e2b-it"
    },
    "providerConfig": {
      "nvidia_nim": {
        "upstream": "google/gemma-3n-e2b-it"
      }
    }
  },
  "gemma-3n-e4b-it": {
    "providers": [
      "nvidia_nim"
    ],
    "aliases": [
      "google-gemma-3n-e4b-it",
      "google/gemma-3n-e4b-it"
    ],
    "family": "Google",
    "meta": {
      "contextLength": 128000,
      "outputLimit": 4096,
      "knowledgeCutoff": "2024-06",
      "releaseDate": "2025-06-03",
      "reasoning": false,
      "toolCall": true,
      "vision": true,
      "modalities": {
        "input": [
          "text",
          "image"
        ],
        "output": [
          "text"
        ]
      }
    },
    "upstream": {
      "nvidia_nim": "google/gemma-3n-e4b-it"
    },
    "providerConfig": {
      "nvidia_nim": {
        "upstream": "google/gemma-3n-e4b-it"
      }
    }
  },
  "gemma-4-26b-a4b-it": {
    "providers": [
      "gemini_cli",
      "openrouter",
      "workers_ai"
    ],
    "family": "Google",
    "meta": {
      "contextLength": 128000,
      "outputLimit": 8192,
      "releaseDate": "2025-06",
      "reasoning": true,
      "toolCall": true,
      "vision": true,
      "modalities": {
        "input": [
          "text",
          "image"
        ],
        "output": [
          "text"
        ]
      }
    },
    "upstream": {
      "openrouter": "google/gemma-4-26b-a4b-it:free"
    },
    "providerConfig": {
      "openrouter": {
        "upstream": "google/gemma-4-26b-a4b-it:free"
      }
    }
  },
  "gemma-4-31b-it": {
    "providers": [
      "gemini_cli",
      "nvidia_nim",
      "openrouter"
    ],
    "family": "Google",
    "upstream": {
      "nvidia_nim": "google/gemma-4-31b-it",
      "openrouter": "google/gemma-4-31b-it:free"
    },
    "providerConfig": {
      "nvidia_nim": {
        "upstream": "google/gemma-4-31b-it"
      },
      "openrouter": {
        "upstream": "google/gemma-4-31b-it:free"
      }
    }
  },
  "gemma3-12b": {
    "providers": [
      "ollama_cloud"
    ],
    "family": "Google",
    "meta": {
      "contextLength": 128000,
      "outputLimit": 4096,
      "releaseDate": "2025-03-01",
      "reasoning": false,
      "toolCall": true,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    },
    "upstream": {
      "ollama_cloud": "gemma3:12b"
    },
    "providerConfig": {
      "ollama_cloud": {
        "upstream": "gemma3:12b"
      }
    }
  },
  "gemma3-27b": {
    "providers": [
      "ollama_cloud"
    ],
    "family": "Google",
    "meta": {
      "contextLength": 131072,
      "outputLimit": 8192,
      "knowledgeCutoff": "2024-12",
      "releaseDate": "2024-12-01",
      "reasoning": true,
      "toolCall": true,
      "vision": true,
      "modalities": {
        "input": [
          "text",
          "image"
        ],
        "output": [
          "text"
        ]
      }
    },
    "upstream": {
      "ollama_cloud": "gemma3:27b"
    },
    "providerConfig": {
      "ollama_cloud": {
        "upstream": "gemma3:27b"
      }
    }
  },
  "gemma3-4b": {
    "providers": [
      "ollama_cloud"
    ],
    "aliases": [
      "gemma-3-4b-it"
    ],
    "family": "Google",
    "meta": {
      "contextLength": 131072,
      "outputLimit": 131072,
      "releaseDate": "2024-12-01",
      "reasoning": false,
      "toolCall": false,
      "vision": true
    },
    "upstream": {
      "ollama_cloud": "gemma3:4b"
    },
    "providerConfig": {
      "ollama_cloud": {
        "upstream": "gemma3:4b"
      }
    }
  },
  "gemma4-31b": {
    "providers": [
      "ollama_cloud"
    ],
    "family": "Google",
    "upstream": {
      "ollama_cloud": "gemma4:31b"
    },
    "providerConfig": {
      "ollama_cloud": {
        "upstream": "gemma4:31b"
      }
    }
  },
  "kilo-auto-balanced": {
    "providers": [
      "kilo_code"
    ],
    "upstream": {
      "kilo_code": "kilo-auto/balanced"
    },
    "providerConfig": {
      "kilo_code": {
        "upstream": "kilo-auto/balanced"
      }
    }
  },
  "kilo-auto-free": {
    "providers": [
      "kilo_code"
    ],
    "upstream": {
      "kilo_code": "kilo-auto/free"
    },
    "providerConfig": {
      "kilo_code": {
        "upstream": "kilo-auto/free"
      }
    }
  },
  "kilo-auto-frontier": {
    "providers": [
      "kilo_code"
    ],
    "upstream": {
      "kilo_code": "kilo-auto/frontier"
    },
    "providerConfig": {
      "kilo_code": {
        "upstream": "kilo-auto/frontier"
      }
    }
  },
  "kilo-auto-small": {
    "providers": [
      "kilo_code"
    ],
    "upstream": {
      "kilo_code": "kilo-auto/small"
    },
    "providerConfig": {
      "kilo_code": {
        "upstream": "kilo-auto/small"
      }
    }
  },
  "kimi-k2-0905": {
    "providers": [],
    "family": "Kimi",
    "meta": {
      "contextLength": 256000,
      "outputLimit": 64000,
      "knowledgeCutoff": "2024-12",
      "releaseDate": "2025-09-05",
      "reasoning": false,
      "toolCall": true,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    }
  },
  "kimi-k2-1t": {
    "providers": [
      "ollama_cloud"
    ],
    "family": "Kimi",
    "meta": {
      "contextLength": 262144,
      "outputLimit": 262144,
      "knowledgeCutoff": "2024-08",
      "releaseDate": "2025-11-06",
      "reasoning": true,
      "toolCall": true,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    },
    "upstream": {
      "ollama_cloud": "kimi-k2:1t"
    },
    "providerConfig": {
      "ollama_cloud": {
        "upstream": "kimi-k2:1t"
      }
    }
  },
  "kimi-k2-instruct-0905": {
    "providers": []
  },
  "kimi-k2-instruct": {
    "providers": [
      "nvidia_nim"
    ],
    "upstream": {
      "nvidia_nim": "moonshotai/kimi-k2-instruct"
    },
    "providerConfig": {
      "nvidia_nim": {
        "upstream": "moonshotai/kimi-k2-instruct"
      }
    }
  },
  "kimi-k2-thinking": {
    "providers": [
      "ollama_cloud",
      "nvidia_nim"
    ],
    "family": "Kimi",
    "meta": {
      "contextLength": 262144,
      "outputLimit": 262144,
      "knowledgeCutoff": "2024-08",
      "releaseDate": "2025-11-06",
      "reasoning": true,
      "toolCall": true,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    },
    "upstream": {
      "nvidia_nim": "moonshotai/kimi-k2-thinking"
    },
    "providerConfig": {
      "nvidia_nim": {
        "upstream": "moonshotai/kimi-k2-thinking"
      }
    }
  },
  "kimi-k2.5": {
    "providers": [
      "ollama_cloud",
      "workers_ai"
    ],
    "family": "Kimi",
    "meta": {
      "contextLength": 262144,
      "outputLimit": 262144,
      "knowledgeCutoff": "2025-01",
      "releaseDate": "2026-01",
      "reasoning": true,
      "toolCall": true,
      "vision": false,
      "modalities": {
        "input": [
          "text",
          "image",
          "video"
        ],
        "output": [
          "text"
        ]
      }
    },
    "upstream": {
      "workers_ai": "@cf/moonshotai/kimi-k2.5"
    },
    "providerConfig": {
      "workers_ai": {
        "upstream": "@cf/moonshotai/kimi-k2.5"
      }
    }
  },
  "kimi-k2.6": {
    "providers": [
      "ollama_cloud"
    ]
  },
  "kimi-k2": {
    "providers": [
      "ollama_cloud"
    ],
    "family": "Kimi",
    "meta": {
      "contextLength": 128000,
      "outputLimit": 64000,
      "knowledgeCutoff": "2024-10",
      "releaseDate": "2024-12-01",
      "reasoning": false,
      "toolCall": true,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    },
    "upstream": {
      "ollama_cloud": "kimi-k2:1t"
    },
    "providerConfig": {
      "ollama_cloud": {
        "upstream": "kimi-k2:1t"
      }
    }
  },
  "codellama-70b": {
    "providers": [],
    "aliases": [
      "meta-codellama-70b",
      "meta/codellama-70b"
    ],
    "family": "Meta",
    "meta": {
      "contextLength": 128000,
      "outputLimit": 4096,
      "releaseDate": "2024-01-29",
      "reasoning": false,
      "toolCall": false,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    }
  },
  "llama-3-swallow-70b-instruct-v0.1": {
    "providers": [],
    "family": "Meta"
  },
  "llama-3-taiwan-70b-instruct": {
    "providers": [],
    "family": "Meta"
  },
  "llama-3.1-405b-instruct": {
    "providers": [],
    "aliases": [
      "meta-llama-3.1-405b-instruct",
      "meta/llama-3.1-405b-instruct"
    ],
    "family": "Meta",
    "meta": {
      "contextLength": 128000,
      "outputLimit": 128000,
      "knowledgeCutoff": "2023-12",
      "releaseDate": "2024-07-23",
      "reasoning": false,
      "toolCall": true,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    }
  },
  "llama-3.1-70b-instruct": {
    "providers": [
      "nvidia_nim"
    ],
    "upstream": {
      "nvidia_nim": "meta/llama-3.1-70b-instruct"
    },
    "providerConfig": {
      "nvidia_nim": {
        "upstream": "meta/llama-3.1-70b-instruct"
      }
    }
  },
  "llama-3.1-8b-instruct": {
    "providers": [
      "groq",
      "cerebras",
      "nvidia_nim"
    ],
    "family": "Meta",
    "meta": {
      "contextLength": 128000,
      "outputLimit": 16384,
      "knowledgeCutoff": "2023-12",
      "releaseDate": "2025-01-01",
      "reasoning": false,
      "toolCall": true,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    },
    "upstream": {
      "cerebras": "llama3.1-8b",
      "groq": "llama-3.1-8b-instant",
      "nvidia_nim": "meta/llama-3.1-8b-instruct"
    },
    "providerConfig": {
      "cerebras": {
        "upstream": "llama3.1-8b"
      },
      "groq": {
        "upstream": "llama-3.1-8b-instant"
      },
      "nvidia_nim": {
        "upstream": "meta/llama-3.1-8b-instruct"
      }
    }
  },
  "llama-3.1-nemotron-51b-instruct": {
    "providers": [
      "nvidia_nim"
    ],
    "aliases": [
      "nvidia-llama-3.1-nemotron-51b-instruct",
      "nvidia/llama-3.1-nemotron-51b-instruct"
    ],
    "family": "Meta",
    "meta": {
      "contextLength": 128000,
      "outputLimit": 4096,
      "releaseDate": "2024-09-22",
      "reasoning": false,
      "toolCall": true,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    },
    "upstream": {
      "nvidia_nim": "nvidia/llama-3.1-nemotron-51b-instruct"
    },
    "providerConfig": {
      "nvidia_nim": {
        "upstream": "nvidia/llama-3.1-nemotron-51b-instruct"
      }
    }
  },
  "llama-3.1-nemotron-70b-instruct": {
    "providers": [
      "nvidia_nim"
    ],
    "aliases": [
      "nvidia-llama-3.1-nemotron-70b-instruct",
      "nvidia/llama-3.1-nemotron-70b-instruct"
    ],
    "family": "Meta",
    "meta": {
      "contextLength": 128000,
      "outputLimit": 4096,
      "releaseDate": "2024-10-12",
      "reasoning": false,
      "toolCall": true,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    },
    "upstream": {
      "nvidia_nim": "nvidia/llama-3.1-nemotron-70b-instruct"
    },
    "providerConfig": {
      "nvidia_nim": {
        "upstream": "nvidia/llama-3.1-nemotron-70b-instruct"
      }
    }
  },
  "llama-3.1-nemotron-nano-8b-v1": {
    "providers": [
      "nvidia_nim"
    ],
    "upstream": {
      "nvidia_nim": "nvidia/llama-3.1-nemotron-nano-8b-v1"
    },
    "providerConfig": {
      "nvidia_nim": {
        "upstream": "nvidia/llama-3.1-nemotron-nano-8b-v1"
      }
    }
  },
  "llama-3.1-nemotron-nano-vl-8b-v1": {
    "providers": [
      "nvidia_nim"
    ],
    "upstream": {
      "nvidia_nim": "nvidia/llama-3.1-nemotron-nano-vl-8b-v1"
    },
    "providerConfig": {
      "nvidia_nim": {
        "upstream": "nvidia/llama-3.1-nemotron-nano-vl-8b-v1"
      }
    }
  },
  "llama-3.1-nemotron-ultra-253b-v1": {
    "providers": [],
    "aliases": [
      "nvidia-llama-3.1-nemotron-ultra-253b-v1",
      "nvidia/llama-3.1-nemotron-ultra-253b-v1"
    ],
    "family": "Meta",
    "meta": {
      "contextLength": 131072,
      "outputLimit": 8192,
      "knowledgeCutoff": "2024-07",
      "releaseDate": "2024-07-01",
      "reasoning": true,
      "toolCall": true,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    }
  },
  "llama-3.1-swallow-70b-instruct-v0.1": {
    "providers": [],
    "family": "Meta"
  },
  "llama-3.1-swallow-8b-instruct-v0.1": {
    "providers": [],
    "family": "Meta"
  },
  "llama-3.2-11b-vision-instruct": {
    "providers": [
      "nvidia_nim"
    ],
    "aliases": [
      "meta-llama-3.2-11b-vision-instruct",
      "meta/llama-3.2-11b-vision-instruct"
    ],
    "family": "Meta",
    "meta": {
      "contextLength": 128000,
      "outputLimit": 8192,
      "knowledgeCutoff": "2023-12",
      "releaseDate": "2024-09-25",
      "reasoning": false,
      "toolCall": true,
      "vision": true,
      "modalities": {
        "input": [
          "text",
          "image"
        ],
        "output": [
          "text"
        ]
      }
    },
    "upstream": {
      "nvidia_nim": "meta/llama-3.2-11b-vision-instruct"
    },
    "providerConfig": {
      "nvidia_nim": {
        "upstream": "meta/llama-3.2-11b-vision-instruct"
      }
    }
  },
  "llama-3.2-1b-instruct": {
    "providers": [
      "nvidia_nim"
    ],
    "aliases": [
      "meta-llama-3.2-1b-instruct",
      "meta/llama-3.2-1b-instruct"
    ],
    "family": "Meta",
    "meta": {
      "contextLength": 128000,
      "outputLimit": 4096,
      "knowledgeCutoff": "2023-12",
      "releaseDate": "2024-09-18",
      "reasoning": false,
      "toolCall": true,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    },
    "upstream": {
      "nvidia_nim": "meta/llama-3.2-1b-instruct"
    },
    "providerConfig": {
      "nvidia_nim": {
        "upstream": "meta/llama-3.2-1b-instruct"
      }
    }
  },
  "llama-3.2-3b-instruct": {
    "providers": [
      "openrouter",
      "nvidia_nim"
    ],
    "family": "Meta",
    "meta": {
      "contextLength": 16000,
      "outputLimit": 4096,
      "knowledgeCutoff": "2023-12",
      "releaseDate": "2025-01-01",
      "reasoning": false,
      "toolCall": true,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    },
    "upstream": {
      "nvidia_nim": "meta/llama-3.2-3b-instruct",
      "openrouter": "meta-llama/llama-3.2-3b-instruct:free"
    },
    "providerConfig": {
      "nvidia_nim": {
        "upstream": "meta/llama-3.2-3b-instruct"
      },
      "openrouter": {
        "upstream": "meta-llama/llama-3.2-3b-instruct:free"
      }
    }
  },
  "llama-3.2-90b-vision-instruct": {
    "providers": [
      "nvidia_nim"
    ],
    "family": "Meta",
    "meta": {
      "contextLength": 128000,
      "outputLimit": 8192,
      "knowledgeCutoff": "2023-12",
      "releaseDate": "2024-09-25",
      "reasoning": false,
      "toolCall": true,
      "vision": true,
      "modalities": {
        "input": [
          "text",
          "image"
        ],
        "output": [
          "text"
        ]
      }
    },
    "upstream": {
      "nvidia_nim": "meta/llama-3.2-90b-vision-instruct"
    },
    "providerConfig": {
      "nvidia_nim": {
        "upstream": "meta/llama-3.2-90b-vision-instruct"
      }
    }
  },
  "llama-3.3-70b-instruct": {
    "providers": [
      "openrouter",
      "workers_ai",
      "nvidia_nim"
    ],
    "aliases": [
      "meta-llama-3.3-70b-instruct",
      "meta/llama-3.3-70b-instruct"
    ],
    "family": "Meta",
    "meta": {
      "contextLength": 128000,
      "outputLimit": 4096,
      "knowledgeCutoff": "2023-12",
      "releaseDate": "2024-12-06",
      "reasoning": false,
      "toolCall": true,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    },
    "upstream": {
      "nvidia_nim": "meta/llama-3.3-70b-instruct",
      "openrouter": "meta-llama/llama-3.3-70b-instruct:free"
    },
    "providerConfig": {
      "nvidia_nim": {
        "upstream": "meta/llama-3.3-70b-instruct"
      },
      "openrouter": {
        "upstream": "meta-llama/llama-3.3-70b-instruct:free"
      }
    }
  },
  "llama-3.3-70b-versatile": {
    "providers": [
      "groq"
    ]
  },
  "llama-3.3-nemotron-super-49b-v1.5": {
    "providers": [
      "nvidia_nim"
    ],
    "aliases": [
      "nvidia-llama-3.3-nemotron-super-49b-v1.5",
      "nvidia/llama-3.3-nemotron-super-49b-v1.5"
    ],
    "family": "Meta",
    "meta": {
      "contextLength": 128000,
      "outputLimit": 4096,
      "releaseDate": "2025-03-16",
      "reasoning": false,
      "toolCall": false,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    },
    "upstream": {
      "nvidia_nim": "nvidia/llama-3.3-nemotron-super-49b-v1.5"
    },
    "providerConfig": {
      "nvidia_nim": {
        "upstream": "nvidia/llama-3.3-nemotron-super-49b-v1.5"
      }
    }
  },
  "llama-3.3-nemotron-super-49b-v1": {
    "providers": [
      "nvidia_nim"
    ],
    "aliases": [
      "nvidia-llama-3.3-nemotron-super-49b-v1",
      "nvidia/llama-3.3-nemotron-super-49b-v1"
    ],
    "family": "Meta",
    "meta": {
      "contextLength": 128000,
      "outputLimit": 4096,
      "releaseDate": "2025-03-16",
      "reasoning": false,
      "toolCall": false,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    },
    "upstream": {
      "nvidia_nim": "nvidia/llama-3.3-nemotron-super-49b-v1"
    },
    "providerConfig": {
      "nvidia_nim": {
        "upstream": "nvidia/llama-3.3-nemotron-super-49b-v1"
      }
    }
  },
  "llama-4-maverick-17b-128e-instruct": {
    "providers": [
      "nvidia_nim"
    ],
    "aliases": [
      "meta-llama-4-maverick-17b-128e-instruct",
      "meta/llama-4-maverick-17b-128e-instruct"
    ],
    "family": "Meta",
    "meta": {
      "contextLength": 128000,
      "outputLimit": 4096,
      "knowledgeCutoff": "2024-08",
      "releaseDate": "2025-04-05",
      "reasoning": false,
      "toolCall": true,
      "vision": true,
      "modalities": {
        "input": [
          "text",
          "image"
        ],
        "output": [
          "text"
        ]
      }
    },
    "upstream": {
      "nvidia_nim": "meta/llama-4-maverick-17b-128e-instruct"
    },
    "providerConfig": {
      "nvidia_nim": {
        "upstream": "meta/llama-4-maverick-17b-128e-instruct"
      }
    }
  },
  "llama-4-scout-17b-16e-instruct": {
    "providers": [
      "groq",
      "workers_ai"
    ],
    "aliases": [
      "meta-llama-4-scout-17b-16e-instruct",
      "meta/llama-4-scout-17b-16e-instruct"
    ],
    "family": "Meta",
    "meta": {
      "contextLength": 128000,
      "outputLimit": 8192,
      "knowledgeCutoff": "2024-08",
      "releaseDate": "2025-04-05",
      "reasoning": false,
      "toolCall": true,
      "vision": true,
      "modalities": {
        "input": [
          "text",
          "image"
        ],
        "output": [
          "text"
        ]
      }
    },
    "upstream": {
      "groq": "meta-llama/llama-4-scout-17b-16e-instruct",
      "workers_ai": "@cf/meta/llama-4-scout-17b-16e-instruct"
    },
    "providerConfig": {
      "groq": {
        "upstream": "meta-llama/llama-4-scout-17b-16e-instruct"
      },
      "workers_ai": {
        "upstream": "@cf/meta/llama-4-scout-17b-16e-instruct"
      }
    }
  },
  "llama-guard-4-12b": {
    "providers": [],
    "family": "Meta"
  },
  "llama2-70b": {
    "providers": [
      "nvidia_nim"
    ],
    "upstream": {
      "nvidia_nim": "meta/llama2-70b"
    },
    "providerConfig": {
      "nvidia_nim": {
        "upstream": "meta/llama2-70b"
      }
    }
  },
  "llama3-70b-instruct": {
    "providers": [],
    "aliases": [
      "meta-llama3-70b-instruct",
      "meta/llama3-70b-instruct"
    ],
    "family": "Meta",
    "meta": {
      "contextLength": 128000,
      "outputLimit": 4096,
      "releaseDate": "2024-04-17",
      "reasoning": false,
      "toolCall": true,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    }
  },
  "llama3-8b-instruct": {
    "providers": [],
    "aliases": [
      "meta-llama3-8b-instruct",
      "meta/llama3-8b-instruct"
    ],
    "family": "Meta",
    "meta": {
      "contextLength": 128000,
      "outputLimit": 4096,
      "releaseDate": "2024-04-17",
      "reasoning": false,
      "toolCall": true,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    }
  },
  "llama3-chatqa-1.5-70b": {
    "providers": [],
    "aliases": [
      "nvidia-llama3-chatqa-1.5-70b",
      "nvidia/llama3-chatqa-1.5-70b"
    ],
    "family": "Meta",
    "meta": {
      "contextLength": 128000,
      "outputLimit": 4096,
      "releaseDate": "2024-04-28",
      "reasoning": false,
      "toolCall": true,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    }
  },
  "phi-3-medium-128k-instruct": {
    "providers": [],
    "aliases": [
      "microsoft-phi-3-medium-128k-instruct",
      "microsoft/phi-3-medium-128k-instruct"
    ],
    "family": "Microsoft",
    "meta": {
      "contextLength": 128000,
      "outputLimit": 4096,
      "knowledgeCutoff": "2023-10",
      "releaseDate": "2024-04-23",
      "reasoning": false,
      "toolCall": false,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    }
  },
  "phi-3-medium-4k-instruct": {
    "providers": [],
    "aliases": [
      "microsoft-phi-3-medium-4k-instruct",
      "microsoft/phi-3-medium-4k-instruct"
    ],
    "family": "Microsoft",
    "meta": {
      "contextLength": 4096,
      "outputLimit": 1024,
      "knowledgeCutoff": "2023-10",
      "releaseDate": "2024-04-23",
      "reasoning": false,
      "toolCall": false,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    }
  },
  "phi-3-mini-128k-instruct": {
    "providers": [],
    "family": "Microsoft",
    "meta": {
      "contextLength": 128000,
      "outputLimit": 4096,
      "knowledgeCutoff": "2023-10",
      "releaseDate": "2024-04-23",
      "reasoning": false,
      "toolCall": false,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    }
  },
  "phi-3-mini-4k-instruct": {
    "providers": [],
    "family": "Microsoft",
    "meta": {
      "contextLength": 4096,
      "outputLimit": 1024,
      "knowledgeCutoff": "2023-10",
      "releaseDate": "2024-04-23",
      "reasoning": false,
      "toolCall": false,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    }
  },
  "phi-3-small-128k-instruct": {
    "providers": [],
    "aliases": [
      "microsoft-phi-3-small-128k-instruct",
      "microsoft/phi-3-small-128k-instruct"
    ],
    "family": "Microsoft",
    "meta": {
      "contextLength": 128000,
      "outputLimit": 4096,
      "knowledgeCutoff": "2023-10",
      "releaseDate": "2024-04-23",
      "reasoning": false,
      "toolCall": false,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    }
  },
  "phi-3-small-8k-instruct": {
    "providers": [],
    "aliases": [
      "microsoft-phi-3-small-8k-instruct",
      "microsoft/phi-3-small-8k-instruct"
    ],
    "family": "Microsoft",
    "meta": {
      "contextLength": 8192,
      "outputLimit": 2048,
      "knowledgeCutoff": "2023-10",
      "releaseDate": "2024-04-23",
      "reasoning": false,
      "toolCall": false,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    }
  },
  "phi-3-vision-128k-instruct": {
    "providers": [
      "nvidia_nim"
    ],
    "aliases": [
      "microsoft-phi-3-vision-128k-instruct",
      "microsoft/phi-3-vision-128k-instruct"
    ],
    "family": "Microsoft",
    "meta": {
      "contextLength": 128000,
      "outputLimit": 4096,
      "releaseDate": "2024-05-19",
      "reasoning": false,
      "toolCall": true,
      "vision": false,
      "modalities": {
        "input": [
          "text",
          "image"
        ],
        "output": [
          "text"
        ]
      }
    },
    "upstream": {
      "nvidia_nim": "microsoft/phi-3-vision-128k-instruct"
    },
    "providerConfig": {
      "nvidia_nim": {
        "upstream": "microsoft/phi-3-vision-128k-instruct"
      }
    }
  },
  "phi-3.5-mini-instruct": {
    "providers": [],
    "family": "Microsoft",
    "meta": {
      "contextLength": 128000,
      "outputLimit": 4096,
      "knowledgeCutoff": "2023-10",
      "releaseDate": "2024-08-20",
      "reasoning": false,
      "toolCall": false,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    }
  },
  "phi-3.5-moe-instruct": {
    "providers": [
      "nvidia_nim"
    ],
    "aliases": [
      "microsoft-phi-3.5-moe-instruct",
      "microsoft/phi-3.5-moe-instruct"
    ],
    "family": "Microsoft",
    "meta": {
      "contextLength": 128000,
      "outputLimit": 4096,
      "knowledgeCutoff": "2023-10",
      "releaseDate": "2024-08-20",
      "reasoning": false,
      "toolCall": false,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    },
    "upstream": {
      "nvidia_nim": "microsoft/phi-3.5-moe-instruct"
    },
    "providerConfig": {
      "nvidia_nim": {
        "upstream": "microsoft/phi-3.5-moe-instruct"
      }
    }
  },
  "phi-3.5-vision-instruct": {
    "providers": [],
    "aliases": [
      "microsoft-phi-3.5-vision-instruct",
      "microsoft/phi-3.5-vision-instruct"
    ],
    "family": "Microsoft",
    "meta": {
      "contextLength": 128000,
      "outputLimit": 4096,
      "releaseDate": "2024-08-16",
      "reasoning": false,
      "toolCall": true,
      "vision": false,
      "modalities": {
        "input": [
          "text",
          "image"
        ],
        "output": [
          "text"
        ]
      }
    }
  },
  "phi-4-mini-instruct": {
    "providers": [
      "nvidia_nim"
    ],
    "aliases": [
      "microsoft-phi-4-mini-instruct",
      "microsoft/phi-4-mini-instruct"
    ],
    "family": "Microsoft",
    "meta": {
      "contextLength": 128000,
      "outputLimit": 16384,
      "releaseDate": "2025-07-26",
      "reasoning": false,
      "toolCall": false,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    },
    "upstream": {
      "nvidia_nim": "microsoft/phi-4-mini-instruct"
    },
    "providerConfig": {
      "nvidia_nim": {
        "upstream": "microsoft/phi-4-mini-instruct"
      }
    }
  },
  "phi-4-multimodal-instruct": {
    "providers": [
      "nvidia_nim"
    ],
    "family": "Microsoft",
    "meta": {
      "contextLength": 128000,
      "outputLimit": 16384,
      "releaseDate": "2025-07-26",
      "reasoning": false,
      "toolCall": false,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    },
    "upstream": {
      "nvidia_nim": "microsoft/phi-4-multimodal-instruct"
    },
    "providerConfig": {
      "nvidia_nim": {
        "upstream": "microsoft/phi-4-multimodal-instruct"
      }
    }
  },
  "minimax-m2.1": {
    "providers": [
      "kiro",
      "ollama_cloud"
    ],
    "family": "MiniMax",
    "meta": {
      "contextLength": 204800,
      "outputLimit": 131072,
      "releaseDate": "2025-12-23",
      "reasoning": true,
      "toolCall": true,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    }
  },
  "minimax-m2.5": {
    "providers": [
      "kiro",
      "ollama_cloud",
      "openrouter",
      "nvidia_nim"
    ],
    "family": "MiniMax",
    "meta": {
      "contextLength": 204800,
      "outputLimit": 131072,
      "knowledgeCutoff": "2025-01",
      "releaseDate": "2026-02-12",
      "reasoning": true,
      "toolCall": true,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    },
    "upstream": {
      "nvidia_nim": "minimaxai/minimax-m2.5",
      "openrouter": "minimax/minimax-m2.5:free"
    },
    "providerConfig": {
      "nvidia_nim": {
        "upstream": "minimaxai/minimax-m2.5"
      },
      "openrouter": {
        "upstream": "minimax/minimax-m2.5:free"
      }
    }
  },
  "minimax-m2.7": {
    "providers": [
      "ollama_cloud",
      "nvidia_nim"
    ],
    "family": "MiniMax",
    "meta": {
      "contextLength": 204800,
      "outputLimit": 131072,
      "releaseDate": "2026-03-18",
      "reasoning": true,
      "toolCall": true,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    },
    "upstream": {
      "nvidia_nim": "minimaxai/minimax-m2.7"
    },
    "providerConfig": {
      "nvidia_nim": {
        "upstream": "minimaxai/minimax-m2.7"
      }
    }
  },
  "minimax-m2": {
    "providers": [
      "ollama_cloud"
    ],
    "family": "MiniMax",
    "meta": {
      "contextLength": 204800,
      "outputLimit": 128000,
      "releaseDate": "2025-10-23",
      "reasoning": false,
      "toolCall": true,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    }
  },
  "codestral-22b-instruct-v0.1": {
    "providers": [
      "nvidia_nim"
    ],
    "aliases": [
      "mistralai-codestral-22b-instruct-v0.1",
      "mistralai/codestral-22b-instruct-v0.1"
    ],
    "family": "Mistral",
    "meta": {
      "contextLength": 128000,
      "outputLimit": 4096,
      "releaseDate": "2024-05-29",
      "reasoning": false,
      "toolCall": true,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    },
    "upstream": {
      "nvidia_nim": "mistralai/codestral-22b-instruct-v0.1"
    },
    "providerConfig": {
      "nvidia_nim": {
        "upstream": "mistralai/codestral-22b-instruct-v0.1"
      }
    }
  },
  "devstral-2-123b-instruct-2512": {
    "providers": [
      "nvidia_nim"
    ],
    "upstream": {
      "nvidia_nim": "mistralai/devstral-2-123b-instruct-2512"
    },
    "providerConfig": {
      "nvidia_nim": {
        "upstream": "mistralai/devstral-2-123b-instruct-2512"
      }
    }
  },
  "devstral-2-123b": {
    "providers": [
      "ollama_cloud"
    ],
    "family": "Mistral",
    "meta": {
      "contextLength": 262144,
      "outputLimit": 262144,
      "knowledgeCutoff": "2025-12",
      "releaseDate": "2025-12-09",
      "reasoning": false,
      "toolCall": true,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    },
    "upstream": {
      "ollama_cloud": "devstral-2:123b"
    },
    "providerConfig": {
      "ollama_cloud": {
        "upstream": "devstral-2:123b"
      }
    }
  },
  "devstral-small-2-24b": {
    "providers": [
      "ollama_cloud"
    ],
    "family": "Mistral",
    "meta": {
      "contextLength": 128000,
      "outputLimit": 128000,
      "knowledgeCutoff": "2025-05",
      "releaseDate": "2025-07-10",
      "reasoning": false,
      "toolCall": true,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    },
    "upstream": {
      "ollama_cloud": "devstral-small-2:24b"
    },
    "providerConfig": {
      "ollama_cloud": {
        "upstream": "devstral-small-2:24b"
      }
    }
  },
  "magistral-small-2506": {
    "providers": [
      "nvidia_nim"
    ],
    "family": "Mistral",
    "meta": {
      "contextLength": 128000,
      "outputLimit": 128000,
      "knowledgeCutoff": "2025-06",
      "releaseDate": "2025-03-17",
      "reasoning": true,
      "toolCall": true,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    },
    "upstream": {
      "nvidia_nim": "mistralai/magistral-small-2506"
    },
    "providerConfig": {
      "nvidia_nim": {
        "upstream": "mistralai/magistral-small-2506"
      }
    }
  },
  "mamba-codestral-7b-v0.1": {
    "providers": [],
    "aliases": [
      "mistralai-mamba-codestral-7b-v0.1",
      "mistralai/mamba-codestral-7b-v0.1"
    ],
    "family": "Mistral",
    "meta": {
      "contextLength": 128000,
      "outputLimit": 4096,
      "releaseDate": "2024-07-16",
      "reasoning": false,
      "toolCall": false,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    }
  },
  "ministral-14b-instruct-2512": {
    "providers": [
      "nvidia_nim"
    ],
    "upstream": {
      "nvidia_nim": "mistralai/ministral-14b-instruct-2512"
    },
    "providerConfig": {
      "nvidia_nim": {
        "upstream": "mistralai/ministral-14b-instruct-2512"
      }
    }
  },
  "ministral-3-14b": {
    "providers": [
      "ollama_cloud"
    ],
    "family": "Mistral",
    "meta": {
      "contextLength": 128000,
      "outputLimit": 128000,
      "knowledgeCutoff": "2024-10",
      "releaseDate": "2024-10-01",
      "reasoning": false,
      "toolCall": true,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    },
    "upstream": {
      "ollama_cloud": "ministral-3:14b"
    },
    "providerConfig": {
      "ollama_cloud": {
        "upstream": "ministral-3:14b"
      }
    }
  },
  "ministral-3-3b": {
    "providers": [
      "ollama_cloud"
    ],
    "family": "Mistral",
    "meta": {
      "contextLength": 128000,
      "outputLimit": 128000,
      "knowledgeCutoff": "2024-10",
      "releaseDate": "2024-10-01",
      "reasoning": false,
      "toolCall": true,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    },
    "upstream": {
      "ollama_cloud": "ministral-3:3b"
    },
    "providerConfig": {
      "ollama_cloud": {
        "upstream": "ministral-3:3b"
      }
    }
  },
  "ministral-3-8b": {
    "providers": [
      "ollama_cloud"
    ],
    "family": "Mistral",
    "meta": {
      "contextLength": 128000,
      "outputLimit": 128000,
      "knowledgeCutoff": "2024-10",
      "releaseDate": "2024-10-01",
      "reasoning": false,
      "toolCall": true,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    },
    "upstream": {
      "ollama_cloud": "ministral-3:8b"
    },
    "providerConfig": {
      "ollama_cloud": {
        "upstream": "ministral-3:8b"
      }
    }
  },
  "mistral-7b-instruct-v0.2": {
    "providers": [],
    "family": "Mistral",
    "meta": {
      "contextLength": 128000,
      "outputLimit": 128000,
      "knowledgeCutoff": "2024-07",
      "releaseDate": "2024-07-01",
      "reasoning": false,
      "toolCall": true,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    }
  },
  "mistral-7b-instruct-v0.3": {
    "providers": [
      "nvidia_nim"
    ],
    "family": "Mistral",
    "meta": {
      "contextLength": 65536,
      "outputLimit": 65536,
      "releaseDate": "2025-04-01",
      "reasoning": false,
      "toolCall": true,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    },
    "upstream": {
      "nvidia_nim": "mistralai/mistral-7b-instruct-v0.3"
    },
    "providerConfig": {
      "nvidia_nim": {
        "upstream": "mistralai/mistral-7b-instruct-v0.3"
      }
    }
  },
  "mistral-large-2-instruct": {
    "providers": [
      "nvidia_nim"
    ],
    "aliases": [
      "mistralai-mistral-large-2-instruct",
      "mistralai/mistral-large-2-instruct"
    ],
    "family": "Mistral",
    "meta": {
      "contextLength": 128000,
      "outputLimit": 4096,
      "releaseDate": "2024-07-24",
      "reasoning": false,
      "toolCall": true,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    },
    "upstream": {
      "nvidia_nim": "mistralai/mistral-large-2-instruct"
    },
    "providerConfig": {
      "nvidia_nim": {
        "upstream": "mistralai/mistral-large-2-instruct"
      }
    }
  },
  "mistral-large-3-675b-instruct-2512": {
    "providers": [
      "nvidia_nim"
    ],
    "upstream": {
      "nvidia_nim": "mistralai/mistral-large-3-675b-instruct-2512"
    },
    "providerConfig": {
      "nvidia_nim": {
        "upstream": "mistralai/mistral-large-3-675b-instruct-2512"
      }
    }
  },
  "mistral-large-3-675b": {
    "providers": [
      "ollama_cloud"
    ],
    "family": "Mistral",
    "meta": {
      "contextLength": 262144,
      "outputLimit": 262144,
      "knowledgeCutoff": "2025-01",
      "releaseDate": "2025-12-02",
      "reasoning": false,
      "toolCall": true,
      "vision": true,
      "modalities": {
        "input": [
          "text",
          "image"
        ],
        "output": [
          "text"
        ]
      }
    },
    "upstream": {
      "ollama_cloud": "mistral-large-3:675b"
    },
    "providerConfig": {
      "ollama_cloud": {
        "upstream": "mistral-large-3:675b"
      }
    }
  },
  "mistral-large": {
    "providers": [
      "nvidia_nim"
    ],
    "family": "Mistral",
    "meta": {
      "contextLength": 262144,
      "outputLimit": 262144,
      "knowledgeCutoff": "2024-11",
      "releaseDate": "2024-11-01",
      "reasoning": false,
      "toolCall": true,
      "vision": true,
      "modalities": {
        "input": [
          "text",
          "image"
        ],
        "output": [
          "text"
        ]
      }
    },
    "upstream": {
      "nvidia_nim": "mistralai/mistral-large"
    },
    "providerConfig": {
      "nvidia_nim": {
        "upstream": "mistralai/mistral-large"
      }
    }
  },
  "mistral-medium-3-instruct": {
    "providers": [
      "nvidia_nim"
    ],
    "family": "Mistral",
    "meta": {
      "contextLength": 262144,
      "outputLimit": 262144,
      "knowledgeCutoff": "2025-05",
      "releaseDate": "2025-08-12",
      "reasoning": false,
      "toolCall": true,
      "vision": true,
      "modalities": {
        "input": [
          "text",
          "image"
        ],
        "output": [
          "text"
        ]
      }
    },
    "upstream": {
      "nvidia_nim": "mistralai/mistral-medium-3-instruct"
    },
    "providerConfig": {
      "nvidia_nim": {
        "upstream": "mistralai/mistral-medium-3-instruct"
      }
    }
  },
  "mistral-medium-3.5-128b": {
    "providers": [
      "nvidia_nim"
    ],
    "upstream": {
      "nvidia_nim": "mistralai/mistral-medium-3.5-128b"
    },
    "providerConfig": {
      "nvidia_nim": {
        "upstream": "mistralai/mistral-medium-3.5-128b"
      }
    }
  },
  "mistral-nemo-12b-instruct": {
    "providers": [
      "nvidia_nim"
    ],
    "family": "Mistral",
    "meta": {
      "contextLength": 128000,
      "outputLimit": 128000,
      "knowledgeCutoff": "2024-07",
      "releaseDate": "2024-07-01",
      "reasoning": false,
      "toolCall": true,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    },
    "upstream": {
      "nvidia_nim": "nv-mistralai/mistral-nemo-12b-instruct"
    },
    "providerConfig": {
      "nvidia_nim": {
        "upstream": "nv-mistralai/mistral-nemo-12b-instruct"
      }
    }
  },
  "mistral-nemo-minitron-8b-8k-instruct": {
    "providers": [
      "nvidia_nim"
    ],
    "family": "Mistral",
    "upstream": {
      "nvidia_nim": "nvidia/mistral-nemo-minitron-8b-8k-instruct"
    },
    "providerConfig": {
      "nvidia_nim": {
        "upstream": "nvidia/mistral-nemo-minitron-8b-8k-instruct"
      }
    }
  },
  "mistral-nemotron": {
    "providers": [
      "nvidia_nim"
    ],
    "family": "Mistral",
    "upstream": {
      "nvidia_nim": "mistralai/mistral-nemotron"
    },
    "providerConfig": {
      "nvidia_nim": {
        "upstream": "mistralai/mistral-nemotron"
      }
    }
  },
  "mistral-small-24b-instruct": {
    "providers": [],
    "family": "Mistral",
    "meta": {
      "contextLength": 128000,
      "outputLimit": 16384,
      "knowledgeCutoff": "2025-03",
      "releaseDate": "2025-06-20",
      "reasoning": false,
      "toolCall": true,
      "vision": false,
      "modalities": {
        "input": [
          "text",
          "image"
        ],
        "output": [
          "text"
        ]
      }
    }
  },
  "mistral-small-3.1-24b-instruct-2503": {
    "providers": [],
    "aliases": [
      "mistralai-mistral-small-3.1-24b-instruct-2503",
      "mistralai/mistral-small-3.1-24b-instruct-2503"
    ],
    "family": "Mistral",
    "meta": {
      "contextLength": 128000,
      "outputLimit": 4096,
      "releaseDate": "2025-03-11",
      "reasoning": false,
      "toolCall": true,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    }
  },
  "mistral-small-3.1-24b-instruct": {
    "providers": [
      "workers_ai"
    ],
    "family": "Mistral",
    "meta": {
      "contextLength": 128000,
      "outputLimit": 4096,
      "releaseDate": "2025-03-11",
      "reasoning": false,
      "toolCall": true,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    },
    "upstream": {
      "workers_ai": "@cf/mistralai/mistral-small-3.1-24b-instruct"
    },
    "providerConfig": {
      "workers_ai": {
        "upstream": "@cf/mistralai/mistral-small-3.1-24b-instruct"
      }
    }
  },
  "mistral-small-4-119b-2603": {
    "providers": [
      "nvidia_nim"
    ],
    "family": "Mistral",
    "upstream": {
      "nvidia_nim": "mistralai/mistral-small-4-119b-2603"
    },
    "providerConfig": {
      "nvidia_nim": {
        "upstream": "mistralai/mistral-small-4-119b-2603"
      }
    }
  },
  "mixtral-8x22b-instruct-v0.1": {
    "providers": [
      "nvidia_nim"
    ],
    "family": "Mistral",
    "upstream": {
      "nvidia_nim": "mistralai/mixtral-8x22b-instruct-v0.1"
    },
    "providerConfig": {
      "nvidia_nim": {
        "upstream": "mistralai/mixtral-8x22b-instruct-v0.1"
      }
    }
  },
  "mixtral-8x7b-instruct-v0.1": {
    "providers": [
      "nvidia_nim"
    ],
    "family": "Mistral",
    "meta": {
      "contextLength": 32768,
      "outputLimit": 32768,
      "releaseDate": "2025-04-01",
      "reasoning": false,
      "toolCall": false,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    },
    "upstream": {
      "nvidia_nim": "mistralai/mixtral-8x7b-instruct-v0.1"
    },
    "providerConfig": {
      "nvidia_nim": {
        "upstream": "mistralai/mixtral-8x7b-instruct-v0.1"
      }
    }
  },
  "cosmos-reason2-8b": {
    "providers": [
      "nvidia_nim"
    ],
    "family": "NVIDIA",
    "upstream": {
      "nvidia_nim": "nvidia/cosmos-reason2-8b"
    },
    "providerConfig": {
      "nvidia_nim": {
        "upstream": "nvidia/cosmos-reason2-8b"
      }
    }
  },
  "nemotron-3-nano-30b-a3b": {
    "providers": [
      "nvidia_nim",
      "openrouter"
    ],
    "family": "NVIDIA",
    "meta": {
      "contextLength": 131072,
      "outputLimit": 131072,
      "knowledgeCutoff": "2024-09",
      "releaseDate": "2024-12",
      "reasoning": true,
      "toolCall": true,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    },
    "upstream": {
      "nvidia_nim": "nvidia/nemotron-3-nano-30b-a3b",
      "openrouter": "nvidia/nemotron-3-nano-30b-a3b:free"
    },
    "providerConfig": {
      "nvidia_nim": {
        "upstream": "nvidia/nemotron-3-nano-30b-a3b"
      },
      "openrouter": {
        "upstream": "nvidia/nemotron-3-nano-30b-a3b:free"
      }
    }
  },
  "nemotron-3-nano-30b": {
    "providers": [
      "ollama_cloud"
    ],
    "family": "NVIDIA",
    "meta": {
      "contextLength": 131072,
      "outputLimit": 131072,
      "knowledgeCutoff": "2024-09",
      "releaseDate": "2024-12",
      "reasoning": true,
      "toolCall": true,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    },
    "upstream": {
      "ollama_cloud": "nemotron-3-nano:30b"
    },
    "providerConfig": {
      "ollama_cloud": {
        "upstream": "nemotron-3-nano:30b"
      }
    }
  },
  "nemotron-3-nano-omni-30b-a3b-reasoning": {
    "providers": [
      "kilo_code",
      "nvidia_nim",
      "openrouter"
    ],
    "upstream": {
      "kilo_code": "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
      "nvidia_nim": "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
      "openrouter": "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free"
    },
    "providerConfig": {
      "kilo_code": {
        "upstream": "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free"
      },
      "nvidia_nim": {
        "upstream": "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning"
      },
      "openrouter": {
        "upstream": "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free"
      }
    }
  },
  "nemotron-3-super-120b-a12b": {
    "providers": [
      "kilo_code",
      "nvidia_nim",
      "openrouter",
      "workers_ai"
    ],
    "family": "NVIDIA",
    "meta": {
      "contextLength": 262144,
      "outputLimit": 262144,
      "knowledgeCutoff": "2024-04",
      "releaseDate": "2026-03-11",
      "reasoning": true,
      "toolCall": true,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    },
    "upstream": {
      "kilo_code": "nvidia/nemotron-3-super-120b-a12b:free",
      "nvidia_nim": "nvidia/nemotron-3-super-120b-a12b",
      "openrouter": "nvidia/nemotron-3-super-120b-a12b:free",
      "workers_ai": "@cf/nvidia/nemotron-3-120b-a12b"
    },
    "providerConfig": {
      "kilo_code": {
        "upstream": "nvidia/nemotron-3-super-120b-a12b:free"
      },
      "nvidia_nim": {
        "upstream": "nvidia/nemotron-3-super-120b-a12b"
      },
      "openrouter": {
        "upstream": "nvidia/nemotron-3-super-120b-a12b:free"
      },
      "workers_ai": {
        "upstream": "@cf/nvidia/nemotron-3-120b-a12b"
      }
    }
  },
  "nemotron-3-super": {
    "providers": [
      "ollama_cloud"
    ],
    "family": "NVIDIA",
    "meta": {
      "contextLength": 262144,
      "outputLimit": 65536,
      "releaseDate": "2026-03-11",
      "reasoning": true,
      "toolCall": true,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    }
  },
  "nemotron-4-340b-instruct": {
    "providers": [
      "nvidia_nim"
    ],
    "aliases": [
      "nvidia-nemotron-4-340b-instruct",
      "nvidia/nemotron-4-340b-instruct"
    ],
    "family": "NVIDIA",
    "meta": {
      "contextLength": 128000,
      "outputLimit": 4096,
      "releaseDate": "2024-06-13",
      "reasoning": false,
      "toolCall": true,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    },
    "upstream": {
      "nvidia_nim": "nvidia/nemotron-4-340b-instruct"
    },
    "providerConfig": {
      "nvidia_nim": {
        "upstream": "nvidia/nemotron-4-340b-instruct"
      }
    }
  },
  "nemotron-4-mini-hindi-4b-instruct": {
    "providers": [],
    "family": "NVIDIA"
  },
  "nemotron-mini-4b-instruct": {
    "providers": [
      "nvidia_nim"
    ],
    "family": "NVIDIA",
    "upstream": {
      "nvidia_nim": "nvidia/nemotron-mini-4b-instruct"
    },
    "providerConfig": {
      "nvidia_nim": {
        "upstream": "nvidia/nemotron-mini-4b-instruct"
      }
    }
  },
  "nemotron-nano-12b-v2-vl": {
    "providers": [
      "nvidia_nim",
      "openrouter"
    ],
    "family": "NVIDIA",
    "meta": {
      "contextLength": 131072,
      "outputLimit": 131072,
      "knowledgeCutoff": "2024-10",
      "releaseDate": "2024-12",
      "reasoning": true,
      "toolCall": true,
      "vision": true,
      "modalities": {
        "input": [
          "text",
          "image"
        ],
        "output": [
          "text"
        ]
      }
    },
    "upstream": {
      "nvidia_nim": "nvidia/nemotron-nano-12b-v2-vl",
      "openrouter": "nvidia/nemotron-nano-12b-v2-vl:free"
    },
    "providerConfig": {
      "nvidia_nim": {
        "upstream": "nvidia/nemotron-nano-12b-v2-vl"
      },
      "openrouter": {
        "upstream": "nvidia/nemotron-nano-12b-v2-vl:free"
      }
    }
  },
  "nemotron-nano-9b-v2": {
    "providers": [
      "nvidia_nim",
      "openrouter"
    ],
    "aliases": [
      "nvidia-nvidia-nemotron-nano-9b-v2",
      "nvidia-nemotron-nano-9b-v2",
      "nvidia/nvidia-nemotron-nano-9b-v2"
    ],
    "family": "NVIDIA",
    "meta": {
      "contextLength": 131072,
      "outputLimit": 131072,
      "knowledgeCutoff": "2024-09",
      "releaseDate": "2025-08-18",
      "reasoning": true,
      "toolCall": true,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    },
    "upstream": {
      "nvidia_nim": "nvidia/nvidia-nemotron-nano-9b-v2",
      "openrouter": "nvidia/nemotron-nano-9b-v2:free"
    },
    "providerConfig": {
      "nvidia_nim": {
        "upstream": "nvidia/nvidia-nemotron-nano-9b-v2"
      },
      "openrouter": {
        "upstream": "nvidia/nemotron-nano-9b-v2:free"
      }
    }
  },
  "nim-llama-3.1-70b-instruct": {
    "providers": [],
    "aliases": [
      "meta/llama-3.1-70b-instruct"
    ],
    "family": "NVIDIA",
    "meta": {
      "contextLength": 128000,
      "outputLimit": 4096,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    }
  },
  "usdcode-llama-3.1-70b-instruct": {
    "providers": [],
    "family": "NVIDIA"
  },
  "gpt-4.1": {
    "providers": [
      "copilot"
    ],
    "family": "OpenAI",
    "meta": {
      "contextLength": 1047576,
      "outputLimit": 32768,
      "knowledgeCutoff": "2024-04",
      "releaseDate": "2025-04-14",
      "reasoning": false,
      "toolCall": true,
      "vision": true,
      "modalities": {
        "input": [
          "text",
          "image"
        ],
        "output": [
          "text"
        ]
      }
    }
  },
  "gpt-4o": {
    "providers": [],
    "family": "OpenAI",
    "meta": {
      "contextLength": 128000,
      "outputLimit": 16384,
      "knowledgeCutoff": "2023-09",
      "releaseDate": "2024-05-13",
      "reasoning": false,
      "toolCall": true,
      "vision": true,
      "modalities": {
        "input": [
          "text",
          "image"
        ],
        "output": [
          "text"
        ]
      }
    }
  },
  "gpt-5-mini": {
    "providers": [
      "copilot"
    ],
    "family": "OpenAI",
    "meta": {
      "contextLength": 400000,
      "outputLimit": 128000,
      "knowledgeCutoff": "2024-05-30",
      "releaseDate": "2025-08-07",
      "reasoning": true,
      "toolCall": true,
      "vision": true,
      "modalities": {
        "input": [
          "text",
          "image"
        ],
        "output": [
          "text"
        ]
      }
    }
  },
  "gpt-5.1-codex-max": {
    "providers": [],
    "family": "OpenAI",
    "meta": {
      "contextLength": 400000,
      "outputLimit": 128000,
      "knowledgeCutoff": "2024-09-30",
      "releaseDate": "2025-11-13",
      "reasoning": true,
      "toolCall": true,
      "vision": true,
      "modalities": {
        "input": [
          "text",
          "image"
        ],
        "output": [
          "text"
        ]
      }
    }
  },
  "gpt-5.1-codex-mini": {
    "providers": [],
    "family": "OpenAI",
    "meta": {
      "contextLength": 400000,
      "outputLimit": 128000,
      "knowledgeCutoff": "2024-09-30",
      "releaseDate": "2025-11-13",
      "reasoning": true,
      "toolCall": true,
      "vision": true,
      "modalities": {
        "input": [
          "text",
          "image"
        ],
        "output": [
          "text"
        ]
      }
    }
  },
  "gpt-5.1-codex": {
    "providers": [],
    "family": "OpenAI",
    "meta": {
      "contextLength": 400000,
      "outputLimit": 128000,
      "knowledgeCutoff": "2024-09-30",
      "releaseDate": "2025-11-13",
      "reasoning": true,
      "toolCall": true,
      "vision": true,
      "modalities": {
        "input": [
          "text",
          "image"
        ],
        "output": [
          "text"
        ]
      }
    }
  },
  "gpt-5.1": {
    "providers": [],
    "family": "OpenAI",
    "meta": {
      "contextLength": 400000,
      "outputLimit": 128000,
      "knowledgeCutoff": "2024-09-30",
      "releaseDate": "2025-11-13",
      "reasoning": true,
      "toolCall": true,
      "vision": true,
      "modalities": {
        "input": [
          "text",
          "image"
        ],
        "output": [
          "text"
        ]
      }
    }
  },
  "gpt-5.2-codex": {
    "providers": [
      "copilot"
    ],
    "family": "OpenAI",
    "meta": {
      "contextLength": 400000,
      "outputLimit": 128000,
      "knowledgeCutoff": "2025-08-31",
      "releaseDate": "2025-12-11",
      "reasoning": true,
      "toolCall": true,
      "vision": true,
      "modalities": {
        "input": [
          "text",
          "image",
          "pdf"
        ],
        "output": [
          "text"
        ]
      }
    },
    "providerConfig": {
      "copilot": {
        "responses_api": true
      }
    }
  },
  "gpt-5.2": {
    "providers": [
      "codex",
      "copilot"
    ],
    "family": "OpenAI",
    "meta": {
      "contextLength": 400000,
      "outputLimit": 128000,
      "knowledgeCutoff": "2025-08-31",
      "releaseDate": "2025-12-11",
      "reasoning": true,
      "toolCall": true,
      "vision": true,
      "modalities": {
        "input": [
          "text",
          "image"
        ],
        "output": [
          "text"
        ]
      }
    }
  },
  "gpt-5.3-codex": {
    "providers": [
      "codex",
      "copilot"
    ],
    "family": "OpenAI",
    "meta": {
      "contextLength": 400000,
      "outputLimit": 128000,
      "knowledgeCutoff": "2025-08-31",
      "releaseDate": "2026-02-05",
      "reasoning": true,
      "toolCall": true,
      "vision": true,
      "modalities": {
        "input": [
          "text",
          "image",
          "pdf"
        ],
        "output": [
          "text"
        ]
      }
    },
    "providerConfig": {
      "copilot": {
        "responses_api": true
      }
    }
  },
  "gpt-5.4-mini": {
    "providers": [
      "codex",
      "copilot"
    ],
    "family": "OpenAI",
    "meta": {
      "contextLength": 400000,
      "outputLimit": 128000,
      "knowledgeCutoff": "2025-08-31",
      "releaseDate": "2026-03-17",
      "reasoning": true,
      "toolCall": true,
      "vision": true,
      "modalities": {
        "input": [
          "text",
          "image"
        ],
        "output": [
          "text"
        ]
      }
    },
    "providerConfig": {
      "copilot": {
        "responses_api": true
      }
    }
  },
  "gpt-5.4-nano": {
    "providers": [
      "copilot"
    ],
    "providerConfig": {
      "copilot": {
        "responses_api": true
      }
    }
  },
  "gpt-5.4": {
    "providers": [
      "codex",
      "copilot"
    ],
    "family": "OpenAI",
    "meta": {
      "contextLength": 1050000,
      "outputLimit": 128000,
      "knowledgeCutoff": "2025-08-31",
      "releaseDate": "2026-03-05",
      "reasoning": true,
      "toolCall": true,
      "vision": true,
      "modalities": {
        "input": [
          "text",
          "image",
          "pdf"
        ],
        "output": [
          "text"
        ]
      }
    },
    "providerConfig": {
      "copilot": {
        "responses_api": true
      }
    }
  },
  "gpt-5.5": {
    "providers": [
      "codex",
      "copilot"
    ],
    "family": "OpenAI"
  },
  "gpt-oss-120b-medium": {
    "providers": [
      "antigravity",
      "ollama_cloud"
    ],
    "aliases": [
      "gpt-oss-120b"
    ],
    "family": "OpenAI",
    "meta": {
      "contextLength": 128000,
      "outputLimit": 4096,
      "releaseDate": "2025-08-06",
      "reasoning": true,
      "toolCall": true,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    },
    "upstream": {
      "ollama_cloud": "gpt-oss:120b"
    },
    "providerConfig": {
      "ollama_cloud": {
        "upstream": "gpt-oss:120b"
      }
    }
  },
  "gpt-oss-120b": {
    "providers": [
      "groq",
      "nvidia_nim",
      "ollama_cloud",
      "openrouter",
      "workers_ai"
    ],
    "family": "OpenAI",
    "upstream": {
      "groq": "openai/gpt-oss-120b",
      "nvidia_nim": "openai/gpt-oss-120b",
      "ollama_cloud": "gpt-oss:120b",
      "openrouter": "openai/gpt-oss-120b:free"
    },
    "providerConfig": {
      "groq": {
        "upstream": "openai/gpt-oss-120b"
      },
      "nvidia_nim": {
        "upstream": "openai/gpt-oss-120b"
      },
      "ollama_cloud": {
        "upstream": "gpt-oss:120b"
      },
      "openrouter": {
        "upstream": "openai/gpt-oss-120b:free"
      }
    }
  },
  "gpt-oss-20b": {
    "providers": [
      "groq",
      "ollama_cloud",
      "openrouter",
      "workers_ai",
      "nvidia_nim"
    ],
    "aliases": [
      "openai-gpt-oss-20b"
    ],
    "family": "OpenAI",
    "meta": {
      "contextLength": 128000,
      "outputLimit": 4096,
      "releaseDate": "2025-08-06",
      "reasoning": true,
      "toolCall": true,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    },
    "upstream": {
      "groq": "openai/gpt-oss-20b",
      "nvidia_nim": "openai/gpt-oss-20b",
      "ollama_cloud": "gpt-oss:20b",
      "openrouter": "openai/gpt-oss-20b:free",
      "workers_ai": "@cf/openai/gpt-oss-20b"
    },
    "providerConfig": {
      "groq": {
        "upstream": "openai/gpt-oss-20b"
      },
      "nvidia_nim": {
        "upstream": "openai/gpt-oss-20b"
      },
      "ollama_cloud": {
        "upstream": "gpt-oss:20b"
      },
      "openrouter": {
        "upstream": "openai/gpt-oss-20b:free"
      },
      "workers_ai": {
        "upstream": "@cf/openai/gpt-oss-20b"
      }
    }
  },
  "grok-code-fast-1": {
    "providers": [
      "copilot",
      "kilo_code"
    ],
    "family": "OpenAI",
    "meta": {
      "contextLength": 256000,
      "outputLimit": 10000,
      "knowledgeCutoff": "2023-10",
      "releaseDate": "2025-08-28",
      "reasoning": false,
      "toolCall": true,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    },
    "upstream": {
      "kilo_code": "x-ai/grok-code-fast-1:optimized:free"
    },
    "providerConfig": {
      "kilo_code": {
        "upstream": "x-ai/grok-code-fast-1:optimized:free",
        "responses_api": true
      }
    }
  },
  "openrouter-free": {
    "providers": [
      "openrouter"
    ],
    "description": "OpenRouter router that automatically selects a compatible free model.",
    "meta": {
      "contextLength": 200000,
      "reasoning": true,
      "toolCall": true,
      "vision": true
    },
    "upstream": {
      "openrouter": "openrouter/free"
    },
    "providerConfig": {
      "openrouter": {
        "upstream": "openrouter/free"
      }
    }
  },
  "agi-nova-beta": {
    "providers": [],
    "family": "AGI Nova",
    "meta": {
      "contextLength": 1000000,
      "outputLimit": 65536,
      "releaseDate": "2026-03",
      "reasoning": true,
      "toolCall": true,
      "vision": true
    }
  },
  "baichuan2-13b-chat": {
    "providers": [],
    "aliases": [
      "baichuan-inc-baichuan2-13b-chat",
      "baichuan-inc/baichuan2-13b-chat"
    ],
    "family": "Baichuan"
  },
  "bielik-11b-v2.3-instruct": {
    "providers": [],
    "family": "Bielik"
  },
  "bielik-11b-v2.6-instruct": {
    "providers": [],
    "family": "Bielik",
    "meta": {
      "contextLength": 32000,
      "outputLimit": 32000,
      "knowledgeCutoff": "2025-03",
      "releaseDate": "2025-03-13",
      "reasoning": false,
      "toolCall": true,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    }
  },
  "breeze-7b-instruct": {
    "providers": [],
    "family": "MediaTek"
  },
  "cobuddy": {
    "providers": [
      "kilo_code",
      "openrouter"
    ],
    "upstream": {
      "kilo_code": "baidu/cobuddy:free",
      "openrouter": "baidu/cobuddy:free"
    },
    "providerConfig": {
      "kilo_code": {
        "upstream": "baidu/cobuddy:free"
      },
      "openrouter": {
        "upstream": "baidu/cobuddy:free"
      }
    }
  },
  "cogito-2.1-671b": {
    "providers": [
      "ollama_cloud"
    ],
    "family": "Deep Cogito",
    "meta": {
      "contextLength": 163840,
      "outputLimit": 32000,
      "releaseDate": "2025-11-19",
      "reasoning": true,
      "toolCall": true,
      "vision": false
    },
    "upstream": {
      "ollama_cloud": "cogito-2.1:671b"
    },
    "providerConfig": {
      "ollama_cloud": {
        "upstream": "cogito-2.1:671b"
      }
    }
  },
  "corethink": {
    "providers": []
  },
  "dbrx-instruct": {
    "providers": [
      "nvidia_nim"
    ],
    "family": "Databricks",
    "upstream": {
      "nvidia_nim": "databricks/dbrx-instruct"
    },
    "providerConfig": {
      "nvidia_nim": {
        "upstream": "databricks/dbrx-instruct"
      }
    }
  },
  "dola-seed-2.0-pro": {
    "providers": [],
    "family": "ByteDance"
  },
  "dolphin-mistral-24b-venice-edition": {
    "providers": [
      "openrouter"
    ],
    "family": "Cognitive Computations",
    "meta": {
      "contextLength": 32768,
      "outputLimit": 32768,
      "knowledgeCutoff": "2025-06",
      "releaseDate": "2025-07-09",
      "reasoning": false,
      "toolCall": false,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    },
    "upstream": {
      "openrouter": "cognitivecomputations/dolphin-mistral-24b-venice-edition:free"
    },
    "providerConfig": {
      "openrouter": {
        "upstream": "cognitivecomputations/dolphin-mistral-24b-venice-edition:free"
      }
    }
  },
  "dracarys-llama-3.1-70b-instruct": {
    "providers": [
      "nvidia_nim"
    ],
    "family": "Abacus.AI",
    "upstream": {
      "nvidia_nim": "abacusai/dracarys-llama-3.1-70b-instruct"
    },
    "providerConfig": {
      "nvidia_nim": {
        "upstream": "abacusai/dracarys-llama-3.1-70b-instruct"
      }
    }
  },
  "elephant-alpha": {
    "providers": []
  },
  "eurollm-9b-instruct": {
    "providers": [],
    "family": "EuroLLM"
  },
  "falcon3-7b-instruct": {
    "providers": [],
    "family": "TII"
  },
  "free": {
    "providers": [
      "kilo_code"
    ],
    "upstream": {
      "kilo_code": "openrouter/free"
    },
    "providerConfig": {
      "kilo_code": {
        "upstream": "openrouter/free"
      }
    }
  },
  "glm4.7": {
    "providers": [
      "nvidia_nim"
    ],
    "upstream": {
      "nvidia_nim": "z-ai/glm4.7"
    },
    "providerConfig": {
      "nvidia_nim": {
        "upstream": "z-ai/glm4.7"
      }
    }
  },
  "glm5": {
    "providers": [
      "nvidia_nim"
    ],
    "upstream": {
      "nvidia_nim": "z-ai/glm5"
    },
    "providerConfig": {
      "nvidia_nim": {
        "upstream": "z-ai/glm5"
      }
    }
  },
  "goldeneye": {
    "providers": [
      "copilot"
    ],
    "family": "OpenAI"
  },
  "granite-3.0-3b-a800m-instruct": {
    "providers": [
      "nvidia_nim"
    ],
    "family": "IBM",
    "upstream": {
      "nvidia_nim": "ibm/granite-3.0-3b-a800m-instruct"
    },
    "providerConfig": {
      "nvidia_nim": {
        "upstream": "ibm/granite-3.0-3b-a800m-instruct"
      }
    }
  },
  "granite-3.0-8b-instruct": {
    "providers": [
      "nvidia_nim"
    ],
    "family": "IBM",
    "upstream": {
      "nvidia_nim": "ibm/granite-3.0-8b-instruct"
    },
    "providerConfig": {
      "nvidia_nim": {
        "upstream": "ibm/granite-3.0-8b-instruct"
      }
    }
  },
  "granite-3.3-8b-instruct": {
    "providers": [],
    "family": "IBM"
  },
  "granite-34b-code-instruct": {
    "providers": [
      "nvidia_nim"
    ],
    "family": "IBM",
    "upstream": {
      "nvidia_nim": "ibm/granite-34b-code-instruct"
    },
    "providerConfig": {
      "nvidia_nim": {
        "upstream": "ibm/granite-34b-code-instruct"
      }
    }
  },
  "granite-4.0-h-micro": {
    "providers": [
      "workers_ai"
    ],
    "family": "IBM",
    "meta": {
      "contextLength": 128000,
      "outputLimit": 4096,
      "releaseDate": "2025-06",
      "reasoning": false,
      "toolCall": true,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    },
    "upstream": {
      "workers_ai": "@cf/ibm-granite/granite-4.0-h-micro"
    },
    "providerConfig": {
      "workers_ai": {
        "upstream": "@cf/ibm-granite/granite-4.0-h-micro"
      }
    }
  },
  "granite-8b-code-instruct": {
    "providers": [
      "nvidia_nim"
    ],
    "family": "IBM",
    "upstream": {
      "nvidia_nim": "ibm/granite-8b-code-instruct"
    },
    "providerConfig": {
      "nvidia_nim": {
        "upstream": "ibm/granite-8b-code-instruct"
      }
    }
  },
  "hermes-3-llama-3.1-405b": {
    "providers": [
      "openrouter"
    ],
    "family": "Nous Research",
    "meta": {
      "contextLength": 128000,
      "outputLimit": 16384,
      "knowledgeCutoff": "2024-04",
      "releaseDate": "2025-09-25",
      "reasoning": false,
      "toolCall": false,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    },
    "upstream": {
      "openrouter": "nousresearch/hermes-3-llama-3.1-405b:free"
    },
    "providerConfig": {
      "openrouter": {
        "upstream": "nousresearch/hermes-3-llama-3.1-405b:free"
      }
    }
  },
  "hy3-preview": {
    "providers": [
      "kilo_code",
      "openrouter"
    ],
    "upstream": {
      "kilo_code": "tencent/hy3-preview:free",
      "openrouter": "tencent/hy3-preview:free"
    },
    "providerConfig": {
      "kilo_code": {
        "upstream": "tencent/hy3-preview:free"
      },
      "openrouter": {
        "upstream": "tencent/hy3-preview:free"
      }
    }
  },
  "jamba-1.5-large-instruct": {
    "providers": [
      "nvidia_nim"
    ],
    "family": "AI21",
    "upstream": {
      "nvidia_nim": "ai21labs/jamba-1.5-large-instruct"
    },
    "providerConfig": {
      "nvidia_nim": {
        "upstream": "ai21labs/jamba-1.5-large-instruct"
      }
    }
  },
  "jamba-1.5-mini-instruct": {
    "providers": [],
    "family": "AI21"
  },
  "laguna-m.1": {
    "providers": [
      "kilo_code",
      "openrouter"
    ],
    "upstream": {
      "kilo_code": "poolside/laguna-m.1:free",
      "openrouter": "poolside/laguna-m.1:free"
    },
    "providerConfig": {
      "kilo_code": {
        "upstream": "poolside/laguna-m.1:free"
      },
      "openrouter": {
        "upstream": "poolside/laguna-m.1:free"
      }
    }
  },
  "laguna-xs.2": {
    "providers": [
      "kilo_code",
      "openrouter"
    ],
    "upstream": {
      "kilo_code": "poolside/laguna-xs.2:free",
      "openrouter": "poolside/laguna-xs.2:free"
    },
    "providerConfig": {
      "kilo_code": {
        "upstream": "poolside/laguna-xs.2:free"
      },
      "openrouter": {
        "upstream": "poolside/laguna-xs.2:free"
      }
    }
  },
  "lfm-2.5-1.2b-instruct": {
    "providers": [
      "openrouter"
    ],
    "family": "Liquid AI",
    "meta": {
      "contextLength": 131072,
      "outputLimit": 32768,
      "knowledgeCutoff": "2025-06",
      "releaseDate": "2026-01-20",
      "reasoning": false,
      "toolCall": false,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    },
    "upstream": {
      "openrouter": "liquid/lfm-2.5-1.2b-instruct:free"
    },
    "providerConfig": {
      "openrouter": {
        "upstream": "liquid/lfm-2.5-1.2b-instruct:free"
      }
    }
  },
  "lfm-2.5-1.2b-thinking": {
    "providers": [
      "openrouter"
    ],
    "family": "Liquid AI",
    "meta": {
      "contextLength": 131072,
      "outputLimit": 32768,
      "knowledgeCutoff": "2025-06",
      "releaseDate": "2026-01-20",
      "reasoning": true,
      "toolCall": false,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    },
    "upstream": {
      "openrouter": "liquid/lfm-2.5-1.2b-thinking:free"
    },
    "providerConfig": {
      "openrouter": {
        "upstream": "liquid/lfm-2.5-1.2b-thinking:free"
      }
    }
  },
  "ling-2.6-1t": {
    "providers": []
  },
  "ling-2.6-flash": {
    "providers": []
  },
  "lyria-3-clip-preview": {
    "providers": [],
    "family": "Google"
  },
  "lyria-3-pro-preview": {
    "providers": [],
    "family": "Google"
  },
  "marin-8b-instruct": {
    "providers": [],
    "family": "Marin"
  },
  "mimo-v2-omni": {
    "providers": [],
    "family": "Xiaomi"
  },
  "mimo-v2-pro": {
    "providers": [],
    "family": "Xiaomi"
  },
  "owl-alpha": {
    "providers": [
      "kilo_code"
    ],
    "upstream": {
      "kilo_code": "openrouter/owl-alpha"
    },
    "providerConfig": {
      "kilo_code": {
        "upstream": "openrouter/owl-alpha"
      }
    }
  },
  "qianfan-ocr-fast": {
    "providers": [
      "kilo_code",
      "openrouter"
    ],
    "upstream": {
      "kilo_code": "baidu/qianfan-ocr-fast:free",
      "openrouter": "baidu/qianfan-ocr-fast:free"
    },
    "providerConfig": {
      "kilo_code": {
        "upstream": "baidu/qianfan-ocr-fast:free"
      },
      "openrouter": {
        "upstream": "baidu/qianfan-ocr-fast:free"
      }
    }
  },
  "rakutenai-7b-chat": {
    "providers": [],
    "family": "Rakuten"
  },
  "rakutenai-7b-instruct": {
    "providers": [],
    "family": "Rakuten"
  },
  "raptor-mini": {
    "providers": [
      "copilot"
    ],
    "family": "OpenAI"
  },
  "riva-translate-4b-instruct-v1.1": {
    "providers": [
      "nvidia_nim"
    ],
    "upstream": {
      "nvidia_nim": "nvidia/riva-translate-4b-instruct-v1.1"
    },
    "providerConfig": {
      "nvidia_nim": {
        "upstream": "nvidia/riva-translate-4b-instruct-v1.1"
      }
    }
  },
  "rnj-1-8b": {
    "providers": [
      "ollama_cloud"
    ],
    "family": "RNJ",
    "meta": {
      "contextLength": 32768,
      "outputLimit": 4096,
      "releaseDate": "2025-12-06",
      "reasoning": false,
      "toolCall": true,
      "vision": false
    },
    "upstream": {
      "ollama_cloud": "rnj-1:8b"
    },
    "providerConfig": {
      "ollama_cloud": {
        "upstream": "rnj-1:8b"
      }
    }
  },
  "sarvam-m": {
    "providers": [
      "nvidia_nim"
    ],
    "upstream": {
      "nvidia_nim": "sarvamai/sarvam-m"
    },
    "providerConfig": {
      "nvidia_nim": {
        "upstream": "sarvamai/sarvam-m"
      }
    }
  },
  "sea-lion-7b-instruct": {
    "providers": [
      "nvidia_nim"
    ],
    "family": "AI Singapore",
    "upstream": {
      "nvidia_nim": "aisingapore/sea-lion-7b-instruct"
    },
    "providerConfig": {
      "nvidia_nim": {
        "upstream": "aisingapore/sea-lion-7b-instruct"
      }
    }
  },
  "seed-oss-36b-instruct": {
    "providers": [
      "nvidia_nim"
    ],
    "family": "ByteDance",
    "meta": {
      "contextLength": 262000,
      "outputLimit": 262000,
      "releaseDate": "2025-09-04",
      "reasoning": false,
      "toolCall": true,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    },
    "upstream": {
      "nvidia_nim": "bytedance/seed-oss-36b-instruct"
    },
    "providerConfig": {
      "nvidia_nim": {
        "upstream": "bytedance/seed-oss-36b-instruct"
      }
    }
  },
  "solar-10.7b-instruct": {
    "providers": [
      "nvidia_nim"
    ],
    "family": "Upstage",
    "upstream": {
      "nvidia_nim": "upstage/solar-10.7b-instruct"
    },
    "providerConfig": {
      "nvidia_nim": {
        "upstream": "upstage/solar-10.7b-instruct"
      }
    }
  },
  "step-3.5-flash": {
    "providers": [
      "kilo_code",
      "nvidia_nim"
    ],
    "family": "StepFun",
    "meta": {
      "contextLength": 256000,
      "outputLimit": 256000,
      "knowledgeCutoff": "2025-01",
      "releaseDate": "2026-01-29",
      "reasoning": true,
      "toolCall": true,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    },
    "upstream": {
      "kilo_code": "stepfun/step-3.5-flash:free",
      "nvidia_nim": "stepfun-ai/step-3.5-flash"
    },
    "providerConfig": {
      "kilo_code": {
        "upstream": "stepfun/step-3.5-flash:free"
      },
      "nvidia_nim": {
        "upstream": "stepfun-ai/step-3.5-flash"
      }
    }
  },
  "stockmark-2-100b-instruct": {
    "providers": [
      "nvidia_nim"
    ],
    "family": "Stockmark",
    "upstream": {
      "nvidia_nim": "stockmark/stockmark-2-100b-instruct"
    },
    "providerConfig": {
      "nvidia_nim": {
        "upstream": "stockmark/stockmark-2-100b-instruct"
      }
    }
  },
  "teuken-7b-instruct-commercial-v0.4": {
    "providers": [],
    "family": "OpenGPT-X"
  },
  "trinity-large-preview": {
    "providers": [],
    "family": "Trinity",
    "meta": {
      "contextLength": 131000,
      "outputLimit": 131000,
      "knowledgeCutoff": "2024-10",
      "releaseDate": "2025-01",
      "reasoning": false,
      "toolCall": true,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    }
  },
  "trinity-large-thinking": {
    "providers": [],
    "family": "Trinity"
  },
  "trinity-mini": {
    "providers": [],
    "family": "Trinity",
    "meta": {
      "contextLength": 131072,
      "outputLimit": 131072,
      "knowledgeCutoff": "2024-10",
      "releaseDate": "2025-12",
      "reasoning": false,
      "toolCall": false,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    }
  },
  "zamba2-7b-instruct": {
    "providers": [
      "nvidia_nim"
    ],
    "family": "Zyphra",
    "upstream": {
      "nvidia_nim": "zyphra/zamba2-7b-instruct"
    },
    "providerConfig": {
      "nvidia_nim": {
        "upstream": "zyphra/zamba2-7b-instruct"
      }
    }
  },
  "qwen2-7b-instruct": {
    "providers": [],
    "aliases": [
      "qwen-qwen2-7b-instruct",
      "qwen/qwen2-7b-instruct"
    ],
    "family": "Qwen"
  },
  "qwen2.5-7b-instruct": {
    "providers": [],
    "aliases": [
      "qwen-qwen2.5-7b-instruct",
      "qwen/qwen2.5-7b-instruct"
    ],
    "family": "Qwen",
    "meta": {
      "contextLength": 131072,
      "outputLimit": 8192,
      "knowledgeCutoff": "2024-04",
      "releaseDate": "2024-09",
      "reasoning": false,
      "toolCall": true,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    }
  },
  "qwen2.5-coder-32b": {
    "providers": [
      "nvidia_nim"
    ],
    "aliases": [
      "qwen-qwen2.5-coder-32b-instruct",
      "qwen/qwen2.5-coder-32b-instruct"
    ],
    "family": "Qwen",
    "meta": {
      "contextLength": 32768,
      "outputLimit": 32768,
      "releaseDate": "2025-03-24",
      "reasoning": false,
      "toolCall": false,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    },
    "upstream": {
      "nvidia_nim": "qwen/qwen2.5-coder-32b-instruct"
    },
    "providerConfig": {
      "nvidia_nim": {
        "upstream": "qwen/qwen2.5-coder-32b-instruct"
      }
    }
  },
  "qwen2.5-coder-7b": {
    "providers": [],
    "aliases": [
      "qwen-qwen2.5-coder-7b-instruct",
      "qwen/qwen2.5-coder-7b-instruct"
    ],
    "family": "Qwen",
    "meta": {
      "contextLength": 128000,
      "outputLimit": 4096,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    }
  },
  "qwen3-235b-a22b": {
    "providers": [
      "cerebras"
    ],
    "aliases": [
      "qwen-qwen3-235b-a22b",
      "qwen/qwen3-235b-a22b"
    ],
    "family": "Qwen",
    "meta": {
      "contextLength": 131072,
      "outputLimit": 16384,
      "knowledgeCutoff": "2025-04",
      "releaseDate": "2025-04",
      "reasoning": true,
      "toolCall": true,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    },
    "upstream": {
      "cerebras": "qwen-3-235b-a22b-instruct-2507"
    },
    "providerConfig": {
      "cerebras": {
        "upstream": "qwen-3-235b-a22b-instruct-2507"
      }
    }
  },
  "qwen3-30b-a3b-fp8": {
    "providers": [
      "workers_ai"
    ],
    "family": "Qwen",
    "meta": {
      "contextLength": 128000,
      "outputLimit": 4096,
      "releaseDate": "2025-05",
      "reasoning": true,
      "toolCall": true,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    },
    "upstream": {
      "workers_ai": "@cf/qwen/qwen3-30b-a3b-fp8"
    },
    "providerConfig": {
      "workers_ai": {
        "upstream": "@cf/qwen/qwen3-30b-a3b-fp8"
      }
    }
  },
  "qwen3-32b": {
    "providers": [],
    "family": "Qwen",
    "meta": {
      "contextLength": 131072,
      "outputLimit": 40960,
      "reasoning": true,
      "toolCall": true,
      "vision": false
    }
  },
  "qwen3-4b": {
    "providers": [],
    "family": "Qwen",
    "meta": {
      "contextLength": 32000,
      "outputLimit": 4096,
      "knowledgeCutoff": "2024-07",
      "releaseDate": "2025-04-29",
      "reasoning": true,
      "toolCall": true,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    }
  },
  "qwen3-coder-480b-a35b-instruct": {
    "providers": [
      "nvidia_nim"
    ],
    "upstream": {
      "nvidia_nim": "qwen/qwen3-coder-480b-a35b-instruct"
    },
    "providerConfig": {
      "nvidia_nim": {
        "upstream": "qwen/qwen3-coder-480b-a35b-instruct"
      }
    }
  },
  "qwen3-coder-480b": {
    "providers": [
      "ollama_cloud"
    ],
    "family": "Qwen",
    "meta": {
      "contextLength": 262144,
      "outputLimit": 65536,
      "knowledgeCutoff": "2025-04",
      "releaseDate": "2025-04",
      "reasoning": false,
      "toolCall": true,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    },
    "upstream": {
      "ollama_cloud": "qwen3-coder:480b"
    },
    "providerConfig": {
      "ollama_cloud": {
        "upstream": "qwen3-coder:480b"
      }
    }
  },
  "qwen3-coder-flash": {
    "providers": [
      "qwen_code"
    ],
    "family": "Qwen",
    "meta": {
      "contextLength": 1000000,
      "outputLimit": 65536,
      "knowledgeCutoff": "2025-04",
      "releaseDate": "2025-07-28",
      "reasoning": false,
      "toolCall": true,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    }
  },
  "qwen3-coder-next": {
    "providers": [
      "kiro",
      "ollama_cloud"
    ],
    "family": "Qwen",
    "meta": {
      "contextLength": 262144,
      "outputLimit": 65536,
      "releaseDate": "2026-02-03",
      "reasoning": false,
      "toolCall": true,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    }
  },
  "qwen3-coder-plus": {
    "providers": [
      "qwen_code"
    ],
    "family": "Qwen",
    "meta": {
      "contextLength": 1048576,
      "outputLimit": 65536,
      "knowledgeCutoff": "2025-04",
      "releaseDate": "2025-07-23",
      "reasoning": false,
      "toolCall": true,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    }
  },
  "qwen3-coder": {
    "providers": [
      "openrouter"
    ],
    "family": "Qwen",
    "meta": {
      "contextLength": 262144,
      "outputLimit": 65536,
      "knowledgeCutoff": "2025-04",
      "releaseDate": "2025-07-23",
      "reasoning": false,
      "toolCall": true,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    },
    "upstream": {
      "openrouter": "qwen/qwen3-coder:free"
    },
    "providerConfig": {
      "openrouter": {
        "upstream": "qwen/qwen3-coder:free"
      }
    }
  },
  "qwen3-next-80b-a3b-instruct": {
    "providers": [
      "openrouter",
      "nvidia_nim"
    ],
    "aliases": [
      "qwen-qwen3-next-80b-a3b-instruct",
      "qwen/qwen3-next-80b-a3b-instruct"
    ],
    "family": "Qwen",
    "meta": {
      "contextLength": 131072,
      "outputLimit": 32768,
      "knowledgeCutoff": "2025-04",
      "releaseDate": "2025-09",
      "reasoning": false,
      "toolCall": true,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    },
    "upstream": {
      "nvidia_nim": "qwen/qwen3-next-80b-a3b-instruct",
      "openrouter": "qwen/qwen3-next-80b-a3b-instruct:free"
    },
    "providerConfig": {
      "nvidia_nim": {
        "upstream": "qwen/qwen3-next-80b-a3b-instruct"
      },
      "openrouter": {
        "upstream": "qwen/qwen3-next-80b-a3b-instruct:free"
      }
    }
  },
  "qwen3-next-80b-a3b-thinking": {
    "providers": [
      "nvidia_nim"
    ],
    "upstream": {
      "nvidia_nim": "qwen/qwen3-next-80b-a3b-thinking"
    },
    "providerConfig": {
      "nvidia_nim": {
        "upstream": "qwen/qwen3-next-80b-a3b-thinking"
      }
    }
  },
  "qwen3-next-80b": {
    "providers": [
      "ollama_cloud"
    ],
    "family": "Qwen",
    "meta": {
      "contextLength": 256000,
      "outputLimit": 16384,
      "knowledgeCutoff": "2025-07",
      "releaseDate": "2025-04-29",
      "reasoning": false,
      "toolCall": true,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    },
    "upstream": {
      "ollama_cloud": "qwen3-next:80b"
    },
    "providerConfig": {
      "ollama_cloud": {
        "upstream": "qwen3-next:80b"
      }
    }
  },
  "qwen3-vl-235b-a22b-thinking": {
    "providers": [],
    "family": "Qwen",
    "meta": {
      "contextLength": 32768,
      "outputLimit": 32768,
      "releaseDate": "2025-08-26",
      "reasoning": true,
      "toolCall": false,
      "vision": true,
      "modalities": {
        "input": [
          "text",
          "image"
        ],
        "output": [
          "text"
        ]
      }
    }
  },
  "qwen3-vl-235b-instruct": {
    "providers": [
      "ollama_cloud"
    ],
    "family": "Qwen",
    "meta": {
      "contextLength": 262144,
      "outputLimit": 131072,
      "releaseDate": "2025-09-22",
      "reasoning": false,
      "toolCall": true,
      "vision": true
    },
    "upstream": {
      "ollama_cloud": "qwen3-vl:235b-instruct"
    },
    "providerConfig": {
      "ollama_cloud": {
        "upstream": "qwen3-vl:235b-instruct"
      }
    }
  },
  "qwen3-vl-235b": {
    "providers": [
      "ollama_cloud"
    ],
    "family": "Qwen",
    "meta": {
      "contextLength": 131072,
      "outputLimit": 32768,
      "knowledgeCutoff": "2025-04",
      "releaseDate": "2025-04",
      "reasoning": true,
      "toolCall": true,
      "vision": false,
      "modalities": {
        "input": [
          "text",
          "image"
        ],
        "output": [
          "text"
        ]
      }
    },
    "upstream": {
      "ollama_cloud": "qwen3-vl:235b"
    },
    "providerConfig": {
      "ollama_cloud": {
        "upstream": "qwen3-vl:235b"
      }
    }
  },
  "qwen3-vl-30b-a3b-thinking": {
    "providers": [],
    "family": "Qwen",
    "meta": {
      "contextLength": 128000,
      "outputLimit": 32000,
      "releaseDate": "2026-02-09",
      "reasoning": false,
      "toolCall": true,
      "vision": true,
      "modalities": {
        "input": [
          "text",
          "image",
          "video"
        ],
        "output": [
          "text"
        ]
      }
    }
  },
  "qwen3.5-122b-a10b": {
    "providers": [
      "nvidia_nim"
    ],
    "upstream": {
      "nvidia_nim": "qwen/qwen3.5-122b-a10b"
    },
    "providerConfig": {
      "nvidia_nim": {
        "upstream": "qwen/qwen3.5-122b-a10b"
      }
    }
  },
  "qwen3.5-397b-a17b": {
    "providers": [
      "nvidia_nim"
    ],
    "upstream": {
      "nvidia_nim": "qwen/qwen3.5-397b-a17b"
    },
    "providerConfig": {
      "nvidia_nim": {
        "upstream": "qwen/qwen3.5-397b-a17b"
      }
    }
  },
  "qwen3.5-397b": {
    "providers": [
      "ollama_cloud"
    ],
    "family": "Qwen",
    "meta": {
      "contextLength": 262144,
      "outputLimit": 65536,
      "knowledgeCutoff": "2025-04",
      "releaseDate": "2026-02-16",
      "reasoning": true,
      "toolCall": true,
      "vision": false,
      "modalities": {
        "input": [
          "text",
          "image",
          "video"
        ],
        "output": [
          "text"
        ]
      }
    },
    "upstream": {
      "ollama_cloud": "qwen3.5:397b"
    },
    "providerConfig": {
      "ollama_cloud": {
        "upstream": "qwen3.5:397b"
      }
    }
  },
  "qwen3.5": {
    "providers": [
      "qwen_code"
    ],
    "family": "Qwen",
    "meta": {
      "contextLength": 1000000,
      "outputLimit": 65536,
      "knowledgeCutoff": "2025-04",
      "releaseDate": "2026-02-16",
      "reasoning": true,
      "toolCall": true,
      "vision": false,
      "modalities": {
        "input": [
          "text",
          "image",
          "video"
        ],
        "output": [
          "text"
        ]
      }
    }
  },
  "qwen3.6-plus-preview": {
    "providers": [],
    "family": "Qwen"
  },
  "qwen3.6-plus": {
    "providers": [],
    "family": "Qwen"
  },
  "qwq-32b": {
    "providers": [],
    "aliases": [
      "qwen-qwq-32b",
      "qwen/qwq-32b"
    ],
    "family": "Qwen",
    "meta": {
      "contextLength": 128000,
      "outputLimit": 32768,
      "releaseDate": "2025-04-15",
      "reasoning": false,
      "toolCall": false,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    }
  },
  "glm-4.5-air": {
    "providers": [
      "openrouter"
    ],
    "family": "Z.AI",
    "meta": {
      "contextLength": 131072,
      "outputLimit": 98304,
      "knowledgeCutoff": "2025-04",
      "releaseDate": "2025-07-28",
      "reasoning": true,
      "toolCall": true,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    },
    "upstream": {
      "openrouter": "z-ai/glm-4.5-air:free"
    },
    "providerConfig": {
      "openrouter": {
        "upstream": "z-ai/glm-4.5-air:free"
      }
    }
  },
  "glm-4.6": {
    "providers": [
      "ollama_cloud"
    ],
    "family": "Z.AI",
    "meta": {
      "contextLength": 204800,
      "outputLimit": 131072,
      "knowledgeCutoff": "2025-04",
      "releaseDate": "2025-09-30",
      "reasoning": true,
      "toolCall": true,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    }
  },
  "glm-4.7-flash": {
    "providers": [
      "workers_ai"
    ],
    "family": "Z.AI",
    "meta": {
      "contextLength": 200000,
      "outputLimit": 131072,
      "knowledgeCutoff": "2025-04",
      "releaseDate": "2026-01-19",
      "reasoning": true,
      "toolCall": true,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    },
    "upstream": {
      "workers_ai": "@cf/zai-org/glm-4.7-flash"
    },
    "providerConfig": {
      "workers_ai": {
        "upstream": "@cf/zai-org/glm-4.7-flash"
      }
    }
  },
  "glm-4.7": {
    "providers": [
      "ollama_cloud"
    ],
    "family": "Z.AI",
    "meta": {
      "contextLength": 204800,
      "outputLimit": 131072,
      "knowledgeCutoff": "2025-04",
      "releaseDate": "2025-12-22",
      "reasoning": true,
      "toolCall": true,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    }
  },
  "glm-5.1": {
    "providers": [
      "ollama_cloud",
      "nvidia_nim"
    ],
    "family": "Z.AI",
    "upstream": {
      "nvidia_nim": "z-ai/glm-5.1"
    },
    "providerConfig": {
      "nvidia_nim": {
        "upstream": "z-ai/glm-5.1"
      }
    }
  },
  "glm-5": {
    "providers": [
      "kiro",
      "ollama_cloud"
    ],
    "family": "Z.AI",
    "meta": {
      "contextLength": 204800,
      "outputLimit": 131072,
      "releaseDate": "2026-02-11",
      "reasoning": true,
      "toolCall": true,
      "vision": false,
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      }
    }
  }
} as const satisfies Record<string, ModelInfo>;

export const GENERATED_IGNORED_MODELS = new Set<string>([
  "deepseek-coder-6.7b-instruct",
  "gemini-3-pro-image-preview",
  "codegemma-1.1-7b",
  "codegemma-7b",
  "gemma-2-27b-it",
  "gemma-2-2b-it",
  "gemma-2-9b-cpt-sahabatai-instruct",
  "gemma-3-1b-it",
  "gemma-3n-e2b-it",
  "gemma-3n-e4b-it",
  "gemma3-4b",
  "kilo-auto-balanced",
  "kilo-auto-free",
  "kilo-auto-frontier",
  "kilo-auto-small",
  "codellama-70b",
  "llama-3-swallow-70b-instruct-v0.1",
  "llama-3-taiwan-70b-instruct",
  "llama-3.1-nemotron-51b-instruct",
  "llama-3.1-nemotron-70b-instruct",
  "llama-3.1-swallow-70b-instruct-v0.1",
  "llama-3.1-swallow-8b-instruct-v0.1",
  "llama-3.2-11b-vision-instruct",
  "llama-3.2-1b-instruct",
  "llama-3.3-nemotron-super-49b-v1.5",
  "llama-3.3-nemotron-super-49b-v1",
  "llama3-70b-instruct",
  "llama3-8b-instruct",
  "llama3-chatqa-1.5-70b",
  "phi-3-medium-128k-instruct",
  "phi-3-medium-4k-instruct",
  "phi-3-small-128k-instruct",
  "phi-3-small-8k-instruct",
  "phi-3-vision-128k-instruct",
  "phi-3.5-moe-instruct",
  "phi-3.5-vision-instruct",
  "devstral-small-2-24b",
  "mamba-codestral-7b-v0.1",
  "ministral-3-14b",
  "ministral-3-3b",
  "ministral-3-8b",
  "mistral-large-2-instruct",
  "mistral-small-3.1-24b-instruct-2503",
  "cosmos-reason2-8b",
  "nemotron-4-340b-instruct",
  "nemotron-4-mini-hindi-4b-instruct",
  "nemotron-mini-4b-instruct",
  "nemotron-nano-9b-v2",
  "nim-llama-3.1-70b-instruct",
  "usdcode-llama-3.1-70b-instruct",
  "baichuan2-13b-chat",
  "bielik-11b-v2.3-instruct",
  "bielik-11b-v2.6-instruct",
  "breeze-7b-instruct",
  "cogito-2.1-671b",
  "corethink",
  "dbrx-instruct",
  "dracarys-llama-3.1-70b-instruct",
  "eurollm-9b-instruct",
  "falcon3-7b-instruct",
  "free",
  "goldeneye",
  "granite-3.0-3b-a800m-instruct",
  "granite-3.0-8b-instruct",
  "granite-34b-code-instruct",
  "granite-8b-code-instruct",
  "jamba-1.5-large-instruct",
  "jamba-1.5-mini-instruct",
  "lfm-2.5-1.2b-instruct",
  "lfm-2.5-1.2b-thinking",
  "marin-8b-instruct",
  "rakutenai-7b-chat",
  "rakutenai-7b-instruct",
  "raptor-mini",
  "rnj-1-8b",
  "sea-lion-7b-instruct",
  "solar-10.7b-instruct",
  "stockmark-2-100b-instruct",
  "teuken-7b-instruct-commercial-v0.4",
  "zamba2-7b-instruct",
  "qwen2-7b-instruct",
  "qwen2.5-7b-instruct",
  "qwen2.5-coder-7b",
  "qwq-32b"
]);
