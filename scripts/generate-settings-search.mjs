import ts from 'typescript';
import { readFileSync, writeFileSync } from 'node:fs';
import { SOURCES, ROUTES, EXTRA_ENTRIES } from './settings-search-config.mjs';

// Build-time only: reuse UI copy without mounting controls or indexing private values.
const entries = [];
const areaCopy = new Map();
const literal = node => node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;
const strings = node => { const out = []; if (node) { const walk = n => { const value = literal(n); if (value !== undefined) out.push(value); else ts.forEachChild(n, walk); }; walk(node); } return out; };
for (const [file, config] of Object.entries(SOURCES)) {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const variables = new Map();
  const scanVariables = node => { if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) variables.set(node.name.text, node.initializer); ts.forEachChild(node, scanVariables); };
  scanVariables(source);
  const routeFromContainer = (node, seen = new Set()) => {
    if (!node) return undefined;
    const text = node.getText(source);
    if (config.containers?.[text]) return config.containers[text];
    if (ts.isIdentifier(node) && !seen.has(text)) { seen.add(text); return routeFromContainer(variables.get(text), seen); }
    if (ts.isCallExpression(node)) return routeFromContainer(node.arguments[0], seen) || (ts.isPropertyAccessExpression(node.expression) ? routeFromContainer(node.expression.expression, seen) : undefined);
    return undefined;
  };
  const routeFor = node => {
    const parents=[]; for(let p=node.parent;p;p=p.parent)parents.unshift(p);
    let route=config.route;
    for (const p of parents) {
      if ((ts.isMethodDeclaration(p) || ts.isFunctionDeclaration(p)) && p.name) route=config.methods?.[p.name.getText(source)] || route;
      if (ts.isIfStatement(p) && p.thenStatement.pos <= node.pos && p.thenStatement.end >= node.end) {
        for (const match of p.expression.getText(source).matchAll(/this\.(activeSettingsPage|activeRulesFieldsPage|activeWorkflowPage|activePage)\s*===\s*['"]([^'"]+)['"]/g)) {
          route=config.conditions?.[match[1]+':'+match[2]] || route;
        }
      }
    }
    return route;
  };
  const visit = node => {
    if (ts.isNewExpression(node) && ['Setting', 'ButtonComponent'].includes(node.expression.getText(source))) {
      let chain=node; while (chain.parent && ((ts.isPropertyAccessExpression(chain.parent) && chain.parent.expression===chain) || (ts.isCallExpression(chain.parent) && chain.parent.expression===chain))) chain=chain.parent;
      const fields={}; const collect=n=>{if(ts.isCallExpression(n)&&ts.isPropertyAccessExpression(n.expression)){const k=n.expression.name.text;if(['setName','setDesc','setPlaceholder','setTooltip','setButtonText','addOption','addOptions'].includes(k)){(fields[k]??=[]).push(...strings(k==='addOption'?n.arguments[1]:n.arguments[0]));}}ts.forEachChild(n,collect);}; collect(chain);
      const hasName=/\.setName\(/.test(chain.getText(source));
      const nameCall = (()=>{let found;const walk=n=>{if(ts.isCallExpression(n)&&ts.isPropertyAccessExpression(n.expression)&&n.expression.name.text==='setName')found=n.arguments[0];ts.forEachChild(n,walk);};walk(chain);return found;})();
      const resolvedName = nameCall && ts.isIdentifier(nameCall) ? variables.get(nameCall.text) || nameCall : nameCall;
      const completeName = literal(resolvedName) ?? (resolvedName && ts.isConditionalExpression(resolvedName) ? literal(resolvedName.whenTrue) : undefined);
      const name=completeName || (!hasName ? fields.setButtonText?.[0] : undefined);
      const route=routeFromContainer(node.arguments?.[0]) || routeFor(node);
      if (name && route) entries.push({name,desc:(fields.setDesc||[]).join(' '),aliases:[...new Set([...fields.setName||[],...fields.setPlaceholder||[],...fields.setTooltip||[],...fields.setButtonText||[],...fields.addOption||[],...fields.addOptions||[]])],route});
      else if (name) throw new Error(`${file}:${source.getLineAndCharacterOfPosition(node.pos).line+1}: missing search route for ${name}`);
    }
    if(ts.isCallExpression(node)) {
      const method=ts.isPropertyAccessExpression(node.expression)?node.expression.name.text:node.expression.getText(source);
      const helper=config.helpers?.[method];
      if(helper) {
        const name=literal(node.arguments[helper.name]);
        const route=routeFromContainer(node.arguments[0]) || routeFor(node);
        if(name && route)entries.push({name,desc:strings(node.arguments[helper.desc]).join(' '),aliases:[],route});
      }
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method=node.expression.name.text;
      if(['createEl','createDiv','createSpan','setText'].includes(method)) {
        const options=node.arguments[method==='createEl'?1:0];
        const text=method==='setText'?options:options&&ts.isObjectLiteralExpression(options)?options.properties.find(p=>ts.isPropertyAssignment(p)&&p.name.getText(source)==='text')?.initializer:undefined;
        const route=routeFromContainer(node.expression.expression) || routeFor(node);
        const value=literal(text);
        if(value&&route){const copy=areaCopy.get(route)||[];copy.push(value);areaCopy.set(route,copy);}
      }
    }
    ts.forEachChild(node,visit);
  };
  visit(source);
  for(const [variable, options] of Object.entries(config.objects || {})) {
    const table=variables.get(variable);if(!table || !ts.isArrayLiteralExpression(table))throw Error('Missing objects '+variable);
    for(const item of table.elements)if(ts.isObjectLiteralExpression(item)) {
      const value=key=>literal(item.properties.find(p=>ts.isPropertyAssignment(p)&&p.name.getText(source)===key)?.initializer);
      const name=value(options.label);if(name)entries.push({name:name+(options.suffix||''),desc:options.desc||'',aliases:[value('key'),value('default'),value('placeholder')].filter(Boolean),route:options.route});
    }
  }
  for(const [variable, route] of Object.entries(config.maps || {})) {
    const table=variables.get(variable);if(!table || !ts.isObjectLiteralExpression(table))throw Error('Missing map '+variable);
    for(const item of table.properties)if(ts.isPropertyAssignment(item)){const name=literal(item.initializer);if(name)entries.push({name,desc:'Shared integration property name.',aliases:[item.name.getText(source)],route});}
  }
  for(const [variable, route] of Object.entries(config.tuples || {})) {
    const visitTuple=node=>{if(ts.isArrayLiteralExpression(node)&&node.elements.length===2){const key=literal(node.elements[0]),name=literal(node.elements[1]);if(key&&name){entries.push({key,name,desc:'Property name mapping. Apply reviews the change before updating records.',aliases:[key],route});return;}}ts.forEachChild(node,visitTuple);};
    const table=variables.get(variable);if(!table)throw Error('Missing table '+variable);visitTuple(table);
  }
}
for(const [route,copy] of areaCopy)entries.push({name:ROUTES[route],desc:'Open this settings area.',aliases:[...new Set(copy)],route});
for(const entry of EXTRA_ENTRIES)entries.push(entry);
const merged=new Map();
for(const entry of entries){if(!ROUTES[entry.route])throw Error('Unknown route '+entry.route);const key=entry.route+'\n'+entry.name;const prev=merged.get(key);merged.set(key,prev?{...prev,desc:[...new Set([prev.desc,entry.desc].filter(Boolean))].join(' '),aliases:[...new Set([...prev.aliases||[],...entry.aliases||[]])]}:entry);}
const output='// Generated from settings UI copy. Run npm run settings:search; do not edit.\nexport const SETTINGS_SEARCH_ROUTES = '+JSON.stringify(ROUTES,null,2)+' as const;\nexport const SETTINGS_SEARCH_ENTRIES = '+'[\n'+[...merged.values()].map(entry=>'  '+JSON.stringify(entry)).join(',\n')+'\n]'+' as const;\n';
const target='src/settings-search-catalog.ts';
if(process.argv.includes('--check')) { if(readFileSync(target,'utf8')!==output)throw Error('Settings search catalog is stale. Run npm run settings:search.'); }
else writeFileSync(target,output);
console.log(`Settings search: ${merged.size} entries across ${Object.keys(ROUTES).length} destinations`);
