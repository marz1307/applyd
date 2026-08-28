#!/usr/bin/env node
/**
 * match.test.mjs — guards the response-matcher.
 *
 * This module can mark a live application dead, so the properties that matter
 * most are the negative ones: what it must REFUSE to auto-apply.
 */

import {
  classify, findCandidates, propose, isAutoAppliable, needsAttention, tokens, companyIn, isRelay, isDiscriminating,
  brandSegments,
} from './match.mjs';

let pass = 0, fail = 0;
const ok = (cond, label) => cond ? (pass++, console.log(`  ok   ${label}`))
                                 : (fail++, console.log(`  FAIL ${label}`));

const ROWS = [
  { application_id: 'APP-1', id: 'p1', title: 'Acme',        stage: '4. Applied' },
  { application_id: 'APP-2', id: 'p2', title: 'Abound',      stage: '4. Applied' },
  { application_id: 'APP-3', id: 'p3', title: 'Vinco',       stage: '4. Applied' },
  { application_id: 'APP-4', id: 'p4', title: 'Vinco',       stage: '6. Phone screen' },
  { application_id: 'APP-5', id: 'p5', title: 'ElevenLabs',  stage: '3. Drafted' },  // never sent
  { application_id: 'APP-6', id: 'p6', title: 'Spotify',     stage: 'Rejected' },    // closed
];

console.log('\nclassification');
ok(classify({ subject: 'Update', body: 'Unfortunately we will not be moving forward.' }).kind === 'rejection',
   'plain rejection');
ok(classify({ subject: 'Absage', body: 'Wir haben uns leider anders entschieden.' }).kind === 'rejection',
   'German rejection (leider / Absage)');
ok(classify({ subject: 'Next steps', body: 'We would like to invite you to a first-stage call.' }).kind === 'interview',
   'interview invite');
ok(classify({ subject: 'Your take-home', body: 'Please complete the HackerRank assessment.' }).kind === 'assessment',
   'assessment');
ok(classify({ subject: 'We got your application!', body: 'Thanks for applying.' }).kind === 'confirmation',
   'confirmation');
ok(classify({ subject: 'Newsletter', body: 'Jobs you might like this week.' }).kind === 'other',
   'unrelated mail is other, not a false rejection');

// A rejection that mentions interviewing must not be read as an invite. This is
// the single most damaging misclassification available to the module.
ok(classify({ subject: 'Your application',
              body: 'Unfortunately we will not be progressing to interview on this occasion.' }).kind === 'rejection',
   'rejection mentioning "interview" still classifies as rejection');

console.log('\nmatching');
ok(findCandidates({ sender: 'no-reply@greenhouse.io', senderName: 'Acme', subject: 'x' }, ROWS)
     .hits.length === 1,
   'ATS relay: employer recovered from display name');
ok(findCandidates({ sender: 'careers@acme.de', senderName: '', subject: 'x' }, ROWS)
     .hits.length === 1,
   'non-relay: employer recovered from domain');
ok(findCandidates({ sender: 'x@y.com', senderName: '', subject: 'Your application at Abound' }, ROWS)
     .hits.length === 1,
   'employer recovered from subject');
ok(findCandidates({ sender: 'no-reply@greenhouse.io', senderName: 'ElevenLabs', subject: 'x' }, ROWS)
     .hits.length === 0,
   'Stage-3 row is NOT respondable — never submitted, so no reply can belong to it');
ok(findCandidates({ sender: 'no-reply@greenhouse.io', senderName: 'Spotify', subject: 'x' }, ROWS)
     .hits.length === 0,
   'already-Rejected row is not a candidate');
ok(findCandidates({ sender: 'no-reply@greenhouse.io', senderName: 'Vinco', subject: 'x' }, ROWS)
     .hits.length === 2,
   'two live rows at one company are both surfaced');

