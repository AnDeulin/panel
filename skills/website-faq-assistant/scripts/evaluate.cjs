'use strict';
// Evaluate approved routing examples; no network, providers or personal data.
const fs = require('node:fs');
const path = require('node:path');
function argument(name) { const i=process.argv.indexOf(name); return i>=0 ? process.argv[i+1] : null; }
const knowledgeFile=argument('--knowledge'), casesFile=argument('--cases');
const siblingCore=path.join(__dirname,'..','component','faq-core.js');
const coreFile=argument('--core') || (fs.existsSync(siblingCore)?siblingCore:path.join(__dirname,'..','assets','component','faq-core.js'));
if (!knowledgeFile || !casesFile) { console.error('Use --knowledge FILE --cases FILE [--core FILE]'); process.exit(2); }
const core=require(path.resolve(coreFile));
const knowledge=JSON.parse(fs.readFileSync(knowledgeFile,'utf8'));
const dataset=JSON.parse(fs.readFileSync(casesFile,'utf8'));
const cases=Array.isArray(dataset) ? dataset : dataset.cases;
if(!Array.isArray(cases) || !cases.length) throw new Error('Evaluation cases missing');
let correct=0, critical=0, criticalCorrect=0;
const failures=[];
for(const item of cases) {
  const actual=core.classify(item.question,knowledge,item.context || {});
  const expectedIds=[...(item.ids||[])].sort();
  const actualIds=[...(actual.ids||[])].sort();
  const ok=actual.status===item.status && JSON.stringify(actualIds)===JSON.stringify(expectedIds);
  if(ok) correct++;
  if(item.critical){critical++;if(ok)criticalCorrect++;}
  if(!ok)failures.push({question:item.question,expected:{status:item.status,ids:expectedIds},actual});
}
const summary={total:cases.length,correct,accuracy:correct/cases.length,critical,criticalCorrect,failures};
console.log(JSON.stringify(summary,null,2));
const minimum=Number(argument('--minimum') || 0.95);
if(summary.accuracy < minimum || criticalCorrect !== critical)process.exitCode=1;
