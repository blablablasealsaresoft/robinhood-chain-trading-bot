import fs from 'node:fs';

const file=process.argv[2]||'data/shadow/shadow-summary.json';
if(!fs.existsSync(file))process.exit(0);
const s=JSON.parse(fs.readFileSync(file,'utf8'));
const lines=[];
lines.push('# Mainnet shadow session');
lines.push('');
lines.push('- Duration: '+Number(s.durationMinutes||0).toFixed(1)+' min');
lines.push('- Mode: '+s.mode);
lines.push('- Signing: '+String(s.signing));
lines.push('- Broadcasting: '+String(s.broadcasting));
lines.push('- Stock eligibility acknowledged: '+String(s.stockTokenEligibilityAcknowledged));
lines.push('');
lines.push('## Strategies');
lines.push('');
lines.push('| Strategy | Ticks | Trades | Refusals | Realized | Open | Equity | Refinement |');
lines.push('|---|---:|---:|---:|---:|---:|---:|---|');
for(const a of s.agents||[]){
 lines.push('| '+a.id+' | '+a.ticks+' | '+a.trades+' | '+a.refusals+' | $'+Number(a.realizedUsd||0).toFixed(2)+' | $'+Number(a.openValueUsd||0).toFixed(2)+' | $'+Number(a.equityUsd||0).toFixed(2)+' | '+(a.refinementReady?'review-ready':'collecting')+' |');
 const refusals=a.decisions?.refusals||{};
 const top=Object.entries(refusals).sort((x,y)=>Number(y[1])-Number(x[1])).slice(0,5);
 if(top.length)lines.push('\n**'+a.id+' refusal reasons:** '+top.map(([k,v])=>k+'='+v).join(', '));
}
lines.push('');
lines.push('## Monitors');
lines.push('');
lines.push('- Launch monitor events: '+String(s.monitors?.launch?.recentEvents??0));
lines.push('- Arbitrage monitor: '+String(s.monitors?.arbitrage?.status??'unknown'));
lines.push('');
lines.push('> Shadow results are simulations/observations, not evidence of profitability. Parameter changes require separate review.');
const out=lines.join('\n')+'\n';
process.stdout.write(out);
if(process.env.GITHUB_STEP_SUMMARY)fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,out);
