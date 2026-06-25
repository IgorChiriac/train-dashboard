// Preloaded via NODE_OPTIONS=--require in the Firebase deploy steps.
//
// Works around a Node 22/24 keep-alive bug where node-fetch/gaxios throw
//   "Invalid response body ... oauth2/v4/token: Premature close"
// during the Firebase service-account token exchange (google-auth-library ->
// gtoken -> gaxios). Since Node 19 the global HTTP(S) agent defaults to
// keepAlive:true, and reused sockets intermittently drop the response body.
//
// Disabling keep-alive forces a fresh "Connection: close" socket per request —
// the same remedy firebase-tools#10697 applies to its own client, but here it
// also covers the auth library that firebase-tools doesn't control.
const http = require("http");
const https = require("https");

for (const mod of [http, https]) {
  if (mod.globalAgent) {
    mod.globalAgent.keepAlive = false;
    if (mod.globalAgent.options) mod.globalAgent.options.keepAlive = false;
  }
}
