#!/usr/bin/env node
// test-gpt-approval-evidence.mjs — Unit test cho review-contract evidence/authority functions (Issue #38)
// + integration trực tiếp verifyGptEvidence (không mock override). Verify:
//   parseGptEvidenceArtifact, validateGptEvidenceBind, isReviewerAuthorized, GPT_EVIDENCE_PREFIX,
//   và verifier REAL (authority allowlist, bind exact, self-author rejection).
// Đăng ký trong scripts/full-verify.mjs optionalSuites + package.json test:gpt-approval.

import { defaultIo } from './gpt-approval.mjs';
import {
  GPT_EVIDENCE_PREFIX, parseGptEvidenceArtifact, validateGptEvidenceBind, isReviewerAuthorized,
} from './review-contract.mjs';

const results = [];
const eq = (name, got, want) => results.push({ name, ok: got === want, got, want });
const tru = (name, got) => results.push({ name, ok: Boolean(got), got });
const incl = (name, s, needle) => results.push({ name, ok: String(s).includes(needle), got: s, want: needle });

const SHA = 'a'.repeat(40);
const DIGEST = 'b'.repeat(64);
const RDIGEST = 'c'.repeat(64);
const POLICY_VERSION = '2026-08-23.7';

function artifact(overrides = {}) {
  return {
    schemaVersion: '1.0', repository: 'o/r', prNumber: 7, headSha: SHA,
    policyVersion: POLICY_VERSION, policyDigest: DIGEST, decision: 'approve',
    reviewDigest: RDIGEST, issuer: 'gpt-account', issuedAt: '2026-09-01T10:00:00Z',
    decisionId: 'evidence-dec-001', nonce: 'n-1',
    ...overrides,
  };
}
const body = (obj) => `<!-- ${GPT_EVIDENCE_PREFIX}${JSON.stringify(obj)} -->`;

const EXPECTED = { repository: 'o/r', prNumber: 7, headSha: SHA, policyVersion: POLICY_VERSION, policyDigest: DIGEST, decisionId: 'evidence-dec-001' };
const EVIDENCE_OPTS = { gptApprovers: ['user', 'gpt-account'], gptAuthorities: ['gpt-account'], headSha: SHA, policyVersion: POLICY_VERSION, actorSelf: 'bo', policyDigest: DIGEST, decisionId: 'evidence-dec-001' };
const URL = 'https://github.com/o/r/issues/7#issuecomment-123';

// real verify (bind listPrComments qua `this`)
const realVerify = defaultIo().verifyGptEvidence;
function verifyWith(comments, gptEvidence, opts) {
  return realVerify.call({ listPrComments: () => comments }, 'o/r', 7, gptEvidence, opts || EVIDENCE_OPTS);
}

// ------------------------------------------------------------- GPT_EVIDENCE_PREFIX
eq('prefix constant', GPT_EVIDENCE_PREFIX, 'ai-pr-reviewer:gpt-evidence:');

// ------------------------------------------------------------- parseGptEvidenceArtifact
{
  const p = parseGptEvidenceArtifact(body(artifact()));
  tru('parse valid', p && p.decisionId === 'evidence-dec-001' && p.repository === 'o/r');
  eq('parse non-artifact → null', parseGptEvidenceArtifact('no artifact here'), null);
  eq('parse malformed JSON → null', parseGptEvidenceArtifact(`<!-- ${GPT_EVIDENCE_PREFIX}{bad json -->`), null);
  eq('parse empty body → null', parseGptEvidenceArtifact(''), null);
}

// ------------------------------------------------------------- validateGptEvidenceBind
{
  eq('bind all-ok', validateGptEvidenceBind(artifact(), EXPECTED).ok, true);
  const missing = validateGptEvidenceBind(artifact({ nonce: '' }), EXPECTED);
  eq('bind missing field → fail', missing.ok, false);
  incl('bind missing field msg', missing.error, 'thiếu trường nonce');
  eq('bind wrong decision → fail', validateGptEvidenceBind(artifact({ decision: 'request-changes' }), EXPECTED).ok, false);
  eq('bind bad headSha → fail', validateGptEvidenceBind(artifact({ headSha: 'xyz' }), EXPECTED).ok, false);
  eq('bind bad policyDigest → fail', validateGptEvidenceBind(artifact({ policyDigest: 'short' }), EXPECTED).ok, false);
  eq('bind bad reviewDigest → fail', validateGptEvidenceBind(artifact({ reviewDigest: 'short' }), EXPECTED).ok, false);
  eq('bind decisionId whitespace → fail', validateGptEvidenceBind(artifact({ decisionId: 'has space' }), EXPECTED).ok, false);
  eq('bind bad issuedAt → fail', validateGptEvidenceBind(artifact({ issuedAt: 'not-a-date' }), EXPECTED).ok, false);
  eq('bind repo mismatch → fail', validateGptEvidenceBind(artifact({ repository: 'x/y' }), EXPECTED).ok, false);
  eq('bind pr mismatch → fail', validateGptEvidenceBind(artifact({ prNumber: 99 }), EXPECTED).ok, false);
  eq('bind head mismatch → fail', validateGptEvidenceBind(artifact({ headSha: SHA.replace('a', 'b') }), EXPECTED).ok, false);
  eq('bind policyVersion mismatch → fail', validateGptEvidenceBind(artifact({ policyVersion: '9.9.9' }), EXPECTED).ok, false);
  eq('bind policyDigest mismatch → fail', validateGptEvidenceBind(artifact({ policyDigest: DIGEST.replace('b', 'c') }), EXPECTED).ok, false);
  eq('bind decisionId mismatch → fail', validateGptEvidenceBind(artifact({ decisionId: 'other-dec' }), EXPECTED).ok, false);
}

