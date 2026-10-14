import * as fs from "fs";
import * as path from "path";
import { loadConfig } from "../lib/config";
import { templateDefaults } from "../setup/envfile";
import { FIELDS, SECTIONS, fieldForError } from "../setup/fields";

const template = fs.readFileSync(path.join(__dirname, "..", ".env.example"), "utf8");
const defaults = templateDefaults(template);
// The least a student must type for a config that loadConfig accepts.
const minimal = {
  ...defaults,
  ALERT_EMAIL: "student@example.edu",
  IAM_DENY_TARGET_USERS: "learning",
  RECOVERY_PRINCIPAL_ARN: "arn:aws:iam::111122223333:role/Admin"
};

test("every .env.example key has setup-page metadata, and vice versa", () => {
  expect(FIELDS.map(f => f.key).sort()).toEqual(Object.keys(defaults).sort());
});

test("every field belongs to a known section and no section is empty", () => {
  const ids = SECTIONS.map(s => s.id);
  for (const f of FIELDS) expect(ids).toContain(f.section);
  for (const id of ids) expect(FIELDS.some(f => f.section === id)).toBe(true);
});

test("dependsOn always names a toggle field", () => {
  for (const f of FIELDS.filter(f => f.dependsOn)) {
    expect(FIELDS.find(g => g.key === f.dependsOn)?.type).toBe("toggle");
  }
});

test("the minimal student config is valid", () => {
  expect(() => loadConfig(minimal as any)).not.toThrow();
});

test.each(FIELDS.map(f => [f.key, !!f.required] as const))(
  "%s marked required=%p matches loadConfig when left blank",
  (key, required) => {
    const blanked = () => loadConfig({ ...minimal, [key]: "" } as any);
    if (required) expect(blanked).toThrow();
    else expect(blanked).not.toThrow();
  }
);

test("every choice option is a value loadConfig accepts", () => {
  for (const f of FIELDS.filter(f => f.options)) {
    for (const o of f.options!) {
      expect(() => loadConfig({ ...minimal, [f.key]: o.value } as any)).not.toThrow();
    }
  }
});

test("every \"Learn more\" link points at a real heading in a real doc (GitHub anchor rules)", () => {
  const anchorsIn = (file: string) => fs.readFileSync(path.join(__dirname, "..", file), "utf8").split("\n")
    .filter(l => /^#{1,6} /.test(l))
    .map(l => l.replace(/^#+ /, "").toLowerCase().replace(/[^\w\- ]/g, "").replace(/ /g, "-"));
  const linked = FIELDS.filter(f => f.docs);
  expect(linked.length).toBeGreaterThan(0);
  for (const f of linked) {
    const [file, anchor] = f.docs!.split("#");
    expect(anchorsIn(file)).toContain(anchor);
  }
});

test("exampleOnly fields really have an example value in .env.example to blank out", () => {
  for (const f of FIELDS.filter(f => f.exampleOnly)) expect(defaults[f.key]).not.toBe("");
});

describe("fieldForError maps loadConfig's messages to the field to highlight", () => {
  const errorFor = (overrides: Record<string, string>) => {
    try { loadConfig({ ...minimal, ...overrides } as any); } catch (e: any) { return e.message as string; }
    throw new Error("expected loadConfig to throw");
  };

  test.each([
    [{ ALERT_EMAIL: "nope" }, "ALERT_EMAIL"],
    [{ IAM_DENY_TARGET_USERS: "" }, "IAM_DENY_TARGET_USERS"],
    [{ IAM_DENY_TARGET_USERS: "learn*" }, "IAM_DENY_TARGET_USERS"],
    [{ RECOVERY_PRINCIPAL_ARN: "Admin" }, "RECOVERY_PRINCIPAL_ARN"],
    [{ IAM_DENY_TARGET_ROLES: "Admin" }, "RECOVERY_PRINCIPAL_ARN"],
    [{ DAILY_DIGEST_HOUR_UTC: "25" }, "DAILY_DIGEST_HOUR_UTC"],
    [{ DAILY_DIGEST: "maybe" }, "DAILY_DIGEST"],
    [{ STOP_EC2_INSTANCES: "not-an-id" }, "STOP_EC2_INSTANCES"],
    [{ SERVICE_BUDGETS: "Amazon SageMaker" }, "SERVICE_BUDGETS"]
  ] as const)("%p -> %s", (overrides, key) => {
    expect(fieldForError(errorFor(overrides))).toBe(key);
  });

  test("returns undefined for a message naming no field", () => {
    expect(fieldForError("something unexpected")).toBeUndefined();
  });
});
