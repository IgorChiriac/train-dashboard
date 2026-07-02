// Bakes API keys from GitHub Actions secrets into the deployed trains.js so
// the train radar works with zero per-device setup. Run before the Firebase
// deploy step with GEOPS_KEY / TEDP_TOKEN in the environment.
//
// Note: anything injected here ends up in the public page source. Both keys
// are free-tier, per-user tokens — acceptable for a personal dashboard.
//
// An empty or missing secret leaves its placeholder untouched, so the page
// falls back to asking for that key in the browser (localStorage).
const fs = require("fs");

const path = "public/trains.js";
let src = fs.readFileSync(path, "utf8");

function inject(constName, value) {
  if (!value) return false;
  const needle = `const ${constName} = ""`;
  if (!src.includes(needle)) throw new Error(`placeholder not found: ${needle}`);
  src = src.replace(needle, `const ${constName} = ${JSON.stringify(value)}`);
  return true;
}

const geops = inject("GEOPS_KEY_CONST", process.env.GEOPS_KEY);
const otd = inject("OTD_KEY_CONST", process.env.TEDP_TOKEN);
fs.writeFileSync(path, src);
console.log(`inject-keys: geops=${geops} otd=${otd}`);
