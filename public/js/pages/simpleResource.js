import { renderResourcePage } from '../components/resourcePage.js';
export function resourceRenderer(config) { return (root, context = {}) => renderResourcePage(root, config, context); }
