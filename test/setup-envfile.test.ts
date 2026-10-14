import * as fs from "fs";
import * as path from "path";
import { parse } from "dotenv";
import { templateDefaults, renderEnv, formatValue } from "../setup/envfile";

const TEMPLATE = [
  "# --- header ---",
  "ALERT_EMAIL=",
  "",
  "# a comment block",
  "MONTHLY_BUDGET_USD=5          # used only when creating a budget",
  "WARN_AT_PERCENT=80            # Path-B-only",
  "                               # continuation comment",
  "# e.g. EXCLUDE_SERVICES=AWS Cost Explorer",
  "EXCLUDE_SERVICES=",
  "SAFETY=watch"
].join("\n");

test("templateDefaults reads keys and default values in file order, ignoring commented examples", () => {
  expect(Object.entries(templateDefaults(TEMPLATE))).toEqual([
    ["ALERT_EMAIL", ""],
    ["MONTHLY_BUDGET_USD", "5"],
    ["WARN_AT_PERCENT", "80"],
    ["EXCLUDE_SERVICES", ""],
    ["SAFETY", "watch"]
  ]);
});

test("renderEnv replaces values, keeps every comment, and keeps the inline-comment column", () => {
  const out = renderEnv(TEMPLATE, { ALERT_EMAIL: "me@uky.edu", MONTHLY_BUDGET_USD: "0.01" }, {});
  const lines = out.split("\n");
  expect(lines[0]).toBe("# --- header ---");
  expect(lines).toContain("ALERT_EMAIL=me@uky.edu");
  const budget = lines.find(l => l.startsWith("MONTHLY_BUDGET_USD="))!;
  expect(budget).toBe("MONTHLY_BUDGET_USD=0.01       # used only when creating a budget");
  // Untouched keys keep their template value.
  expect(lines).toContain("SAFETY=watch");
  expect(out).toContain("# e.g. EXCLUDE_SERVICES=AWS Cost Explorer");
  expect(out).toContain("# continuation comment");
});

test("renderEnv output parses back (dotenv) to exactly the submitted values", () => {
  const values = {
    ALERT_EMAIL: "me@uky.edu",
    MONTHLY_BUDGET_USD: "12.5",
    WARN_AT_PERCENT: "90",
    EXCLUDE_SERVICES: "AWS Cost Explorer,Amazon Elastic Compute Cloud - Compute",
    SAFETY: "armed"
  };
  expect(parse(renderEnv(TEMPLATE, values, {}))).toEqual(values);
});

test("a value longer than the inline-comment column still gets a space before #", () => {
  const out = renderEnv(TEMPLATE, { MONTHLY_BUDGET_USD: "123456789012345678901234567890" }, {});
  expect(out).toContain("MONTHLY_BUDGET_USD=123456789012345678901234567890 # used only");
  expect(parse(out).MONTHLY_BUDGET_USD).toBe("123456789012345678901234567890");
});

test("extra keys from an existing .env are kept, appended after the template", () => {
  const out = renderEnv(TEMPLATE, {}, { AWS_PROFILE: "learning-admin", AWS_REGION: "us-east-2" });
  const parsed = parse(out);
  expect(parsed.AWS_PROFILE).toBe("learning-admin");
  expect(parsed.AWS_REGION).toBe("us-east-2");
  expect(out.indexOf("AWS_PROFILE=")).toBeGreaterThan(out.indexOf("SAFETY=watch"));
});

test("CRLF templates (Windows checkouts) render and parse cleanly", () => {
  const out = renderEnv(TEMPLATE.replace(/\n/g, "\r\n"), { ALERT_EMAIL: "me@uky.edu" }, {});
  expect(out).not.toContain("\r");
  expect(parse(out).ALERT_EMAIL).toBe("me@uky.edu");
});

test("renderEnv ends with exactly one newline", () => {
  expect(renderEnv(TEMPLATE, {}, {}).endsWith("watch\n")).toBe(true);
});

describe("formatValue", () => {
  const roundTrip = (v: string) => parse(`K=${formatValue(v)}`).K;

  test.each([
    "plain",
    "with inner spaces",
    "has#hash",
    " leading and trailing ",
    "'starts with a quote",
    "it's",
    'say "hi"',
    "back\\nslash-n literal",
    "Amazon Elastic Compute Cloud - Compute:20,Amazon SageMaker:10",
    ""
  ])("round-trips %p through dotenv", v => {
    expect(roundTrip(v)).toBe(v);
  });

  test("leaves ordinary values unquoted so .env stays readable", () => {
    expect(formatValue("me@uky.edu")).toBe("me@uky.edu");
    expect(formatValue("arn:aws:iam::123456789012:role/Admin")).toBe("arn:aws:iam::123456789012:role/Admin");
  });

  test("rejects line breaks", () => {
    expect(() => formatValue("a\nb")).toThrow(/line break/);
    expect(() => formatValue("a\rb")).toThrow(/line break/);
  });
});

test("the real .env.example renders and parses back to its own defaults", () => {
  const template = fs.readFileSync(path.join(__dirname, "..", ".env.example"), "utf8");
  const defaults = templateDefaults(template);
  expect(Object.keys(defaults)).toContain("ALERT_EMAIL");
  expect(defaults).toEqual(parse(template));
  // Passing every value forces every KEY= line to be rewritten.
  expect(parse(renderEnv(template, defaults, {}))).toEqual(defaults);
});
