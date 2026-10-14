import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { deployRegionFromEnv } from "../lib/config";

// The setup page's optional AWS helper. Read-only and free: STS
// GetCallerIdentity, IAM GetRole and ListUsers. It finds which AWS CLI
// profiles are signed in right now (students often have several accounts),
// then looks up details for the one they pick. It only suggests values; the
// student still decides what goes in .env.

// What the page needs from AWS; the server takes this so tests can fake it.
export interface SetupAws {
  profiles(env: NodeJS.ProcessEnv): AwsProfile[];
  probe(env: NodeJS.ProcessEnv, profile: string): Promise<{ Account?: string; Arn?: string }>;
  whoami(env: NodeJS.ProcessEnv): Promise<WhoAmI>;
}

export interface AwsProfile { name: string; sso: boolean; account?: string; }

export type SignIn =
  | { profile: string; signedIn: true; account: string; arn: string }
  | { profile: string; signedIn: false; sso: boolean; account?: string; reason: string };

const SECTION_RE = /^\s*\[\s*([^\]]+?)\s*\]/;
const KEY_VALUE_RE = /^\s*([\w.-]+)\s*=\s*(.*?)\s*$/;

// Profiles from the AWS CLI's config and credentials files, default first.
// sso_account_id (when present) says which account a signed-out SSO
// profile belongs to, without calling AWS.
export function parseProfiles(configText: string, credentialsText: string): AwsProfile[] {
  const byName = new Map<string, AwsProfile>();
  let current: AwsProfile | undefined;
  for (const line of configText.split(/\r?\n/)) {
    const section = line.match(SECTION_RE);
    if (section) {
      const s = section[1];
      const name = s === "default" ? s : /^profile\s+/.test(s) ? s.replace(/^profile\s+/, "") : undefined;
      current = name ? byName.get(name) ?? { name, sso: false } : undefined; // skip [sso-session], [services]
      if (current) byName.set(current.name, current);
      continue;
    }
    const kv = line.match(KEY_VALUE_RE);
    if (!current || !kv) continue;
    if (kv[1] === "sso_session" || kv[1] === "sso_start_url") current.sso = true;
    if (kv[1] === "sso_account_id") current.account = kv[2];
  }
  for (const line of credentialsText.split(/\r?\n/)) {
    const name = line.match(SECTION_RE)?.[1];
    if (name && !byName.has(name)) byName.set(name, { name, sso: false });
  }
  return [...byName.values()].sort((a, b) => (a.name === "default" ? -1 : b.name === "default" ? 1 : 0));
}

export function localProfiles(env: NodeJS.ProcessEnv): AwsProfile[] {
  const read = (file: string) => { try { return fs.readFileSync(file, "utf8"); } catch { return ""; } };
  const aws = path.join(os.homedir(), ".aws");
  return parseProfiles(
    read(env.AWS_CONFIG_FILE || path.join(aws, "config")),
    read(env.AWS_SHARED_CREDENTIALS_FILE || path.join(aws, "credentials"))
  );
}

// Asks every profile "who am I?" in parallel. A profile that hangs (e.g. a
// credential_process waiting for input) times out instead of stalling.
export async function checkSignIns(
  profiles: AwsProfile[],
  probe: (profile: string) => Promise<{ Account?: string; Arn?: string }>,
  timeoutMs = 10_000
): Promise<SignIn[]> {
  return Promise.all(profiles.map(async (p): Promise<SignIn> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("__timeout__")), timeoutMs);
      });
      const id = await Promise.race([probe(p.name), timeout]);
      return { profile: p.name, signedIn: true, account: id.Account ?? "", arn: id.Arn ?? "" };
    } catch (e: any) {
      const out: SignIn = { profile: p.name, signedIn: false, sso: p.sso, reason: signInReason(e) };
      if (p.account) out.account = p.account;
      return out;
    } finally {
      clearTimeout(timer);
    }
  }));
}

function signInReason(e: any): string {
  const msg = String(e?.message ?? e);
  if (msg === "__timeout__") return "No answer (timed out)";
  if (/expired/i.test(msg)) return "Sign-in expired";
  if (/could not load credentials|no credentials|could not be found|unable to load|sso.*(invalid|not found)/i.test(`${e?.name} ${msg}`)) {
    return "Not signed in";
  }
  return msg.length > 160 ? `${msg.slice(0, 157)}...` : msg;
}

export interface AwsCalls {
  callerIdentity(): Promise<{ Account?: string; Arn?: string }>;
  roleArn(roleName: string): Promise<string>;
  userNames(): Promise<string[]>;
  region(): Promise<string | undefined>;
}

export type WhoAmI =
  | {
      ok: true;
      account: string;
      arn: string;
      region?: string;
      kind: "user" | "role" | "root" | "other";
      // Suggested RECOVERY_PRINCIPAL_ARN: the identity you're signed in as,
      // which is also the one you'll deploy with.
      recoveryArn?: string;
      note?: string;
      users: string[];
      usersError?: string;
    }
  | { ok: false; error: string };

