import { test } from 'node:test';
import assert from 'node:assert/strict';
import { brandOf } from '../src/logos.js';

test('picks a logo from the account name unless one is chosen', () => {
  assert.equal(brandOf({ name: 'DKB Girokonto' }).id, 'dkb');
  assert.equal(brandOf({ name: 'PayPal' }).id, 'paypal');
  assert.equal(brandOf({ name: 'Kraken' }).id, 'kraken');
  assert.equal(brandOf({ name: 'Joint account' }), null);
  assert.equal(brandOf({ name: 'Joint account', brand: 'dkb' }).id, 'dkb');
  assert.equal(brandOf({ name: 'PayPal', brand: 'none' }), null);
});
