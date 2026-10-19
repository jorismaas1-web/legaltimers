import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dictionaries, detectLanguage, translate } from '../public/src/i18n.js';

const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test('NL and EN dictionaries have the same keys', () => {
  assert.deepEqual(Object.keys(dictionaries.en).sort(), Object.keys(dictionaries.nl).sort());
});

test('NL and EN strings use the same {placeholders}', () => {
  for (const key of Object.keys(dictionaries.nl)) {
    assert.deepEqual(placeholders(dictionaries.en[key]), placeholders(dictionaries.nl[key]), key);
  }
});

test('no string is empty', () => {
  for (const [lang, dict] of Object.entries(dictionaries)) {
    for (const [key, value] of Object.entries(dict)) {
      assert.ok(typeof value === 'string' && value.trim() !== '', `${lang}.${key}`);
    }
  }
});

test('detectLanguage picks NL for nl* and EN otherwise', () => {
  assert.equal(detectLanguage('nl-NL'), 'nl');
  assert.equal(detectLanguage('nl'), 'nl');
  assert.equal(detectLanguage('en-GB'), 'en');
  assert.equal(detectLanguage('de-DE'), 'en');
  assert.equal(detectLanguage(undefined), 'en');
});

test('translate falls back to EN, then to the key', () => {
  assert.equal(translate('fr', 'cancel'), dictionaries.en.cancel);
  assert.equal(translate('nl', 'no-such-key'), 'no-such-key');
});
