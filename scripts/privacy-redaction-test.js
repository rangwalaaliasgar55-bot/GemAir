'use strict';

const assert = require('assert');
const { redactSensitiveText } = require('../lib/privacy-redaction');

const result = redactSensitiveText('Email me at gem@example.com or call +91 98765 43210. Token: ghp_1234567890abcdef and card 4111 1111 1111 1111.');
assert.equal(result.redacted, true);
assert(result.categories.includes('email'));
assert(result.categories.includes('phone'));
assert(result.categories.includes('secret'));
assert(result.categories.includes('card'));
assert(!result.text.includes('gem@example.com'));
assert(!result.text.includes('ghp_1234567890abcdef'));
assert.equal(redactSensitiveText('A calm local note.').redacted, false);
console.log('privacy-redaction-test: all assertions passed');
