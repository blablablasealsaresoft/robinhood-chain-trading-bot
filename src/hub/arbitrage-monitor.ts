import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Journal } from '../framework/journal.js'

export function monitorEnvironment(source: NodeJS.ProcessEnv, rpcUrl?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of ['SystemRoot','SystemDrive','WINDIR','PATH','Path','PATHEXT','TEMP','TMP','COMSPEC','USERPROFILE','APPDATA','LOCALAPPDATA','HOME']) if (source[key]) env[key] = source[key]
  return { ...env, DOTENV_CONFIG_PATH: process.platform === 'win32' ? 'NUL' : '/dev/null',
    PRIVATE_KEY: '', LIVE: '0', EXECUTOR_ADDR: '', TELEGRAM_BOT_TOKEN: '', TELEGRAM_CHAT_ID: '',
    RPC_URL: rpcUrl || 'https://rpc.mainnet.chain.robinhood.com', WATCHLIST: '0' }
}
/** Runs the existing repository unchanged as a separate, signer-free monitor. */
export class ArbitrageMonitor {
  private child: ChildProcessWithoutNullStreams | null = null
  private state: 'stopped'|'starting'|'running'|'stopping'|'failed' = 'stopped'
  private startedAt: number | null = null
  private exitCode: number | null = null
  private lines: string[] = []
  private stopPromise: Promise<void> | null = null
  constructor(readonly repository: string, private journal: Pick<Journal,'recordDecision'>, private rpcUrl?: string) {}
  available() { return existsSync(resolve(this.repository,'arb.js')) && existsSync(resolve(this.repository,'node_modules/ethers/package.json')) }
  status() {
    return { id:'arbitrage', name:'RobinFun / Uniswap v4 arbitrage', status:this.available()?this.state:'not-installed',
      running:!!this.child, controlEnabled:this.available(), mode:'monitor', signing:false,
      pid:this.child?.pid ?? null, startedAt:this.startedAt, exitCode:this.exitCode, logs:[...this.lines],
      detail:'Existing arb.js in a separate dry-run process. Uses its configured market, quote sizing, gas policy and slippage controls. No signer, execution or Telegram notifications.',
      positions:[] }
  }
  async start(): Promise<void> {
    if(this.stopPromise)await this.stopPromise
    if(this.child)return
    if(!this.available())throw new Error('Arbitrage repository or its dependencies are unavailable.')
    this.lines=[];this.state='starting';this.exitCode=null;this.startedAt=Date.now()
    const child=spawn(process.execPath,['arb.js','--dry-run'],{cwd:this.repository,env:monitorEnvironment(process.env,this.rpcUrl),windowsHide:true,stdio:'pipe'})
    this.child=child
    const capture=(chunk:Buffer)=>{
      // Bound all in-memory output; never expose credentials or RPC URLs.
      const text=chunk.toString().replace(/\x1b\[[0-9;]*m/g,'').replace(/https?:\/\/[^\s"']+/g,'[RPC endpoint]').slice(0,8000)
      this.lines.push(...text.split(/\r?\n/).filter(Boolean).map(line=>line.slice(0,400)))
      this.lines=this.lines.slice(-40)
      if(this.state!=='stopping' && text.includes('DRY-RUN'))this.state='running'
    }
    child.stdout.on('data',capture);child.stderr.on('data',capture)
    child.on('error',()=>{if(this.child===child)this.child=null;this.state='failed';this.lines.push('Monitor process could not start. Check the local service.');})
    child.once('exit',(code)=>{
      const stopping=this.state==='stopping'
      this.exitCode=code;this.state=stopping||code===0?'stopped':'failed'
      if(this.child===child)this.child=null
      this.journal.recordDecision({agentId:'hub:arbitrage',ts:Date.now(),kind:'observe',detail:stopping?'Arbitrage monitor stopped':'Arbitrage monitor exited',meta:{mode:'monitor',exitCode:code}})
    })
    await new Promise<void>((accept,reject)=>{child.once('spawn',accept);child.once('error',reject)})
    this.journal.recordDecision({agentId:'hub:arbitrage',ts:Date.now(),kind:'observe',detail:'Existing arbitrage dry-run monitor started; no signing',meta:{mode:'monitor'}})
  }
  async stop(): Promise<void> {
    if(this.stopPromise)return this.stopPromise
    const child=this.child
    if(!child)return
    this.state='stopping'
    this.stopPromise=new Promise<void>((accept,reject)=>{
      const timer=setTimeout(()=>{if(this.child===child)child.kill('SIGKILL')},3000)
      const deadline=setTimeout(()=>{reject(new Error('Monitor termination was not acknowledged.'))},7000)
      child.once('exit',()=>{clearTimeout(timer);clearTimeout(deadline);accept()})
      child.kill('SIGTERM')
    }).finally(()=>{this.stopPromise=null})
    return this.stopPromise
  }
}