console.log('\nsubstring safety');
ok(!companyIn('Finnair Cabin Crew', tokens('Finn')), 'Finn does not match inside Finnair');
ok(!companyIn('Aboundant Health', tokens('Abound')), 'Abound does not match inside Aboundant');
ok(companyIn('Acme SE Recruiting', tokens('Acme')), 'legal suffix and boilerplate ignored');
ok(isRelay('no-reply@eu.greenhouse-mail.io') && !isRelay('careers@acme.de'),
   'relay detection separates ATS from employer domains');

// Real false-positive shape: a company name that reduces to a single generic
// token (["data"]) matches nearly every subject line in a data-jobs pipeline.
console.log('\ngeneric-name guard');
const GENERIC_ROWS = [
  { application_id: 'APP-G', id: 'g1', title: 'Data-Talent GmbH', stage: '4. Applied' },
  { application_id: 'APP-H', id: 'g2', title: 'Delivery Hero',    stage: '4. Applied' },
];
ok(findCandidates({ sender: 'no-reply@eagle.org', senderName: 'ABS Careers',
                    subject: 'Your recent job application for Junior Data Scientist' },
                  GENERIC_ROWS).hits.length === 0,
   'company reducing to ["data"] never matches on a generic subject');
ok(findCandidates({ sender: 'x@y.com', senderName: 'Delivery Hero', subject: 'x' },
                  GENERIC_ROWS).hits.length === 1,
   'a name with a distinctive token still matches normally');
ok(isDiscriminating(tokens('Delivery Hero')) && !isDiscriminating(tokens('Data-Talent GmbH')),
   'isDiscriminating separates real names from industry boilerplate');

console.log('\nconfirmations reach Drafted rows');
const DRAFTED = [{ application_id: 'APP-D', id: 'd1', title: 'Acme', stage: '3. Drafted' }];
ok(propose({ id: 'c1', sender: 'no-reply@greenhouse.io', senderName: 'Acme',
             subject: 'We got your application!', body: '' }, DRAFTED).confidence === 'high',
   'confirmation matches a row still at Drafted — that is the missing 3->4 evidence');
ok(propose({ id: 'c2', sender: 'no-reply@greenhouse.io', senderName: 'Acme',
             subject: 'Update', body: 'Unfortunately not moving forward.' }, DRAFTED).confidence === 'unmatched',
   'a REJECTION still cannot match a Drafted row — it was never sent');

console.log('\nproposals and the auto-apply gate');
// A row filed under a sub-brand never contains all its tokens in mail from the
// parent brand; parent-brand rejections must still match the sub-brand row.
const SUBBRAND = [{ application_id: 'APP-Q', id: 'q1', title: 'QuantumBlack, AI by McKinsey', stage: '4. Applied' }];
ok(findCandidates({ sender: 'mckinsey_recruiting@mckinsey.com', senderName: 'McKinsey Recruiting',
                    subject: 'Update on your application with McKinsey & Company' }, SUBBRAND).hits.length === 1,
   'parent-brand mail matches a sub-brand row');
ok(JSON.stringify(brandSegments('QuantumBlack, AI by McKinsey')) === '[["quantumblack"],["mckinsey"]]',
   'the generic "AI" segment is dropped and can never carry a match alone');
ok(brandSegments('Acme').length === 1, 'a single-name company yields one segment');

// The rescue runs ONLY on an empty strict result, so it can add matches but
// never change one.
const MIXED = [
  { application_id: 'APP-S', id: 's1', title: 'Acme', stage: '4. Applied' },
  { application_id: 'APP-T', id: 't1', title: 'QuantumBlack, AI by McKinsey', stage: '4. Applied' },
];
const strictHit = findCandidates({ sender: 'x@y.com', senderName: 'Acme', subject: 'Your application' }, MIXED);
ok(strictHit.hits.length === 1 && strictHit.hits[0].row.application_id === 'APP-S',
   'a strict match is not widened by the rescue pass');

const rej = propose({ id: 'm1', sender: 'no-reply@greenhouse.io', senderName: 'Acme',
                      subject: 'Your application', body: 'Unfortunately, not moving forward.' }, ROWS);
ok(rej.confidence === 'high' && isAutoAppliable(rej), 'unambiguous rejection is auto-appliable');

