"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  assertRuntimeModeConfig,
  getArtifactDirectory
} = require("../config/runtime-mode");
const {
  POSTCARD_SCHEMA_VERSION,
  POSTCARD_SCOPE,
  POSTCARD_JSON_SCHEMA,
  assertValidPostcard
} = require("./schema");

const DEMO_HEADER = "DEMO FIELD NOTE - NOT REAL JUDGMENT";
const DEFAULT_CAN_SHOW = Object.freeze([
  "This node observed a CampaignClosed event or successful closeCampaign receipt.",
  "This field note records local observation, including peer messages this node saw.",
  "The submitter field records the address that submitted the close transaction."
]);
const DEFAULT_CANNOT_PROVE = Object.freeze([
  "This local note is not reputation, credentialing, governance approval, or global truth.",
  "It cannot prove what every oracle saw, only what this node observed.",
  "It does not prove durable operator economics or a committed payment design."
]);
const DEFAULT_ECONOMIC_DISCLOSURE = Object.freeze({
  phase_3_gate: "Phase 3+ reputation work is gated on committed operator payment design.",
  operator_payment_status: "The active v1 escrow flow does not implement operator bounty payouts.",
  escrow_payout_status: "PilotEscrow.closeCampaign() currently returns the campaign bounty to the recorded campaign recipient."
});

class PostcardPolicyError extends Error {
  constructor(message) {
    super(message);
    this.name = "PostcardPolicyError";
  }
}

function normalizeHex(value) {
  return typeof value === "string" ? value.toLowerCase() : value;
}

function assertBytes32(value, name) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(value || ""))) {
    throw new Error(`${name} must be a bytes32 hex string.`);
  }
}

function assertAddress(value, name) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(value || ""))) {
    throw new Error(`${name} must be an address hex string.`);
  }
}

function safeCampaignFileStem(campaignUid) {
  assertBytes32(campaignUid, "campaignUid");
  return normalizeHex(campaignUid).slice(2);
}

function resolvePostcardDirectory(runtimeConfig, options = {}) {
  if (options.outputDirectory) {
    return path.resolve(options.outputDirectory);
  }
  return path.resolve(runtimeConfig.postcardDirectory);
}

function assertPostcardRuntimePolicy(runtimeConfig, options = {}) {
  if (runtimeConfig.useTestPayload && runtimeConfig.runtimeMode !== "demo") {
    if (!options.routeTestPayloadToDemo) {
      throw new PostcardPolicyError(
        "Refusing postcard generation because USE_TEST_PAYLOAD=true outside demo mode. Set VENOM_RUNTIME_MODE=demo or pass routeTestPayloadToDemo for an explicitly demo-only artifact."
      );
    }

    return {
      ...runtimeConfig,
      runtimeMode: "demo",
      artifactDirectory: getArtifactDirectory("demo", runtimeConfig.artifactRoot),
      postcardDirectory: path.join(getArtifactDirectory("demo", runtimeConfig.artifactRoot), "postcards")
    };
  }

  return runtimeConfig;
}

function normalizeCloseObservation(closeObservation) {
  if (!closeObservation || closeObservation.observed !== true) {
    throw new PostcardPolicyError("Postcards require observed closeCampaign success evidence.");
  }
  if (!["transaction_receipt", "event_log"].includes(closeObservation.source)) {
    throw new PostcardPolicyError("close_observation.source must be transaction_receipt or event_log.");
  }
  if (!closeObservation.transaction_hash) {
    throw new PostcardPolicyError("close_observation.transaction_hash is required.");
  }
  if (!Number.isInteger(closeObservation.block_number) || closeObservation.block_number < 0) {
    throw new PostcardPolicyError("close_observation.block_number is required.");
  }

  return {
    observed: true,
    source: closeObservation.source,
    event_name: "CampaignClosed",
    transaction_hash: normalizeHex(closeObservation.transaction_hash),
    block_number: closeObservation.block_number,
    transaction_index: closeObservation.transaction_index,
    log_index: closeObservation.log_index,
    contract_address: normalizeHex(closeObservation.contract_address)
  };
}

