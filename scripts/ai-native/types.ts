export type ControlSurface =
  | 'button'
  | 'palette'
  | 'shortcut'
  | 'menu'
  | 'rpc-handler'
  | 'postmessage-handler'
  | 'subscription-handler'
  | 'dom'
  | 'link';

export type ControlPropagation = 'direct' | 'forwarded' | 'manual-pool';

export type ControlOwner = 'us' | 'editor' | 'marketplace';

export type UiRepo = 'interface' | 'chat' | 'studio';

export interface ControlRow {
  control_id: string;
  repo: UiRepo;
  surface: ControlSurface;
  event: string;
  component: string;
  file: string;
  evidence_line: number;
  effect_id: string | null;
  propagation: ControlPropagation;
  owner: ControlOwner;
  notes: string;
}

export interface ActionEquivalent {
  id: string;
  capability: string;
  surface: 'ui' | 'server' | 'both';
  firstClass: boolean;
}

export interface ToolEquivalent {
  ids: string[];
  runtime_fill: boolean;
  source: string;
}

export interface EffectRow {
  effect_id: string;
  /** Every repository that contributes a declaration, route, or control edge. */
  repo: string[];
  vocab: {
    setters: string[];
    commands: string[];
    actions: string[];
  };
  agent_equiv: {
    action?: ActionEquivalent;
    tool?: ToolEquivalent;
    headless: 'yes' | 'no' | 'n-a';
  };
  server_endpoints: string[];
  domain: string;
}

export interface EdgeRow {
  control_id: string;
  effect_id: string;
  propagation: Exclude<ControlPropagation, 'manual-pool'>;
  via: string[];
  evidence_line: number;
}

export interface ManualPoolRow {
  manual_id: string;
  kind: 'control' | 'vocab' | 'route' | 'provider-di' | 'listener-event';
  file: string;
  evidence_line: number;
  component: string;
  event: string;
  control_id: string | null;
  candidate: string;
  reason: string;
  details: Record<string, unknown>;
}

export interface AliasEntry {
  old_control_id: string;
  new_control_id: string;
  reason: string;
}

export interface AliasMap {
  version: 1;
  aliases: AliasEntry[];
}

export interface ControlIdentityInput {
  repo: string;
  relativePath: string;
  component: string;
  event: string;
  elementType: string;
  stableAttributes?: Record<string, string>;
  staticText?: string;
  ordinal?: number;
}
