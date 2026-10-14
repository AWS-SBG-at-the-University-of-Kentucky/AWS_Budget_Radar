import { whoami, parseProfiles, checkSignIns, AwsCalls } from "../setup/aws";

function fakeCalls(over: Partial<AwsCalls> = {}): AwsCalls {
  return {
    callerIdentity: async () => ({ Account: "111122223333", Arn: "arn:aws:iam::111122223333:user/admin" }),
    roleArn: async (name) => `arn:aws:iam::111122223333:role/${name}`,
    userNames: async () => ["admin", "learning"],
    region: async () => "us-east-1",
    ...over
  };
}

test("IAM user: suggests that user's ARN and lists IAM users", async () => {
  const r = await whoami(fakeCalls());
  expect(r).toMatchObject({
    ok: true, account: "111122223333", kind: "user", region: "us-east-1",
    recoveryArn: "arn:aws:iam::111122223333:user/admin", users: ["admin", "learning"]
  });
});

test("assumed role (e.g. SSO): resolves the role's full ARN, path included, via GetRole", async () => {
  const sso = "AWSReservedSSO_AdministratorAccess_0123456789abcdef";
  const r = await whoami(fakeCalls({
    callerIdentity: async () => ({ Account: "111122223333", Arn: `arn:aws:sts::111122223333:assumed-role/${sso}/student` }),
    roleArn: async (name) => `arn:aws:iam::111122223333:role/aws-reserved/sso.amazonaws.com/${name}`
  }));
  expect(r).toMatchObject({
    ok: true, kind: "role",
    recoveryArn: `arn:aws:iam::111122223333:role/aws-reserved/sso.amazonaws.com/${sso}`
  });
});

test("assumed role whose path can't be looked up: falls back to a pathless ARN with a warning", async () => {
  const r = await whoami(fakeCalls({
    callerIdentity: async () => ({ Account: "111122223333", Arn: "arn:aws:sts::111122223333:assumed-role/Admin/me" }),
    roleArn: async () => { throw Object.assign(new Error("not authorized to perform iam:GetRole"), { name: "AccessDenied" }); }
  }));
  expect(r).toMatchObject({ ok: true, kind: "role", recoveryArn: "arn:aws:iam::111122223333:role/Admin" });
  expect((r as any).note).toMatch(/path/i);
});

test("root user: no suggestion, and explains why", async () => {
  const r = await whoami(fakeCalls({
    callerIdentity: async () => ({ Account: "111122223333", Arn: "arn:aws:iam::111122223333:root" })
  }));
  expect(r).toMatchObject({ ok: true, kind: "root" });
  expect((r as any).recoveryArn).toBeUndefined();
  expect((r as any).note).toMatch(/root/i);
});

test("listing users can fail without failing the whole lookup", async () => {
  const r = await whoami(fakeCalls({ userNames: async () => { throw new Error("AccessDenied: iam:ListUsers"); } }));
  expect(r).toMatchObject({ ok: true, users: [] });
  expect((r as any).usersError).toMatch(/ListUsers/);
});

test("missing credentials: friendly instructions instead of a stack trace", async () => {
  const r = await whoami(fakeCalls({
    callerIdentity: async () => { throw Object.assign(new Error("Could not load credentials from any providers"), { name: "CredentialsProviderError" }); }
  }));
  expect(r.ok).toBe(false);
  expect((r as any).error).toMatch(/Could not load credentials/);
  expect((r as any).error).toMatch(/sign in from a terminal/i);
});

test("missing region: says how to set one", async () => {
  const r = await whoami(fakeCalls({ callerIdentity: async () => { throw new Error("Region is missing"); } }));
  expect(r.ok).toBe(false);
  expect((r as any).error).toMatch(/region/i);
});

describe("parseProfiles (from ~/.aws/config and ~/.aws/credentials)", () => {
  const config = [
    "[profile club-sso]", "sso_session = club-sso", "sso_account_id = 222222222222",
    "[default]", "region = us-east-1",
    "[profile student-sso]", "sso_session = student-session", "sso_account_id = 111111111111",
    "[sso-session student-session]", "sso_start_url = https://example.awsapps.com/start",
    "[services local]", "  s3 =",
    "  [ profile  legacy-sso ]  ", "sso_start_url = https://example.awsapps.com/start"
  ].join("\n");

  test("lists profiles with default first, skipping sso-session and services sections", () => {
    expect(parseProfiles(config, "")).toEqual([
      { name: "default", sso: false },
      { name: "club-sso", sso: true, account: "222222222222" },
      { name: "student-sso", sso: true, account: "111111111111" },
      { name: "legacy-sso", sso: true }
    ]);
  });

  test("adds access-key profiles from the credentials file, without duplicates", () => {
    const names = parseProfiles(config, "[default]\naws_access_key_id = x\n[keys-only]\n").map(p => p.name);
    expect(names).toEqual(["default", "club-sso", "student-sso", "legacy-sso", "keys-only"]);
  });

  test("no AWS config at all: no profiles", () => {
    expect(parseProfiles("", "")).toEqual([]);
  });
});

describe("checkSignIns: which profiles are signed in right now", () => {
  const profiles = [
    { name: "default", sso: true, account: "222222222222" },
    { name: "student-sso", sso: true, account: "111111111111" },
    { name: "keys", sso: false }
  ];

  test("probes every profile and reports each one's account or why it isn't signed in", async () => {
    const r = await checkSignIns(profiles, async (p) => {
      if (p === "student-sso") return { Account: "111111111111", Arn: "arn:aws:sts::111111111111:assumed-role/Admin/me" };
      if (p === "default") throw new Error("Token is expired. To refresh this SSO session run 'aws sso login'");
      throw Object.assign(new Error("Could not load credentials from any providers"), { name: "CredentialsProviderError" });
    });
    expect(r).toEqual([
      { profile: "default", signedIn: false, sso: true, account: "222222222222", reason: "Sign-in expired" },
      { profile: "student-sso", signedIn: true, account: "111111111111", arn: "arn:aws:sts::111111111111:assumed-role/Admin/me" },
      { profile: "keys", signedIn: false, sso: false, reason: "Not signed in" }
    ]);
  });

  test("a profile that hangs times out instead of blocking the page", async () => {
    const r = await checkSignIns([profiles[2]], () => new Promise(() => {}), 20);
    expect(r).toEqual([{ profile: "keys", signedIn: false, sso: false, reason: "No answer (timed out)" }]);
  });

  test("other errors are passed through, shortened", async () => {
    const r = await checkSignIns([profiles[2]], async () => { throw new Error("x".repeat(500)); });
    expect((r[0] as any).reason.length).toBeLessThanOrEqual(160);
  });
});

test("GovCloud/China partitions keep their partition in the suggested ARN", async () => {
  const r = await whoami(fakeCalls({
    callerIdentity: async () => ({ Account: "111122223333", Arn: "arn:aws-us-gov:sts::111122223333:assumed-role/Admin/me" }),
    roleArn: async () => { throw new Error("denied"); }
  }));
  expect((r as any).recoveryArn).toBe("arn:aws-us-gov:iam::111122223333:role/Admin");
});
