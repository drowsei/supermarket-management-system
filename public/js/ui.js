export function element(tag,{className,text,attributes,dataset}={},children=[]){ const node=document.createElement(tag); if(className)node.className=className; if(text!==undefined)node.textContent=String(text); for(const [name,value] of Object.entries(attributes??{})){if(value!==undefined&&value!==null)node.setAttribute(name,String(value));} for(const [name,value] of Object.entries(dataset??{}))node.dataset[name]=String(value); for(const child of Array.isArray(children)?children:[children]){if(child)node.append(child);} return node; }
export function clear(node){ node.replaceChildren(); return node; }
export const ICON_PATHS = Object.freeze({
  back: ['M15 5l-7 7 7 7', 'M8 12h13'],
  dashboard: ['M4 4h6v6H4Z', 'M14 4h6v6h-6Z', 'M4 14h6v6H4Z', 'M14 14h6v6h-6Z'],
  home: ['M3 11.5 12 4l9 7.5', 'M5.5 10.5V20h13v-9.5', 'M9.5 20v-6h5v6'],
  menu: ['M4 7h16', 'M4 12h16', 'M4 17h16'],
  user: ['M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z', 'M4.5 21a7.5 7.5 0 0 1 15 0'],
  users: ['M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2', 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z', 'M22 21v-2a4 4 0 0 0-3-3.87'],
  store: ['M4 10v10h16V10', 'M3 4h18l-1 6H4L3 4Z', 'M9 20v-6h6v6'],
  shield: ['M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z', 'M9 12l2 2 4-4'],
  list: ['M8 6h13', 'M8 12h13', 'M8 18h13', 'M3 6h.01', 'M3 12h.01', 'M3 18h.01'],
  package: ['M21 8l-9 5-9-5', 'M3 8l9-5 9 5v8l-9 5-9-5V8', 'M12 13v8'],
  tag: ['M20 13l-7 7-9-9V4h7l9 9Z', 'M8.5 8.5h.01'],
  truck: ['M3 6h11v11H3Z', 'M14 10h4l3 3v4h-7Z', 'M7 20a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z', 'M18 20a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z'],
  cart: ['M3 4h2l2.4 11h10.8l2-8H6', 'M9 20h.01', 'M18 20h.01'],
  warehouse: ['M3 21V9l9-6 9 6v12', 'M7 21v-8h10v8', 'M7 17h10'],
  activity: ['M3 12h4l2-7 4 14 2-7h6'],
  terminal: ['M4 5h16v14H4Z', 'M7 9l3 3-3 3', 'M12 15h5'],
  receipt: ['M5 3l2 1 2-1 2 1 2-1 2 1 2-1v18l-2-1-2 1-2-1-2 1-2-1-2 1V3Z', 'M8 9h8', 'M8 13h8', 'M8 17h5'],
  return: ['M9 14l-4-4 4-4', 'M5 10h9a5 5 0 0 1 5 5v3'],
  chart: ['M4 20V10', 'M10 20V4', 'M16 20v-7', 'M22 20H2'],
  logout: ['M10 5H5v14h5', 'M14 8l4 4-4 4', 'M8 12h10'],
  refresh: ['M20 7v5h-5', 'M4 17v-5h5', 'M6.1 8A7 7 0 0 1 18 6l2 6', 'M17.9 16A7 7 0 0 1 6 18l-2-6'],
});

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

export function icon(name,size=18){
  const svg=document.createElementNS(SVG_NAMESPACE,'svg');
  for(const [attribute,value] of Object.entries({viewBox:'0 0 24 24',width:size,height:size,'aria-hidden':'true',focusable:'false',fill:'none',stroke:'currentColor','stroke-width':'1.8','stroke-linecap':'round','stroke-linejoin':'round'}))svg.setAttribute(attribute,String(value));
  for(const value of ICON_PATHS[name]??ICON_PATHS.home){const path=document.createElementNS(SVG_NAMESPACE,'path');path.setAttribute('d',value);svg.append(path);}
  return svg;
}
export function refreshButton({type='button'}={}){
  return element('button',{className:'button button-secondary icon-button',attributes:{type,'aria-label':'Refresh',title:'Refresh'}},[icon('refresh',24)]);
}
export function pageHeader(title,description,actions=[]){ const header=element('header',{className:'page-header'}); const copy=element('div'); copy.append(element('h1',{text:title})); if(description)copy.append(element('p',{className:'muted',text:description})); header.append(copy); if(actions.length)header.append(element('div',{className:'cluster'},actions)); return header; }
export function statusBadge(status){ return element('span',{className:`status-badge status-${String(status??'unknown').toLowerCase().replaceAll('_','-')}`,text:titleCaseLocal(status??'Unknown')}); }
function titleCaseLocal(value){return String(value).toLowerCase().replaceAll('_',' ').replace(/\b\w/g,(letter)=>letter.toUpperCase());}
