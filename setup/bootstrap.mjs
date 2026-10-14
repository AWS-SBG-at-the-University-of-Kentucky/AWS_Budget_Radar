// `npm run setup`: the one command to run after cloning.
//   1. checks Node.js is new enough
//   2. installs dependencies (fast no-op when already up to date)
//   3. creates .env from .env.example (never overwrites an existing .env)
//   4. starts the setup page (`npm run dev`) and opens it in your browser
// Node built-ins only, so it runs before `npm install`, on macOS, Linux and
// Windows alike.
import { copyFileSync, existsSync, constants } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MIN_NODE = 20;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const say = (line = "") => console.log(line && `  ${line}`);

function fail(lines) {
  console.error();
  for (const l of lines) console.error(`  ${l}`);
  console.error();
  process.exit(1);
}

// Re-use the npm that launched us (npm_execpath) so this works on Windows
// too, where spawning npm.cmd directly needs a shell.
function npm(args) {
  const viaNpm = process.env.npm_execpath;
  const r = viaNpm
    ? spawnSync(process.execPath, [viaNpm, ...args], { cwd: root, stdio: "inherit" })
    : spawnSync("npm", args, { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
  if (r.error) fail([`Couldn't run npm: ${r.error.message}`]);
  return r.status ?? 1;
}

say();
say("AWS Budget Radar setup");
say("──────────────────────");

const major = Number(process.versions.node.split(".")[0]);
if (major < MIN_NODE) {
  fail([
    `✖ Node.js ${process.versions.node} is too old. Budget Radar needs Node.js ${MIN_NODE} or newer.`,
    "  Install the LTS version from https://nodejs.org, open a new terminal, and run npm run setup again."
  ]);
}
say(`✔ Node.js ${process.versions.node}`);

say("… Installing dependencies (about a minute the first time, instant after that)");
// Errors only: deprecation warnings from test-tool dependencies are noise here.
if (npm(["install", "--no-audit", "--no-fund", "--loglevel=error"]) !== 0) {
  fail(["✖ npm install failed. Read the error above, fix it, and run npm run setup again."]);
}
say("✔ Dependencies installed");

const envPath = join(root, ".env");
if (existsSync(envPath)) {
  say("✔ Found your .env. The setup page loads it; nothing is overwritten until you click Save.");
} else {
  copyFileSync(join(root, ".env.example"), envPath, constants.COPYFILE_EXCL);
  say("✔ Created .env from .env.example");
}

say("… Starting the setup page");
process.exitCode = npm(["run", "dev"]);