const USER_ARN_RE = /^arn:aws[a-z-]*:iam::\d{12}:user\/.+$/;
const ROOT_ARN_RE = /^arn:aws[a-z-]*:iam::\d{12}:root$/;
const ASSUMED_ROLE_RE = /^arn:(aws[a-z-]*):sts::(\d{12}):assumed-role\/([^/]+)\/.+$/;

export async function whoami(calls: AwsCalls): Promise<WhoAmI> {
  let id: { Account?: string; Arn?: string };
  let region: string | undefined;
  try {
    id = await calls.callerIdentity();
    region = await calls.region();
  } catch (e) {
    return { ok: false, error: credentialHelp(e) };
  }
  const arn = id.Arn ?? "";
  const account = id.Account ?? "";

  let users: string[] = [];
  let usersError: string | undefined;
  try {
    users = await calls.userNames();
  } catch (e: any) {
    usersError = `Couldn't list IAM users (${e?.message ?? e}). You can still type the name.`;
  }

  const base = { ok: true as const, account, arn, region, users, usersError };
  if (USER_ARN_RE.test(arn)) {
    return { ...base, kind: "user", recoveryArn: arn };
  }
  if (ROOT_ARN_RE.test(arn)) {
    return {
      ...base, kind: "root",
      note: "You're signed in as the root user. The recovery admin has to be an IAM user or role, so sign in as a separate admin (or your SSO admin) and check again."
    };
  }
  const role = arn.match(ASSUMED_ROLE_RE);
  if (role) {
    const [, partition, acct, roleName] = role;
    try {
      return { ...base, kind: "role", recoveryArn: await calls.roleArn(roleName) };
    } catch (e: any) {
      return {
        ...base, kind: "role", recoveryArn: `arn:${partition}:iam::${acct}:role/${roleName}`,
        note: `Couldn't look up this role's full path (${e?.message ?? e}). SSO roles have a path like role/aws-reserved/sso.amazonaws.com/…; the deploy check will tell you if this ARN is wrong.`
      };
    }
  }
  return { ...base, kind: "other" };
}

function credentialHelp(e: any): string {
  const msg = String(e?.message ?? e);
  if (/region is missing/i.test(msg)) {
    return `No AWS region is set. In a terminal run "aws configure" and set a default region such as us-east-1, then check again.`;
  }
  if (/credential|token|sso|signature/i.test(`${e?.name} ${msg}`)) {
    return `Couldn't sign in to AWS (${msg}). Sign in from a terminal, then check again. You can also fill everything in by hand.`;
  }
  return `AWS check failed: ${msg}`;
}

// Real SDK calls with the deploy's credential/region resolution: .env values
// (e.g. AWS_PROFILE) apply unless the shell already set them, exactly like
// `import "dotenv/config"` in preflight and the CDK app.
export function sdkCalls(env: NodeJS.ProcessEnv): AwsCalls {
  const config = () => ({ profile: env.AWS_PROFILE?.trim() || undefined, region: deployRegionFromEnv(env) });
  let stsClient: Promise<import("@aws-sdk/client-sts").STSClient> | undefined;
  let iamClient: Promise<import("@aws-sdk/client-iam").IAMClient> | undefined;
  const sts = () => (stsClient ??= import("@aws-sdk/client-sts").then(m => new m.STSClient(config())));
  const iam = () => (iamClient ??= import("@aws-sdk/client-iam").then(m => new m.IAMClient(config())));

  return {
    callerIdentity: async () => {
      const { GetCallerIdentityCommand } = await import("@aws-sdk/client-sts");
      return (await sts()).send(new GetCallerIdentityCommand({}));
    },
    region: async () => (await sts()).config.region(),
    roleArn: async (roleName) => {
      const { GetRoleCommand } = await import("@aws-sdk/client-iam");
      const r = await (await iam()).send(new GetRoleCommand({ RoleName: roleName }));
      return r.Role!.Arn!;
    },
    userNames: async () => {
      const { paginateListUsers } = await import("@aws-sdk/client-iam");
      const names: string[] = [];
      for await (const page of paginateListUsers({ client: await iam() }, {})) {
        for (const u of page.Users ?? []) if (u.UserName) names.push(u.UserName);
        if (names.length >= 200) break;
      }
      return names;
    }
  };
}

// Identity check for one named profile. Region doesn't matter for "who am
// I?", so a profile without one still gets checked.
async function sdkProbe(env: NodeJS.ProcessEnv, profile: string) {
  const { STSClient, GetCallerIdentityCommand } = await import("@aws-sdk/client-sts");
  const sts = new STSClient({ profile, region: deployRegionFromEnv(env) ?? "us-east-1" });
  return sts.send(new GetCallerIdentityCommand({}));
}

export const localAws: SetupAws = {
  profiles: localProfiles,
  probe: sdkProbe,
  whoami: env => whoami(sdkCalls(env))
};
