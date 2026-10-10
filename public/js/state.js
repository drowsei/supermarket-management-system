const listeners = new Set();
const state = { session:null, branches:[], selectedBranchId:null, route:null, requestGeneration:0 };
export function getState(){ return state; }
export function setState(patch){ Object.assign(state,patch); for(const listener of listeners) listener(state); return state; }
export function subscribe(listener){ listeners.add(listener); return ()=>listeners.delete(listener); }
export function nextRequestGeneration(){ state.requestGeneration+=1; return state.requestGeneration; }
export function isCurrentGeneration(value){ return value===state.requestGeneration; }
export function resetState(){ Object.assign(state,{session:null,branches:[],selectedBranchId:null,route:null}); state.requestGeneration+=1; }
