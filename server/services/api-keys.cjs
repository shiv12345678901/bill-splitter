function unquote(value) {
  const trimmed = String(value || "").trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function parseApiKeys(input) {
  if (!input) return [];
  const entries = Array.isArray(input) ? input : [input];
  const keys = [];

  for (const entry of entries) {
    for (const rawLine of String(entry || "").split(/\r?\n/)) {
      const line = rawLine.trim().replace(/^export\s+/i, "");
      if (!line || line.startsWith("#")) continue;

      const assignment = line.match(
        /^(GEMINI_API_KEY(?:_?\d+)?|GEMINI_API_KEYS)\s*=\s*(.*)$/i,
      );
      if (assignment) {
        const values = /^GEMINI_API_KEYS$/i.test(assignment[1])
          ? assignment[2].split(/[,;]+/)
          : [assignment[2]];
        keys.push(...values.map(unquote));
        continue;
      }

      // Ignore unrelated environment-variable assignments instead of treating
      // the complete NAME=value line as an API key.
      if (line.includes("=")) continue;
      keys.push(...line.split(/[,;]+/).map(unquote));
    }
  }

  return [...new Set(keys.filter((key) => key.length > 5))];
}

module.exports = { parseApiKeys };
