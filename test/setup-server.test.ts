import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as http from "http";
import { AddressInfo } from "net";
import { parse } from "dotenv";
import { createSetupServer } from "../setup/server";
import { WhoAmI, AwsProfile } from "../setup/aws";

const REPO = path.join(__dirname, "..");
const TOKEN = "this-launchs-token-0123456789abcdefghijk";
const VALID = {
  ALERT_EMAIL: "student@example.edu",
  IAM_DENY_TARGET_USERS: "learning",
  RECOVERY_PRINCIPAL_ARN: "arn:aws:iam::111122223333:role/Admin"
};

let root: string;
let server: http.Server;
let port: number;
let whoamiEnv: NodeJS.ProcessEnv | undefined;
let probeEnv: NodeJS.ProcessEnv | undefined;
const PROFILES: AwsProfile[] = [
  { name: "default", sso: true, account: "222222222222" },
  { name: "student-sso", sso: true, account: "111122223333" }
];

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "radar-setup-"));
  fs.copyFileSync(path.join(REPO, ".env.example"), path.join(root, ".env.example"));
  whoamiEnv = undefined;
  probeEnv = undefined;
  server = createSetupServer({
    root,
    token: TOKEN,
    pagePath: path.join(REPO, "setup", "index.html"),
    aws: {
      profiles: () => PROFILES,
      probe: async (env, profile) => {
        probeEnv = env;
        if (profile === "student-sso") return { Account: "111122223333", Arn: "arn:aws:sts::111122223333:assumed-role/Admin/me" };
        throw new Error("Token is expired.");
      },
      whoami: async (env): Promise<WhoAmI> => {
        whoamiEnv = env;
        return { ok: true, account: "111122223333", arn: "arn:aws:iam::111122223333:user/admin", kind: "user", users: [] };
      }
    }
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  await new Promise(r => server.close(r));
  fs.rmSync(root, { recursive: true, force: true });
});

interface Res { status: number; headers: http.IncomingHttpHeaders; body: any; }

