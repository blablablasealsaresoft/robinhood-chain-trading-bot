import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'

const REQUIRED_TABLES=['external_events','wallet_plans','wallet_activity','agent_state','portfolio_snapshots','trades','decisions','equity'] as const

export interface JournalInspection {
  path:string
  sizeBytes:number
  quickCheck:string
  integrityCheck:string
  tables:string[]
  sha256:string
}
export interface JournalBackupResult {
  backupPath:string
  manifestPath:string
  inspection:JournalInspection
}
export interface JournalRestoreResult {
  restoredPath:string
  rollbackPath:string|null
  inspection:JournalInspection
}

function hashFile(path:string):string {
  const hash=createHash('sha256'),fd=openSync(path,'r'),buffer=Buffer.allocUnsafe(1024*1024)
  try{
    for(;;){
      const count=readSync(fd,buffer,0,buffer.length,null)
      if(count===0)break
      hash.update(buffer.subarray(0,count))
    }
  } finally {closeSync(fd)}
  return hash.digest('hex')
}

export function inspectJournal(path:string):JournalInspection {
  const absolute=resolve(path)
  if(!existsSync(absolute))throw new Error('Journal file does not exist: '+absolute)
  const db=new Database(absolute,{readonly:true,fileMustExist:true})
  try{
    db.pragma('busy_timeout = 1000')
    const quick=String((db.pragma('quick_check',{simple:true}) as unknown)??'')
    const integrity=String((db.pragma('integrity_check',{simple:true}) as unknown)??'')
    const tables=(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as {name:string}[]).map(row=>row.name)
    if(quick!=='ok'||integrity!=='ok')throw new Error('Journal integrity check failed')
    const missing=REQUIRED_TABLES.filter(name=>!tables.includes(name))
    if(missing.length)throw new Error('Journal is missing required tables: '+missing.join(', '))
    return {path:absolute,sizeBytes:statSync(absolute).size,quickCheck:quick,integrityCheck:integrity,tables,sha256:hashFile(absolute)}
  } finally {db.close()}
}

function timestamp(now=new Date()):string {
  return now.toISOString().replace(/[:.]/g,'-')
}

export async function backupJournal(source:string,destination?:string):Promise<JournalBackupResult> {
  const sourcePath=resolve(source)
  if(!existsSync(sourcePath))throw new Error('Journal file does not exist: '+sourcePath)
  const backupPath=resolve(destination??resolve(dirname(sourcePath),'backups','hub-'+timestamp()+'.db'))
  if(backupPath===sourcePath)throw new Error('Backup destination must differ from the source Journal')
  if(existsSync(backupPath))throw new Error('Backup destination already exists: '+backupPath)
  mkdirSync(dirname(backupPath),{recursive:true})
  const db=new Database(sourcePath,{fileMustExist:true})
  try{
    db.pragma('busy_timeout = 5000')
    await db.backup(backupPath)
  } finally {db.close()}
  const inspection=inspectJournal(backupPath)
  const manifestPath=backupPath+'.json'
  writeFileSync(manifestPath,JSON.stringify({
    version:1,
    createdAt:new Date().toISOString(),
    source:basename(sourcePath),
    backup:basename(backupPath),
    sizeBytes:inspection.sizeBytes,
    sha256:inspection.sha256,
    tables:inspection.tables,
  },null,2)+'\n',{flag:'wx',mode:0o600})
  return {backupPath,manifestPath,inspection}
}

function checkpointAndSnapshot(path:string,rollbackPath:string):void {
  const db=new Database(path,{fileMustExist:true})
  try{
    db.pragma('busy_timeout = 1000')
    db.pragma('wal_checkpoint(TRUNCATE)')
    db.exec('BEGIN EXCLUSIVE')
    db.exec('ROLLBACK')
  } finally {db.close()}
  copyFileSync(path,rollbackPath,0)
  inspectJournal(rollbackPath)
}

export function restoreJournal(input:{from:string;to:string;confirmOffline:boolean}):JournalRestoreResult {
  if(!input.confirmOffline)throw new Error('Restore requires --confirm-offline after the Hub process is stopped')
  const source=resolve(input.from),target=resolve(input.to)
  if(source===target)throw new Error('Restore source and destination must differ')
  const inspection=inspectJournal(source)
  mkdirSync(dirname(target),{recursive:true})
  let rollbackPath:string|null=null
  if(existsSync(target)){
    rollbackPath=target+'.rollback-'+timestamp()+'.db'
    checkpointAndSnapshot(target,rollbackPath)
  }
  const staged=target+'.restore-'+process.pid
  if(existsSync(staged))rmSync(staged,{force:true})
  copyFileSync(source,staged)
  inspectJournal(staged)
  for(const suffix of ['-wal','-shm'])if(existsSync(target+suffix))rmSync(target+suffix,{force:true})
  if(existsSync(target))rmSync(target,{force:true})
  renameSync(staged,target)
  const restored=inspectJournal(target)
  if(restored.sha256!==inspection.sha256)throw new Error('Restored Journal checksum mismatch')
  return {restoredPath:target,rollbackPath,inspection:restored}
}

export function readBackupManifest(path:string):Record<string,unknown> {
  const value=JSON.parse(readFileSync(path,'utf8')) as Record<string,unknown>
  if(value.version!==1||typeof value.sha256!=='string'||typeof value.backup!=='string')throw new Error('Invalid backup manifest')
  return value
}
