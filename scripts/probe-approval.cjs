// Scratch probe for the approval matcher (v6.49). Run: node scripts/probe-approval.cjs
const path = require('path');
const { statesApproval } = require(path.join(__dirname, '..', 'dist/engine/gate.js'));
const p = /\b(approved|approval|lgtm)\b/i;
const cases = [
  ['Approved by Jane', true], ['No objections - approved', true], ['LGTM, ship it', true],
  ['Approval pending', false], ['not approved', false], ['Seeking approval from legal', false],
  ['Requesting approval before deploy', false], ['Approval not granted', false], ['approved? no', false],
  ['Approval from Legal pending', false], ['Approval requested from security', false],
  ['Approval: none', false], ['Approval deferred', false], ['Approval was sought', false],
  ['Approval to deploy: not yet', false], ['Approval please', false], ['Tentatively approved', false],
  ['approved, but not for prod', false],
  ['Awaiting approval from the change board', false], ['Sent for approval to the CAB', false],
  ['Approval required before the release window', false], ['Approved, and no further review is needed', true],
  ['Jordan reviewed the plan and approved it', true], ['We are not seeking approval for this one', false],
  ['Approved - independent of the executor.', true], ['LGTM, approved by the change board.', true],
  ['Approval: finance and risk signed off.', true], ['No objections - approved.', true],
  ['Approved in CAB on Tuesday.', true], ['This is not approved yet.', false],
  ['Approval was rejected by the risk team.', false], ['Approval rejected - pending a control owner.', false],
  ["Can't be approved until the policy is current.", false], ['Pending approval from security.', false],
  ['Approval withdrawn on Friday.', false],
  ['Approved by the CAB on 2026-11-01', true], ['Approval was granted by Jane', true],
  ['Approved, please deploy after the freeze', true], ['Approval not yet given', false],
  ['Approved conditional on the freeze ending', false], ['Approval still pending with Legal', false],
  ['Approved. Pending items: none', true],
];
let bad = 0;
for (const [t, e] of cases) {
  const g = statesApproval(t, p);
  if (g !== e) {
    bad += 1;
    console.log('FAIL', JSON.stringify(t), 'got', g, 'want', e);
  }
}
console.log(bad === 0 ? `all ${cases.length} ok` : `${bad} failures of ${cases.length}`);
