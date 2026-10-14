import { parse } from "dotenv";

// Pure text helpers for the setup page. `.env.example` is the template: a
// student's `.env` is rendered from it so the explanatory comments (and any
// keys added in later versions) carry over, with only the values replaced.

const KEY_LINE_RE = /^([A-Za-z_][A-Za-z0-9_.-]*)\s*=(.*)$/;

// Key -> default value, in file order. Parsing goes through dotenv itself
// so a default here is exactly what the deploy would read.
export function templateDefaults(template: string): Record<string, string> {
  return parse(template);
}

// Formats one value so dotenv reads it back unchanged. Ordinary values stay
// unquoted; anything dotenv would otherwise trim, truncate at "#", or strip
// quotes from gets the first quote style that can hold it literally (double
// quotes expand "\n", so they're skipped for values containing it).
export function formatValue(value: string): string {
  if (/[\r\n]/.test(value)) throw new Error("Values can't contain line breaks.");
  const needsQuotes = value.includes("#") || value !== value.trim() || /^['"`]/.test(value);
  if (!needsQuotes) return value;
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"') && !/\\[nr]/.test(value)) return `"${value}"`;
  if (!value.includes("`")) return `\`${value}\``;
  throw new Error("Values can't mix single quotes, double quotes, and backticks.");
}

// Renders a complete .env: the template with each submitted key's value
// replaced (keeping its inline comment in the same column), then any extra
// keys from the student's previous .env (e.g. AWS_PROFILE) appended so
// nothing they set by hand is lost.
export function renderEnv(
  template: string,
  values: Record<string, string>,
  extras: Record<string, string>
): string {
  const lines = template.split(/\r?\n/).map(line => {
    const m = line.match(KEY_LINE_RE);
    if (!m || !(m[1] in values)) return line;
    const key = m[1];
    const rest = m[2];
    const assignment = `${key}=${formatValue(values[key])}`;
    const commentStart = rest.search(/(^|\s)#/);
    if (commentStart < 0) return assignment;
    const hashAt = rest.indexOf("#", commentStart);
    const hashColumn = key.length + 1 + hashAt;
    return `${assignment.padEnd(hashColumn - 1)} ${rest.slice(hashAt)}`;
  });
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();

  const extraKeys = Object.keys(extras);
  if (extraKeys.length) {
    lines.push("", "# --- Other settings kept from your previous .env ---");
    for (const k of extraKeys) lines.push(`${k}=${formatValue(extras[k])}`);
  }
  return lines.join("\n") + "\n";
}
