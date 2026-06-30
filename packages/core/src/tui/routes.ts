/**
 * 路由表(A8 铁律:屏幕走路由,不写死单屏)。本期只有 'chat'。
 *
 * 中→重:团队/多 agent 视图 = 加一条路由 + 一个屏幕组件,App 零改动。
 * Boundary(HOST 层):react + 相对 import。
 */
import type React from 'react';
import { Repl } from './screens/Repl';

export type RouteName = 'chat';

export interface Route {
  name: RouteName;
  screen: React.ComponentType;
}

export const routes: Record<RouteName, Route> = {
  chat: { name: 'chat', screen: Repl },
};

export const defaultRoute: RouteName = 'chat';
