#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const ROADMAP_VERSION = "roadmap.v1.6.1";
const VOCABULARY_VERSION = "vocabulary.v1.6.1";
const IGNORED_DIRS = new Set([".git", "node_modules", "artifacts", "cache", "_archive", "coverage", "tmp"]);
const REQUIRED_TERM_IDS = Object.freeze([
  "local_observation",
  "on_chain_state",
  "hypothetical_simulation",
  "runtime_mode",
  "test_payload",
  "demo_artifact",
  "mainnet_artifact",
  "testnet_artifact",
  "operator_card",
  "campaign_postcard",
  "judgment_capsule",
  "economic_disclosure",
  "dashboard_isolation",
  "redis_read_only_role"
]);

const checks = [];

function fail(message) {
  checks.push({ ok: false, message });
}

function pass(message) {
  checks.push({ ok: true, message });
}

function readJson(relativePath) {
  const absolutePath = path.join(ROOT, relativePath);
  return JSON.parse(fs.readFileSync(absolutePath, "utf8"));
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) {
        walk(path.join(dir, entry.name), out);
      }
      continue;
    }
    if (entry.isFile()) out.push(path.join(dir, entry.name));
  }
  return out;
}

function relative(file) {
  return path.relative(ROOT, file).replace(/\\/g, "/");
}

function readTextFiles() {
  return walk(ROOT).filter((file) => {
    const ext = path.extname(file).toLowerCase();
    return [".js", ".cjs", ".mjs", ".json", ".md", ".yml", ".yaml", ".txt"].includes(ext);
  }).map((file) => ({
    file,
    relative: relative(file),
    text: fs.readFileSync(file, "utf8")
  }));
}

function checkVocabulary() {
  const vocabulary = readJson("vocabulary/vocabulary.json");
  if (vocabulary.version !== VOCABULARY_VERSION) {
    fail(`vocabulary.json version must be ${VOCABULARY_VERSION}; received ${vocabulary.version || "missing"}`);
  }
  if (vocabulary.roadmap_version !== ROADMAP_VERSION) {
    fail(`vocabulary.json roadmap_version must be ${ROADMAP_VERSION}; received ${vocabulary.roadmap_version || "missing"}`);
  }

  const ids = new Set((vocabulary.terms || []).map((term) => term.id));
  for (const id of REQUIRED_TERM_IDS) {
    if (!ids.has(id)) fail(`vocabulary.json is missing required term id: ${id}`);
  }

  if (!checks.some((check) => !check.ok && check.message.includes("vocabulary.json"))) {
    pass("vocabulary.json version and required trust-boundary terms are locked");
  }
}

function checkRuntimeModeMatrix() {
  const runtimePath = path.join(ROOT, "src/config/runtime-mode.js");
  const registerPath = path.join(ROOT, "register_and_start.js");
  const runtime = require(runtimePath);

  const validCases = [
    { VENOM_RUNTIME_MODE: "mainnet", USE_TEST_PAYLOAD: "false" },
    { VENOM_RUNTIME_MODE: "testnet", USE_TEST_PAYLOAD: "true" },
    { VENOM_RUNTIME_MODE: "testnet", USE_TEST_PAYLOAD: "false" },
    { VENOM_RUNTIME_MODE: "demo", USE_TEST_PAYLOAD: "true" },
    { VENOM_RUNTIME_MODE: "demo", USE_TEST_PAYLOAD: "false" }
  ];
  const invalidCases = [
    { VENOM_RUNTIME_MODE: "mainnet", USE_TEST_PAYLOAD: "true" },
    { VENOM_RUNTIME_MODE: "demo" },
    { USE_TEST_PAYLOAD: "false" },
    { VENOM_RUNTIME_MODE: "production", USE_TEST_PAYLOAD: "false" }
  ];

  for (const env of validCases) {
    const result = runtime.validateRuntimeModeConfig(env);
    if (!result.ok) {
      fail(`runtime matrix rejected valid case ${JSON.stringify(env)}: ${result.errors.join("; ")}`);
    }
  }

  for (const env of invalidCases) {
    const result = runtime.validateRuntimeModeConfig(env);
    if (result.ok) {
      fail(`runtime matrix accepted invalid case ${JSON.stringify(env)}`);
    }
  }

  const registerText = fs.readFileSync(registerPath, "utf8");
  if (!registerText.includes("assertRuntimeModeConfig")) {
    fail("register_and_start.js must call assertRuntimeModeConfig before startup");
  }

  if (!registerText.includes("src/config/runtime-mode")) {
    fail("register_and_start.js must use the shared runtime-mode module");
  }

  if (!checks.some((check) => !check.ok && check.message.includes("runtime matrix"))) {
    pass("VENOM_RUNTIME_MODE + USE_TEST_PAYLOAD matrix is enforced");
  }
}