function buildJudgmentCapsule(input = {}) {
  const scoreCount = Number.isInteger(input.score_count) ? input.score_count : 0;
  const abstainCount = Number.isInteger(input.abstain_count) ? input.abstain_count : 0;
  const medianScore = input.median_score === undefined ? null : input.median_score;

  return {
    summary: input.summary || "Quorum reached and this node observed the campaign close on-chain.",
    median_score: medianScore,
    score_count: scoreCount,
    abstain_count: abstainCount,
    can_show: input.can_show || [...DEFAULT_CAN_SHOW],
    cannot_prove: input.cannot_prove || [...DEFAULT_CANNOT_PROVE]
  };
}

function buildPostcard(input, options = {}) {
  assertBytes32(input.campaignUid, "campaignUid");
  assertAddress(input.submitter, "submitter");

  const initialRuntimeConfig = options.runtimeConfig || assertRuntimeModeConfig(options.env || process.env);
  const runtimeConfig = assertPostcardRuntimePolicy(initialRuntimeConfig, options);
  const closeObservation = normalizeCloseObservation(input.closeObservation);

  if (closeObservation.contract_address) {
    assertAddress(closeObservation.contract_address, "close_observation.contract_address");
  }

  const postcard = {
    schema_version: POSTCARD_SCHEMA_VERSION,
    generated_at: new Date(options.now || Date.now()).toISOString(),
    campaign_uid: normalizeHex(input.campaignUid),
    scope: POSTCARD_SCOPE,
    submitter: normalizeHex(input.submitter),
    local_operator: input.localOperator ? normalizeHex(input.localOperator) : undefined,
    runtime: {
      mode: runtimeConfig.runtimeMode,
      use_test_payload: Boolean(runtimeConfig.useTestPayload),
      artifact_directory: runtimeConfig.artifactDirectory,
      demo_header_required: runtimeConfig.runtimeMode === "demo"
    },
    close_observation: closeObservation,
    judgment_capsule: buildJudgmentCapsule(input.judgmentCapsule),
    economic_disclosure: {
      ...DEFAULT_ECONOMIC_DISCLOSURE,
      ...(input.economicDisclosure || {})
    }
  };

  if (runtimeConfig.runtimeMode === "demo") {
    postcard.demo_header = DEMO_HEADER;
  }

  return assertValidPostcard(postcard);
}

function renderList(items) {
  return items.map((item) => `- ${item}`).join("\n");
}

function renderMarkdown(postcard) {
  assertValidPostcard(postcard);

  const demoHeader = postcard.runtime.mode === "demo" ? `${DEMO_HEADER}\n\n` : "";
  const median = postcard.judgment_capsule.median_score === null || postcard.judgment_capsule.median_score === undefined
    ? "not recorded"
    : postcard.judgment_capsule.median_score;

  return `${demoHeader}# Campaign Postcard v1

## What This Can Show

${renderList(postcard.judgment_capsule.can_show)}

## What This Cannot Prove

${renderList(postcard.judgment_capsule.cannot_prove)}

## Field Note

- schema_version: "${postcard.schema_version}"
- scope: "${postcard.scope}"
- campaign_uid: ${postcard.campaign_uid}
- submitter: ${postcard.submitter}
- generated_at: ${postcard.generated_at}
- runtime_mode: ${postcard.runtime.mode}
- use_test_payload: ${postcard.runtime.use_test_payload}

## Observed Close

- source: ${postcard.close_observation.source}
- event: ${postcard.close_observation.event_name}
- transaction_hash: ${postcard.close_observation.transaction_hash}
- block_number: ${postcard.close_observation.block_number}
- contract_address: ${postcard.close_observation.contract_address || "not recorded"}

## Judgment Capsule

${postcard.judgment_capsule.summary}

- median_score: ${median}
- score_count: ${postcard.judgment_capsule.score_count}
- abstain_count: ${postcard.judgment_capsule.abstain_count}

## Economic Disclosure

- ${postcard.economic_disclosure.phase_3_gate}
- ${postcard.economic_disclosure.operator_payment_status}
- ${postcard.economic_disclosure.escrow_payout_status}

## Ephemerality

This postcard is a local, immutable field note. It is not a credential, ranking, governance approval, or portable reputation claim.
`;
}

