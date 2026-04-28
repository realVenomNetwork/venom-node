"use strict";

const POSTCARD_SCHEMA_VERSION = "postcard.v1";
const POSTCARD_SCOPE = "local_observation";

const POSTCARD_JSON_SCHEMA = Object.freeze({
  $id: "https://venom.local/schemas/postcard.v1.json",
  type: "object",
  required: [
    "schema_version",
    "campaign_uid",
    "scope",
    "runtime",
    "submitter",
    "close_observation",
    "judgment_capsule",
    "economic_disclosure"
  ],
  properties: {
    schema_version: { const: POSTCARD_SCHEMA_VERSION },
    campaign_uid: { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" },
    scope: { const: POSTCARD_SCOPE },
    runtime: {
      type: "object",
      required: ["mode", "use_test_payload", "artifact_directory"],
      properties: {
        mode: { enum: ["mainnet", "testnet", "demo"] },
        use_test_payload: { type: "boolean" },
        artifact_directory: { type: "string" },
        demo_header_required: { type: "boolean" }
      }
    },
    submitter: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" },
    close_observation: {
      type: "object",
      required: ["observed", "source", "transaction_hash", "block_number"],
      properties: {
        observed: { const: true },
        source: { enum: ["transaction_receipt", "event_log"] },
        event_name: { const: "CampaignClosed" },
        transaction_hash: { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" },
        block_number: { type: "integer", minimum: 0 },
        transaction_index: { type: "integer", minimum: 0 },
        log_index: { type: "integer", minimum: 0 },
        contract_address: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" }
      }
    },
    judgment_capsule: {
      type: "object",
      required: ["summary", "score_count", "abstain_count", "can_show", "cannot_prove"],
      properties: {
        summary: { type: "string", minLength: 1 },
        median_score: { type: ["integer", "null"], minimum: 0, maximum: 100 },
        score_count: { type: "integer", minimum: 0 },
        abstain_count: { type: "integer", minimum: 0 },
        can_show: { type: "array", items: { type: "string" }, minItems: 1 },
        cannot_prove: { type: "array", items: { type: "string" }, minItems: 1 }
      }
    },
    economic_disclosure: {
      type: "object",
      required: ["phase_3_gate", "operator_payment_status", "escrow_payout_status"],
      properties: {
        phase_3_gate: { type: "string", minLength: 1 },
        operator_payment_status: { type: "string", minLength: 1 },
        escrow_payout_status: { type: "string", minLength: 1 }
      }
    }
  }
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isHex(value, bytes) {
  return typeof value === "string" && new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`).test(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function validateStringList(value, pathName, errors) {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${pathName} must be a non-empty array.`);
    return;
  }
  value.forEach((item, index) => {
    if (!isNonEmptyString(item)) errors.push(`${pathName}[${index}] must be a non-empty string.`);
  });
}

function validatePostcard(postcard) {
  const errors = [];

  if (!isPlainObject(postcard)) {
    return { ok: false, errors: ["postcard must be an object."] };
  }

  if (postcard.schema_version !== POSTCARD_SCHEMA_VERSION) {
    errors.push(`schema_version must be ${POSTCARD_SCHEMA_VERSION}.`);
  }
  if (!isHex(postcard.campaign_uid, 32)) {
    errors.push("campaign_uid must be a bytes32 hex string.");
  }
  if (postcard.scope !== POSTCARD_SCOPE) {
    errors.push(`scope must be ${POSTCARD_SCOPE}.`);
  }

  if (!isPlainObject(postcard.runtime)) {
    errors.push("runtime must be an object.");
  } else {
    if (!["mainnet", "testnet", "demo"].includes(postcard.runtime.mode)) {
      errors.push("runtime.mode must be mainnet, testnet, or demo.");
    }
    if (typeof postcard.runtime.use_test_payload !== "boolean") {
      errors.push("runtime.use_test_payload must be boolean.");
    }
    if (!isNonEmptyString(postcard.runtime.artifact_directory)) {
      errors.push("runtime.artifact_directory must be a non-empty string.");
    }
    if (postcard.runtime.use_test_payload && postcard.runtime.mode !== "demo") {
      errors.push("USE_TEST_PAYLOAD=true postcards must be refused or written under demo mode.");
    }
  }

  if (!isHex(postcard.submitter, 20)) {
    errors.push("submitter must be an address hex string.");
  }

  if (!isPlainObject(postcard.close_observation)) {
    errors.push("close_observation must be an object.");
  } else {
    if (postcard.close_observation.observed !== true) {
      errors.push("close_observation.observed must be true.");
    }
    if (!["transaction_receipt", "event_log"].includes(postcard.close_observation.source)) {
      errors.push("close_observation.source must be transaction_receipt or event_log.");
    }
    if (postcard.close_observation.event_name !== "CampaignClosed") {
      errors.push("close_observation.event_name must be CampaignClosed.");
    }
    if (!isHex(postcard.close_observation.transaction_hash, 32)) {
      errors.push("close_observation.transaction_hash must be a transaction hash.");
    }
    if (!isNonNegativeInteger(postcard.close_observation.block_number)) {
      errors.push("close_observation.block_number must be a non-negative integer.");
    }
    if (postcard.close_observation.contract_address !== undefined && !isHex(postcard.close_observation.contract_address, 20)) {
      errors.push("close_observation.contract_address must be an address when present.");
    }
  }

  if (!isPlainObject(postcard.judgment_capsule)) {
    errors.push("judgment_capsule must be an object.");
  } else {
    if (!isNonEmptyString(postcard.judgment_capsule.summary)) {
      errors.push("judgment_capsule.summary must be a non-empty string.");
    }
    if (!isNonNegativeInteger(postcard.judgment_capsule.score_count)) {
      errors.push("judgment_capsule.score_count must be a non-negative integer.");
    }
    if (!isNonNegativeInteger(postcard.judgment_capsule.abstain_count)) {
      errors.push("judgment_capsule.abstain_count must be a non-negative integer.");
    }
    if (
      postcard.judgment_capsule.median_score !== null &&
      postcard.judgment_capsule.median_score !== undefined &&
      (!Number.isInteger(postcard.judgment_capsule.median_score) ||
        postcard.judgment_capsule.median_score < 0 ||
        postcard.judgment_capsule.median_score > 100)
    ) {
      errors.push("judgment_capsule.median_score must be null or an integer from 0 to 100.");
    }
    validateStringList(postcard.judgment_capsule.can_show, "judgment_capsule.can_show", errors);
    validateStringList(postcard.judgment_capsule.cannot_prove, "judgment_capsule.cannot_prove", errors);
  }

  if (!isPlainObject(postcard.economic_disclosure)) {
    errors.push("economic_disclosure must be an object.");
  } else {
    for (const key of ["phase_3_gate", "operator_payment_status", "escrow_payout_status"]) {
      if (!isNonEmptyString(postcard.economic_disclosure[key])) {
        errors.push(`economic_disclosure.${key} must be a non-empty string.`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

function assertValidPostcard(postcard) {
  const result = validatePostcard(postcard);
  if (!result.ok) {
    throw new Error(`Invalid postcard.v1 payload:\n- ${result.errors.join("\n- ")}`);
  }
  return postcard;
}

module.exports = {
  POSTCARD_SCHEMA_VERSION,
  POSTCARD_SCOPE,
  POSTCARD_JSON_SCHEMA,
  validatePostcard,
  assertValidPostcard
};
