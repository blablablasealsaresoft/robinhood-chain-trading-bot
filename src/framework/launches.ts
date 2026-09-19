import {
  NOXA_ADDRESSES,
  ODYSSEY_ADDRESSES,
  noxaTokenLaunchedEvent,
  odysseyTokenCreatedEvent,
  type HoodClient,
  type Launch,
} from 'hoodchain'
import type { Address } from 'viem'

const ODYSSEY_FACTORIES: Address[] = [
  ODYSSEY_ADDRESSES.bondingCurveFactory,
  ODYSSEY_ADDRESSES.reflectionFactory,
  ODYSSEY_ADDRESSES.instantFactory,
]

export async function getRecentLaunchesReliable(
  client: HoodClient,
  options: { lookbackBlocks?: bigint; chunkSize?: bigint; onError?: (error: Error) => void } = {},
): Promise<Launch[]> {
  const latest = await client.public.getBlockNumber()
  const lookback = options.lookbackBlocks ?? 30_000n
  const chunk = options.chunkSize ?? 5_000n
  const fromBlock = latest > lookback ? latest - lookback : 0n
  const launches: Launch[] = []

  for (let start = fromBlock; start <= latest; start += chunk) {
    const end = start + chunk - 1n > latest ? latest : start + chunk - 1n
    let noxaLogs:any[]=[]
    try{
      noxaLogs=await client.public.getLogs({
        address:NOXA_ADDRESSES.launchFactory,
        event:noxaTokenLaunchedEvent,
        fromBlock:start,
        toBlock:end,
      })
    }catch(error){options.onError?.(sourceError('noxa',error))}
    for (const log of noxaLogs) {
      launches.push({
        launchpad: 'noxa',
        token: log.args.token as Address,
        creator: log.args.deployer as Address,
        pool: (log.args.pool as Address) ?? null,
        blockNumber: log.blockNumber,
        transactionHash: log.transactionHash,
      })
    }

    for (const [index,address] of ODYSSEY_FACTORIES.entries()) {
      let logs:any[]=[]
      try{
        logs=await client.public.getLogs({
          address,
          event:odysseyTokenCreatedEvent,
          fromBlock:start,
          toBlock:end,
        })
      }catch(error){options.onError?.(sourceError('odyssey-'+index,error))}
      for (const log of logs) {
        launches.push({
          launchpad: 'odyssey',
          token: log.args.token as Address,
          creator: log.args.creator as Address,
          pool: null,
          blockNumber: log.blockNumber,
          transactionHash: log.transactionHash,
        })
      }
    }
  }

  return launches.sort((a,b)=>a.blockNumber<b.blockNumber?-1:a.blockNumber>b.blockNumber?1:0)
}

export function watchLaunchesReliable(
  client: HoodClient,
  onLaunch: (launch: Launch) => void,
  options: { pollingInterval?: number; onError?: (error: Error) => void } = {},
): () => void {
  const pollingInterval=options.pollingInterval??2000
  const unwatchers:Array<()=>void>=[]

  unwatchers.push(client.public.watchContractEvent({
    address:NOXA_ADDRESSES.launchFactory,
    abi:[noxaTokenLaunchedEvent],
    eventName:'TokenLaunched',
    pollingInterval,
    onError:(error)=>options.onError?.(sourceError('noxa',error)),
    onLogs:(logs)=>{
      for(const log of logs)onLaunch({
        launchpad:'noxa',
        token:log.args.token as Address,
        creator:log.args.deployer as Address,
        pool:(log.args.pool as Address)??null,
        blockNumber:log.blockNumber,
        transactionHash:log.transactionHash,
      })
    },
  }))

  for(const address of ODYSSEY_FACTORIES){
    unwatchers.push(client.public.watchContractEvent({
      address,
      abi:[odysseyTokenCreatedEvent],
      eventName:'TokenCreated',
      pollingInterval,
      onError:(error)=>options.onError?.(sourceError('odyssey-'+ODYSSEY_FACTORIES.indexOf(address),error)),
      onLogs:(logs)=>{
        for(const log of logs)onLaunch({
          launchpad:'odyssey',
          token:log.args.token as Address,
          creator:log.args.creator as Address,
          pool:null,
          blockNumber:log.blockNumber,
          transactionHash:log.transactionHash,
        })
      },
    }))
  }

  return ()=>unwatchers.forEach(unwatch=>unwatch())
}

function sourceError(source:string,error:unknown):Error {
  const message=error instanceof Error?error.message:String(error)
  return new Error('launch source '+source+' failed: '+message)
}
