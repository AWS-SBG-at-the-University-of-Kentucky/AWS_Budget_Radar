import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { AddressInfo } from "net";
import { spawn } from "child_process";
import { parse } from "dotenv";
import { loadConfig } from "../lib/config";
import { templateDefaults, renderEnv } from "./envfile";
import { FIELDS, SECTIONS, fieldForError } from "./fields";
import { SetupAws, checkSignIns, localAws } from "./aws";

// `npm run dev`: a local-only page that fills in .env. Built on Node's http
// module so there is nothing extra to install. It only ever reads
// .env.example and reads/writes .env in `root`; it never deploys anything.

export interface SetupServerOptions {
  root: string; // folder holding .env.example and .env
  aws: SetupAws;
  pagePath?: string;
}

interface Validation { ok: boolean; error?: string; field?: string; }
type Values = Record<string, string>;

const MAX_BODY_BYTES = 64 * 1024;
const FIELD_KEYS = new Set(FIELDS.map(f => f.key));
// Inline script/style only (the page is one self-contained file); the page
// can talk to this server and nothing else, and can't be framed.
const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; " +
  "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function createSetupServer(opts: SetupServerOptions): http.Server {
  const templatePath = path.join(opts.root, ".env.example");
  const envPath = path.join(opts.root, ".env");
  const pagePath = opts.pagePath ?? path.join(__dirname, "index.html");
  const readmeUrl = repoReadmeUrl(opts.root);

  const readTemplate = () => fs.readFileSync(templatePath, "utf8");
  const readEnv = (): Values | undefined => (fs.existsSync(envPath) ? parse(fs.readFileSync(envPath)) : undefined);

  // What the form shows: the .env value if set, else the template default.
  // Example-only template values ("your-iam-username") count as blank.
  function formValues(template: string, env: Values | undefined): Values {
    const defaults = templateDefaults(template);
    return Object.fromEntries(FIELDS.map(f => {
      const value = env && f.key in env ? env[f.key] : defaults[f.key] ?? "";
      return [f.key, f.exampleOnly && value === defaults[f.key] ? "" : value];
    }));
  }

  function validate(values: Values): Validation {
    try {
      loadConfig(values);
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e.message, field: fieldForError(e.message) };
    }
  }

  function state() {
    const template = readTemplate();
    const env = readEnv();
    const defaults = templateDefaults(template);
    const values = formValues(template, env);
    return {
      envFile: { exists: !!env, path: envPath },
      sections: SECTIONS,
      fields: FIELDS.map(f => ({ ...f, value: values[f.key], templateValue: defaults[f.key] ?? "" })),
      extras: Object.keys(env ?? {}).filter(k => !(k in defaults)),
      readmeUrl,
      validation: validate(values)
    };
  }

  // Submitted values win; anything not submitted keeps what .env already
  // had. Keys that exist only in the old .env (e.g. AWS_PROFILE) are kept.
  function merged(submitted: Values) {
    const template = readTemplate();
    const env = readEnv() ?? {};
    const defaults = templateDefaults(template);
    const kept = Object.fromEntries(Object.entries(env).filter(([k]) => k in defaults));
    const extras = Object.fromEntries(Object.entries(env).filter(([k]) => !(k in defaults)));
    return { template, extras, values: { ...kept, ...formValues(template, env), ...submitted } };
  }

  function save(submitted: Values) {
    const { template, extras, values } = merged(submitted);
    let text: string;
    try {
      text = renderEnv(template, values, extras);
    } catch (e: any) {
      throw new HttpError(400, e.message);
    }
    // Write-then-rename so a crash can't leave a half-written .env. The temp
    // name matches .gitignore's `.env.*.local`.
    const tmp = path.join(opts.root, ".env.saving.local");
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, envPath);
    return { saved: true, envFile: { exists: true, path: envPath }, validation: validate(values) };
  }

  // Same precedence as `import "dotenv/config"`: the shell wins over .env.
  const awsEnv = (): NodeJS.ProcessEnv => ({ ...(readEnv() ?? {}), ...process.env });

  const server = http.createServer(async (req, res) => {
    try {
      const port = (server.address() as AddressInfo).port;
      const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
      // A foreign Host means DNS rebinding: some website pointing its own
      // domain at 127.0.0.1 to reach this server.
      if (!hosts.includes(req.headers.host ?? "")) throw new HttpError(403, "Unexpected Host header.");
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      if (url.pathname.startsWith("/api/")) {
        const site = req.headers["sec-fetch-site"];
        if (site && site !== "same-origin" && site !== "none") throw new HttpError(403, "Cross-site request blocked.");
      }
      if (req.method === "POST") {
        // JSON forces a CORS preflight (which this server never approves),
        // and a present Origin must be this page: no cross-site writes.
        if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) throw new HttpError(415, "Expected JSON.");
        const origin = req.headers.origin;
        if (origin && !hosts.some(h => origin === `http://${h}`)) throw new HttpError(403, "Cross-origin request blocked.");
      }

      switch (`${req.method} ${url.pathname}`) {
        case "GET /":
          return send(res, 200, fs.readFileSync(pagePath), "text/html; charset=utf-8");
        case "GET /api/state":
          return sendJson(res, 200, state());
        case "POST /api/validate":
          return sendJson(res, 200, validate(merged(submittedValues(await readJson(req))).values));
        case "POST /api/save":
          return sendJson(res, 200, save(submittedValues(await readJson(req))));
        case "GET /api/aws/signins": {
          const env = awsEnv();
          const signIns = await checkSignIns(opts.aws.profiles(env), p => opts.aws.probe(env, p));
          return sendJson(res, 200, { active: env.AWS_PROFILE?.trim() || null, signIns });
        }
        case "GET /api/aws/whoami": {
          const env = awsEnv();
          const requested = url.searchParams.get("profile");
          if (requested) {
            if (!opts.aws.profiles(env).some(p => p.name === requested)) {
              throw new HttpError(400, `There's no AWS profile named "${requested}" on this computer.`);
            }
            env.AWS_PROFILE = requested;
          }
          return sendJson(res, 200, { ...(await opts.aws.whoami(env)), profile: env.AWS_PROFILE?.trim() || "default" });
        }
        default:
          throw new HttpError(404, "Not found.");
      }
    } catch (e: any) {
      const status = e instanceof HttpError ? e.status : 500;
      sendJson(res, status, { error: status === 500 ? `Setup server error: ${e?.message ?? e}` : e.message });
    }
  });
  return server;
}