async function checkRedisAclSentinel() {
  const sentinelPath = path.join(ROOT, "dashboard/redis-acl-sentinel.js");
  if (!fs.existsSync(sentinelPath)) {
    fail("dashboard Redis ACL sentinel module is missing");
    return;
  }

  const { assertRedisReadOnlyConnection } = require(sentinelPath);
  const readOnlyResult = await assertRedisReadOnlyConnection({
    set: async () => {
      throw new Error("NOPERM this user has no permissions to run the SET command");
    }
  });
  if (!readOnlyResult.ok || !readOnlyResult.readOnly) {
    fail("dashboard Redis ACL sentinel did not accept a read-only Redis connection");
  }

  let writableRejected = false;
  try {
    await assertRedisReadOnlyConnection({ set: async () => "OK" });
  } catch (error) {
    writableRejected = /writable/i.test(error.message);
  }

  if (!writableRejected) {
    fail("dashboard Redis ACL sentinel must reject a writable Redis connection");
  }

  const sentinelText = fs.readFileSync(sentinelPath, "utf8");
  if (!sentinelText.includes("venom_dash")) {
    fail("dashboard Redis ACL sentinel error must name the venom_dash read-only role");
  }

  if (!checks.some((check) => !check.ok && check.message.includes("Redis ACL sentinel"))) {
    pass("Redis ACL read-only startup sentinel rejects writable dashboard connections");
  }
}

function checkCarefulWitnessUsage(files) {
  const phrase = ["careful", "witness"].join(" ");
  const pattern = new RegExp(phrase, "gi");
  const occurrences = [];

  for (const item of files) {
    if (item.relative === "vocabulary/vocabulary.json") continue;
    const matches = item.text.match(pattern);
    if (matches) {
      occurrences.push({ file: item.relative, count: matches.length });
    }
  }

  const total = occurrences.reduce((sum, item) => sum + item.count, 0);
  const readmeOnly = occurrences.length === 1 && occurrences[0].file === "README.md";

  if (total !== 1 || !readmeOnly) {
    fail(`product-language anchor phrase must appear exactly once in README.md outside vocabulary.json; found ${total}: ${JSON.stringify(occurrences)}`);
    return;
  }

  pass("product-language anchor phrase usage is locked to README.md");
}

function checkPostcardPolicy(files) {
  const jsFiles = files.filter((item) => [".js", ".cjs", ".mjs"].includes(path.extname(item.file).toLowerCase()));

  for (const item of jsFiles) {
    const isPostcardWriter = item.relative.includes("postcard") ||
      /postcard\.v1|Campaign Postcard|campaign postcard/i.test(item.text);
    if (!isPostcardWriter) continue;

    const writesPostcard = /writeFile(?:Sync)?\s*\(/.test(item.text) || /open(?:Sync)?\s*\([^)]*["']wx["']/.test(item.text);
    if (!writesPostcard) continue;

    if (!/flag\s*:\s*["']wx["']|["']wx["']/.test(item.text)) {
      fail(`${item.relative} writes postcards without exclusive-create immutability (flag: "wx")`);
    }
    if (!/\bsubmitter\b/.test(item.text)) {
      fail(`${item.relative} writes postcards without a submitter field`);
    }
    if (!/closeCampaign|CampaignClosed|closed on-chain|receipt/i.test(item.text)) {
      fail(`${item.relative} writes postcards without an on-chain close success marker`);
    }
  }

  for (const item of files) {
    if (!/schema_version\s*["']?\s*:\s*["']postcard\.v1["']/.test(item.text)) continue;
    if (!/\bsubmitter\b/.test(item.text)) {
      fail(`${item.relative} defines postcard.v1 without submitter`);
    }
    if (!/local_observation/.test(item.text)) {
      fail(`${item.relative} defines postcard.v1 without scope: local_observation`);
    }
  }

  if (!checks.some((check) => !check.ok && check.message.includes("postcard"))) {
    pass("postcard immutability, submitter, and on-chain close policy checks are active");
  }
}

async function main() {
  const files = readTextFiles();
  checkVocabulary();
  checkRuntimeModeMatrix();
  await checkRedisAclSentinel();
  checkCarefulWitnessUsage(files);
  checkPostcardPolicy(files);

  for (const check of checks) {
    console.log(`${check.ok ? "PASS" : "FAIL"} ${check.message}`);
  }

  const failures = checks.filter((check) => !check.ok);
  if (failures.length) {
    console.error(`\nroadmap:check failed with ${failures.length} issue(s).`);
    process.exit(1);
  }

  console.log(`\nroadmap:check passed for ${ROADMAP_VERSION}.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
