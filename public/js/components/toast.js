import { element } from '../ui.js';
export function toast(message,type='success'){ const region=document.querySelector('#toast-region'); if(!region)return; const item=element('div',{className:`toast toast-${type}`,text:message,attributes:{role:type==='error'?'alert':'status'}}); region.append(item); setTimeout(()=>item.remove(),5000); }
