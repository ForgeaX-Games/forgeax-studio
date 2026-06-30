/**
 * 工具视图 barrel(梁① · by canonical name)—— import 一次触发各视图 registerTool。
 * Default 先注册(兜底 key='default'),其余按真名注册;未命中自动落 Default。
 * Boundary(HOST 层):仅 core 相对 import。
 */
import './Default';
import './Bash';
import './FileEdit';
import './Read';
import './Search';
import './Ask';

export { registerTool, resolveTool, resolveToolByMeta } from './registry';
