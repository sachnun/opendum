# oxlint-plugin-naming

Local oxlint JS plugin enforcing identifier naming conventions without external dependencies.

## Rules

| Rule | Description |
| --- | --- |
| `naming/naming-convention` | Validates declared identifiers against case format, underscore policy, word count, and forbidden words |

## Selectors

| Selector | Applies to |
| --- | --- |
| `default` | Fallback for every selector without an explicit entry |
| `variable` | Variable declarators, destructured bindings, loop and catch bindings |
| `function` | Function declarations and named function expressions |
| `parameter` | Function, arrow, and constructor parameter properties |
| `type` | Class, interface, type alias, and enum names |
| `member` | Class fields, methods, and private members |

## Options

Each array entry is one selector object.

| Key | Values | Default |
| --- | --- | --- |
| `selector` | `default`, `variable`, `function`, `parameter`, `type`, `member` | required |
| `format` | `camelCase`, `PascalCase`, `UPPER_CASE`, `snake_case`, or `null` | `["camelCase"]` |
| `leadingUnderscore` | `allow`, `allowDouble`, `forbid` | `allow` |
| `trailingUnderscore` | `allow`, `allowDouble`, `forbid` | `forbid` |
| `maxSegments` | Integer, maximum word count of the identifier | unlimited |
| `forbid` | Array of words that must not appear in the identifier | `[]` |

`maxSegments` counts words after splitting camelCase, PascalCase, snake_case, and UPPER_CASE, so `isUserAntigravityAccount` counts as four words.

## Usage

```json
{
  "jsPlugins": ["./.oxlint/plugin/index.mjs"],
  "rules": {
    "naming/naming-convention": [
      "error",
      { "selector": "default", "format": ["camelCase"] },
      { "selector": "variable", "format": ["camelCase", "UPPER_CASE", "PascalCase"] },
      { "selector": "function", "format": ["camelCase"], "maxSegments": 2 },
      { "selector": "type", "format": ["PascalCase"] }
    ]
  }
}
```

With `maxSegments: 2` a function such as `isUserAntigravityAccount` (four words) and `getUserAccount` (three words) are rejected, while `getAccount` and `buildSnapshot` pass.
