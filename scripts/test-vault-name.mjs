import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const source = readFileSync(new URL('../src/services/vault-name.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
const exports = {};
new Function('exports', compiled)(exports);
const {portableVaultNamesMatch} = exports;

test('settings handoff retains case-insensitive NFC vault identity', () => {
  for (const [a,b] of [['QA Vault + 100%','qa vault + 100%'],['Café','Cafe\u0301'],['日本語 🧪','日本語 🧪']]) {
    assert.equal(portableVaultNamesMatch(a,b),true);
  }
  assert.equal(portableVaultNamesMatch('QA Vault','Different vault'),false);
});

test('settings handoff rejects malformed or oversized names before comparison', () => {
  for(const invalid of [null,undefined,42,{},'', ' QA', 'QA ', '\u200bQA','QA\u200b', '\ufeffQA', 'QA\ufeff', 'QA\nVault','QA\u0085Vault','QA\u2028Vault','QA\ud800','QA\udfff','a'.repeat(257),'é'.repeat(129)]) {
    assert.equal(portableVaultNamesMatch(invalid,invalid),false,String(invalid));
  }
  assert.equal(portableVaultNamesMatch('é'.repeat(128),'é'.repeat(128)),true);
});