// Sends what the page sends; a header set to undefined is left out.
function request(method: string, urlPath: string, opts: { body?: unknown; headers?: Record<string, string | undefined> } = {}): Promise<Res> {
  const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  const headers = Object.fromEntries(Object.entries({
    host: `127.0.0.1:${port}`,
    authorization: `Bearer ${TOKEN}`,
    ...(payload ? { "content-type": "application/json", origin: `http://127.0.0.1:${port}` } : {}),
    ...opts.headers
  }).filter(([, v]) => v !== undefined)) as Record<string, string>;
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: urlPath, headers }, res => {
      let data = "";
      res.on("data", c => (data += c));
      res.on("end", () => {
        let body: any = data;
        try { body = JSON.parse(data); } catch { /* html or text */ }
        resolve({ status: res.statusCode!, headers: res.headers, body });
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const envFile = () => path.join(root, ".env");
const valuesOf = (state: any) => Object.fromEntries(state.fields.map((f: any) => [f.key, f.value]));

describe("GET /api/state", () => {
  test("with no .env yet: template defaults, example-only values blanked, not ready", async () => {
    const r = await request("GET", "/api/state");
    expect(r.status).toBe(200);
    expect(r.body.envFile.exists).toBe(false);
    const v = valuesOf(r.body);
    expect(v.MONTHLY_BUDGET_USD).toBe("5");
    expect(v.SAFETY).toBe("watch");
    expect(v.IAM_DENY_TARGET_USERS).toBe("");      // "your-iam-username" is an example
    expect(v.RECOVERY_PRINCIPAL_ARN).toBe("");     // "arn:aws:iam::<account-id>:..." too
    expect(r.body.validation).toMatchObject({ ok: false, field: "ALERT_EMAIL" });
    expect(r.body.sections.length).toBeGreaterThan(0);
  });

  test("with an existing .env: its values load, and keys not in the template are listed as kept", async () => {
    fs.writeFileSync(envFile(), "ALERT_EMAIL=me@example.edu\nIAM_DENY_TARGET_USERS=your-iam-username\nAWS_PROFILE=admin\n");
    const r = await request("GET", "/api/state");
    expect(r.body.envFile.exists).toBe(true);
    expect(valuesOf(r.body).ALERT_EMAIL).toBe("me@example.edu");
    expect(valuesOf(r.body).IAM_DENY_TARGET_USERS).toBe("");
    expect(r.body.extras).toEqual(["AWS_PROFILE"]);
  });
});

describe("POST /api/validate", () => {
  test("runs the real loadConfig and names the field to fix", async () => {
    const bad = await request("POST", "/api/validate", { body: { values: { ...VALID, RECOVERY_PRINCIPAL_ARN: "Admin" } } });
    expect(bad.body).toMatchObject({ ok: false, field: "RECOVERY_PRINCIPAL_ARN" });
    expect(bad.body.error).toMatch(/full IAM ARN/);

    const good = await request("POST", "/api/validate", { body: { values: VALID } });
    expect(good.body).toEqual({ ok: true });
    expect(fs.existsSync(envFile())).toBe(false); // validating never writes
  });
});

describe("POST /api/save", () => {
  test("writes .env from the template: comments kept, values exact, ready to deploy", async () => {
    const r = await request("POST", "/api/save", { body: { values: { ...VALID, MONTHLY_BUDGET_USD: "0.01" } } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ saved: true, validation: { ok: true } });
    const text = fs.readFileSync(envFile(), "utf8");
    expect(text).toContain("# --- AWS Budget Radar configuration");
    const saved = parse(text);
    expect(saved).toMatchObject({ ...VALID, MONTHLY_BUDGET_USD: "0.01", SAFETY: "watch" });
  });

  test("keeps settings that only exist in the old .env, and ignores unknown submitted keys", async () => {
    fs.writeFileSync(envFile(), "AWS_PROFILE=admin\nALERT_EMAIL=old@example.edu\n");
    await request("POST", "/api/save", { body: { values: { ...VALID, NOT_A_SETTING: "x" } } });
    const saved = parse(fs.readFileSync(envFile(), "utf8"));
    expect(saved.AWS_PROFILE).toBe("admin");
    expect(saved.ALERT_EMAIL).toBe(VALID.ALERT_EMAIL);
    expect(saved.NOT_A_SETTING).toBeUndefined();
  });

  test("saves an incomplete form too (students can come back later) but reports it isn't ready", async () => {
    const r = await request("POST", "/api/save", { body: { values: { ALERT_EMAIL: "student@example.edu" } } });
    expect(r.body).toMatchObject({ saved: true, validation: { ok: false, field: "IAM_DENY_TARGET_USERS" } });
    expect(parse(fs.readFileSync(envFile(), "utf8")).ALERT_EMAIL).toBe("student@example.edu");
  });

  test("trims pasted whitespace", async () => {
    await request("POST", "/api/save", { body: { values: { ...VALID, ALERT_EMAIL: "  student@example.edu \t" } } });
    expect(parse(fs.readFileSync(envFile(), "utf8")).ALERT_EMAIL).toBe("student@example.edu");
  });

  test("rejects a value with a line break and leaves .env untouched", async () => {
    fs.writeFileSync(envFile(), "ALERT_EMAIL=keep@example.edu\n");
    const r = await request("POST", "/api/save", { body: { values: { ...VALID, ALERT_EMAIL: "a@b.edu\nSAFETY=armed" } } });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/line break/);
    expect(fs.readFileSync(envFile(), "utf8")).toBe("ALERT_EMAIL=keep@example.edu\n");
  });

  test("rejects non-string values and malformed JSON", async () => {
    expect((await request("POST", "/api/save", { body: { values: { ALERT_EMAIL: 5 } } })).status).toBe(400);
    const raw = await new Promise<number>((resolve) => {
      const req = http.request({
        host: "127.0.0.1", port, method: "POST", path: "/api/save",
        headers: { host: `127.0.0.1:${port}`, "content-type": "application/json", authorization: `Bearer ${TOKEN}` }
      }, res => { res.resume(); resolve(res.statusCode!); });
      req.end("{not json");
    });
    expect(raw).toBe(400);
  });
});

// POSIX modes only: Windows files have just a read-only bit.
(process.platform === "win32" ? describe.skip : describe)("POST /api/save keeps .env private", () => {
  const realFs: typeof fs = require("fs"); // the module server.ts calls, so spies reach it
  const modeOf = (p: string) => fs.statSync(p).mode & 0o777;
  let oldUmask: number;
  // 022 is the common default: a plain new file comes out 0644, readable by everyone.
  beforeEach(() => { oldUmask = process.umask(0o022); });
  afterEach(() => { process.umask(oldUmask); jest.restoreAllMocks(); });

  test("saving over an owner-only .env keeps it owner-only, kept settings included", async () => {
    fs.writeFileSync(envFile(), "AWS_PROFILE=admin\nMY_TOKEN=not-for-others\n", { mode: 0o600 });
    const r = await request("POST", "/api/save", { body: { values: VALID } });
    expect(r.status).toBe(200);
    expect(modeOf(envFile())).toBe(0o600);
    expect(parse(fs.readFileSync(envFile(), "utf8"))).toMatchObject({ AWS_PROFILE: "admin", MY_TOKEN: "not-for-others" });
  });

  test("a new .env, or one others could read, is saved owner-only", async () => {
    await request("POST", "/api/save", { body: { values: VALID } });
    expect(modeOf(envFile())).toBe(0o600);
    fs.chmodSync(envFile(), 0o644);
    await request("POST", "/api/save", { body: { values: VALID } });
    expect(modeOf(envFile())).toBe(0o600);
    expect(fs.readdirSync(root).sort()).toEqual([".env", ".env.example"]); // no temp file left
  });

  test("the temp file is owner-only and gitignored, and a failed save removes it and leaves .env alone", async () => {
    fs.writeFileSync(envFile(), "ALERT_EMAIL=keep@example.edu\n", { mode: 0o600 });
    let tmp = "";
    let tmpMode = 0;
    jest.spyOn(realFs, "renameSync").mockImplementationOnce(from => {
      tmp = String(from);
      tmpMode = modeOf(tmp);
      throw new Error("disk full");
    });
    const r = await request("POST", "/api/save", { body: { values: VALID } });
    expect(r.status).toBe(500);
    expect(tmpMode).toBe(0o600);
    expect(path.basename(tmp)).toMatch(/^\.env\..+\.local$/); // .gitignore's `.env.*.local`
    expect(fs.existsSync(tmp)).toBe(false);
    expect(fs.readFileSync(envFile(), "utf8")).toBe("ALERT_EMAIL=keep@example.edu\n");
  });
});

describe("AWS profiles", () => {
  test("signins reports which profiles are signed in, plus the profile the shell/.env already selects", async () => {
    fs.writeFileSync(envFile(), "AWS_PROFILE=from-dotenv\n");
    const r = await request("GET", "/api/aws/signins");
    expect(r.status).toBe(200);
    expect(r.body.active).toBe(process.env.AWS_PROFILE ?? "from-dotenv");
    expect(r.body.signIns).toEqual([
      { profile: "default", signedIn: false, sso: true, account: "222222222222", reason: "Sign-in expired" },
      { profile: "student-sso", signedIn: true, account: "111122223333", arn: "arn:aws:sts::111122223333:assumed-role/Admin/me" }
    ]);
    expect(probeEnv?.AWS_PROFILE).toBe(process.env.AWS_PROFILE ?? "from-dotenv");
  });

  test("signins says active=null when nothing selects a profile", async () => {
    const r = await request("GET", "/api/aws/signins");
    expect(r.body.active).toBe(process.env.AWS_PROFILE ?? null);
  });

  test("whoami passes .env settings (e.g. AWS_PROFILE) to the AWS lookup, shell env winning, and says which profile", async () => {
    fs.writeFileSync(envFile(), "AWS_PROFILE=from-dotenv\n");
    const r = await request("GET", "/api/aws/whoami");
    const expected = process.env.AWS_PROFILE ?? "from-dotenv";
    expect(r.body).toMatchObject({ ok: true, account: "111122223333", profile: expected });
    expect(whoamiEnv?.AWS_PROFILE).toBe(expected);
  });

  test("whoami?profile= checks the profile the student picked", async () => {
    const r = await request("GET", "/api/aws/whoami?profile=student-sso");
    expect(r.body).toMatchObject({ ok: true, profile: "student-sso" });
    expect(whoamiEnv?.AWS_PROFILE).toBe("student-sso");
  });

  test("whoami rejects a profile that isn't in the AWS config", async () => {
    const r = await request("GET", "/api/aws/whoami?profile=nope");
    expect(r.status).toBe(400);
    expect(whoamiEnv).toBeUndefined();
  });
});

describe("localhost safety", () => {
  test("serves the page with a strict CSP and no framing", async () => {
    const r = await request("GET", "/");
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toMatch(/text\/html/);
    expect(r.headers["content-security-policy"]).toMatch(/frame-ancestors 'none'/);
    expect(r.headers["content-security-policy"]).toMatch(/connect-src 'self'/);
  });

  test("rejects a foreign Host header (DNS rebinding)", async () => {
    const r = await request("GET", "/api/state", { headers: { host: `evil.example:${port}` } });
    expect(r.status).toBe(403);
  });

  test("accepts localhost as well as 127.0.0.1", async () => {
    const r = await request("GET", "/api/state", { headers: { host: `localhost:${port}` } });
    expect(r.status).toBe(200);
  });

  test("rejects a cross-site POST (CSRF) and leaves .env untouched", async () => {
    const r = await request("POST", "/api/save", { body: { values: VALID }, headers: { origin: "https://evil.example" } });
    expect(r.status).toBe(403);
    expect(fs.existsSync(envFile())).toBe(false);
  });

  test("rejects POSTs that aren't JSON (form posts can't skip CORS preflight)", async () => {
    const r = await request("POST", "/api/save", {
      body: { values: VALID }, headers: { "content-type": "text/plain" }
    });
    expect(r.status).toBe(415);
    expect(fs.existsSync(envFile())).toBe(false);
  });

  test("rejects API reads a browser marks as cross-site", async () => {
    const r = await request("GET", "/api/aws/whoami", { headers: { "sec-fetch-site": "cross-site" } });
    expect(r.status).toBe(403);
    expect(whoamiEnv).toBeUndefined();
  });

  // Any program on this computer (another user's, say) can reach 127.0.0.1,
  // send the right Host and leave out the browser headers. Only the
  // per-launch token sets the person who started setup apart.
  const API: [string, string][] = [
    ["GET", "/api/state"], ["POST", "/api/validate"], ["POST", "/api/save"],
    ["GET", "/api/aws/signins"], ["GET", "/api/aws/whoami?profile=student-sso"]
  ];
  test.each([
    ["no token", undefined],
    ["a wrong token", "Bearer wrong"],
    ["a same-length token from another launch", `Bearer ${"x".repeat(TOKEN.length)}`],
    ["the token without Bearer", TOKEN]
  ])("every API route refuses %s, and nothing is written or looked up", async (_label, authorization) => {
    for (const [method, p] of API) {
      const r = await request(method, p, {
        body: method === "POST" ? { values: VALID } : undefined,
        headers: { authorization, origin: undefined }
      });
      expect([p, r.status]).toEqual([p, 401]);
      expect(r.body.error).toMatch(/link printed in the terminal/);
    }
    expect(fs.existsSync(envFile())).toBe(false);
    expect(probeEnv).toBeUndefined();
    expect(whoamiEnv).toBeUndefined();
  });

  test("with the token, a client without browser headers is served", async () => {
    const r = await request("POST", "/api/save", { body: { values: VALID }, headers: { origin: undefined } });
    expect(r.status).toBe(200);
    expect(fs.existsSync(envFile())).toBe(true);
  });

  test("the page loads without the token, and no response ever contains it", async () => {
    const page = await request("GET", "/", { headers: { authorization: undefined } });
    expect(page.status).toBe(200);
    const responses = [page, ...await Promise.all(API.map(([method, p]) =>
      request(method, p, { body: method === "POST" ? { values: VALID } : undefined })))];
    for (const r of responses) expect(JSON.stringify([r.headers, r.body])).not.toContain(TOKEN);
  });

  test("unknown paths are 404, and nothing else in the folder is served", async () => {
    expect((await request("GET", "/.env.example")).status).toBe(404);
    expect((await request("GET", "/../package.json")).status).toBe(404);
  });
});