// ------------------------------------------------------------- isReviewerAuthorized (pure)
{
  eq('authority ok', isReviewerAuthorized({ authorLogin: 'gpt-account', issuer: 'gpt-account', reviewerAuthorities: ['gpt-account'], actorSelf: 'bo' }).ok, true);
  const unconf = isReviewerAuthorized({ authorLogin: 'gpt-account', issuer: 'gpt-account', reviewerAuthorities: [], actorSelf: 'bo' });
  eq('authority empty list → fail', unconf.ok, false);
  incl('authority empty list code', unconf.reason, 'MANUAL_REVIEWER_AUTHORITY_UNCONFIGURED');
  const notIn = isReviewerAuthorized({ authorLogin: 'gpt-account', issuer: 'gpt-account', reviewerAuthorities: ['other'], actorSelf: 'bo' });
  eq('authority not allowed → fail', notIn.ok, false);
  incl('authority not allowed code', notIn.reason, 'MANUAL_GPT_AUTHOR_NOT_ALLOWLISTED');
  const selfAuth = isReviewerAuthorized({ authorLogin: 'gpt-account', issuer: 'gpt-account', reviewerAuthorities: ['gpt-account'], actorSelf: 'gpt-account' });
  eq('authority self-author → fail', selfAuth.ok, false);
  incl('authority self-author code', selfAuth.reason, 'MANUAL_GPT_SELF_AUTHORED');
  const issuerMismatch = isReviewerAuthorized({ authorLogin: 'gpt-account', issuer: 'other', reviewerAuthorities: ['gpt-account'], actorSelf: 'bo' });
  eq('authority issuer mismatch → fail', issuerMismatch.ok, false);
}

// ------------------------------------------------------------- real verifyGptEvidence
const goodComments = [{ id: '123', user: { login: 'gpt-account' }, body: body(artifact()) }];
{
  const r = verifyWith(goodComments, { url: URL, commentId: '123' });
  tru('verify happy', r && r.decisionId === 'evidence-dec-001' && r.authorLogin === 'gpt-account' && r.issuer === 'gpt-account');
  eq('verify head lowercased', r.headSha, SHA);
  eq('verify policyDigest from artifact', r.policyDigest, DIGEST);
}
{
  let threw = null;
  try { verifyWith(goodComments, { url: URL, commentId: '123' }, { ...EVIDENCE_OPTS, gptAuthorities: ['other-principal'] }); } catch (e) { threw = e; }
  tru('verify not-allowed throws', threw);
  incl('verify not-allowed code', threw && threw.message, 'MANUAL_GPT_AUTHOR_NOT_ALLOWLISTED');
}
{
  let threw = null;
  try { verifyWith(goodComments, { url: URL, commentId: '123' }, { ...EVIDENCE_OPTS, gptAuthorities: [] }); } catch (e) { threw = e; }
  tru('verify unconfigured throws', threw);
  incl('verify unconfigured code', threw && threw.message, 'MANUAL_REVIEWER_AUTHORITY_UNCONFIGURED');
}
{
  let threw = null;
  try { verifyWith(goodComments, { url: URL, commentId: '123' }, { ...EVIDENCE_OPTS, actorSelf: 'gpt-account' }); } catch (e) { threw = e; }
  tru('verify self-author throws', threw);
  incl('verify self-author code', threw && threw.message, 'MANUAL_GPT_SELF_AUTHORED');
}
{
  let threw = null;
  try { verifyWith([{ id: '123', user: { login: 'gpt-account' }, body: body(artifact({ decisionId: 'other-dec' })) }], { url: URL, commentId: '123' }); } catch (e) { threw = e; }
  tru('verify decisionId bind throws', threw);
  incl('verify decisionId bind msg', threw && threw.message, 'decisionId');
}
{
  let threw = null;
  try { verifyWith([{ id: '123', user: { login: 'gpt-account' }, body: 'no artifact' }], { url: URL, commentId: '123' }); } catch (e) { threw = e; }
  tru('verify malformed throws', threw);
}
{
  let threw = null;
  try { verifyWith(goodComments, { url: URL, commentId: '999' }); } catch (e) { threw = e; }
  tru('verify commentId mismatch throws', threw);
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log((r.ok ? 'PASS ' : 'FAIL ') + r.name);
console.log('Total: ' + (results.length - failed.length) + '/' + results.length + ' PASS');
process.exit(failed.length ? 1 : 0);

