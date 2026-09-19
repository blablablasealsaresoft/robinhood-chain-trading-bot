import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Journal } from '../../src/framework/journal.js'
import { backupJournal, inspectJournal, readBackupManifest, restoreJournal } from '../../src/ops/journal-backup.js'

const dirs:string[]=[]
function temp(){
  const dir=mkdtempSync(join(tmpdir(),'hub-journal-'));dirs.push(dir);return dir
}
afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true})})

describe('Hub Journal backup and restore',()=>{
  it('creates an integrity-checked online backup with a checksum manifest',async()=>{
    const dir=temp(),source=join(dir,'hub.db'),backup=join(dir,'backups','one.db')
    const journal=new Journal(source)
    journal.recordDecision({agentId:'test',ts:1,kind:'observe',detail:'before backup',meta:{}})
    const result=await backupJournal(source,backup)
    journal.close()
    expect(result.backupPath).toBe(backup)
    expect(result.inspection.quickCheck).toBe('ok')
    expect(result.inspection.integrityCheck).toBe('ok')
    expect(result.inspection.tables).toContain('wallet_activity')
    const manifest=readBackupManifest(result.manifestPath)
    expect(manifest.sha256).toBe(result.inspection.sha256)
    expect(manifest.backup).toBe('one.db')
  })

  it('captures committed WAL data rather than copying only the main sqlite file',async()=>{
    const dir=temp(),source=join(dir,'hub.db'),backup=join(dir,'backup.db')
    const journal=new Journal(source)
    for(let i=0;i<20;i++)journal.recordDecision({agentId:'wal',ts:i,kind:'observe',detail:'row '+i,meta:{}})
    await backupJournal(source,backup)
    const restored=new Journal(backup)
    expect(restored.recentDecisions('wal',50)).toHaveLength(20)
    restored.close();journal.close()
  })

  it('refuses restore without explicit offline confirmation',async()=>{
    const dir=temp(),source=join(dir,'source.db'),backup=join(dir,'backup.db'),target=join(dir,'target.db')
    const sourceJournal=new Journal(source);sourceJournal.recordDecision({agentId:'source',ts:1,kind:'observe',detail:'source',meta:{}});sourceJournal.close()
    await backupJournal(source,backup)
    const targetJournal=new Journal(target);targetJournal.close()
    expect(()=>restoreJournal({from:backup,to:target,confirmOffline:false})).toThrow('confirm-offline')
  })

  it('restores a verified backup and preserves a rollback snapshot of the replaced Journal',async()=>{
    const dir=temp(),source=join(dir,'source.db'),backup=join(dir,'backup.db'),target=join(dir,'target.db')
    const sourceJournal=new Journal(source);sourceJournal.recordDecision({agentId:'source',ts:1,kind:'observe',detail:'source state',meta:{}});sourceJournal.close()
    await backupJournal(source,backup)
    const targetJournal=new Journal(target);targetJournal.recordDecision({agentId:'target',ts:2,kind:'observe',detail:'target state',meta:{}});targetJournal.close()
    const result=restoreJournal({from:backup,to:target,confirmOffline:true})
    expect(result.rollbackPath).toBeTruthy()
    const restored=new Journal(target)
    expect(restored.recentDecisions('source',10)).toHaveLength(1)
    expect(restored.recentDecisions('target',10)).toHaveLength(0)
    restored.close()
    const rollback=new Journal(result.rollbackPath!)
    expect(rollback.recentDecisions('target',10)).toHaveLength(1)
    rollback.close()
  })

  it('rejects a corrupt or non-Hub database before restore',()=>{
    const dir=temp(),bad=join(dir,'bad.db'),target=join(dir,'target.db')
    const journal=new Journal(target);journal.close()
    const bytes=Buffer.from('not sqlite')
    writeFileSync(bad,bytes)
    expect(()=>inspectJournal(bad)).toThrow()
    expect(()=>restoreJournal({from:bad,to:target,confirmOffline:true})).toThrow()
    expect(readFileSync(target).length).toBeGreaterThan(0)
  })
})
