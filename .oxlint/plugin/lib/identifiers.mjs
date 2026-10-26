export const CASE_PATTERNS = {
  camelCase: /^[a-z][a-zA-Z0-9]*$/,
  PascalCase: /^[A-Z][a-zA-Z0-9]*$/,
  UPPER_CASE: /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/,
  snake_case: /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/,
};

export const CASE_FORMATS = Object.keys(CASE_PATTERNS);

export function matchesFormat(name, formats) {
  return formats.some((format) => CASE_PATTERNS[format]?.test(name) ?? false);
}

function underscoreProblem(count, policy, position) {
  if (count === 0) return null;
  if (policy === "allow") return count > 1 ? position : null;
  if (policy === "allowDouble") return count > 2 ? position : null;
  return position;
}

export function stripUnderscores(name, leadingPolicy, trailingPolicy) {
  const leading = name.length - name.replace(/^_+/, "").length;
  const rest = name.slice(leading);
  const trailing = rest.length - rest.replace(/_+$/, "").length;
  const core = rest.slice(0, rest.length - trailing);
  const problem =
    underscoreProblem(leading, leadingPolicy, "leading") ?? underscoreProblem(trailing, trailingPolicy, "trailing");

  return { core, problem };
}

export function splitIdentifier(name) {
  return name
    .replace(/[_$]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.toLowerCase());
}
