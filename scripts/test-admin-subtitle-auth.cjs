const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const source = fs.readFileSync(path.join(__dirname, "../src/lib/adminSubtitleRequestAuth.ts"), "utf8");
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText;
const exportsObject = {};
new Function("exports", js)(exportsObject);
const { isTrustedAdminWriteRequest } = exportsObject;
const head = values => new Headers(values);
const internal = "http://anime:3000";

test("Caddy external domain can make authenticated admin write requests", () => {
  assert.equal(isTrustedAdminWriteRequest(head({
    origin: "https://yjhmoon.iptime.org",
    host: "anime:3000",
    "x-forwarded-host": "yjhmoon.iptime.org",
    "sec-fetch-site": "same-origin",
  }), internal), true);
  assert.equal(isTrustedAdminWriteRequest(head({
    origin: "http://192.168.0.62:3020",
    host: "192.168.0.62:3020",
    "sec-fetch-site": "same-origin",
  }), internal), true);
});

test("Mutations from unrelated origins are blocked", () => {
  assert.equal(isTrustedAdminWriteRequest(head({
    origin: "https://unrelated.example",
    host: "anime:3000",
    "x-forwarded-host": "yjhmoon.iptime.org",
    "sec-fetch-site": "same-site",
  }), internal), false);
  assert.equal(isTrustedAdminWriteRequest(head({
    origin: "https://yjhmoon.iptime.org",
    host: "anime:3000",
    "x-forwarded-host": "yjhmoon.iptime.org",
    "sec-fetch-site": "cross-site",
  }), internal), false);
});

test("Same-site without matching origin is blocked", () => {
  assert.equal(isTrustedAdminWriteRequest(head({
    "sec-fetch-site": "same-site"
  }), internal), false);
  assert.equal(isTrustedAdminWriteRequest(head({
    "sec-fetch-site": "same-origin"
  }), internal), true);
});

test("Malformed or non-web origin cannot submit an admin mutation", () => {
  assert.equal(isTrustedAdminWriteRequest(head({
    origin: "null",
    host: "yjhmoon.iptime.org"
  }), internal), false);
  assert.equal(isTrustedAdminWriteRequest(head({
    origin: "file:///etc/passwd",
    host: "yjhmoon.iptime.org"
  }), internal), false);
});