// Only known keys; strings only; pasted whitespace trimmed. Line breaks
// would let one field inject another line into .env.
function submittedValues(body: any): Values {
  if (!body || typeof body.values !== "object" || body.values === null) {
    throw new HttpError(400, "Expected {\"values\": {...}}.");
  }
  const out: Values = {};
  for (const [key, raw] of Object.entries(body.values)) {
    if (!FIELD_KEYS.has(key)) continue;
    if (typeof raw !== "string") throw new HttpError(400, `${key} must be text.`);
    const value = raw.trim();
    if (/[\r\n]/.test(value)) throw new HttpError(400, `${key}: values can't contain line breaks.`);
    out[key] = value;
  }
  return out;
}

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { reject(new HttpError(413, "Request too large.")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(new HttpError(400, "Request body isn't valid JSON.")); }
    });
    req.on("error", reject);
  });
}

function send(res: http.ServerResponse, status: number, body: string | Buffer, type: string) {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "Content-Security-Policy": CSP,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer"
  });
  res.end(body);
}

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  send(res, status, JSON.stringify(body), "application/json; charset=utf-8");
}

// "Learn more" links go to the README on the project's GitHub page.
function repoReadmeUrl(root: string): string | undefined {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    const url = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
    if (!url) return undefined;
    return `${url.replace(/^git\+/, "").replace(/\.git$/, "")}/blob/main/README.md`;
  } catch {
    return undefined;
  }
}

// Tries PORT (default 4000), then the next ports up if they're taken.
function listenFrom(server: http.Server, port: number, tries: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (e: NodeJS.ErrnoException) => {
      server.off("listening", onListening);
      if (e.code === "EADDRINUSE" && tries > 1) resolve(listenFrom(server, port + 1, tries - 1));
      else reject(e);
    };
    const onListening = () => { server.off("error", onError); resolve(port); };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

// Best effort: the URL is always printed too (e.g. for WSL or SSH).
function openBrowser(url: string) {
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [url]] :
    process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] :
    ["xdg-open", [url]];
  const child = spawn(cmd as string, args as string[], { stdio: "ignore", detached: true });
  child.on("error", () => {});
  child.unref();
}

if (require.main === module) {
  (async () => {
    const root = path.resolve(__dirname, "..");
    if (!fs.existsSync(path.join(root, ".env.example"))) {
      console.error(`Can't find .env.example in ${root}. Run this from the AWS_Budget_Radar folder.`);
      process.exit(1);
    }
    const server = createSetupServer({ root, aws: localAws });
    const port = await listenFrom(server, Number(process.env.PORT) || 4000, 20);
    const url = `http://127.0.0.1:${port}`;
    console.log([
      "",
      "  AWS Budget Radar setup is running:",
      "",
      `    ➜  ${url}`,
      "",
      "  Fill in the form and click Save. It writes your .env file for you.",
      "  Press Ctrl+C here when you're done.",
      ""
    ].join("\n"));
    if (process.env.BROWSER !== "none" && !process.argv.includes("--no-open")) openBrowser(url);
  })().catch(e => {
    console.error(`Setup page failed to start: ${e?.message ?? e}`);
    process.exit(1);
  });
}
