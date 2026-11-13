'use strict'
const test=require('node:test')
const assert=require('node:assert/strict')
const {shouldHandleUpsert}=require('../src/message-guard')

test('linked account can issue a recognized command from its own number',()=>{
 assert.equal(shouldHandleUpsert({conversation:'/start'},{fromMe:true,type:'notify'}),true)
 assert.equal(shouldHandleUpsert({extendedTextMessage:{text:'/balance'}},{fromMe:true,type:'append'}),true)
})
test('linked account ordinary outgoing text is still ignored',()=>{
 assert.equal(shouldHandleUpsert({conversation:'hello everyone'},{fromMe:true,type:'notify'}),false)
 assert.equal(shouldHandleUpsert({conversation:'hello everyone'},{fromMe:true,type:'append'}),false)
})
test('normal incoming player commands and interactive buttons remain accepted',()=>{
 assert.equal(shouldHandleUpsert({conversation:'/rpg'},{fromMe:false,type:'notify'}),true)
 assert.equal(shouldHandleUpsert({interactiveResponseMessage:{nativeFlowResponseMessage:{paramsJson:'{"id":"rpg_home"}'}}},{fromMe:true,type:'notify'}),true)
})
test('unknown append messages remain ignored',()=>{
 assert.equal(shouldHandleUpsert({conversation:'ordinary message'},{fromMe:false,type:'append'}),false)
})