const amb = propose({ id: 'm2', sender: 'no-reply@greenhouse.io', senderName: 'Vinco',
                      subject: 'Your application', body: 'Unfortunately, not moving forward.' }, ROWS);
ok(amb.confidence === 'ambiguous' && !isAutoAppliable(amb),
   'rejection matching two rows is NOT auto-appliable');

const inv = propose({ id: 'm3', sender: 'no-reply@greenhouse.io', senderName: 'Acme',
                      subject: 'Next steps', body: 'We would like to invite you to a call.' }, ROWS);
ok(inv.confidence === 'high' && !isAutoAppliable(inv),
   'interview invite is NEVER auto-applied even when unambiguous');

const conf = propose({ id: 'm4', sender: 'no-reply@greenhouse.io', senderName: 'Acme',
                       subject: 'We got your application!', body: 'Thanks for applying.' }, ROWS);
ok(isAutoAppliable(conf),
   'unambiguous confirmation IS auto-applied — it records a submission that already happened');

// Two live roles at one employer, and nothing in the message says which one.
console.log('\ntwo roles at one company');
const TWO = [
  { application_id: 'APP-X', id: 'x1', title: 'Vinco', stage: '4. Applied', position: ['Data Engineer'] },
  { application_id: 'APP-Y', id: 'y1', title: 'Vinco', stage: '4. Applied', position: ['Data Analyst'] },
];
const vague = propose({ id: 't1', sender: 'no-reply@greenhouse.io', senderName: 'Vinco',
                        subject: 'Your application', body: 'Unfortunately we are not moving forward.' }, TWO);
ok(vague.confidence === 'ambiguous' && !isAutoAppliable(vague) && needsAttention(vague),
   'rejection with no role named stays ambiguous and is escalated, never guessed');
ok(vague.candidates.length === 2, 'both candidate rows are surfaced so a human can pick');

const named = propose({ id: 't2', sender: 'no-reply@greenhouse.io', senderName: 'Vinco',
                        subject: 'Your application for Data Analyst',
                        body: 'Unfortunately we are not moving forward.' }, TWO);
ok(named.confidence === 'high' && named.candidates[0].application_id === 'APP-Y',
   'naming the role resolves which of the two it is');
ok(named.candidates[0].matched_via.includes('role'), 'the role signal is recorded in matched_via');

const sameTitle = [
  { application_id: 'APP-P', id: 'p9', title: 'Vinco', stage: '4. Applied', position: ['Data Engineer'] },
  { application_id: 'APP-Q', id: 'q9', title: 'Vinco', stage: '4. Applied', position: ['Data Engineer'] },
];
const dup = propose({ id: 't3', sender: 'no-reply@greenhouse.io', senderName: 'Vinco',
                      subject: 'Your application for Data Engineer',
                      body: 'Unfortunately we are not moving forward.' }, sameTitle);
ok(dup.confidence === 'ambiguous' && !isAutoAppliable(dup),
   'two rows with the SAME title stay ambiguous — the role cannot separate them');

console.log('\nescalation surface');
ok(needsAttention(propose({ id: 't4', sender: 'no-reply@greenhouse.io', senderName: 'Acme',
                            subject: 'Next steps', body: 'Are you available Thursday?' }, ROWS)),
   'interview invite is escalated for a human');
ok(!needsAttention(propose({ id: 't5', sender: 'news@substack.com', senderName: 'News',
                             subject: 'Weekly', body: 'hello' }, ROWS)),
   'ignored mail does not clutter the attention queue');

const unk = propose({ id: 'm5', sender: 'no-reply@greenhouse.io', senderName: 'Monzo',
                      subject: 'Your application', body: 'Unfortunately, not moving forward.' }, ROWS);
ok(unk.confidence === 'unmatched' && !isAutoAppliable(unk), 'no candidate row means no action');

const noise = propose({ id: 'm6', sender: 'news@substack.com', senderName: 'Some Newsletter',
                        subject: 'Weekly roundup', body: 'Hello.' }, ROWS);
ok(noise.confidence === 'ignore', 'unrelated mail proposes nothing');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
