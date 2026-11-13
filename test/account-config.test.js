'use strict'
const test=require('node:test'),assert=require('node:assert/strict')
const {_test}=require('../src/account-config')
test('all sessions use the Architect command engine',()=>{const x=_test.defaults('wa-two',false);assert.equal(x.mode,'architect');assert.equal(x.label,'Architect Instance');assert.equal(x.enabled,true)})
test('session configuration is normalized to Architect mode',()=>{const x=_test.clean('wa-two',{mode:'autoreply',label:'Second Bot',enabled:false},false);assert.equal(x.mode,'architect');assert.equal(x.label,'Second Bot');assert.equal(x.enabled,false)})
