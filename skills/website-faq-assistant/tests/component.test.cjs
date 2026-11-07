'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const core=require('../assets/component/faq-core.js');
const knowledge=require('../assets/example-knowledge.json');

test('fictional project can use the component without school configuration',()=>{
  assert.equal(core.validateKnowledge(knowledge),true);
  const answer=core.classify('Who can join?',knowledge);
  assert.equal(answer.status,'answer');
  assert.deepEqual(answer.ids,['audience']);
});
test('unconfirmed price displays only the approved contact explanation',()=>{
  const answer=core.classify('What is the price?',knowledge);
  assert.equal(answer.status,'answer');
  assert.deepEqual(answer.ids,['price']);
  assert.equal(knowledge.cards.find(c=>c.id==='price').handoff,true);
  assert.equal(/\d/.test(knowledge.cards.find(c=>c.id==='price').answer),false);
});
test('unconfigured contact never points to a placeholder account',()=>{
  assert.equal(core.telegramUrl(knowledge.telegramUsername,'test'), '');
});
test('a forged model result cannot add an unapproved card',()=>{
  assert.equal(core.validateDecision({status:'answer',ids:['unknown']},knowledge).status,'handoff');
});

test('same product with an unapproved condition is handed off',()=>{
  for (const card of knowledge.cards) {
    for (const question of card.nearMisses || []) {
      assert.equal(core.classify(question,knowledge).status,'handoff',question);
    }
  }
});
