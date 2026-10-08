const { readdirSync } = require("node:fs");
const { join } = require("node:path");
const { execFileSync } = require("node:child_process");
function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((f) =>
    f.isDirectory() ? files(join(dir, f.name)) : [join(dir, f.name)],
  );
}
const source = [
  "server.js",
  "public/appearance.js",
  ...files("server"),
  ...files("public/js"),
].filter((f) => /\.(js|mjs|cjs)$/.test(f));
for (const file of source)
  execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
console.log(
  `Checked ${source.length} source files. Native modules are ready to serve; no bundle is required.`,
);
