'use strict';

const { expect } = require('chai');
const { validatePostcard } = require('../src/postcard/schema');
const {
  DEFAULT_ECONOMIC_DISCLOSURE,
  buildPostcard,
  renderMarkdown,
} = require('../src/postcard');

const VALID_BASE_INPUT = {
  campaignUid: `0x${'a'.repeat(64)}`,
  submitter: `0x${'b'.repeat(40)}`,
  closeObservation: {
    observed: true,
    source: 'transaction_receipt',
    transaction_hash: `0x${'c'.repeat(64)}`,
    block_number: 123456,
    contract_address: `0x${'d'.repeat(40)}`,
  },
};

const RUNTIME_OPTS = {
  runtimeConfig: {
    runtimeMode: 'testnet',
    useTestPayload: false,
    artifactRoot: '/tmp/venom-artifacts',
    artifactDirectory: '/tmp/venom-artifacts/testnet',
    postcardDirectory: '/tmp/venom-artifacts/testnet/postcards',
  },
};

describe('postcard not_in_scope', function () {
  it('default generator output includes a non-empty not_in_scope array', function () {
    const postcard = buildPostcard(VALID_BASE_INPUT, RUNTIME_OPTS);
    expect(postcard.economic_disclosure.not_in_scope).to.be.an('array').that.is.not.empty;
    expect(postcard.economic_disclosure.not_in_scope)
      .to.deep.equal([...DEFAULT_ECONOMIC_DISCLOSURE.not_in_scope]);
  });

  it('postcards without not_in_scope still validate', function () {
    const postcard = buildPostcard(VALID_BASE_INPUT, RUNTIME_OPTS);
    delete postcard.economic_disclosure.not_in_scope;

    const result = validatePostcard(postcard);

    expect(result.ok, JSON.stringify(result.errors)).to.equal(true);
  });

  it('rejects an empty not_in_scope array', function () {
    const postcard = buildPostcard(VALID_BASE_INPUT, RUNTIME_OPTS);
    postcard.economic_disclosure.not_in_scope = [];

    const result = validatePostcard(postcard);

    expect(result.ok).to.equal(false);
    expect(result.errors.join(' ')).to.match(/not_in_scope/);
  });

  it('rejects an empty string in not_in_scope', function () {
    const postcard = buildPostcard(VALID_BASE_INPUT, RUNTIME_OPTS);
    postcard.economic_disclosure.not_in_scope = ['valid string', '   '];

    const result = validatePostcard(postcard);

    expect(result.ok).to.equal(false);
    expect(result.errors.join(' ')).to.match(/not_in_scope\[1\]/);
  });

  it('user-provided not_in_scope overrides the default', function () {
    const postcard = buildPostcard({
      ...VALID_BASE_INPUT,
      economicDisclosure: { not_in_scope: ['custom canary boundary'] },
    }, RUNTIME_OPTS);

    expect(postcard.economic_disclosure.not_in_scope).to.deep.equal(['custom canary boundary']);
  });

  it('markdown renderer includes an Out of Scope section when present', function () {
    const postcard = buildPostcard(VALID_BASE_INPUT, RUNTIME_OPTS);
    const markdown = renderMarkdown(postcard);

    expect(markdown).to.include('## Out of Scope');
    for (const item of postcard.economic_disclosure.not_in_scope) {
      expect(markdown).to.include(`- ${item}`);
    }
  });

  it('markdown renderer omits Out of Scope when not_in_scope is missing', function () {
    const postcard = buildPostcard(VALID_BASE_INPUT, RUNTIME_OPTS);
    delete postcard.economic_disclosure.not_in_scope;

    const markdown = renderMarkdown(postcard);

    expect(markdown).to.not.include('## Out of Scope');
    expect(markdown).to.include('## Ephemerality');
  });
});
