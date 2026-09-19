#!/usr/bin/env node
import { backupJournal, inspectJournal, readBackupManifest, restoreJournal } from './ops/journal-backup.js'

function arg(name:string):string|undefined {
  const index=process.argv.indexOf(name)
  return index>=0?process.argv[index+1]:undefined
}
function has(name:string):boolean {return process.argv.includes(name)}
function dbPath():string {return arg('--db')||process.env.HOOD_TRADERS_DB||'./data/hood-traders.db'}
function usage():never {
  console.error([
    'Usage:',
    '  hub-journal verify [--db PATH]',
    '  hub-journal backup [--db PATH] [--out PATH]',
    '  hub-journal verify-backup --from PATH [--manifest PATH]',
    '  hub-journal restore --from PATH [--db PATH] --confirm-offline',
  ].join('\n'))
  process.exit(2)
}
async function main(){
  const command=process.argv[2]
  if(command==='verify'){
    console.log(JSON.stringify(inspectJournal(dbPath()),null,2));return
  }
  if(command==='backup'){
    console.log(JSON.stringify(await backupJournal(dbPath(),arg('--out')),null,2));return
  }
  if(command==='verify-backup'){
    const from=arg('--from');if(!from)usage()
    const inspection=inspectJournal(from)
    const manifest=arg('--manifest')||from+'.json'
    const saved=readBackupManifest(manifest)
    if(saved.sha256!==inspection.sha256)throw new Error('Backup manifest checksum does not match the database')
    console.log(JSON.stringify({ok:true,inspection,manifest},null,2));return
  }
  if(command==='restore'){
    const from=arg('--from');if(!from)usage()
    console.log(JSON.stringify(restoreJournal({from,to:dbPath(),confirmOffline:has('--confirm-offline')}),null,2));return
  }
  usage()
}
main().catch(error=>{console.error(error instanceof Error?error.message:'Journal maintenance failed');process.exit(1)})