async function assertNoExistingPostcard(paths) {
  for (const filePath of Object.values(paths)) {
    try {
      await fs.promises.access(filePath, fs.constants.F_OK);
      throw new PostcardPolicyError(`Postcard already exists and will not be overwritten: ${filePath}`);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
  }
}

async function writePostcard(postcard, options = {}) {
  assertValidPostcard(postcard);
  const runtimeConfig = options.runtimeConfig || assertRuntimeModeConfig(options.env || process.env);
  const effectiveRuntimeConfig = assertPostcardRuntimePolicy(runtimeConfig, options);
  const directory = resolvePostcardDirectory(effectiveRuntimeConfig, options);
  const stem = safeCampaignFileStem(postcard.campaign_uid);
  const paths = {
    json: path.join(directory, `${stem}.json`),
    markdown: path.join(directory, `${stem}.md`)
  };

  await fs.promises.mkdir(directory, { recursive: true });
  await assertNoExistingPostcard(paths);

  const json = `${JSON.stringify(postcard, null, 2)}\n`;
  const markdown = renderMarkdown(postcard);

  // Immutability guard: "wx" is exclusive create. Existing postcards are never modified.
  await fs.promises.writeFile(paths.json, json, { encoding: "utf8", flag: "wx" });
  await fs.promises.writeFile(paths.markdown, markdown, { encoding: "utf8", flag: "wx" });

  return { postcard, paths };
}

async function generatePostcard(input, options = {}) {
  const postcard = buildPostcard(input, options);
  return writePostcard(postcard, options);
}

function receiptToCloseObservation(receipt, fallback = {}) {
  if (!receipt || receipt.status === 0) {
    throw new PostcardPolicyError("Cannot generate postcard from a failed or missing closeCampaign receipt.");
  }

  return normalizeCloseObservation({
    observed: true,
    source: "transaction_receipt",
    event_name: "CampaignClosed",
    transaction_hash: receipt.hash || receipt.transactionHash || fallback.transaction_hash,
    block_number: Number(receipt.blockNumber ?? fallback.block_number),
    transaction_index: Number(receipt.index ?? receipt.transactionIndex ?? fallback.transaction_index ?? 0),
    contract_address: receipt.to || fallback.contract_address,
    ...fallback
  });
}

async function generatePostcardFromCloseReceipt(input, options = {}) {
  const closeObservation = receiptToCloseObservation(input.receipt, input.closeObservation);
  const submitter = input.submitter || input.receipt?.from;
  if (!submitter) {
    throw new PostcardPolicyError("submitter is required when generating a postcard from a closeCampaign receipt.");
  }

  return generatePostcard({
    campaignUid: input.campaignUid,
    submitter,
    localOperator: input.localOperator,
    closeObservation,
    judgmentCapsule: input.judgmentCapsule,
    economicDisclosure: input.economicDisclosure
  }, options);
}

module.exports = {
  DEMO_HEADER,
  DEFAULT_ECONOMIC_DISCLOSURE,
  POSTCARD_JSON_SCHEMA,
  PostcardPolicyError,
  buildPostcard,
  writePostcard,
  generatePostcard,
  generatePostcardFromCloseReceipt,
  receiptToCloseObservation,
  renderMarkdown,
  resolvePostcardDirectory
};
