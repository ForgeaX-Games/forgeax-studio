/**
 * 消息视图 barrel —— import 一次触发各视图 registerMessage(user/assistant/notice)。
 * Thinking 不进 registry(见 Thinking.tsx),单独按需 export 供 Repl 调用。
 * Boundary(HOST 层):仅 core 相对 import。
 */
import './User';
import './Assistant';
import './Notice';

export {
  registerMessage,
  resolveMessage,
  resolveMessageByItem,
  messageKeyOf,
  type MessageView,
  type MessageViewProps,
  type MessageKey,
} from './registry';
export { AssistantView, assistantText } from './Assistant';
export { ThinkingView, thinkingText } from './Thinking';
export { UserView } from './User';
export { NoticeView } from './Notice';
